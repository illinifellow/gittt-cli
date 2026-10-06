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
})
