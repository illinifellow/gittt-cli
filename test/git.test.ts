/**
 * The git layer against real repositories: status parsing, remotes, file reads
 * and the runner for user actions. Catches a file name read as a pattern (staging
 * `*.txt` stages every text file), renamed files with spaces losing a path,
 * remotes without tracking branches vanishing, remote names with a slash split
 * in the wrong place, a cut file shown as whole or with a broken last character,
 * an unreadable file silently replaced by its committed version, a stash number
 * that moved, and a push or pull that waits on an ssh prompt forever.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { parseStatus, readDetails, readDiff, readRepositoryState, readStashReference, readWholeFile, runActionCommand, runGit, splitRemoteRef } from "@/git"
import { WORKING_TREE, type ChangedFile } from "@/protocol"

const ENVIRONMENT = { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"] })

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-git-"))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Makes a repository holding the given files in its first commit. */
const makeRepository = (name: string, files: Record<string, string>) => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true })
    writeFileSync(join(path, file), text)
  }
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}

const file = (path: string, status = "M"): ChangedFile => ({ status, path, previousPath: null, staged: false, unstaged: true })

describe("literal paths", () => {
  /** A file named `*.txt` is one file: staging or diffing it must not touch every other text file. */
  it("stages and diffs a file named like a pattern as that file alone", async () => {
    const path = makeRepository("patterns", { "*.txt": "star\n", "a.txt": "a\n", ":(top)b.txt": "magic\n" })
    for (const name of ["*.txt", "a.txt", ":(top)b.txt"]) writeFileSync(join(path, name), "changed\n")
    await runGit(path, ["add", "-A", "--", "*.txt"])
    expect(git(path, "diff", "--cached", "--name-only").trim()).toBe("*.txt")
    await runGit(path, ["add", "-A", "--", ":(top)b.txt"])
    expect(git(path, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual(["*.txt", ":(top)b.txt"])
    const text = await readDiff(path, WORKING_TREE, file("*.txt"), 64)
    expect(text).toContain("+changed")
    expect(text).not.toContain("a.txt")
  })

  /** The whole-tree pathspec still means every file once paths are literal. */
  it("stages and unstages everything through the whole-tree path", async () => {
    const path = makeRepository("everything", { "one.txt": "1\n", "deep/two.txt": "2\n" })
    writeFileSync(join(path, "one.txt"), "changed\n")
    writeFileSync(join(path, "deep", "two.txt"), "changed\n")
    await runGit(path, ["add", "-A", "--", "."])
    expect(git(path, "diff", "--cached", "--name-only").trim().split("\n")).toEqual(["deep/two.txt", "one.txt"])
    await runGit(path, ["restore", "--staged", "--", "."])
    expect(git(path, "diff", "--cached", "--name-only").trim()).toBe("")
  })
})

describe("status", () => {
  /** A rename keeps both paths, spaces included; untracked files and staged sides are told apart. */
  it("parses renames, untracked files and both sides", async () => {
    const path = makeRepository("renames", { "old name.txt": "same\n", "kept.txt": "1\n" })
    git(path, "mv", "old name.txt", "new name.txt")
    writeFileSync(join(path, "kept.txt"), "2\n")
    writeFileSync(join(path, "fresh file.txt"), "new\n")
    const { files } = await readDetails(path, WORKING_TREE)
    expect(files).toEqual(expect.arrayContaining([
      { status: "R", path: "new name.txt", previousPath: "old name.txt", staged: true, unstaged: false },
      { status: "M", path: "kept.txt", previousPath: null, staged: false, unstaged: true },
      { status: "?", path: "fresh file.txt", previousPath: null, staged: false, unstaged: true },
    ]))
    const renamed = files.find(candidate => candidate.status === "R") as ChangedFile
    expect(await readDiff(path, WORKING_TREE, renamed, 64)).toMatch(/rename from old name\.txt[\s\S]*rename to new name\.txt/)
    const untracked = files.find(candidate => candidate.status === "?") as ChangedFile
    expect(await readDiff(path, WORKING_TREE, untracked, 64)).toContain("+new")
  })

  /** The summary counts what the file list shows: changes, staged entries, conflicts. */
  it("counts changes, staged files and conflicts from one parse", () => {
    const output = ["# branch.oid abc", "# branch.head main", "1 M. N... 100644 100644 100644 a b staged.txt", "1 .M N... 100644 100644 100644 a b loose.txt", "u UU N... 100644 100644 100644 100644 a b c both.txt", "? new.txt", "! build/", ""].join("\0")
    const status = parseStatus(output)
    expect(status.branch).toBe("main")
    expect(status.files.map(entry => [entry.path, entry.status, entry.staged, entry.unstaged])).toEqual([["staged.txt", "M", true, false], ["loose.txt", "M", false, true], ["both.txt", "U", false, true], ["new.txt", "?", false, true]])
    expect(status.ignored).toEqual(["build/"])
  })
})

describe("remotes", () => {
  /** A remote just added (nothing fetched yet) has no tracking refs; it must still be listed so it can be fetched. */
  it("lists remotes that have no tracking branches", async () => {
    const path = makeRepository("new-remote", { "a.txt": "a\n" })
    git(path, "remote", "add", "upstream", join(root, "nowhere.git"))
    const { repository } = await readRepositoryState(path)
    expect(repository.remotes).toEqual([{ name: "upstream", branches: [] }])
  })

  /** Remote names may hold a slash; `team/fork/main` belongs to remote `team/fork`, not `team`. */
  it("splits a tracking name at the longest remote", async () => {
    expect(splitRemoteRef("team/fork/feature/x", ["team", "team/fork"])).toEqual({ remote: "team/fork", branch: "feature/x" })
    expect(splitRemoteRef("origin/main", ["team"])).toBeNull()
    const remote = join(root, "slash-remote.git")
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote])
    const path = makeRepository("slash-local", { "a.txt": "a\n" })
    git(path, "remote", "add", "team/fork", remote)
    git(path, "push", "-q", "team/fork", "main")
    git(path, "fetch", "-q", "team/fork")
    const { repository } = await readRepositoryState(path)
    expect(repository.remotes).toEqual([{ name: "team/fork", branches: [{ remote: "team/fork", name: "main", hash: expect.any(String) }] }])
  })
})

