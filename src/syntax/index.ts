/**
 * Finds the VS Code color theme the user runs (from the settings and installed
 * extensions of VS Code, its Insiders build, VSCodium or Cursor, no editor API
 * needed) so the terminal highlights diffs with the editor's colours; falls back
 * to Dark+.
 */
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import type { ThemeRegistrationAny } from "shiki/core"
import { bundledThemes } from "shiki/themes"

interface TokenRule {
  scope?: string | string[]
  settings: Record<string, string>
}

const SHORTHAND_SCOPES: Record<string, string[]> = {
  comments: ["comment", "punctuation.definition.comment"],
  strings: ["string"],
  keywords: ["keyword", "keyword.control", "storage"],
  numbers: ["constant.numeric"],
  types: ["entity.name.type", "support.type", "support.class"],
  functions: ["entity.name.function", "support.function"],
  variables: ["variable", "entity.name.variable"],
}

/** Editors that share VS Code's settings and theme format: their folder under the user's config folder, and their extensions folder. */
const EDITORS = [
  { config: "Code", extensions: ".vscode" },
  { config: "Code - Insiders", extensions: ".vscode-insiders" },
  { config: "VSCodium", extensions: ".vscode-oss" },
  { config: "Cursor", extensions: ".cursor" },
]

/** @returns the folder that holds each editor's `User/settings.json` on this system */
const configRoot = () => {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support")
  if (platform() === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
}

/** Settings files to look in, in order: each editor's, then the Flatpak build of VS Code's. */
const SETTINGS_PATHS = [
  ...EDITORS.map(editor => join(configRoot(), editor.config, "User", "settings.json")),
  join(homedir(), ".var", "app", "com.visualstudio.code", "config", "Code", "User", "settings.json"),
]

/** Folders holding themes: each editor's extensions, then the built-in themes of the usual installs (macOS, Linux packages, Snap, Windows). */
const EXTENSION_ROOTS = [
  ...EDITORS.map(editor => join(homedir(), editor.extensions, "extensions")),
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
  "/snap/code/current/usr/share/code/resources/app/extensions",
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Microsoft VS Code", "resources", "app", "extensions"),
]

const readJson = async <Shape>(path: string) => parse(await readFile(path, "utf8"), [], { allowTrailingComma: true }) as Shape

const loadThemeFile = async (path: string): Promise<{ colors: Record<string, string>; tokenColors: TokenRule[]; type?: string }> => {
  const theme = await readJson<{ include?: string; type?: string; colors?: Record<string, string>; tokenColors?: TokenRule[] | string }>(path)
  const base = theme.include ? await loadThemeFile(join(dirname(path), theme.include)) : { colors: {}, tokenColors: [] as TokenRule[] }
  const own = typeof theme.tokenColors === "string" ? (await readJson<{ settings?: TokenRule[] }>(join(dirname(path), theme.tokenColors))).settings ?? [] : theme.tokenColors ?? []
  return { type: theme.type ?? base.type, colors: { ...base.colors, ...theme.colors }, tokenColors: [...base.tokenColors, ...own] }
}

const findThemePath = async (name: string) => {
  for (const root of EXTENSION_ROOTS) {
    if (!existsSync(root)) continue
    for (const folder of await readdir(root)) {
      const manifest = await readJson<{ contributes?: { themes?: { id?: string; label?: string; path: string }[] } }>(join(root, folder, "package.json")).catch(() => null)
      const match = manifest?.contributes?.themes?.find(theme => theme.id === name || theme.label === name)
      if (match) return join(root, folder, match.path)
    }
  }
  return null
}

const customizationRules = (customizations: Record<string, unknown> | undefined): TokenRule[] => {
  if (!customizations) return []
  const rules: TokenRule[] = []
  for (const [key, scopes] of Object.entries(SHORTHAND_SCOPES)) {
    const value = customizations[key]
    if (typeof value === "string") rules.push({ scope: scopes, settings: { foreground: value } })
    else if (value && typeof value === "object") rules.push({ scope: scopes, settings: value as Record<string, string> })
  }
  return [...rules, ...((customizations.textMateRules as TokenRule[] | undefined) ?? [])]
}

/**
 * @param name `vscode` for the editor's theme, or the name of a bundled shiki theme
 * @returns the theme diffs are highlighted with; an unknown name falls back to Dark+
 */
export const readSyntaxTheme = async (name: string): Promise<ThemeRegistrationAny> => {
  if (name !== "vscode") return ((await (bundledThemes[name as keyof typeof bundledThemes] ?? bundledThemes["dark-plus"])()).default) as ThemeRegistrationAny
  return readEditorTheme()
}

/** @returns the editor theme in use with the user's token colour customizations, or Dark+ when no editor is found */
const readEditorTheme = async (): Promise<ThemeRegistrationAny> => {
  const settingsPath = SETTINGS_PATHS.find(path => existsSync(path))
  const settings = settingsPath ? await readJson<Record<string, unknown>>(settingsPath).catch(() => ({} as Record<string, unknown>)) : {}
  const name = String(settings["workbench.colorTheme"] ?? "")
  const path = name ? await findThemePath(name) : null
  const theme = path ? await loadThemeFile(path).catch(() => null) : null
  const fallback = theme ?? ((await bundledThemes["dark-plus"]()).default as unknown as { colors: Record<string, string>; tokenColors: TokenRule[]; type?: string })
  const customizations = settings["editor.tokenColorCustomizations"] as Record<string, unknown> | undefined
  return {
    type: theme?.type === "light" ? "light" : "dark",
    colors: fallback.colors,
    tokenColors: [...fallback.tokenColors, ...customizationRules(customizations), ...customizationRules(customizations?.[`[${name}]`] as Record<string, unknown> | undefined)],
  } as ThemeRegistrationAny
}
