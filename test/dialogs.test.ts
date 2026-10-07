/**
 * Dialogs against a real repository with a remote: the values each dialog
 * starts with and the git commands its answers become. Catches an option that
 * silently does nothing, commands aimed at the wrong branch or remote, validation
 * that lets empty names or option-like names through, a branch list that does
 * not follow its remote, a deferred merge that fast-forwards, and force pushes
 * that the background fetch makes unsafe.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildDialog, dialogCommands, initialValues, isValidRefName, settleValues, validateDialog, type DialogKind, type DialogTarget, type DialogValues } from "@/dialogs"
import { readDetails, readOperation, readRepositoryState, runGit } from "@/git"
import { WORKING_TREE, type Repository } from "@/protocol"
import { dialogKey, openDialogState } from "@/ui/dialog"
import type { Key } from "ink"

let root: string
let repository: string
let remote: string
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } })

const submit = async (kind: DialogKind, target: DialogTarget, change: DialogValues) => {
  const summary = (await readRepositoryState(repository)).repository
  const spec = buildDialog(kind, summary, target)
  const values = { ...initialValues(spec), ...change }
  const problem = validateDialog(spec, values, summary)
  if (problem) return problem
  for (const command of dialogCommands(spec, values, summary, target)) await runGit(repository, command)
  return null
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-"))
  remote = join(root, "remote.git")
  repository = join(root, "work")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote])
  execFileSync("mkdir", ["-p", repository])
  git(repository, "init", "-q", "-b", "main")
  writeFileSync(join(repository, "a.txt"), "one\n")
  git(repository, "add", ".")
  git(repository, "commit", "-q", "-m", "first")
  git(repository, "remote", "add", "origin", remote)
  git(repository, "push", "-q", "-u", "origin", "main")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("dialogs", () => {
  /** New Branch refuses an empty name and checks the new branch out. */
  it("creates and checks out a branch", async () => {
    expect(await submit("branch", {}, { name: "" })).toBe("New branch is required")
    expect(await submit("branch", {}, { name: "feature/x" })).toBeNull()
    expect(git(repository, "branch", "--show-current").trim()).toBe("feature/x")
  })

  /** Push sends the checked branch and tracks it when it had no upstream. */
  it("pushes a new branch with tracking", async () => {
    writeFileSync(join(repository, "b.txt"), "two\n")
    git(repository, "add", ".")
    git(repository, "commit", "-q", "-m", "second")
    expect(await submit("push", {}, {})).toBeNull()
    expect(git(repository, "rev-parse", "--abbrev-ref", "feature/x@{upstream}").trim()).toBe("origin/feature/x")
  })

  /** Add Tag tags the specified commit and pushes the tag when asked. */
  it("tags a specified commit and pushes the tag", async () => {
    const first = git(repository, "rev-parse", "main").trim()
    expect(await submit("tag", { hash: first }, { name: "v1", push: true, message: "release" })).toBeNull()
    expect(git(repository, "rev-parse", "v1^{commit}").trim()).toBe(first)
    expect(git(remote, "tag").trim()).toBe("v1")
  })

  /** Merge with "create a new commit even if fast-forward" leaves two parents. */
  it("merges without fast-forward", async () => {
    git(repository, "switch", "-q", "main")
    expect(await submit("merge", { ref: "feature/x" }, { noFastForward: true })).toBeNull()
    expect(git(repository, "show", "-s", "--format=%P", "HEAD").trim().split(" ")).toHaveLength(2)
  })

  /** Stash with a message, then Apply with "delete after applying". */
  it("stashes and applies with delete", async () => {
    writeFileSync(join(repository, "a.txt"), "changed\n")
    expect(await submit("stash", {}, { message: "keep" })).toBeNull()
    expect(git(repository, "stash", "list")).toContain("keep")
    expect(await submit("stashApply", { stash: "stash@{0}" }, { drop: true })).toBeNull()
    expect(git(repository, "stash", "list").trim()).toBe("")
    git(repository, "checkout", "--", "a.txt")
  })

  /** Reset in soft mode moves the branch and keeps the changes staged. */
  it("resets softly", async () => {
    const parent = git(repository, "rev-parse", "HEAD~1").trim()
    expect(await submit("reset", { hash: parent }, { mode: "soft" })).toBeNull()
    expect(git(repository, "rev-parse", "HEAD").trim()).toBe(parent)
    expect(git(repository, "diff", "--cached", "--name-only").trim()).not.toBe("")
    git(repository, "reset", "-q", "--hard", "ORIG_HEAD")
  })

  /** Checking out a remote branch creates a tracking branch under the chosen name. */
  it("checks out a remote branch as a tracking branch", async () => {
    git(repository, "branch", "-q", "-D", "feature/x")
    expect(await submit("checkoutRemote", { ref: "origin/feature/x", section: "remote" }, { name: "x-local" })).toBeNull()
    expect(git(repository, "rev-parse", "--abbrev-ref", "x-local@{upstream}").trim()).toBe("origin/feature/x")
  })

  /** Delete Branch with the remote option removes it on the remote too. */
  it("deletes a branch locally and on the remote", async () => {
    git(repository, "switch", "-q", "main")
    expect(await submit("deleteBranch", { ref: "x-local", section: "branch" }, { force: true, remote: true })).toBeNull()
    expect(git(repository, "branch", "--list", "x-local").trim()).toBe("")
    expect(git(remote, "branch", "--list", "feature/x").trim()).toBe("")
  })

  /** Status reads which files are staged, and the commit dialog refuses an empty message or an empty selection. */
  it("refuses a commit without a message or staged files", async () => {
    writeFileSync(join(repository, "c.txt"), "three\n")
    writeFileSync(join(repository, "d.txt"), "four\n")
    const files = (await readDetails(repository, WORKING_TREE)).files
    expect(files.map(file => [file.path, file.staged, file.unstaged])).toEqual([["c.txt", false, true], ["d.txt", false, true]])
    expect(await submit("commit", {}, { message: "" })).toBe("Write a commit message")
    expect(await submit("commit", {}, { message: "add c" })).toBe("Stage at least one file: tick its checkbox in the file list")
  })

  /** Committing takes only the staged file, and nothing reaches the remote unless asked. */
  it("commits staged files only and pushes only when asked", async () => {
    git(repository, "add", "c.txt")
    const remoteBefore = git(remote, "rev-parse", "main").trim()
    expect(await submit("commit", {}, { message: "add c" })).toBeNull()
    expect(git(repository, "show", "--name-only", "--format=", "HEAD").trim()).toBe("c.txt")
    expect(git(repository, "status", "--porcelain").trim()).toBe("?? d.txt")
    expect(git(remote, "rev-parse", "main").trim()).toBe(remoteBefore)
    git(repository, "add", "d.txt")
    expect(await submit("commit", {}, { message: "add d", push: true })).toBeNull()
    expect(git(remote, "rev-parse", "main").trim()).toBe(git(repository, "rev-parse", "HEAD").trim())
  })

  /** A merge stopped on a conflict is reported with its target and the conflicted file. */
  it("reports a stopped merge with conflicts", async () => {
    git(repository, "switch", "-q", "-c", "left")
    writeFileSync(join(repository, "a.txt"), "left\n")
    git(repository, "commit", "-q", "-am", "left")
    git(repository, "switch", "-q", "-c", "right", "main")
    writeFileSync(join(repository, "a.txt"), "right\n")
    git(repository, "commit", "-q", "-am", "right")
    expect(() => git(repository, "merge", "left")).toThrow()
    const summary = (await readRepositoryState(repository)).repository
    expect(summary.operation?.kind).toBe("merge")
    expect(summary.conflicts).toBe(1)
    git(repository, "merge", "--abort")
    expect(() => git(repository, "rebase", "left")).toThrow()
    expect(await readOperation(git(repository, "rev-parse", "--absolute-git-dir").trim())).toMatchObject({ kind: "rebase", branch: "right", step: 1, total: 1 })
    git(repository, "rebase", "--abort")
  })
})

