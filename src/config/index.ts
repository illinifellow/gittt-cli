/**
 * One settings file in two places, of the same shape. `config/settings.json`,
 * shipped with gittt, holds every default: view settings, limits, column
 * widths, key bindings, the themes, icon sets and an empty `state`.
 * `~/.config/gittt-cli/settings.json` holds only what the user changed and what
 * gittt remembers (`state`: recent folders, each folder's repository list); it
 * may carry comments and trailing commas. The two are merged on load and every
 * value is checked against the type and range of its default; saving edits only
 * the values that changed, keeps the user's comments, and replaces the file in
 * one rename so a crash never leaves it half written. A user file that cannot
 * be parsed is never overwritten: gittt runs on the defaults and says why.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { ViewSettings } from "@/protocol"
import type { PartialGlyphs, ThemeOverrides } from "@/theme"

/** The user's changes to one folder's scanned list. */
export interface Catalog {
  order: string[]
  hidden: string[]
  added: string[]
}

/** Every action a key can trigger. */
export type KeyBindings = Record<
  | "commit" | "pull" | "push" | "fetch" | "branch" | "merge" | "stash" | "tag" | "settings"
  | "rescan" | "refresh" | "add" | "remove" | "moveUp" | "moveDown" | "menu" | "search" | "copyHash" | "fileView" | "quit"
  | "branches" | "remotes" | "order" | "view" | "dates" | "gitmoji"
  | "graphNarrower" | "graphWider" | "authorNarrower" | "authorWider" | "dateNarrower" | "dateWider" | "sidebarNarrower" | "sidebarWider",
  string
>

/** Sizes, timings and caps that shape behaviour rather than looks. */
export interface Limits {
  diffKilobytes: number
  tabWidth: number
  highlightMaxLines: number
  highlightChunkLines: number
  highlightCacheSize: number
  highlightCacheLines: number
  highlightProgressMs: number
  detailsCacheEntries: number
  detailsCacheCharacters: number
  diffCacheEntries: number
  diffCacheCharacters: number
  settleMs: number
  refreshDelayMs: number
  pollSeconds: number
  summaryReads: number
  refreshFetches: number
  fetchTimeoutSeconds: number
  fetchBackoff: number
  scanConcurrency: number
  doubleClickMs: number
  doubleClickCells: number
  inputSplitMs: number
  backgroundQueryMs: number
  statusMs: number
  errorStatusMs: number
  updateCheckHours: number
  recentFolders: number
  watchIgnore: string[]
}

/** The whole configuration, defaults and user changes merged. */
export interface Config {
  settings: ViewSettings & {
    /** `auto` (by the terminal background), `golden-brown`, `milk-and-honey`, or the name of a theme under `themes`. */
    theme: string
    /** `unicode` for the theme's own glyphs, or the name of a set under `iconSets`. */
    icons: string
    fileView: "path" | "status" | "tree"
    maxCommits: number
    scanDepth: number
    scanExclude: string[]
    /** Minutes between two background fetches of one repository's remotes; 0 never fetches in the background. */
    fetchMinutes: number
  }
  limits: Limits
  /** Column widths in terminal cells and the lower panes' height in rows; `null` sizes automatically. */
  columns: { tree: number; graph: number | null; hash: number; author: number; date: number; files: number; details: number | null }
  keys: KeyBindings
  /** Every theme; a theme of the user's own fills what it leaves out from the theme it `extends`. */
  themes: Record<string, ThemeOverrides>
  /** Icon sets that replace the theme's icons when `settings.icons` names them. */
  iconSets: Record<string, PartialGlyphs>
  /** Single values laid over the active theme. */
  tokens: ThemeOverrides
  /** What gittt remembers between runs. */
  state: State
}

/** What gittt remembers between runs. */
export interface State {
  recent: string[]
  catalogs: Record<string, Catalog>
}

/** The `settings.icons` value that keeps the theme's own glyphs. */
export const THEME_ICONS = "unicode"

/** The `settings.theme` value that picks a shipped theme by the terminal's background. */
export const AUTO_THEME = "auto"

const USER_SETTINGS = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gittt-cli", "settings.json")

/** How saved files are indented. */
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }

/** Allowed values of the settings that take one of a few words. */
const CHOICES: Record<string, readonly string[]> = {
  "settings.branches": ["all", "current"],
  "settings.order": ["ancestor", "date"],
  "settings.dateFormat": ["absolute", "relative"],
  "settings.fileView": ["path", "status", "tree"],
}

