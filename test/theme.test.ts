/**
 * Theme resolution: which ground the screen paints, which colour tints mix with, and what a partial theme inherits.
 * Catches a transparent theme painting a solid ground, tints mixed with the word "transparent", and a theme of the
 * user's own (or a single overridden glyph) losing every token it did not name, which broke drawing.
 */
import { describe, expect, it } from "vitest"
import { loadDefaults } from "@/config"
import { DEFAULT_THEME, LIGHT_THEME, TRANSPARENT, resolveTheme } from "@/theme"

const withTheme = (theme: string) => {
  const config = loadDefaults()
  return { ...config, settings: { ...config.settings, theme } }
}

describe("resolveTheme", () => {
  /** golden-brown must leave the terminal's background showing and mix tints with it. */
  it("paints nothing under a transparent theme and mixes with the terminal background", () => {
    const theme = resolveTheme(withTheme(DEFAULT_THEME), "#101418")
    expect(loadDefaults().themes[DEFAULT_THEME].colors?.background).toBe(TRANSPARENT)
    expect(theme.surface).toBeUndefined()
    expect(theme.colors.background).toBe("#101418")
  })

  /** A terminal that does not answer the background query still gets a real colour to mix with. */
  it("falls back to black when the terminal background is unknown", () => {
    expect(resolveTheme(withTheme(DEFAULT_THEME), undefined).colors.background).toBe("#000000")
  })

  /** milk-and-honey paints its own ground so it stays readable on a dark terminal. */
  it("paints an opaque theme's own background", () => {
    const theme = resolveTheme(withTheme(LIGHT_THEME), "#101418")
    expect(theme.surface).toBe(theme.colors.background)
    expect(theme.surface).toMatch(/^#[0-9a-f]{6}$/)
  })

  /** auto picks the light theme only on a light terminal. */
  it("picks the theme by the terminal background under auto", () => {
    expect(resolveTheme(withTheme("auto"), "#ffffff").surface).toBe(loadDefaults().themes[LIGHT_THEME].colors?.background)
    expect(resolveTheme(withTheme("auto"), "#000000").surface).toBeUndefined()
  })

  /** A theme of the user's own naming one colour gets every other token from the theme it extends. */
  it("fills a partial theme from the default theme", () => {
    const config = withTheme("mine")
    config.themes = { ...config.themes, mine: { colors: { accent: "#123456" } } }
    const theme = resolveTheme(config, "#000000")
    const shipped = resolveTheme(withTheme(DEFAULT_THEME), "#000000")
    expect(theme.colors.accent).toBe("#123456")
    expect({ ...theme.colors, accent: shipped.colors.accent }).toEqual(shipped.colors)
    expect(theme.glyphs).toEqual(shipped.glyphs)
    expect(theme.spacing).toEqual(shipped.spacing)
  })

  /** `extends` picks the theme a partial theme starts from. */
  it("fills a partial theme from the theme it extends", () => {
    const config = withTheme("mine")
    config.themes = { ...config.themes, mine: { extends: LIGHT_THEME, colors: { accent: "#123456" } } }
    const theme = resolveTheme(config, "#000000")
    expect(theme.colors.text).toBe(loadDefaults().themes[LIGHT_THEME].colors?.text)
    expect(theme.syntax).toBe(loadDefaults().themes[LIGHT_THEME].syntax)
  })

  /** One overridden graph glyph replaces that glyph only; the icon set and the tokens are laid over value by value. */
  it("overrides nested glyphs one by one", () => {
    const config = withTheme(DEFAULT_THEME)
    config.tokens = { glyphs: { graph: { node: "*" } } }
    config.iconSets = { ...config.iconSets, partial: { status: { added: "A" } } }
    config.settings.icons = "partial"
    const theme = resolveTheme(config, "#000000")
    const shipped = loadDefaults().themes[DEFAULT_THEME].glyphs
    expect(theme.glyphs.graph).toEqual({ ...shipped?.graph, node: "*" })
    expect(theme.glyphs.status).toEqual({ ...shipped?.status, added: "A" })
  })
})
