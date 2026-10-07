/**
 * The smaller parts the screen is built from: diff parsing, commit message
 * highlighting, the file tree, conflict markers, the repository search, syntax
 * highlighting and the clipboard. Catches a conflict diff read with the wrong
 * prefix width, message parts that no longer join back into the message, folder
 * rows repeated or missing, conflict markers committed as resolved, a wide tree
 * searched with unbounded open folders or failures dropped, a highlighting that
 * keeps running after the screen moved on, and a missing clipboard program
 * crashing gittt.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { copyToClipboard } from "@/clipboard"
import { loadDefaults } from "@/config"
import { hasConflictMarkers, parseDiff, prefixWidth } from "@/diff"
import { fileRows } from "@/files"
import { DiffHighlighter } from "@/highlight"
import { splitMessage } from "@/message"
import type { ChangedFile } from "@/protocol"
import { expandPath, findRepositories } from "@/scan"
import { readSyntaxTheme } from "@/syntax"

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-parts-"))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const changed = (path: string, status = "M"): ChangedFile => ({ status, path, previousPath: null, staged: false, unstaged: false })

describe("diff parsing", () => {
  /** A conflicted file's combined diff carries two prefix columns and its marker lines are found. */
  it("reads combined diffs and their markers", () => {
    const parsed = parseDiff(["diff --cc a.txt", "index 1,2..3", "@@@ -1,1 -1,1 +1,5 @@@", "++<<<<<<< ours", " +mine", "++=======", " +theirs", "++>>>>>>> theirs", ""].join("\n"))
    expect(parsed.combined).toBe(true)
    expect(prefixWidth(parsed)).toBe(2)
    expect(parsed.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, newCount: 5 })
    expect(parsed.hunks[0].lines).toHaveLength(5)
  })

  /** A file still holding markers is not resolved; marker-like text inside a line is no marker. */
  it("finds leftover conflict markers", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> topic\n")).toBe(true)
    expect(hasConflictMarkers("a\n=======\n")).toBe(true)
    expect(hasConflictMarkers("title\n===========\n")).toBe(false)
    expect(hasConflictMarkers("x = '<<<<<<< not at the start'\n")).toBe(false)
  })
})

describe("commit messages", () => {
  /** Every part keeps its source text, so joined they give the message back; shortcodes become emoji only when asked. */
  it("splits a message into parts that join back", () => {
    const message = "feat(ui): :sparkles: add `fit` for ABC-12, see https://example.com/x and 1a2b3c4d"
    const parts = splitMessage(message, false)
    expect(parts.map(part => part.text).join("")).toBe(message.replace("`fit`", "fit"))
    expect(parts.map(part => part.kind)).toEqual(expect.arrayContaining(["prefix", "shortcode", "code", "issue", "url", "hash"]))
    expect(splitMessage(":sparkles: x", true)[0]).toEqual({ kind: "emoji", text: "✨", source: ":sparkles:" })
    expect(splitMessage(":warning: x", true)[0].kind).toBe("shortcode")
  })
})

describe("file tree", () => {
  /** Each folder heading appears once, before the first file inside it, at its depth. */
  it("lists folders once, nested", () => {
    const rows = fileRows([changed("src/ui/b.ts"), changed("src/a.ts"), changed("README.md"), changed("src/ui/a.ts")], "tree")
    expect(rows.map(row => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/` : row.name}`)).toEqual(["README.md", "src/", "  a.ts", "  ui/", "    a.ts", "    b.ts"])
  })
})

describe("repository search", () => {
  /** Nested repositories are found, excluded folders skipped, and a wide tree read a few folders at a time. */
  it("finds nested repositories with a bounded number of open folders", async () => {
    const tree = join(root, "tree")
    for (let index = 0; index < 40; index++) mkdirSync(join(tree, `group${index % 4}`, `repo${index}`, ".git"), { recursive: true })
    mkdirSync(join(tree, "group0", "repo0", "nested", ".git"), { recursive: true })
    mkdirSync(join(tree, "node_modules", "dependency", ".git"), { recursive: true })
    const result = await findRepositories([tree], 3, ["node_modules"], 2)
    expect(result.repositories).toHaveLength(41)
    expect(result.repositories).toContain(join(tree, "group0", "repo0", "nested"))
    expect(result.repositories.some(path => path.includes("node_modules"))).toBe(false)
    expect(result.failures).toEqual([])
  })

  /** A typed `~` means the home folder; a relative path starts in the current folder. */
  it("expands typed paths", () => {
    expect(expandPath("~/code")).toBe(join(homedir(), "code"))
    expect(expandPath("~")).toBe(homedir())
    expect(expandPath("code")).toBe(join(process.cwd(), "code"))
  })
})