/** Numbers that may be 0; every other number in `settings`, `limits` and `columns` is a whole number of at least 1. */
const ZERO_ALLOWED = new Set(["settings.fetchMinutes", "limits.refreshDelayMs", "limits.inputSplitMs", "limits.highlightProgressMs"])

/** Sections whose every value is checked against the type of its default. */
const CHECKED_SECTIONS = ["settings", "limits", "columns", "keys", "state"] as const

/** A user settings file gittt cannot read; it is left untouched. */
export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Finds `config/settings.json` above this module: next to `dist/` when installed, next to `src/` in development. */
const defaultsPath = () => {
  let folder = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(folder, "config", "settings.json"))) {
    const parent = dirname(folder)
    if (parent === folder) throw new Error(`gittt: config/settings.json not found above ${fileURLToPath(import.meta.url)}`)
    folder = parent
  }
  return join(folder, "config", "settings.json")
}

/** @returns every default, read from `config/settings.json` */
export const loadDefaults = (): Config => JSON.parse(readFileSync(defaultsPath(), "utf8")) as Config

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Lays `changes` over `base`, recursively for plain objects; arrays and other values from `changes` replace.
 * @param base the complete value
 * @param changes what to lay over it; `undefined` keeps `base`
 * @returns a new value; neither input is changed
 */
export const overlay = <Shape>(base: Shape, changes: unknown): Shape => {
  if (!isObject(base) || !isObject(changes)) return structuredClone((changes === undefined ? base : changes) as Shape)
  const result: Record<string, unknown> = structuredClone(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(changes)) result[key] = overlay(result[key], value)
  return result as Shape
}

