/**
 * Terminal text helpers: display width (wide characters count two cells),
 * truncation and padding to a column width, and the colour tokens.
 */
import stringWidth from "string-width"
import type { Config } from "@/config"

/**
 * @param text any text
 * @param width cells available
 * @returns the text cut to `width` cells with an ellipsis when it does not fit, padded with spaces to exactly `width`
 */
export const fit = (text: string, width: number) => {
  if (width <= 0) return ""
  let result = ""
  let used = 0
  const full = stringWidth(text) > width
  const limit = full ? width - 1 : width
  for (const character of text) {
    const size = stringWidth(character)
    if (used + size > limit) break
    result += character
    used += size
  }
  return full ? `${result}…${" ".repeat(Math.max(0, width - used - 1))}` : result + " ".repeat(width - used)
}

/**
 * @param text any text
 * @returns its display width in terminal cells; wide characters count two
 */
export const widthOf = (text: string) => stringWidth(text)

/** Colour tokens resolved from the config. */
export type Palette = { [name: string]: string } & { lanes: string[] }

/**
 * Resolves the colour tokens; tints not set in the config are mixed from the
 * text, accent and the terminal's own background.
 * @param tokens the config's tokens
 * @param background the terminal background, `#1e1e1e` when it did not say
 * @returns single colours by name plus the lane palette
 */
export const paletteOf = (tokens: Config["tokens"], background = "#1e1e1e"): Palette => {
  const singles = Object.fromEntries(Object.entries(tokens).filter(([, value]) => typeof value === "string")) as Record<string, string>
  const ground = singles.background ?? background
  const text = singles.text ?? "#e4e4e4"
  const derived: Record<string, string> = {
    background: ground,
    textMuted: mix(text, ground, 0.55),
    border: mix(text, ground, 0.16),
    selection: mix(singles.accent ?? "#ff905c", ground, 0.3),
    addedBackground: mix(singles.added ?? "#a3be8c", ground, 0.16),
    deletedBackground: mix(singles.deleted ?? "#ff6b81", ground, 0.16),
  }
  return { ...derived, ...singles, lanes: Array.isArray(tokens.laneColors) ? tokens.laneColors : [singles.accent] } as Palette
}

/**
 * Mixes two hex colours.
 * @param color the tint
 * @param base the colour it is laid on
 * @param amount share of the tint, 0 to 1
 * @returns a `#rrggbb` colour
 */
export const mix = (color: string, base: string, amount: number) => {
  const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
  const tint = channels(color)
  const ground = channels(base)
  return `#${tint.map((value, index) => Math.round(value * amount + ground[index] * (1 - amount)).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Scrolls text sideways.
 * @param text any text
 * @param offset cells to drop from the start
 * @returns the text without its first `offset` cells
 */
export const slide = (text: string, offset: number) => {
  if (offset <= 0) return text
  let dropped = 0
  let index = 0
  const characters = [...text]
  while (index < characters.length && dropped < offset) dropped += stringWidth(characters[index++])
  return characters.slice(index).join("")
}
