/**
 * The git command line, wrapped: every read the views need (repository summary,
 * log, commit details, file diffs) and the runner the actions use. Parsing uses
 * unit and record separators so no message or ref name can break a field, and
 * every path gittt hands git is a literal file name, never a pattern.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { open, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { loadConfig } from "@/config"
import { WORKING_TREE, type Branch, type ChangedFile, type Commit, type CommitDetails, type Operation, type Repository, type ViewSettings } from "@/protocol"

const UNIT = "\x1f"
const RECORD = "\x1e"
/** Standard output kept by default; reads that can be huge (diffs, whole files) pass their own, smaller limit. */
const MAX_BUFFER = 256 * 1024 * 1024
/** Standard error kept for the error message; the rest is dropped. */
const MAX_ERROR_BYTES = 64 * 1024
/** Never takes optional locks, never asks for a password, and reads every path as a literal name (`*.txt` is one file). */
const GIT_ENVIRONMENT = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" }

/** Commands that talk to a remote: user actions run them unattended and with a time limit. */
const NETWORK_COMMANDS = new Set(["fetch", "pull", "push"])

/** Options of one git run. */
export interface GitOptions {
  /** exit codes besides 0 that still count as success (`git diff --no-index` exits 1 on differences) */
  acceptedExitCodes?: number[]
  /** aborting stops git at once and rejects with an `AbortError` */
  signal?: AbortSignal
  /** standard output kept at most, in bytes; once more arrives git is stopped and the output ends there */
  maxBytes?: number
  /** variables added to git's environment */
  env?: Record<string, string>
}

/** Git processes still running, so leaving gittt can stop them. */
const running = new Set<ChildProcess>()

const abortError = () => Object.assign(new Error("git run aborted"), { name: "AbortError" })

/**
 * Decodes UTF-8 output; a cut output drops a character split at the cut instead of showing a replacement mark.
 * @param buffer the bytes
 * @param cut whether the bytes stop part way through the real output
 * @returns the text
 */
const decodeText = (buffer: Buffer, cut: boolean) => new TextDecoder().decode(buffer, { stream: cut })

/**
 * Runs git and resolves with its standard output and whether it was cut at `maxBytes`.
 * @param cwd repository directory the command runs in
 * @param args arguments after `git`
 * @param options accepted exit codes, abort signal, output limit
 * @returns standard output and `cut`; rejects with an error naming the command, the directory and git's standard error,
 *   with an error saying the time ran out when the signal fired on a timeout, or with an `AbortError` when it fired otherwise
 */
