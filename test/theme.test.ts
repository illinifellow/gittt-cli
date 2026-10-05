/**
 * Theme resolution: which ground the screen paints and which colour tints mix with.
 * Catches a transparent theme painting a solid ground, or tints mixed with the word "transparent".
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
})
