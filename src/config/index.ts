/**
 * The terminal client's settings and remembered state, kept in
 * `~/.config/gittt-cli/config.json`: view settings, colour tokens (only
 * those changed from the defaults), column widths, recent scan folders, and
 * per folder the list changes (order, removed and added repositories).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ViewSettings } from "@/protocol"

/** The user's changes to one folder's scanned list. */
export interface Catalog {
  order: string[]
  hidden: string[]
  added: string[]
}

/** Everything stored. */
export interface Config {
  settings: ViewSettings & { maxCommits: number; scanDepth: number; scanExclude: string[]; fileView: "path" | "status" | "tree"; icons: "unicode" | "nerd" }
  /** Colour tokens by name; `laneColors` is the graph palette. */
  tokens: Record<string, string | string[]>
  recent: string[]
  catalogs: Record<string, Catalog>
  /** Column widths in terminal cells. */
  columns: { tree: number; graph: number | null; hash: number; author: number; date: number; files: number; details: number | null }
}

const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gittt-cli", "config.json")

/** Defaults: accent `#ff905c`, warm lane palette, dark grounds. */
const DEFAULT_CONFIG: Config = {
  settings: {
    branches: "all",
    showRemoteBranches: true,
    order: "ancestor",
    compact: false,
    dateFormat: "absolute",
    gitmoji: true,
    maxCommits: 2000,
    scanDepth: 3,
    scanExclude: ["node_modules", "Library", ".Trash", ".cache", ".npm", ".nvm", ".yarn", ".next", "dist", "build", "out", "vendor", "Pods", ".tmp", "tmp", "marketplace-cache", "plugins", "extensions", ".vscode-shared"],
    fileView: "path",
    icons: "unicode",
  },
  tokens: {
    accent: "#ff905c",
    text: "#e4e4e4",
    branch: "#ff905c",
    remote: "#c3a6ff",
    tag: "#ebcb8b",
    head: "#a3be8c",
    stash: "#ff6b81",
    added: "#a3be8c",
    deleted: "#ff6b81",
    modified: "#ebcb8b",
    renamed: "#c3a6ff",
    untracked: "#c3a6ff",
    laneColors: ["#ff905c", "#a3be8c", "#c3a6ff", "#ebcb8b", "#ff6b81", "#7fd1b9", "#f7a072", "#e5a3d6", "#d4c48a"],
  },
  recent: [],
  catalogs: {},
  columns: { tree: 36, graph: null, hash: 8, author: 16, date: 20, files: 44, details: null },
}

/** @returns the stored config merged over the defaults; a missing or broken file yields the defaults */
export const loadConfig = (): Config => {
  try {
    const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      settings: { ...DEFAULT_CONFIG.settings, ...stored.settings, scanExclude: [...new Set([...DEFAULT_CONFIG.settings.scanExclude, ...(stored.settings?.scanExclude ?? [])])] },
      tokens: { ...DEFAULT_CONFIG.tokens, ...stored.tokens },
      columns: { ...DEFAULT_CONFIG.columns, ...stored.columns },
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

/**
 * Writes the config; colour tokens are stored only where they differ from the defaults.
 * @param config the whole config
 */
export const saveConfig = (config: Config) => {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const tokens = Object.fromEntries(Object.entries(config.tokens).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(DEFAULT_CONFIG.tokens[name])))
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...config, tokens }, null, 2)}\n`)
}

