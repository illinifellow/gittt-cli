/**
 * The user settings file: what loading accepts and what saving writes. Catches
 * a hand-edited file with a comment or a typo being silently replaced by the
 * defaults on the next save, comments lost on save, a half-written file after a
 * crash, an invalid value (a zero that hangs highlighting, a word for a number)
 * reaching the screen, values equal to the defaults piling up in the file, and a
 * reset that forgets the remembered folders.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const folder = vi.hoisted(() => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/gittt-config-test-${process.pid}`
  process.env.XDG_CONFIG_HOME = path
  return path
})

const { ConfigError, configProblems, loadConfig, loadDefaults, resetConfig, saveConfig, saveState } = await import("@/config")

const file = join(folder, "gittt-cli", "settings.json")
const write = (text: string) => {
  mkdirSync(join(folder, "gittt-cli"), { recursive: true })
  writeFileSync(file, text)
}

beforeEach(() => rmSync(folder, { recursive: true, force: true }))

describe("loading", () => {
  /** The README invites hand editing; comments and trailing commas are part of that and must not cost the settings. */
  it("reads comments and trailing commas", () => {
    write(`// my tweaks\n{\n  "settings": { "maxCommits": 50, }, // fewer commits\n}\n`)
    expect(loadConfig().settings.maxCommits).toBe(50)
    expect(configProblems()).toEqual([])
  })

  /** A file gittt cannot parse is reported with its line and column, and gittt runs on the defaults. */
  it("reports a file it cannot parse and runs on the defaults", () => {
    write(`{\n  "settings": { "maxCommits": 50,, }\n}\n`)
    expect(loadConfig().settings.maxCommits).toBe(loadDefaults().settings.maxCommits)
    expect(configProblems()[0]).toMatch(/settings\.json:2:\d+: .*saves nothing until it is fixed/)
  })

  /** A value of the wrong type or range is replaced by its default and named, so it never reaches the screen. */
  it("replaces unusable values with their defaults and names them", () => {
    write(JSON.stringify({ limits: { highlightChunkLines: 0, tabWidth: "wide" }, settings: { order: "random", theme: "missing" }, columns: { graph: 0 } }))
    const config = loadConfig()
    const defaults = loadDefaults()
    expect(config.limits.highlightChunkLines).toBe(defaults.limits.highlightChunkLines)
    expect(config.limits.tabWidth).toBe(defaults.limits.tabWidth)
    expect(config.settings.order).toBe(defaults.settings.order)
    expect(config.settings.theme).toBe(defaults.settings.theme)
    expect(config.columns.graph).toBeNull()
    expect(configProblems()).toEqual([
      expect.stringMatching(/^settings\.theme names no theme/),
      expect.stringMatching(/^settings\.order must be one of ancestor, date/),
      expect.stringMatching(/^limits\.tabWidth must be a whole number of at least 1/),
      expect.stringMatching(/^limits\.highlightChunkLines must be a whole number of at least 1/),
      expect.stringMatching(/^columns\.graph must be null or a whole number of at least 1/),
    ])
  })

  /** A theme the user added counts as a valid choice. */
  it("accepts a theme of the user's own", () => {
    write(JSON.stringify({ themes: { mine: { colors: { accent: "#123456" } } }, settings: { theme: "mine" } }))
    expect(loadConfig().settings.theme).toBe("mine")
    expect(configProblems()).toEqual([])
  })
})

describe("saving", () => {
  /** A broken file used to be overwritten by the next toggle with defaults plus that toggle: every setting lost. */
  it("refuses to write over a file it cannot parse", () => {
    const broken = `{ "settings": { "maxCommits": 50 // no closing brace\n`
    write(broken)
    expect(() => saveState({ recent: ["/somewhere"], catalogs: {} })).toThrow(ConfigError)
    expect(readFileSync(file, "utf8")).toBe(broken)
  })

  /** Saving touches only what changed: comments stay, defaults never enter the file, a value put back to its default leaves it. */
  it("keeps comments and writes only differences", () => {
    write(`// my tweaks\n{\n  // shorter log\n  "settings": { "maxCommits": 50 }\n}\n`)
    const config = loadConfig()
    config.settings.compact = true
    saveConfig(config)
    const saved = readFileSync(file, "utf8")
    expect(saved).toContain("// my tweaks")
    expect(saved).toContain("// shorter log")
    expect(saved).toContain(`"compact": true`)
    expect(saved).not.toContain("dateFormat")
    config.settings.maxCommits = loadDefaults().settings.maxCommits
    saveConfig(config)
    expect(readFileSync(file, "utf8")).not.toContain("maxCommits")
    expect(loadConfig().settings.compact).toBe(true)
  })

  /** The file is replaced in one rename: no temporary file is left behind and the result always parses. */
  it("replaces the file in one step", () => {
    const config = loadConfig()
    for (let index = 1; index <= 20; index++) {
      config.settings.maxCommits = index
      saveConfig(config)
      expect(loadConfig().settings.maxCommits).toBe(index)
    }
    expect(readdirSync(join(folder, "gittt-cli"))).toEqual(["settings.json"])
  })

  /** Reset puts every setting back and keeps the remembered folders. */
  it("resets settings but keeps the state", () => {
    write(JSON.stringify({ settings: { maxCommits: 50 }, state: { recent: ["/work"], catalogs: {} } }))
    const config = resetConfig()
    expect(config.settings.maxCommits).toBe(loadDefaults().settings.maxCommits)
    expect(config.state.recent).toEqual(["/work"])
    expect(existsSync(file)).toBe(true)
  })
})
