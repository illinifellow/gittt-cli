/**
 * The settings dialog as data: every option of `settings.json` that the toolbar
 * and filters do not already cycle, the reset to defaults, and the Buy Me a
 * Coffee link. Submitting writes the changes through `saveConfig`.
 */
import { spawn } from "node:child_process"
import { AUTO_THEME, THEME_ICONS, checkConfig, type Config } from "@/config"
import type { DialogSpec, DialogValues } from "@/dialogs"

/** Where the Buy Me a Coffee button leads: the same page illinifellow.com links to. */
export const COFFEE_URL = "https://buymeacoffee.com/illinifellow"

/** Buy Me a Coffee's own button colours, kept as the brand draws them in every theme. */
const COFFEE_BUTTON = { background: "#ffdd04", color: "#000000" }

/**
 * Builds the settings dialog from the current configuration.
 * @param config the configuration in effect
 * @returns the dialog: theme and view choices, numbers, scan exclusions, the reset box and the coffee link
 */
export const settingsDialog = (config: Config): DialogSpec => {
  const { settings, limits } = config
  const themes = [AUTO_THEME, ...Object.keys(config.themes)]
  const icons = [THEME_ICONS, ...Object.keys(config.iconSets)]
  return { kind: "settings", title: "Settings", submit: "Save", fields: [
    { type: "select", key: "theme", label: "Theme", value: settings.theme, choices: themes.map(name => ({ value: name, label: name })) },
    { type: "select", key: "icons", label: "Icons", value: settings.icons, choices: icons.map(name => ({ value: name, label: name })) },
    { type: "select", key: "fileView", label: "Files", value: settings.fileView, choices: [{ value: "path", label: "sorted by path" }, { value: "status", label: "sorted by status" }, { value: "tree", label: "tree" }] },
    { type: "select", key: "branches", label: "Branches", value: settings.branches, choices: [{ value: "all", label: "all branches" }, { value: "current", label: "current branch" }] },
    { type: "select", key: "order", label: "Order", value: settings.order, choices: [{ value: "ancestor", label: "ancestor order" }, { value: "date", label: "date order" }] },
    { type: "select", key: "dateFormat", label: "Dates", value: settings.dateFormat, choices: [{ value: "absolute", label: "absolute" }, { value: "relative", label: "relative" }] },
    { type: "checkbox", key: "showRemoteBranches", label: "Show remote branches in the log", value: settings.showRemoteBranches },
    { type: "checkbox", key: "compact", label: "Compact log rows", value: settings.compact },
    { type: "checkbox", key: "gitmoji", label: "Draw gitmoji shortcodes as emoji", value: settings.gitmoji },
    { type: "text", key: "maxCommits", label: "Commits shown", value: String(settings.maxCommits) },
    { type: "text", key: "scanDepth", label: "Search depth", value: String(settings.scanDepth) },
    { type: "text", key: "scanExclude", label: "Skip folders", value: settings.scanExclude.join(", ") },
    { type: "text", key: "fetchMinutes", label: "Fetch every, min", value: String(settings.fetchMinutes) },
    { type: "text", key: "diffKilobytes", label: "Diff limit, KB", value: String(limits.diffKilobytes) },
    { type: "text", key: "doubleClickMs", label: "Double click, ms", value: String(limits.doubleClickMs) },
    { type: "text", key: "recentFolders", label: "Recent folders", value: String(limits.recentFolders) },
    { type: "checkbox", key: "reset", label: "Reset every setting to its default", value: false, warning: "Themes, keys, columns and limits all go back to the defaults on Save" },
    { type: "link", label: "Support gittt", text: "☕ Buy me a coffee", url: COFFEE_URL, ...COFFEE_BUTTON },
  ] }
}

/**
 * Checks the dialog's values by the same rules the settings file is checked by on load.
 * @param config the configuration the dialog was opened on
 * @param values the dialog's values
 * @returns the first problem in words, naming the setting (e.g. `settings.maxCommits must be a whole number of at
 *   least 1, found "many"`), or null when every value is usable
 */
export const validateSettings = (config: Config, values: DialogValues): string | null => checkConfig(applySettings(config, values)).problems[0] ?? null

/** @returns a typed number; blank text is no number (`Number("")` would read it as 0) */
const toNumber = (value: DialogValues[string]) => String(value).trim() ? Number(value) : Number.NaN

/**
 * Writes the dialog's values into a copy of the configuration.
 * @param config the configuration to change
 * @param values the dialog's values, already validated
 * @returns the changed configuration; the reset box is handled by the caller
 */
export const applySettings = (config: Config, values: DialogValues): Config => {
  const next = structuredClone(config)
  next.settings.theme = String(values.theme)
  next.settings.icons = String(values.icons)
  next.settings.fileView = values.fileView as Config["settings"]["fileView"]
  next.settings.branches = values.branches as Config["settings"]["branches"]
  next.settings.order = values.order as Config["settings"]["order"]
  next.settings.dateFormat = values.dateFormat as Config["settings"]["dateFormat"]
  next.settings.showRemoteBranches = values.showRemoteBranches === true
  next.settings.compact = values.compact === true
  next.settings.gitmoji = values.gitmoji === true
  next.settings.maxCommits = toNumber(values.maxCommits)
  next.settings.scanDepth = toNumber(values.scanDepth)
  next.settings.scanExclude = String(values.scanExclude).split(",").map(name => name.trim()).filter(Boolean)
  next.settings.fetchMinutes = toNumber(values.fetchMinutes)
  next.limits.diffKilobytes = toNumber(values.diffKilobytes)
  next.limits.doubleClickMs = toNumber(values.doubleClickMs)
  next.limits.recentFolders = toNumber(values.recentFolders)
  return next
}

/**
 * Opens a web page in the default browser.
 * @param url the page; failures (no browser, no `open`) are ignored
 */
export const openUrl = (url: string) => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref()
}