describe("highlighting", () => {
  const limits = loadDefaults().limits

  /** Moving through files used to leave one full highlighting per file running; an aborted one stops and caches nothing. */
  it("stops when aborted and caches nothing", async () => {
    const highlighter = new DiffHighlighter(readSyntaxTheme("dark-plus"))
    const lines = Array.from({ length: 3000 }, (_, index) => `+const value${index} = ${index}`)
    const text = ["@@ -0,0 +1,3000 @@", ...lines].join("\n")
    const parsed = parseDiff(text)
    const controller = new AbortController()
    let pieces = 0
    const aborted = await highlighter.highlight("a.ts", text, parsed, { ...limits, highlightChunkLines: 100 }, { signal: controller.signal, onProgress: () => {
      pieces++
      controller.abort()
    } })
    expect(aborted).toBeNull()
    expect(pieces).toBe(1)
    const whole = await highlighter.highlight("a.ts", text, parsed, { ...limits, highlightChunkLines: 100 })
    expect(whole?.[0]).toHaveLength(3000)
  })
})

describe("clipboard", () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
    vi.restoreAllMocks()
  })

  /** Without a clipboard program (xclip missing, a minimal install) the copy goes through the terminal instead of crashing gittt. */
  it("falls back to the terminal when no clipboard program is installed", async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
      written.push(String(chunk))
      return true
    })
    Object.assign(process.env, { PATH: join(root, "empty"), DISPLAY: ":0" })
    delete process.env.WAYLAND_DISPLAY
    delete process.env.SSH_TTY
    delete process.env.SSH_CONNECTION
    await expect(copyToClipboard("hi")).resolves.toBe("terminal")
    expect(written).toContain(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`)
  })

  /** A working clipboard program receives the exact text, and the copy says it went through the program. */
  it("hands the text to the clipboard program", async () => {
    const bin = join(root, "bin-ok")
    const received = join(root, "received.txt")
    mkdirSync(bin, { recursive: true })
    for (const name of ["pbcopy", "xclip"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nwhile IFS= read -r line || [ -n "$line" ]; do printf '%s' "$line" >> '${received}'; done\n`)
      chmodSync(join(bin, name), 0o755)
    }
    Object.assign(process.env, { PATH: bin, DISPLAY: ":0" })
    delete process.env.WAYLAND_DISPLAY
    delete process.env.SSH_TTY
    delete process.env.SSH_CONNECTION
    await expect(copyToClipboard("a1b2c3")).resolves.toBe("program")
    expect(readFileSync(received, "utf8")).toBe("a1b2c3")
  })

  /** Over ssh the local clipboard program would copy on the wrong machine, so the terminal carries the text. */
  it("copies through the terminal in an ssh session", async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
      written.push(String(chunk))
      return true
    })
    process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22"
    await expect(copyToClipboard("hash")).resolves.toBe("terminal")
    expect(written).toContain(`\x1b]52;c;${Buffer.from("hash").toString("base64")}\x07`)
  })

  /** A clipboard program that fails is reported as an error, not as "copied". */
  it("reports a clipboard program that fails", async () => {
    const bin = join(root, "bin")
    mkdirSync(bin, { recursive: true })
    for (const name of ["pbcopy", "xclip"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nwhile read -r line; do :; done\necho refused >&2\nexit 3\n")
      chmodSync(join(bin, name), 0o755)
    }
    Object.assign(process.env, { PATH: bin, DISPLAY: ":0" })
    delete process.env.WAYLAND_DISPLAY
    delete process.env.SSH_TTY
    delete process.env.SSH_CONNECTION
    await expect(copyToClipboard("hi")).rejects.toThrow(/failed: refused/)
  })
})
