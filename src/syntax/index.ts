/**
 * Finds the VS Code color theme the user runs (from VS Code's own settings and
 * installed extensions, no VS Code API needed) so the terminal highlights diffs
 * with the editor's colours; falls back to Dark+.
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

const userSettingsPath = () => {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User", "settings.json")
  if (platform() === "win32") return join(process.env.APPDATA ?? "", "Code", "User", "settings.json")
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Code", "User", "settings.json")
}

const EXTENSION_ROOTS = [
  join(homedir(), ".vscode", "extensions"),
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
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

/** @returns the VS Code theme in use with the user's token colour customizations, or Dark+ when VS Code is absent */
const readEditorTheme = async (): Promise<ThemeRegistrationAny> => {
  const settings = await readJson<Record<string, unknown>>(userSettingsPath()).catch(() => ({} as Record<string, unknown>))
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
