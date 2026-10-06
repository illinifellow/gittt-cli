/**
 * Themes: every colour, glyph and spacing value gittt draws with, as named
 * tokens. The themes themselves live in `config/settings.json` (golden-brown and
 * milk-and-honey ship; `auto` picks one by the terminal's background) and can be
 * changed or added in the user settings: a theme of the user's own names the
 * theme it `extends` (golden-brown when it names none) and everything it leaves
 * out comes from there. An icon set and the `tokens` section are laid over the
 * result, value by value. Components read the resolved theme and hold no literals.
 */
import { AUTO_THEME, overlay, type Config } from "@/config"

/** Colours, as `#rrggbb`. */
export interface ColorTokens {
  /** The screen's ground; `transparent` leaves the terminal's own background showing. */
  background: string
  text: string
  textMuted: string
  border: string
  accent: string
  accentText: string
  selection: string
  selectionInactive: string
  header: string
  field: string
  branch: string
  currentBranch: string
  remote: string
  tag: string
  head: string
  stash: string
  /** Errors, warnings and dangerous buttons. */
  danger: string
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
  /** A checkbox that is partly on: a file with some changes staged and some not. */
  mixed: string
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

/** Glyph tokens with any of them left out, in the nested groups too. */
export type PartialGlyphs = Partial<Omit<GlyphTokens, "status" | "graph">> & { status?: Partial<GlyphTokens["status"]>; graph?: Partial<GlyphTokens["graph"]> }

/** Sizes in terminal cells and rows. */
export interface SpacingTokens {
  indent: number
  toolbarGap: number
  dialogWidth: number
  dialogLabel: number
  menuWidth: number
  checklistRows: number
  /** Cells for an item's name in a dialog checklist; its detail takes the rest of the row. */
  checklistLabel: number
  searchWidth: number
  pickerWidth: number
  sidebarMinWidth: number
  /** The narrowest the log, files and diff panes get, in cells. */
  paneMinWidth: number
  /** The fewest rows the lower panes get. */
  paneMinHeight: number
  columnMinWidth: number
  columnMaxWidth: number
  /** Cells a column grows or shrinks per key press. */
  resizeStep: number
}

/** A full theme. */
export interface Theme {
  colors: ColorTokens
  glyphs: GlyphTokens
  spacing: SpacingTokens
  /** Code highlighting in diffs: `vscode` follows the editor's theme, any other value names a bundled shiki theme. */
  syntax: string
  /** What the screen paints behind everything: the theme's background, or `undefined` for a transparent one. */
  surface: string | undefined
}

/** A theme as stored in the config: complete for the shipped themes, partial for the user's own. */
export interface ThemeOverrides {
  /** The theme that fills what this one leaves out; golden-brown when absent. */
  extends?: string
  colors?: Partial<ColorTokens>
  glyphs?: PartialGlyphs
  spacing?: Partial<SpacingTokens>
  syntax?: string
}

/** The theme used on dark terminals and when a named theme does not exist. */
export const DEFAULT_THEME = "golden-brown"

/** The `background` value that leaves the terminal's own background showing. */
export const TRANSPARENT = "transparent"

/** The ground tints are mixed with under a transparent theme when the terminal does not say its background. */
const FALLBACK_GROUND = "#000000"

/** The theme `auto` picks on light terminals. */
export const LIGHT_THEME = "milk-and-honey"

/** Luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
const luminance = (color: string) => {
  const [red, green, blue] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/**
 * Picks the theme name for `auto`.
 * @param background the terminal background, if it answered
 * @returns the light theme on a light background, the default theme otherwise
 */
export const autoTheme = (background: string | undefined) => background && luminance(background) > 0.5 ? LIGHT_THEME : DEFAULT_THEME

/**
 * Fills a theme from the themes it extends, nearest last.
 * @param themes every configured theme
 * @param name the theme to complete
 * @param seen themes already on the chain, so a loop ends at the default theme
 * @returns the theme with every token its chain supplies; the default theme alone for a name not in `themes`
 */
const completeTheme = (themes: Config["themes"], name: string, seen = new Set<string>()): ThemeOverrides => {
  const theme = themes[name]
  if (!theme || name === DEFAULT_THEME || seen.has(name)) return themes[DEFAULT_THEME]
  seen.add(name)
  return overlay(completeTheme(themes, theme.extends ?? DEFAULT_THEME, seen), theme)
}

/**
 * Builds the active theme from the configuration.
 * @param config themes, icon sets, overrides and settings (`theme`, `icons`)
 * @param background the terminal background; `auto` chooses the theme by it, and a transparent theme mixes its tints with it
 * @returns the theme components draw with: the named theme filled from the themes it extends, then the icon set and
 *   the tokens laid over it value by value; a theme name missing from `themes` falls back to the default theme. Under a
 *   transparent background `colors.background` is the terminal's (black when unknown), which opaque overlays such as
 *   dialogs paint, and `surface` is `undefined`
 */
export const resolveTheme = (config: Pick<Config, "themes" | "iconSets" | "tokens"> & { settings: { theme: string; icons: string } }, background: string | undefined): Theme => {
  const name = config.settings.theme === AUTO_THEME ? autoTheme(background) : config.settings.theme
  const theme = overlay(overlay(completeTheme(config.themes, name), { glyphs: config.iconSets[config.settings.icons] }), config.tokens) as Omit<Theme, "surface">
  const transparent = theme.colors.background === TRANSPARENT
  return {
    colors: transparent ? { ...theme.colors, background: background ?? FALLBACK_GROUND } : theme.colors,
    glyphs: theme.glyphs,
    spacing: theme.spacing,
    syntax: theme.syntax,
    surface: transparent ? undefined : theme.colors.background,
  }
}
