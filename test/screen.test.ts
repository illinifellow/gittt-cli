/**
 * The main screen against real repositories, driven by keys. Catches staging run
 * in one repository with the file list of another (the list shown before the new
 * one arrived), a second edit of a modified file never reaching the diff, a
 * whole-file view that pops up after the selection moved on, and Esc closing the
 * viewer only from the diff pane.
 */
import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "ink"
import { createElement } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const gates = vi.hoisted(() => {
  process.env.XDG_CONFIG_HOME = `${process.env.TMPDIR ?? "/tmp"}/gittt-screen-test-${process.pid}`
  return { detailsOf: null as string | null, wholeFile: false, release: [] as (() => void)[] }
})

vi.mock("@/update", async importOriginal => ({ ...await importOriginal<typeof import("@/update")>(), availableUpdate: async () => null }))

vi.mock("@/git", async importOriginal => {
  const actual = await importOriginal<typeof import("@/git")>()
  /** Holds a read until the test lets it go. */
  const held = () => new Promise<void>(resolve => gates.release.push(resolve))
  return {
    ...actual,
    readDetails: async (...args: Parameters<typeof actual.readDetails>) => {
      if (gates.detailsOf === args[0]) await held()
      return actual.readDetails(...args)
    },
    readWholeFile: async (...args: Parameters<typeof actual.readWholeFile>) => {
      if (gates.wholeFile) await held()
      return actual.readWholeFile(...args)
    },
  }
})

const { RepositoryStore } = await import("@/store")
const { App } = await import("@/ui")

const ENVIRONMENT = { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"] })
const KEYS = { down: "\x1b[B", tab: "\t", enter: "\r", escape: "\x1b", space: " " }

/** A terminal for ink: a fixed size, every frame kept. */
class Screen extends EventEmitter {
  columns = 160
  rows = 48
  frame = ""
  write = (frame: string) => void (this.frame = frame)
}

/** Keyboard input for ink. */
class Keyboard extends EventEmitter {
  isTTY = true
  private pending: string | null = null
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const data = this.pending
    this.pending = null
    return data
  }
  press = (data: string) => {
    this.pending = data
    this.emit("readable")
  }
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-screen-"))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

afterEach(() => {
  gates.detailsOf = null
  gates.wholeFile = false
  gates.release.splice(0).forEach(release => release())
  vi.restoreAllMocks()
})

/** Makes a repository with one commit of the given files. */
const makeRepository = (path: string, files: Record<string, string>) => {
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text)
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
}

/** Opens the main screen on a folder; returns the screen, a key presser and a closer. */
const open = (folder: string) => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const screen = new Screen()
  const keyboard = new Keyboard()
  const store = new RepositoryStore(folder)
  const instance = render(createElement(App, { store, onRestart: () => {} }), { stdout: screen as unknown as NodeJS.WriteStream, stdin: keyboard as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false })
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      keyboard.press(key)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  return { screen, press, close: () => instance.unmount() }
}

