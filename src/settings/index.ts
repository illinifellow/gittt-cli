/**
 * The settings dialog as data: every option of `settings.json` that the toolbar
 * and filters do not already cycle, the reset to defaults, and the Buy Me a
 * Coffee link. Submitting writes the changes through `saveConfig`.
 */
import { spawn } from "node:child_process"
import type { Config } from "@/config"
import type { DialogSpec, DialogValues } from "@/dialogs"

/** Where the Buy Me a Coffee button leads: the same page illinifellow.com links to. */
export const COFFEE_URL = "https://buymeacoffee.com/illinifellow"

/** Buy Me a Coffee's own button colours, kept as the brand draws them in every theme. */
const COFFEE_BUTTON = { background: "#ffdd04", color: "#000000" }

const NUMBER_FIELDS = ["maxCommits", "scanDepth", "diffKilobytes", "doubleClickMs", "recentFolders"] as const

/**
 * Builds the settings dialog from the current configuration.
 * @param config the configuration in effect
 * @returns the dialog: theme and view choices, numbers, scan exclusions, the reset box and the coffee link
 */
export const settingsDialog = (config: Config): DialogSpec => {
  const { settings, limits } = config
  const themes = ["auto", ...Object.keys(config.themes)]
  return { kind: "settings", title: "Settings", submit: "Save", fields: [
    { type: "select", key: "theme", label: "Theme", value: settings.theme, choices: themes.map(name => ({ value: name, label: name })) },
    { type: "select", key: "icons", label: "Icons", value: settings.icons, choices: [{ value: "unicode", label: "unicode" }, { value: "nerd", label: "nerd font" }] },
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
 * Checks the typed numbers.
 * @param values the dialog's values
 * @returns the first problem in words, or null when every number is a whole number of at least 1 (background fetch minutes at least 0)
 */
export const validateSettings = (values: DialogValues): string | null => {
  for (const key of NUMBER_FIELDS) {
    const value = Number(values[key])
    if (!Number.isInteger(value) || value < 1) return `${key} must be a whole number of at least 1`
  }
  const fetchMinutes = Number(values.fetchMinutes)
  if (!Number.isInteger(fetchMinutes) || fetchMinutes < 0) return "fetchMinutes must be a whole number, 0 to never fetch in the background"
  return null
}

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
  next.settings.maxCommits = Number(values.maxCommits)
  next.settings.scanDepth = Number(values.scanDepth)
  next.settings.scanExclude = String(values.scanExclude).split(",").map(name => name.trim()).filter(Boolean)
  next.settings.fetchMinutes = Number(values.fetchMinutes)
  next.limits.diffKilobytes = Number(values.diffKilobytes)
  next.limits.doubleClickMs = Number(values.doubleClickMs)
  next.limits.recentFolders = Number(values.recentFolders)
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
