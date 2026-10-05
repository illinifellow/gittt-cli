/**
 * One settings file in two places, of the same shape. `config/settings.json`,
 * shipped with gittt, holds every default: view settings, limits, column
 * widths, key bindings, the themes, icon sets and an empty `state`.
 * `~/.config/gittt-cli/settings.json` holds only what the user changed and what
 * gittt remembers (`state`: recent folders, each folder's repository list); the
 * two are merged on load, saving writes back just the differences, and a reset
 * drops values from the user file (never the state).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ViewSettings } from "@/protocol"
import type { GlyphTokens, ThemeOverrides } from "@/theme"

/** The user's changes to one folder's scanned list. */
export interface Catalog {
  order: string[]
  hidden: string[]
  added: string[]
}

/** Every action a key can trigger. */
export type KeyBindings = Record<
  | "commit" | "pull" | "push" | "fetch" | "branch" | "merge" | "stash" | "tag" | "settings"
  | "rescan" | "add" | "remove" | "moveUp" | "moveDown" | "menu" | "search" | "copyHash" | "fileView" | "quit"
  | "branches" | "remotes" | "order" | "view" | "dates" | "gitmoji"
  | "graphNarrower" | "graphWider" | "authorNarrower" | "authorWider" | "dateNarrower" | "dateWider" | "sidebarNarrower" | "sidebarWider",
  string
>

/** Sizes, timings and caps that shape behaviour rather than looks. */
export interface Limits {
  diffKilobytes: number
  highlightMaxLines: number
  highlightChunkLines: number
  highlightCacheSize: number
  refreshDelayMs: number
  doubleClickMs: number
  backgroundQueryMs: number
  statusMs: number
  errorStatusMs: number
  recentFolders: number
  watchIgnore: string[]
}

/** The whole configuration, defaults and user changes merged. */
export interface Config {
  settings: ViewSettings & {
    /** `auto` (by the terminal background), `golden-brown`, `light`, or the name of a theme under `themes`. */
    theme: string
    icons: string
    fileView: "path" | "status" | "tree"
    maxCommits: number
    scanDepth: number
    scanExclude: string[]
  }
  limits: Limits
  /** Column widths in terminal cells and the lower panes' height in rows; `null` sizes automatically. */
  columns: { tree: number; graph: number | null; hash: number; author: number; date: number; files: number; details: number | null }
  keys: KeyBindings
  /** Every theme in full. */
  themes: Record<string, ThemeOverrides>
  /** Icon sets that replace the theme's icons when `settings.icons` names them. */
  iconSets: Record<string, Partial<GlyphTokens>>
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

const FOLDER = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gittt-cli")
const USER_SETTINGS = join(FOLDER, "settings.json")
const OLD_CONFIG = join(FOLDER, "config.json")
const OLD_STATE = join(FOLDER, "state.json")

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

/** Lays `changes` over `base`, recursively for plain objects; arrays and values from `changes` replace. */
const merge = <Shape>(base: Shape, changes: unknown): Shape => {
  if (!isObject(base) || !isObject(changes)) return (changes === undefined ? structuredClone(base) : changes) as Shape
  const result: Record<string, unknown> = structuredClone(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(changes)) result[key] = key in result ? merge(result[key], value) : value
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

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value ?? {}, null, 2)}\n`)
}

/** Folds the files an older gittt wrote (`config.json`, `state.json`) into `settings.json`, once. */
const migrate = () => {
  if (existsSync(USER_SETTINGS) || (!existsSync(OLD_CONFIG) && !existsSync(OLD_STATE))) return
  const old = readJson(OLD_CONFIG)
  const { recent, catalogs, ...rest } = isObject(old) ? old : {} as Record<string, unknown>
  if (isObject(rest.tokens) && !("colors" in rest.tokens || "glyphs" in rest.tokens || "spacing" in rest.tokens)) delete rest.tokens
  const state = readJson(OLD_STATE)
  writeJson(USER_SETTINGS, difference({ ...merge(loadDefaults(), rest), state: isObject(state) ? state : { recent: recent ?? [], catalogs: catalogs ?? {} } }, loadDefaults()))
}

/** @returns the defaults with the user's changes laid over them */
export const loadConfig = (): Config => {
  migrate()
  const stored = readJson(USER_SETTINGS)
  return merge(loadDefaults(), isObject(stored) ? renameDarkTheme(stored) : {})
}

/** Carries settings written when the default theme was called `dark` over to `golden-brown`. */
const renameDarkTheme = (stored: Record<string, unknown>) => {
  if (isObject(stored.settings) && stored.settings.theme === "dark") stored.settings.theme = "golden-brown"
  if (isObject(stored.themes) && "dark" in stored.themes && !("golden-brown" in stored.themes)) {
    stored.themes["golden-brown"] = stored.themes.dark
    delete stored.themes.dark
  }
  return stored
}

/**
 * Stores a configuration: only the values that differ from the defaults reach the user file.
 * @param config the whole configuration
 */
export const saveConfig = (config: Config) => writeJson(USER_SETTINGS, difference(config, loadDefaults()))

/**
 * Puts values back to their defaults; the remembered state is kept.
 * @param path keys down to the value or section to reset, e.g. `["themes", "golden-brown", "colors", "accent"]`; empty resets every setting
 * @returns the configuration after the reset
 */
export const resetConfig = (path: string[] = []): Config => {
  if (!path.length) {
    saveConfig({ ...loadDefaults(), state: loadConfig().state })
    return loadConfig()
  }
  const stored = readJson(USER_SETTINGS)
  if (isObject(stored)) {
    let parent: Record<string, unknown> = stored
    for (const key of path.slice(0, -1)) {
      if (!isObject(parent[key])) return loadConfig()
      parent = parent[key] as Record<string, unknown>
    }
    delete parent[path[path.length - 1]]
    writeJson(USER_SETTINGS, difference(merge(loadDefaults(), stored), loadDefaults()))
  }
  return loadConfig()
}

/** @returns remembered folders and repository lists */
export const loadState = (): State => loadConfig().state

/** @param state what to remember; settings in the file stay as they are */
export const saveState = (state: State) => saveConfig({ ...loadConfig(), state })

/** Where the user's settings file lives, for the settings dialog. */
export const USER_SETTINGS_PATH = USER_SETTINGS