describe("main screen", () => {
  /**
   * Switching repositories kept the previous repository's file list on screen until the new one arrived; a Space
   * then staged those paths in the new repository.
   */
  it("never stages with another repository's file list", async () => {
    const folder = join(root, "two")
    makeRepository(join(folder, "alpha"), { "shared.txt": "a\n" })
    makeRepository(join(folder, "bravo"), { "shared.txt": "b\n", "z.txt": "z\n" })
    writeFileSync(join(folder, "alpha", "shared.txt"), "alpha edit\n")
    writeFileSync(join(folder, "bravo", "shared.txt"), "bravo edit\n")
    writeFileSync(join(folder, "bravo", "z.txt"), "bravo edit\n")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("Pending files"), { timeout: 8000, interval: 50 })
    gates.detailsOf = join(folder, "bravo")
    await press(KEYS.tab, KEYS.tab, KEYS.tab, ...Array(7).fill(KEYS.down), KEYS.tab, KEYS.tab)
    await vi.waitFor(() => expect(screen.frame).toMatch(/Nothing to commit|No files changed/), { timeout: 3000, interval: 50 })
    await press(KEYS.space)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(git(join(folder, "bravo"), "diff", "--cached", "--name-only").trim()).toBe("")
    gates.release.splice(0).forEach(release => release())
    await vi.waitFor(() => expect(screen.frame).toContain("z.txt"), { timeout: 3000, interval: 50 })
    close()
  })

  /** A second edit of an already modified file changes no count; the diff on screen must still follow it. */
  it("shows a second edit of a modified file", async () => {
    const folder = join(root, "reedit")
    makeRepository(join(folder, "repo"), { "a.txt": "start\n" })
    writeFileSync(join(folder, "repo", "a.txt"), "first edit\n")
    const { screen, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("first edit"), { timeout: 8000, interval: 50 })
    writeFileSync(join(folder, "repo", "a.txt"), "second edit\n")
    await vi.waitFor(() => expect(screen.frame).toContain("second edit"), { timeout: 8000, interval: 100 })
    close()
  })

  /** A whole file still being read when the selection moves on must not appear over the new selection. */
  it("drops a whole-file view the selection moved away from", async () => {
    const folder = join(root, "viewer")
    makeRepository(join(folder, "repo"), { "a.txt": "a\n", "b.txt": "b\n" })
    writeFileSync(join(folder, "repo", "a.txt"), "a edit\n")
    writeFileSync(join(folder, "repo", "b.txt"), "b edit\n")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("Pending files"), { timeout: 8000, interval: 50 })
    gates.wholeFile = true
    await press(KEYS.tab, KEYS.enter, KEYS.down)
    gates.release.splice(0).forEach(release => release())
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(screen.frame).not.toContain("whole file, esc returns")
    close()
  })

  /** Esc closes the whole-file view from any pane, as the keyboard table says. */
  it("closes the viewer with Esc from any pane", async () => {
    const folder = join(root, "escape")
    makeRepository(join(folder, "repo"), { "a.txt": "a\n" })
    writeFileSync(join(folder, "repo", "a.txt"), "a edit\n")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("Pending files"), { timeout: 8000, interval: 50 })
    await press(KEYS.tab, KEYS.enter)
    await vi.waitFor(() => expect(screen.frame).toContain("whole file, esc returns"), { timeout: 3000, interval: 50 })
    await press(KEYS.tab, KEYS.tab, KEYS.escape)
    await vi.waitFor(() => expect(screen.frame).not.toContain("whole file, esc returns"), { timeout: 3000, interval: 50 })
    close()
  })

  /** Moving through the log changes the commit the details pane shows, and the filter keys relabel the bar. */
  it("follows the selected commit and toggles the branch filter", async () => {
    const folder = join(root, "follow")
    makeRepository(join(folder, "repo"), { "a.txt": "a\n" })
    writeFileSync(join(folder, "repo", "a.txt"), "b\n")
    git(join(folder, "repo"), "commit", "-qam", "second change")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("second change"), { timeout: 8000, interval: 50 })
    const shown = () => /Commit: ([0-9a-f]{40})/.exec(screen.frame)?.[1]
    await vi.waitFor(() => expect(shown()).toBeTruthy(), { timeout: 3000, interval: 50 })
    const first = shown()
    await press(KEYS.down)
    await vi.waitFor(() => expect(shown()).not.toBe(first), { timeout: 3000, interval: 50 })
    expect(screen.frame).toContain("All Branches")
    await press("1")
    await vi.waitFor(() => expect(screen.frame).toContain("Current Branch"), { timeout: 3000, interval: 50 })
    close()
  })

  /** A toolbar key opens its dialog and Esc closes it without running anything. */
  it("opens the fetch dialog from its key and closes it with Esc", async () => {
    const folder = join(root, "dialog")
    makeRepository(join(folder, "repo"), { "a.txt": "a\n" })
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("first"), { timeout: 8000, interval: 50 })
    await press("f")
    await vi.waitFor(() => expect(screen.frame).toMatch(/Fetch from all remotes|Prune/i), { timeout: 3000, interval: 50 })
    await press(KEYS.escape)
    await vi.waitFor(() => expect(screen.frame).not.toMatch(/Prune/i), { timeout: 3000, interval: 50 })
    close()
  })

  /** Search dims what does not match and counts what does. */
  it("searches the log by subject", async () => {
    const folder = join(root, "search")
    makeRepository(join(folder, "repo"), { "a.txt": "a\n" })
    writeFileSync(join(folder, "repo", "a.txt"), "b\n")
    git(join(folder, "repo"), "commit", "-qam", "polish the orbit planner")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("polish the orbit planner"), { timeout: 8000, interval: 50 })
    await press("/", "o", "r", "b", "i", "t")
    await vi.waitFor(() => expect(screen.frame).toMatch(/orbit[^\n]* 1/), { timeout: 3000, interval: 50 })
    close()
  })

  /** Staging a file with Space and committing it from the dialog writes a commit with exactly that file. */
  it("stages a file and commits it from the commit dialog", async () => {
    const folder = join(root, "commit")
    const repo = join(folder, "repo")
    makeRepository(repo, { "a.txt": "a\n", "b.txt": "b\n" })
    writeFileSync(join(repo, "a.txt"), "a edit\n")
    writeFileSync(join(repo, "b.txt"), "b edit\n")
    const { screen, press, close } = open(folder)
    await vi.waitFor(() => expect(screen.frame).toContain("Pending files"), { timeout: 8000, interval: 50 })
    await press(KEYS.tab, KEYS.space)
    await vi.waitFor(() => expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("a.txt"), { timeout: 3000, interval: 50 })
    await press("c")
    await vi.waitFor(() => expect(screen.frame).toMatch(/Message/i), { timeout: 3000, interval: 50 })
    await press("e", "d", "i", "t", " ", "a", KEYS.enter)
    await vi.waitFor(() => expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("edit a"), { timeout: 5000, interval: 50 })
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt")
    expect(git(repo, "status", "--porcelain").trim()).toBe("M b.txt")
    close()
  })
})
