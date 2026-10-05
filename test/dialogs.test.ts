/**
 * Dialogs against a real repository with a remote: the values each dialog
 * starts with and the git commands its answers become. Catches an option that
 * silently does nothing, commands aimed at the wrong branch or remote, and
 * validation that lets empty names through.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildDialog, dialogCommands, initialValues, validateDialog, type DialogKind, type DialogTarget, type DialogValues } from "@/dialogs"
import { readOperation, readRepository, runGit } from "@/git"

Object.assign(process.env, { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" })

let root: string
let repository: string
let remote: string
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } })

const submit = async (kind: DialogKind, target: DialogTarget, change: DialogValues) => {
  const summary = await readRepository(repository)
  const spec = buildDialog(kind, summary, target)
  const values = { ...initialValues(spec), ...change }
  const problem = validateDialog(spec, values)
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

  /** A merge stopped on a conflict is reported with its target and the conflicted file. */
  it("reports a stopped merge with conflicts", async () => {
    git(repository, "switch", "-q", "-c", "left")
    writeFileSync(join(repository, "a.txt"), "left\n")
    git(repository, "commit", "-q", "-am", "left")
    git(repository, "switch", "-q", "-c", "right", "main")
    writeFileSync(join(repository, "a.txt"), "right\n")
    git(repository, "commit", "-q", "-am", "right")
    expect(() => git(repository, "merge", "left")).toThrow()
    const summary = await readRepository(repository)
    expect(summary.operation?.kind).toBe("merge")
    expect(summary.conflicts).toBe(1)
    git(repository, "merge", "--abort")
    expect(() => git(repository, "rebase", "left")).toThrow()
    expect(await readOperation(git(repository, "rev-parse", "--absolute-git-dir").trim())).toMatchObject({ kind: "rebase", branch: "right", step: 1, total: 1 })
    git(repository, "rebase", "--abort")
  })
})