/** @returns what `value` has that differs from `base`, recursively; `undefined` when nothing differs */
const difference = (value: unknown, base: unknown): unknown => {
  if (isObject(value) && isObject(base)) {
    const entries = Object.entries(value).map(([key, child]) => [key, difference(child, base[key])] as const).filter(([, child]) => child !== undefined)
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value
}

/** @returns 1-based line and column of an offset in `text` */
const positionOf = (text: string, offset: number) => {
  const before = text.slice(0, offset).split("\n")
  return { line: before.length, column: before[before.length - 1].length + 1 }
}

/**
 * Reads the user file.
 * @returns its text (empty when there is no file) and the object it holds
 * @throws ConfigError naming the file and the first problem's line and column when it cannot be read or parsed,
 *   or does not hold an object
 */
const readUserFile = (): { text: string; stored: Record<string, unknown> } => {
  let text: string
  try {
    text = readFileSync(USER_SETTINGS, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", stored: {} }
    throw new ConfigError(`${USER_SETTINGS} cannot be read: ${(error as Error).message}`)
  }
  const errors: ParseError[] = []
  const stored: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const { line, column } = positionOf(text, errors[0].offset)
    throw new ConfigError(`${USER_SETTINGS}:${line}:${column}: ${printParseErrorCode(errors[0].error)}; gittt runs on the defaults and saves nothing until it is fixed`)
  }
  if (!isObject(stored) && text.trim()) throw new ConfigError(`${USER_SETTINGS} must hold a JSON object; gittt runs on the defaults and saves nothing until it is fixed`)
  return { text, stored: isObject(stored) ? stored : {} }
}

/** @returns a description of `value` for an error message */
const shown = (value: unknown) => JSON.stringify(value) ?? String(value)

/**
 * Checks one merged value against its default.
 * @param key dotted path, e.g. `limits.tabWidth`
 * @param value the merged value
 * @param fallback the default
 * @param config the merged configuration, for settings that name a theme or icon set
 * @returns a sentence naming the problem, or `null` when the value is usable
 */
const problemOf = (key: string, value: unknown, fallback: unknown, config: Config): string | null => {
  if (key === "settings.theme") return value === AUTO_THEME || (typeof value === "string" && isObject(config.themes[value])) ? null : `${key} names no theme: ${shown(value)}`
  if (key === "settings.icons") return value === THEME_ICONS || (typeof value === "string" && isObject(config.iconSets[value])) ? null : `${key} names no icon set: ${shown(value)}`
  if (CHOICES[key]) return CHOICES[key].includes(value as string) ? null : `${key} must be one of ${CHOICES[key].join(", ")}, found ${shown(value)}`
  if (fallback === null) return value === null || (Number.isInteger(value) && (value as number) >= 1) ? null : `${key} must be null or a whole number of at least 1, found ${shown(value)}`
  if (typeof fallback === "number") {
    const minimum = ZERO_ALLOWED.has(key) ? 0 : 1
    return Number.isInteger(value) && (value as number) >= minimum ? null : `${key} must be a whole number of at least ${minimum}, found ${shown(value)}`
  }
  if (Array.isArray(fallback)) return Array.isArray(value) && value.every(item => typeof item === "string") ? null : `${key} must be a list of names, found ${shown(value)}`
  return typeof value === typeof fallback ? null : `${key} must be a ${typeof fallback}, found ${shown(value)}`
}

/**
 * Checks every setting, limit, column, key and remembered list against the type and range of its default.
 * @param config the merged configuration
 * @param defaults the shipped defaults
 * @returns the configuration with every unusable value replaced by its default, and one sentence per replaced value
 */
export const checkConfig = (config: Config, defaults: Config = loadDefaults()): { config: Config; problems: string[] } => {
  const checked = structuredClone(config)
  const problems: string[] = []
  for (const section of CHECKED_SECTIONS) {
    const values = checked[section] as Record<string, unknown>
    for (const [name, fallback] of Object.entries(defaults[section])) {
      const problem = problemOf(`${section}.${name}`, values[name], fallback, checked)
      if (!problem) continue
      problems.push(problem)
      values[name] = structuredClone(fallback)
    }
  }
  return { config: checked, problems }
}

/** Problems found by the last `loadConfig`: an unreadable file, or values replaced by their defaults. */
let lastProblems: string[] = []

/** @returns what the last load found wrong with the user file; empty when nothing */
export const configProblems = () => lastProblems

/** @returns the defaults with the user's changes laid over them, every unusable value replaced by its default */
export const loadConfig = (): Config => {
  const defaults = loadDefaults()
  let stored: Record<string, unknown> = {}
  const problems: string[] = []
  try {
    stored = readUserFile().stored
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    problems.push(error.message)
  }
  const checked = checkConfig(overlay(defaults, stored), defaults)
  lastProblems = [...problems, ...checked.problems]
  return checked.config
}

/**
 * Edits `text` so the object it holds becomes `wanted`, touching only values that differ, so comments elsewhere stay.
 * @param text the file's text
 * @param path keys down to the value being compared
 * @param current what the text holds at `path`
 * @param wanted what it should hold there; `undefined` removes it
 * @returns the edited text
 */
const edit = (text: string, path: string[], current: unknown, wanted: unknown): string => {
  if (path.length && JSON.stringify(current) === JSON.stringify(wanted)) return text
  if (isObject(current) && isObject(wanted)) {
    for (const key of new Set([...Object.keys(current), ...Object.keys(wanted)])) text = edit(text, [...path, key], current[key], wanted[key])
    return text
  }
  return applyEdits(text, modify(text, path, wanted, FORMATTING))
}

/** Replaces a file in one rename, so a reader never sees it half written. */
const writeAtomically = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}

/**
 * Stores a configuration: the user file ends up holding only the values that differ from the defaults; values that
 * did not change keep their place and the comments around them.
 * @param config the whole configuration
 * @throws ConfigError when the user file cannot be read or parsed; it is then left as it is
 */
export const saveConfig = (config: Config) => {
  const { text, stored } = readUserFile()
  const wanted = (difference(config, loadDefaults()) ?? {}) as Record<string, unknown>
  const edited = edit(text.trim() ? text : "{}\n", [], stored, wanted)
  if (edited !== text) writeAtomically(USER_SETTINGS, edited.endsWith("\n") ? edited : `${edited}\n`)
}

/**
 * Puts every setting back to its default; the remembered state is kept.
 * @returns the configuration after the reset
 * @throws ConfigError as `saveConfig` does
 */
export const resetConfig = (): Config => {
  saveConfig({ ...loadDefaults(), state: loadConfig().state })
  return loadConfig()
}

/** @returns remembered folders and repository lists */
export const loadState = (): State => loadConfig().state

/**
 * @param state what to remember; settings in the file stay as they are
 * @throws ConfigError as `saveConfig` does
 */
export const saveState = (state: State) => saveConfig({ ...loadConfig(), state })