/** A summary of a repository with two remotes, one of them named with a slash, for command-building checks. */
const SUMMARY: Repository = {
  path: "/work/app",
  name: "app",
  head: { branch: "main", hash: "a1" },
  changes: 0,
  staged: 0,
  conflicts: 0,
  operation: null,
  branches: [{ name: "main", hash: "a1", upstream: "team/fork/main", current: true, ahead: 1, behind: 0, gone: false }],
  remotes: [
    { name: "origin", branches: [{ remote: "origin", name: "release", hash: "b2" }] },
    { name: "team/fork", branches: [{ remote: "team/fork", name: "main", hash: "a1" }, { remote: "team/fork", name: "topic", hash: "c3" }] },
  ],
  tags: [],
  stashes: [],
  error: null,
}

/** Builds a dialog on SUMMARY, applies key-free value changes the way the dialog does, and returns the spec and values. */
const answer = (kind: DialogKind, target: DialogTarget, change: DialogValues) => {
  const spec = buildDialog(kind, SUMMARY, target)
  return { spec, values: settleValues(spec, { ...initialValues(spec), ...change }) }
}

describe("dialog safety", () => {
  /** A branch named `-D` from commit `main` used to become `git branch -D main` and delete main. */
  it("refuses names git would read as options or reject", () => {
    for (const name of ["-D", "a b", "x..y", "x.lock", ".hidden", "x:y", "x~1", "a//b", "end/", "@"]) {
      const { spec, values } = answer("branch", { hash: "a1" }, { name, checkout: false })
      expect(validateDialog(spec, values, SUMMARY), name).toMatch(/New branch is no valid name/)
    }
    const tag = answer("tag", {}, { name: "-f" })
    expect(validateDialog(tag.spec, tag.values, SUMMARY)).toMatch(/Tag Name is no valid name/)
    const start = answer("branch", {}, { name: "ok", start: "specified", commit: "--orphan" })
    expect(validateDialog(start.spec, start.values, SUMMARY)).toBe("Specified commit cannot start with -")
    expect(isValidRefName("feature/topic-1")).toBe(true)
  })

  /** Changing Pull's remote used to keep the first remote's branch, pulling a branch the chosen remote does not have. */
  it("follows the chosen remote in Pull's branch list", () => {
    const initial = answer("pull", {}, {})
    expect(initial.values).toMatchObject({ remote: "team/fork", branch: "main" })
    const switched = answer("pull", {}, { remote: "origin" })
    expect(switched.values.branch).toBe("release")
    expect(dialogCommands(switched.spec, switched.values, SUMMARY, {})).toEqual([["pull", "--no-rebase", "--no-edit", "origin", "release"]])
    expect(validateDialog(switched.spec, { ...switched.values, branch: "main" }, SUMMARY)).toBe("Remote branch to pull: choose one of the listed values")
  })

  /** Choosing another remote with the keyboard moves the branch to one that remote has. */
  it("updates Pull's branch when the remote is changed by key", () => {
    const state = openDialogState(SUMMARY.path, buildDialog("pull", SUMMARY, {}), {})
    const next = dialogKey(state, "", { rightArrow: true } as Key)
    expect("values" in next && next.values).toMatchObject({ remote: "origin", branch: "release" })
  })

  /** "Commit merged changes immediately" off used to let a fast-forward move the branch at once anyway. */
  it("never fast-forwards a merge that does not commit at once", () => {
    const { spec, values } = answer("merge", { ref: "team/fork/topic" }, { commit: false })
    expect(dialogCommands(spec, values, SUMMARY, { ref: "team/fork/topic" })).toEqual([["merge", "--no-edit", "--no-commit", "--no-ff", "team/fork/topic"]])
  })

  /** gittt's background fetch updates the lease's reference, so a bare lease no longer protects others' pushes. */
  it("forces pushes only with the lease and include check", () => {
    const { spec, values } = answer("push", {}, { force: true })
    expect(dialogCommands(spec, values, SUMMARY, {})).toEqual([["push", "--force-with-lease", "--force-if-includes", "team/fork", "main:main"]])
  })

  /** Remote names may hold a slash: deleting `team/fork/topic` deletes `topic` on `team/fork`. */
  it("splits remote branches at the right remote", () => {
    const { spec, values } = answer("deleteBranches", {}, { branches: ["team/fork/topic"] })
    expect(dialogCommands(spec, values, SUMMARY, {})).toEqual([["push", "team/fork", "--delete", "topic"]])
    expect(initialValues(buildDialog("checkoutRemote", SUMMARY, { ref: "team/fork/topic", section: "remote" })).name).toBe("topic")
  })
})