export const runGitOutput = (cwd: string, args: string[], { acceptedExitCodes = [], signal, maxBytes = MAX_BUFFER, env }: GitOptions = {}) =>
  new Promise<{ stdout: string; cut: boolean }>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const child = spawn("git", args, { cwd, env: env ? { ...GIT_ENVIRONMENT, ...env } : GIT_ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"] })
    running.add(child)
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let size = 0
    let errorSize = 0
    let cut = false
    const stop = () => child.kill()
    signal?.addEventListener("abort", stop, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      if (cut) return
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size))
        cut = true
        return stop()
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorSize < MAX_ERROR_BYTES) errors.push(chunk)
      errorSize += chunk.length
    })
    let failure: Error | null = null
    child.on("error", error => {
      failure = error
      if (child.pid !== undefined) return
      running.delete(child)
      reject(new Error(`git ${args.join(" ")} could not start in ${cwd}: ${error.message}`))
    })
    child.on("close", code => {
      running.delete(child)
      signal?.removeEventListener("abort", stop)
      if (signal?.aborted) return reject((signal.reason as Error | undefined)?.name === "TimeoutError" ? new Error(`git ${args.join(" ")} gave no answer in time in ${cwd} and was stopped`) : abortError())
      const stdout = decodeText(Buffer.concat(chunks), cut)
      if (cut || (code !== null && (code === 0 || acceptedExitCodes.includes(code)))) return resolve({ stdout, cut })
      const stderr = Buffer.concat(errors).toString("utf8").trim()
      reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || failure?.message || `exit code ${code}`}`))
    })
  })

/**
 * Runs git and resolves with its standard output.
 * @param cwd repository directory the command runs in
 * @param args arguments after `git`
 * @param options accepted exit codes, abort signal, output limit (see `runGitOutput`)
 * @returns standard output; rejects as `runGitOutput` does
 */
export const runGit = (cwd: string, args: string[], options?: GitOptions) => runGitOutput(cwd, args, options).then(result => result.stdout)

/** Stops every git process gittt started that is still running; called when gittt exits. */
export const stopGit = () => running.forEach(child => child.kill())

const parseTrack = (track: string) => ({
  ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
  behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  gone: track.includes("gone"),
})

/**
 * Parses `git status --porcelain=v2 -z --branch` output.
 * The status letter of a file is the index side when it changed, else the working-tree side; conflicts are `U`,
 * untracked files `?`.
 * @param output raw NUL-separated status output, optionally with `--ignored=traditional` entries
 * @returns HEAD's branch (`null` when detached) and hash (`null` before the first commit), the changed files in git's
 *   order, and the ignored paths (folders end in `/`)
 */
export const parseStatus = (output: string) => {
  const status = { branch: null as string | null, hash: null as string | null, files: [] as ChangedFile[], ignored: [] as string[] }
  const entries = output.split("\0")
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const fields = entry.split(" ")
    if (entry.startsWith("# branch.oid ")) status.hash = fields[2] === "(initial)" ? null : fields[2]
    else if (entry.startsWith("# branch.head ")) status.branch = entry.slice(14) === "(detached)" ? null : entry.slice(14)
    else if (fields[0] === "!") status.ignored.push(entry.slice(2))
    else if (fields[0] === "?") status.files.push({ status: "?", path: entry.slice(2), previousPath: null, staged: false, unstaged: true })
    else if (fields[0] === "u") status.files.push({ status: "U", path: fields.slice(10).join(" "), previousPath: null, staged: false, unstaged: true })
    else if (fields[0] === "1" || fields[0] === "2") {
      const [indexSide, workSide] = fields[1]
      const renamed = fields[0] === "2"
      status.files.push({
        status: indexSide !== "." ? indexSide : workSide,
        path: fields.slice(renamed ? 9 : 8).join(" "),
        previousPath: renamed ? entries[++index] : null,
        staged: indexSide !== ".",
        unstaged: workSide !== ".",
      })
    }
  }
  return status
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

/** A repository's own git directory and the one its refs and config live in (they differ for linked worktrees). */
export interface GitDirectories {
  gitDirectory: string
  commonDirectory: string
}

/** Git directories by repository root; they never move while gittt runs. */
const gitDirectories = new Map<string, Promise<GitDirectories>>()
/** Each repository's stash list with the `refs/stash` hash it was read at, so an unchanged stash is not listed again. */
const stashLists = new Map<string, { tip: string; stashes: Repository["stashes"] }>()
/** Each repository's configured remote names with the config file's change time they were read at. */
const remoteNames = new Map<string, { changed: number; names: string[] }>()

/**
 * @param path repository root
 * @returns its absolute git directories, read once per repository; rejects when `path` is no repository
 */
export const readGitDirectories = (path: string) => {
  let directories = gitDirectories.get(path)
  if (!directories) {
    directories = runGit(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).then(output => {
      const [gitDirectory, commonDirectory] = output.trim().split("\n")
      return { gitDirectory, commonDirectory }
    })
    directories.catch(() => gitDirectories.delete(path))
    gitDirectories.set(path, directories)
  }
  return directories
}

/**
 * Lists the configured remotes, again only when the repository's config file changed.
 * @param path repository root
 * @param commonDirectory the git directory holding the config
 * @returns remote names, including remotes that have no tracking branches yet
 */
const readRemoteNames = async (path: string, commonDirectory: string) => {
  const changed = (await stat(join(commonDirectory, "config")).catch(() => null))?.mtimeMs ?? -1
  const known = remoteNames.get(path)
  if (known && known.changed === changed && changed !== -1) return known.names
  const names = (await runGit(path, ["remote"])).split("\n").filter(Boolean)
  remoteNames.set(path, { changed, names })
  return names
}

/**
 * Splits a short remote-tracking name such as `origin/feature/x` at the remote it belongs to; remote names may hold `/`.
 * @param name the short name
 * @param remotes known remote names
 * @returns the longest remote the name starts with and the branch after it, or `null` when no remote matches
 */
export const splitRemoteRef = (name: string, remotes: string[]) => {
  const remote = remotes.filter(candidate => name.startsWith(`${candidate}/`)).sort((first, second) => second.length - first.length)[0]
  return remote === undefined ? null : { remote, branch: name.slice(remote.length + 1) }
}

const readStashes = async (path: string, tip: string) => {
  if (!tip) return []
  const known = stashLists.get(path)
  if (known?.tip === tip) return known.stashes
  const output = await runGit(path, ["stash", "list", `--format=%gd${UNIT}%H${UNIT}%gs`])
  const stashes = output.split("\n").filter(Boolean).map(line => {
    const [reference, hash, message] = line.split(UNIT)
    return { reference, hash, message }
  })
  stashLists.set(path, { tip, stashes })
  return stashes
}

/**
 * Reads everything the repository tree shows: HEAD, local and remote branches, tags, stashes, change count.
 * One git process at a time, two per read: `git status`, then `for-each-ref` (refs and the stash tip); the stash
 * list is read again only when `refs/stash` moved, the remote names only when the config changed, the git directories
 * once per repository.
 * @param path repository root
 * @returns the summary, and the paths git ignores there (folders end in `/`) so the watcher can skip their changes;
 *   a repository git cannot read comes back empty with `error` set
 */
export const readRepositoryState = async (path: string): Promise<{ repository: Repository; ignored: string[] }> => {
  const repository: Repository = {
    path,
    name: basename(path),
    head: { branch: null, hash: null },
    changes: 0,
    staged: 0,
    conflicts: 0,
    operation: null,
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    error: null,
  }
  let ignored: string[] = []
  try {
    const { gitDirectory, commonDirectory } = await readGitDirectories(path)
    const status = parseStatus(await runGit(path, ["status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "-unormal", "--ignored=traditional"]))
    const refs = await runGit(path, ["for-each-ref", `--format=%(refname)${UNIT}%(objectname)${UNIT}%(*objectname)${UNIT}%(upstream:short)${UNIT}%(upstream:track,nobracket)${UNIT}%(HEAD)`, "refs/heads", "refs/remotes", "refs/tags", "refs/stash"])
    ignored = status.ignored
    repository.head = { branch: status.branch, hash: status.hash }
    repository.changes = status.files.length
    repository.staged = status.files.filter(file => file.staged).length
    repository.conflicts = status.files.filter(file => file.status === "U").length
    repository.operation = await readOperation(gitDirectory)
    const names = await readRemoteNames(path, commonDirectory)
    const remotes = new Map<string, Repository["remotes"][number]>(names.map(name => [name, { name, branches: [] }]))
    let stashTip = ""
    for (const line of refs.split("\n")) {
      if (!line) continue
      const [refName, objectName, peeledName, upstream, track, headMark] = line.split(UNIT)
      if (refName.startsWith("refs/heads/")) {
        const branch: Branch = { name: refName.slice(11), hash: objectName, upstream: upstream || null, current: headMark === "*", ...parseTrack(track) }
        repository.branches.push(branch)
      } else if (refName.startsWith("refs/remotes/")) {
        const short = refName.slice(13)
        const { remote, branch: name } = splitRemoteRef(short, names) ?? { remote: short.slice(0, short.indexOf("/")), branch: short.slice(short.indexOf("/") + 1) }
        if (name === "HEAD") continue
        const group = remotes.get(remote) ?? { name: remote, branches: [] }
        group.branches.push({ remote, name, hash: objectName })
        remotes.set(remote, group)
      } else if (refName === "refs/stash") stashTip = objectName
      else repository.tags.push({ name: refName.slice(10), hash: peeledName || objectName })
    }
    repository.remotes = [...remotes.values()]
    repository.tags.sort((first, second) => second.name.localeCompare(first.name, undefined, { numeric: true }))
    repository.stashes = await readStashes(path, stashTip)
  } catch (error) {
    repository.error = error instanceof Error ? error.message : String(error)
  }
  return { repository, ignored }
}

/** Each repository's ssh command for unattended runs: the user's ssh command told never to ask. */
const sshCommands = new Map<string, Promise<string>>()

/**
 * The environment that keeps a remote from asking anything: no password prompt (set for every run) and ssh in batch
 * mode, so a remote that needs input fails instead of drawing over the screen. `GIT_SSH_COMMAND` wins over
 * `core.sshCommand`, as in git itself.
 * @param path repository root
 * @returns variables to add to git's environment; `undefined` when the user set only `GIT_SSH`, whose program takes no ssh options
 */
const networkEnvironment = async (path: string) => {
  if (process.env.GIT_SSH && !process.env.GIT_SSH_COMMAND) return undefined
  let command = sshCommands.get(path)
  if (!command) {
    command = runGit(path, ["config", "--get", "core.sshCommand"], { acceptedExitCodes: [1] })
      .then(configured => `${process.env.GIT_SSH_COMMAND || configured.trim() || "ssh"} -o BatchMode=yes`)
    command.catch(() => sshCommands.delete(path))
    sshCommands.set(path, command)
  }
  return { GIT_SSH_COMMAND: await command }
}

/**
 * Fetches every remote of a repository without asking anything (see `networkEnvironment`).
 * @param path repository root
 * @param signal aborting stops the fetch and rejects with an `AbortError`, or with a time-out error for a timeout signal
 * @returns once fetched; rejects with git's error when a remote cannot be reached or needs credentials
 */
export const fetchRemotes = async (path: string, signal?: AbortSignal) => {
  await runGit(path, ["fetch", "--all", "--quiet"], { signal, env: await networkEnvironment(path) })
}

/**
 * Runs one command of a user action. A command that talks to a remote (fetch, pull, push) runs unattended
 * (see `networkEnvironment`) and is stopped once `timeoutMs` passed.
 * @param path repository root
 * @param args arguments after `git`
 * @param timeoutMs how long a remote may take
 * @returns standard output; rejects as `runGitOutput` does
 */
export const runActionCommand = async (path: string, args: string[], timeoutMs: number) =>
  NETWORK_COMMANDS.has(args[0]) ? runGit(path, args, { env: await networkEnvironment(path), signal: AbortSignal.timeout(timeoutMs) }) : runGit(path, args)

/**
 * Finds a stash's current `stash@{N}` name; stashes made or dropped since the list was read shift the numbers.
 * @param path repository root
 * @param hash the stash commit
 * @returns its reference now; rejects when the stash no longer exists
 */
export const readStashReference = async (path: string, hash: string) => {
  const line = (await runGit(path, ["stash", "list", `--format=%gd${UNIT}%H`])).split("\n").find(candidate => candidate.endsWith(`${UNIT}${hash}`))
  if (!line) throw new Error(`stash ${hash.slice(0, 7)} no longer exists in ${path}`)
  return line.split(UNIT)[0]
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
 * @param signal aborting stops the git processes and rejects with an `AbortError`
 * @returns commits newest first and whether more exist; an empty repository yields none
 */
export const readLog = async (path: string, settings: ViewSettings, maxCommits: number, signal?: AbortSignal) => {
  const [head, refs] = await Promise.all([
    runGit(path, ["rev-parse", "--verify", "-q", "HEAD"], { acceptedExitCodes: [1], signal }),
    runGit(path, ["for-each-ref", "--count=1", "refs/heads", "refs/remotes", "refs/tags"], { signal }),
  ])
  const hasHead = head.trim() !== ""
  const hasRefs = refs.trim() !== ""
  if (!hasHead && !hasRefs) return { commits: [] as Commit[], truncated: false }
  const revisions = logRevisions(settings).filter(revision => hasHead || revision !== "HEAD")
  const output = await runGit(path, [
    "log",
    ...revisions,
    settings.order === "date" ? "--date-order" : "--topo-order",
    `--max-count=${maxCommits + 1}`,
    `--format=%H${UNIT}%P${UNIT}%an${UNIT}%ae${UNIT}%at${UNIT}%s${RECORD}`,
    "--",
  ], { signal })
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
    files.push({ status, path: parts[++index], previousPath, staged: false, unstaged: false })
  }
  return files
}

/**
 * Recently used promises by key, bounded by entry count and by the total weight of what they resolved to;
 * a failed read is forgotten so the next call tries again. A commit never changes, so its git output is read once
 * while it stays here.
 */
class PromiseCache<T> {
  private entries = new Map<string, { promise: Promise<T>; weight: number }>()
  private weight = 0

  /**
   * @param maxEntries entries kept at most
   * @param maxWeight total weight kept at most; the newest entry always stays
   * @param weigh the weight of a resolved value, e.g. its text length
   */
  constructor(private readonly maxEntries: number, private readonly maxWeight: number, private readonly weigh: (value: T) => number) {}

  /**
   * @param key what identifies the value
   * @param load starts reading the value when it is not cached
   * @returns the cached or new promise
   */
  remember(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.promise
    }
    const entry = { promise: load(), weight: 0 }
    this.entries.set(key, entry)
    entry.promise.then(value => {
      if (this.entries.get(key) !== entry) return
      entry.weight = this.weigh(value)
      this.weight += entry.weight
      this.trim()
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    this.trim()
    return entry.promise
  }

  private trim() {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 1 || (this.entries.size <= this.maxEntries && this.weight <= this.maxWeight)) return
      this.entries.delete(key)
      this.weight -= entry.weight
    }
  }
}

/** Commit details and diffs kept, sized by `limits` (entries and characters); created on first use. */
let caches: { details: PromiseCache<CommitDetails>; diffs: PromiseCache<string> } | null = null

const commitCaches = () => {
  if (!caches) {
    const { limits } = loadConfig()
    caches = {
      details: new PromiseCache<CommitDetails>(limits.detailsCacheEntries, limits.detailsCacheCharacters, details => details.message.length + details.files.reduce((total, file) => total + file.path.length + (file.previousPath?.length ?? 0), 0)),
      diffs: new PromiseCache<string>(limits.diffCacheEntries, limits.diffCacheCharacters, text => text.length),
    }
  }
  return caches
}

/**
 * Reads a commit's metadata and changed files (against its first parent), or the working tree's changes.
 * @param path repository root
 * @param hash commit hash, or `WORKING_TREE` for uncommitted changes
 * @param signal aborting stops the working tree's `git status` and rejects with an `AbortError`; commit details are cached and always finish
 * @returns details; for the working tree the author fields are empty and the file list comes from `git status`;
 *   a commit's details are read once and cached
 */
export const readDetails = async (path: string, hash: string, signal?: AbortSignal): Promise<CommitDetails> => {
  if (hash === WORKING_TREE) {
    const { files } = parseStatus(await runGit(path, ["status", "--porcelain=v2", "-z", "-uall"], { signal }))
    return { hash, parents: [], author: "", email: "", authorTime: 0, committer: "", message: "Uncommitted changes", files }
  }
  return commitCaches().details.remember(`${path}\0${hash}`, () => readCommitDetails(path, hash))
}

const readCommitDetails = async (path: string, hash: string): Promise<CommitDetails> => {
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
 * @param maxKilobytes longer diffs are cut there with a closing note; git is stopped there, so a huge diff is never held whole
 * @param signal aborting stops a working-tree diff and rejects with an `AbortError`; commit diffs are cached and always finish
 * @returns unified diff text
 */
export const readDiff = async (path: string, hash: string, file: ChangedFile, maxKilobytes: number, signal?: AbortSignal) => {
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
  const maxBytes = maxKilobytes * 1024
  const note = (result: { stdout: string; cut: boolean }) => result.cut ? `${result.stdout}\n\\ diff cut at ${maxKilobytes} KB` : result.stdout
  if (hash === WORKING_TREE) {
    if (file.status === "?") return note(await runGitOutput(path, ["diff", "--no-index", "--", "/dev/null", file.path], { acceptedExitCodes: [1], signal, maxBytes }))
    if (file.status === "U") return note(await runGitOutput(path, ["diff", "--", file.path], { signal, maxBytes }))
    const hasHead = (await runGit(path, ["rev-parse", "--verify", "-q", "HEAD"], { acceptedExitCodes: [1], signal })).trim() !== ""
    return note(await runGitOutput(path, hasHead ? ["diff", "-M", "HEAD", "--", ...paths] : ["diff", "--cached", "--", ...paths], { signal, maxBytes }))
  }
  return commitCaches().diffs.remember(`${path}\0${hash}\0${maxKilobytes}\0${paths.join("\0")}`, async () => {
    const parent = (await readDetails(path, hash)).parents[0]
    return note(await runGitOutput(path, parent ? ["diff", "-M", parent, hash, "--", ...paths] : ["show", "--format=", "-M", hash, "--", ...paths], { maxBytes }))
  })
}

/** Reads at most `maxBytes` of a file from disk without loading the rest; rejects as `open` does (ENOENT, EISDIR…). */
const readFileStart = async (file: string, maxBytes: number) => {
  const handle = await open(file, "r")
  try {
    const size = (await handle.stat()).size
    const buffer = Buffer.alloc(Math.min(maxBytes, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const cut = size > maxBytes
    return { stdout: decodeText(buffer.subarray(0, bytesRead), cut), cut }
  } finally {
    await handle.close()
  }
}

/**
 * Reads a whole file as it is in the working tree or in a commit.
 * @param path repository root
 * @param hash commit hash, or `WORKING_TREE` for the file on disk
 * @param file the file; a file deleted in the commit is read from its parent, and one deleted from the disk from HEAD
 * @param maxKilobytes longer files are cut there; only that much is ever read
 * @returns the text and whether it was cut; rejects with the read error for anything but a file missing from the disk
 */
export const readWholeFile = async (path: string, hash: string, file: ChangedFile, maxKilobytes: number): Promise<{ text: string; cut: boolean }> => {
  const maxBytes = maxKilobytes * 1024
  const result = hash === WORKING_TREE
    ? await readFileStart(join(path, file.path), maxBytes).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return runGitOutput(path, ["show", `HEAD:${file.previousPath ?? file.path}`], { maxBytes })
    })
    : await runGitOutput(path, ["show", `${file.status === "D" ? `${hash}~` : hash}:${file.path}`], { maxBytes })
  return { text: result.stdout, cut: result.cut }
}
