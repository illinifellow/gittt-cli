/**
 * The git command line, wrapped: every read the views need (repository summary,
 * log, commit details, file diffs) and the runner the actions use. Parsing uses
 * unit and record separators so no message or ref name can break a field.
 */
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { WORKING_TREE, type Branch, type ChangedFile, type Commit, type CommitDetails, type Operation, type Repository, type ViewSettings } from "@/protocol"

const UNIT = "\x1f"
const RECORD = "\x1e"
const MAX_BUFFER = 256 * 1024 * 1024
const MAX_DIFF_LENGTH = 600 * 1024

/**
 * Runs git and resolves with its standard output.
 * @param cwd repository directory the command runs in
 * @param args arguments after `git`
 * @param acceptedExitCodes exit codes besides 0 that still count as success (`git diff --no-index` exits 1 on differences)
 * @returns standard output; rejects with an error naming the command, the directory and git's standard error
 */
export const runGit = (cwd: string, args: string[], acceptedExitCodes: number[] = []) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : null
      if (!error || (exitCode !== null && acceptedExitCodes.includes(exitCode))) resolve(stdout)
      else reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${(stderr || error.message).trim()}`))
    }))

const parseTrack = (track: string) => ({
  ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
  behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  gone: track.includes("gone"),
})

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])

/**
 * Parses `git status --porcelain=v1 -z` output into changed files, one per path.
 * The status letter is the index side when it changed, else the working-tree side; conflicts are `U`, untracked `?`.
 * @param output raw NUL-separated status output
 * @returns changed files in git's order
 */
const parseStatus = (output: string): ChangedFile[] => {
  const entries = output.split("\0")
  const files: ChangedFile[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const renamed = code[0] === "R" || code[0] === "C"
    const previousPath = renamed ? entries[++index] : null
    const status = CONFLICT_CODES.has(code) ? "U" : code[0] === "?" ? "?" : code[0] !== " " ? code[0] : code[1]
    files.push({ status, path: entry.slice(3), previousPath })
  }
  return files
}

const readText = (path: string) => readFile(path, "utf8").then(text => text.trim(), () => null)

/**
 * Detects an operation git left half way, from the marker files in the repository's git directory.
 * @param gitDirectory absolute git directory (the worktree's own one for linked worktrees)
 * @returns the operation, or `null` when none is in progress
 */
export const readOperation = async (gitDirectory: string): Promise<Operation | null> => {
  for (const folder of ["rebase-merge", "rebase-apply"]) {
    const base = join(gitDirectory, folder)
    const onto = await readText(join(base, "onto"))
    if (onto === null) continue
    const headName = await readText(join(base, "head-name"))
    const step = await readText(join(base, folder === "rebase-merge" ? "msgnum" : "next"))
    const total = await readText(join(base, folder === "rebase-merge" ? "end" : "last"))
    return { kind: "rebase", target: onto, branch: headName?.replace(/^refs\/heads\//, "") ?? null, step: step ? Number(step) : null, total: total ? Number(total) : null }
  }
  const markers: [Operation["kind"], string][] = [["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"], ["bisect", "BISECT_LOG"]]
  for (const [kind, file] of markers) {
    const content = await readText(join(gitDirectory, file))
    if (content !== null) return { kind, target: kind === "bisect" ? null : content.split("\n")[0], branch: null, step: null, total: null }
  }
  return null
}

/**
 * Reads everything the repository tree shows: HEAD, local and remote branches, tags, stashes, change count.
 * @param path repository root
 * @returns the summary; a repository git cannot read comes back empty with `error` set
 */
export const readRepository = async (path: string): Promise<Repository> => {
  const repository: Repository = {
    path,
    name: basename(path),
    head: { branch: null, hash: null },
    changes: 0,
    conflicts: 0,
    operation: null,
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    error: null,
  }
  try {
    const [refs, stashes, status, head, symbolic, gitDirectory] = await Promise.all([
      runGit(path, ["for-each-ref", `--format=%(refname)${UNIT}%(objectname)${UNIT}%(*objectname)${UNIT}%(upstream:short)${UNIT}%(upstream:track,nobracket)${UNIT}%(HEAD)`, "refs/heads", "refs/remotes", "refs/tags"]),
      runGit(path, ["stash", "list", `--format=%gd${UNIT}%H${UNIT}%gs`]),
      runGit(path, ["status", "--porcelain=v1", "-z", "-unormal"]),
      runGit(path, ["rev-parse", "--verify", "-q", "HEAD"], [1]),
      runGit(path, ["symbolic-ref", "-q", "--short", "HEAD"], [1]),
      runGit(path, ["rev-parse", "--absolute-git-dir"]),
    ])
    repository.head = { branch: symbolic.trim() || null, hash: head.trim() || null }
    const files = parseStatus(status)
    repository.changes = files.length
    repository.conflicts = files.filter(file => file.status === "U").length
    repository.operation = await readOperation(gitDirectory.trim())
    const remotes = new Map<string, Repository["remotes"][number]>()
    for (const line of refs.split("\n")) {
      if (!line) continue
      const [refName, objectName, peeledName, upstream, track, headMark] = line.split(UNIT)
      if (refName.startsWith("refs/heads/")) {
        const branch: Branch = { name: refName.slice(11), hash: objectName, upstream: upstream || null, current: headMark === "*", ...parseTrack(track) }
        repository.branches.push(branch)
      } else if (refName.startsWith("refs/remotes/")) {
        const [remote, ...rest] = refName.slice(13).split("/")
        const name = rest.join("/")
        if (name === "HEAD") continue
        const group = remotes.get(remote) ?? { name: remote, branches: [] }
        group.branches.push({ remote, name, hash: objectName })
        remotes.set(remote, group)
      } else repository.tags.push({ name: refName.slice(10), hash: peeledName || objectName })
    }
    repository.remotes = [...remotes.values()]
    repository.tags.sort((first, second) => second.name.localeCompare(first.name, undefined, { numeric: true }))
    repository.stashes = stashes.split("\n").filter(Boolean).map(line => {
      const [reference, hash, message] = line.split(UNIT)
      return { reference, hash, message }
    })
  } catch (error) {
    repository.error = error instanceof Error ? error.message : String(error)
  }
  return repository
}

/**
 * Builds the `git log` revision arguments for the view settings.
 * @param settings branch scope and remote visibility
 * @returns revision arguments; `HEAD` alone for the current branch
 */
const logRevisions = (settings: Pick<ViewSettings, "branches" | "showRemoteBranches">) =>
  settings.branches === "current" ? ["HEAD"] : ["HEAD", "--branches", "--tags", ...(settings.showRemoteBranches ? ["--remotes"] : [])]

/**
 * Reads the commit log for the graph.
 * @param path repository root
 * @param settings branch scope, remote visibility and order
 * @param maxCommits commits to load at most
 * @returns commits newest first and whether more exist; an empty repository yields none
 */
export const readLog = async (path: string, settings: ViewSettings, maxCommits: number) => {
  const hasHead = (await runGit(path, ["rev-parse", "--verify", "-q", "HEAD"], [1])).trim() !== ""
  const hasRefs = (await runGit(path, ["for-each-ref", "--count=1", "refs/heads", "refs/remotes", "refs/tags"])).trim() !== ""
  if (!hasHead && !hasRefs) return { commits: [] as Commit[], truncated: false }
  const revisions = logRevisions(settings).filter(revision => hasHead || revision !== "HEAD")
  const output = await runGit(path, [
    "log",
    ...revisions,
    settings.order === "date" ? "--date-order" : "--topo-order",
    `--max-count=${maxCommits + 1}`,
    `--format=%H${UNIT}%P${UNIT}%an${UNIT}%ae${UNIT}%at${UNIT}%s${RECORD}`,
    "--",
  ])
  const commits: Commit[] = output.split(RECORD).map(record => record.replace(/^\n/, "")).filter(Boolean).map(record => {
    const [hash, parents, author, email, time, subject] = record.split(UNIT)
    return { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), subject }
  })
  return { commits: commits.slice(0, maxCommits), truncated: commits.length > maxCommits }
}

const parseNameStatus = (output: string): ChangedFile[] => {
  const parts = output.split("\0").filter(Boolean)
  const files: ChangedFile[] = []
  for (let index = 0; index < parts.length; index++) {
    const status = parts[index][0]
    const renamed = status === "R" || status === "C"
    const previousPath = renamed ? parts[++index] : null
    files.push({ status, path: parts[++index], previousPath })
  }
  return files
}

/**
 * Reads a commit's metadata and changed files (against its first parent), or the working tree's changes.
 * @param path repository root
 * @param hash commit hash, or `WORKING_TREE` for uncommitted changes
 * @returns details; for the working tree the author fields are empty and the file list comes from `git status`
 */
export const readDetails = async (path: string, hash: string): Promise<CommitDetails> => {
  if (hash === WORKING_TREE) {
    const files = parseStatus(await runGit(path, ["status", "--porcelain=v1", "-z", "-uall"]))
    return { hash, parents: [], author: "", email: "", authorTime: 0, committer: "", message: "Uncommitted changes", files }
  }
  const header = await runGit(path, ["show", "-s", `--format=%H${UNIT}%P${UNIT}%an${UNIT}%ae${UNIT}%at${UNIT}%cn${UNIT}%B`, hash])
  const [fullHash, parents, author, email, authorTime, committer, message] = header.split(UNIT)
  const parentList = parents ? parents.split(" ") : []
  const nameStatus = parentList.length
    ? await runGit(path, ["diff", "--name-status", "-z", "-M", parentList[0], fullHash])
    : await runGit(path, ["diff-tree", "--root", "-r", "--name-status", "-z", "-M", "--no-commit-id", fullHash])
  return {
    hash: fullHash,
    parents: parentList,
    author,
    email,
    authorTime: Number(authorTime),
    committer,
    message: message.trimEnd(),
    files: parseNameStatus(nameStatus),
  }
}

/**
 * Reads the unified diff of one file in a commit (against its first parent) or in the working tree (against HEAD;
 * conflicted files show git's combined diff with the conflict markers).
 * @param path repository root
 * @param hash commit hash or `WORKING_TREE`
 * @param file the changed file; renames diff both paths
 * @returns unified diff text, cut at 600 KB with a closing note
 */
export const readDiff = async (path: string, hash: string, file: ChangedFile) => {
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
  let text: string
  if (hash === WORKING_TREE) {
    const hasHead = (await runGit(path, ["rev-parse", "--verify", "-q", "HEAD"], [1])).trim() !== ""
    if (file.status === "?") text = await runGit(path, ["diff", "--no-index", "--", "/dev/null", file.path], [1])
    else if (file.status === "U") text = await runGit(path, ["diff", "--", file.path])
    else text = await runGit(path, hasHead ? ["diff", "-M", "HEAD", "--", ...paths] : ["diff", "--cached", "--", ...paths])
  } else {
    const parents = (await runGit(path, ["show", "-s", "--format=%P", hash])).trim()
    const parent = parents.split(" ")[0]
    text = parent
      ? await runGit(path, ["diff", "-M", parent, hash, "--", ...paths])
      : await runGit(path, ["show", "--format=", "-M", hash, "--", ...paths])
  }
  return text.length > MAX_DIFF_LENGTH ? `${text.slice(0, MAX_DIFF_LENGTH)}\n\\ diff cut at ${MAX_DIFF_LENGTH / 1024} KB` : text
}
