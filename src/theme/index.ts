/**
 * Themes: every colour, glyph and spacing value gittt draws with, as named
 * tokens. The themes themselves live in `config/default.json` (dark and light
 * ship; `auto` picks one by the terminal's background) and can be changed or
 * added in the user config; its `tokens` section overrides single values on top
 * of the active theme. Components read the resolved theme and hold no literals.
 */

/** Colours, as `#rrggbb`. */
export interface ColorTokens {
  background: string
  text: string
  textMuted: string
  border: string
  accent: string
  accentText: string
  selection: string
  selectionInactive: string
  repositoryRow: string
  header: string
  field: string
  branch: string
  currentBranch: string
  remote: string
  tag: string
  head: string
  stash: string
  added: string
  deleted: string
  modified: string
  renamed: string
  untracked: string
  conflicted: string
  addedBackground: string
  deletedBackground: string
  labelGround: number
  /** Digits on count pills, drawn on the pill's solid colour. */
  pillText: string
  lanes: string[]
}

import type { Config } from "@/config"

/** Characters for icons, marks and the graph. */
export interface GlyphTokens {
  repository: string
  branch: string
  remote: string
  tag: string
  commit: string
  sync: string
  alert: string
  stash: string
  workspace: string
  fileStatus: string
  history: string
  search: string
  add: string
  rescan: string
  moveUp: string
  moveDown: string
  ahead: string
  behind: string
  open: string
  closed: string
  currentBranch: string
  dropdown: string
  checked: string
  unchecked: string
  radioOn: string
  radioOff: string
  pointer: string
  cursor: string
  error: string
  file: string
  folder: string
  rule: string
  divider: string
  splitter: string
  status: Record<"added" | "modified" | "deleted" | "renamed" | "conflicted" | "untracked", string>
  graph: Record<"node" | "head" | "working" | "vertical" | "horizontal" | "downRight" | "downLeft" | "upRight" | "upLeft" | "teeLeft" | "teeRight" | "teeUp" | "teeDown" | "cross" | "endUp" | "endDown", string>
}

/** Sizes in terminal cells and rows. */
export interface SpacingTokens {
  indent: number
  toolbarGap: number
  dialogWidth: number
  dialogLabel: number
  menuWidth: number
  checklistRows: number
  searchWidth: number
}

/** A full theme. */
export interface Theme {
  colors: ColorTokens
  glyphs: GlyphTokens
  spacing: SpacingTokens
  /** Code highlighting in diffs: `vscode` follows the editor's theme, any other value names a bundled shiki theme. */
  syntax: string
}

/** Partial overrides of a theme, as stored in the config. */
export interface ThemeOverrides {
  colors?: Partial<ColorTokens>
  glyphs?: Partial<GlyphTokens>
  spacing?: Partial<SpacingTokens>
  syntax?: string
}

/** The theme used on dark terminals and when a named theme does not exist. */
export const DEFAULT_THEME = "golden-brown"

/** Luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
const luminance = (color: string) => {
  const [red, green, blue] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/**
 * Picks the theme name for `auto`.
 * @param background the terminal background, if it answered
 * @returns `light` on a light background, the default theme otherwise
 */
export const autoTheme = (background: string | undefined) => background && luminance(background) > 0.5 ? "light" : DEFAULT_THEME

/**
 * Builds the active theme from the configuration.
 * @param config themes, icon sets, overrides and settings (`theme`, `icons`)
 * @param background the terminal background; only `auto` uses it, to choose the theme
 * @returns the theme components draw with; a theme name missing from `themes` falls back to the default theme
 */
export const resolveTheme = (config: Pick<Config, "themes" | "iconSets" | "tokens"> & { settings: { theme: string; icons: string } }, background: string | undefined): Theme => {
  const name = config.settings.theme === "auto" ? autoTheme(background) : config.settings.theme
  const theme = (config.themes[name] ?? config.themes[DEFAULT_THEME]) as Theme
  const overrides = config.tokens
  return {
    colors: { ...theme.colors, ...overrides.colors },
    glyphs: { ...theme.glyphs, ...config.iconSets[config.settings.icons], ...overrides.glyphs },
    spacing: { ...theme.spacing, ...overrides.spacing },
    syntax: overrides.syntax ?? theme.syntax,
  }
}