describe("whole files", () => {
  /** A file longer than the limit is cut there, says so, and never ends in half a character. */
  it("marks a cut file and drops a character split at the cut", async () => {
    const path = makeRepository("long", { "short.txt": "x\n" })
    writeFileSync(join(path, "long.txt"), "é".repeat(1024))
    const read = await readWholeFile(path, WORKING_TREE, file("long.txt", "?"), 1)
    expect(read.cut).toBe(true)
    expect(read.text).toBe("é".repeat(512))
    expect(await readWholeFile(path, WORKING_TREE, file("short.txt"), 1)).toEqual({ text: "x\n", cut: false })
  })

  /** A file deleted from the disk shows its last committed version; one that cannot be read reports why instead. */
  it("falls back to HEAD only for a file missing from the disk", async () => {
    const path = makeRepository("unreadable", { "gone.txt": "committed\n", "locked.txt": "secret\n" })
    rmSync(join(path, "gone.txt"))
    expect((await readWholeFile(path, WORKING_TREE, file("gone.txt", "D"), 64)).text).toBe("committed\n")
    writeFileSync(join(path, "locked.txt"), "changed\n")
    chmodSync(join(path, "locked.txt"), 0o000)
    try {
      await expect(readWholeFile(path, WORKING_TREE, file("locked.txt"), 64)).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      chmodSync(join(path, "locked.txt"), 0o644)
    }
  })
})

describe("stashes", () => {
  /** A stash made after the list was read shifts the numbers; the stash is found again by its commit. */
  it("finds a stash's current reference by its hash", async () => {
    const path = makeRepository("stashes", { "a.txt": "a\n" })
    writeFileSync(join(path, "a.txt"), "first\n")
    git(path, "stash", "push", "-q", "-m", "first")
    const hash = git(path, "rev-parse", "stash@{0}").trim()
    writeFileSync(join(path, "a.txt"), "second\n")
    git(path, "stash", "push", "-q", "-m", "second")
    expect(await readStashReference(path, hash)).toBe("stash@{1}")
    git(path, "stash", "drop", "-q", "stash@{1}")
    await expect(readStashReference(path, hash)).rejects.toThrow(/no longer exists/)
  })
})

describe("network actions", () => {
  const saved = { command: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH }

  afterEach(() => {
    if (saved.command === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = saved.command
    if (saved.ssh === undefined) delete process.env.GIT_SSH
    else process.env.GIT_SSH = saved.ssh
  })

  /** Writes a fake ssh that records its arguments, then sleeps or fails. */
  const fakeSsh = (name: string, body: string) => {
    const script = join(root, name)
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${script}.log"\n${body}\n`)
    chmodSync(script, 0o755)
    return script
  }

  /**
   * A push from a dialog used to run ssh without batch mode: a passphrase or host-key question opened the terminal
   * and fought the screen for input. The user's `GIT_SSH_COMMAND` wins over `core.sshCommand`, as in git.
   */
  it("runs ssh in batch mode with the user's own ssh command", async () => {
    const path = makeRepository("batch", { "a.txt": "a\n" })
    const configured = fakeSsh("configured-ssh", "exit 1")
    const chosen = fakeSsh("chosen-ssh", "exit 1")
    git(path, "config", "core.sshCommand", configured)
    git(path, "remote", "add", "origin", "ssh://example.invalid/repository.git")
    process.env.GIT_SSH_COMMAND = chosen
    delete process.env.GIT_SSH
    await expect(runActionCommand(path, ["push", "origin", "main"], 10000)).rejects.toThrow(/push/)
    expect(readFileSync(`${chosen}.log`, "utf8")).toContain("-o BatchMode=yes")
    expect(() => readFileSync(`${configured}.log`, "utf8")).toThrow()
  })

  /** A remote that never answers used to keep the action busy forever; it is stopped at the configured time. */
  it("stops a remote that does not answer in time", async () => {
    const path = makeRepository("silent", { "a.txt": "a\n" })
    process.env.GIT_SSH_COMMAND = fakeSsh("silent-ssh", "sleep 30")
    git(path, "remote", "add", "origin", "ssh://example.invalid/repository.git")
    const started = Date.now()
    await expect(runActionCommand(path, ["fetch", "origin"], 500)).rejects.toThrow(/gave no answer in time/)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
