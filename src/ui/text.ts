/**
 * Terminal text helpers: display width measured per grapheme (a character as
 * the eye sees it, so an emoji built of several code points is one piece and
 * wide characters count two cells), truncation and padding to a column width,
 * code laid out on terminal cells with tabs expanded, and colour mixing.
 */
import stringWidth from "string-width"
import type { ColorTokens } from "@/theme"

/** Splits text into graphemes; created on the first text that needs it, since it loads the Unicode tables. */
let segmenter: Intl.Segmenter | null = null

/** Text in which every character is one grapheme; most code and messages, split without the segmenter. */
const SIMPLE = /^[\x00-\x7f]*$/

/**
 * @param text any text
 * @returns its graphemes in order
 */
export const graphemes = (text: string) => {
  if (SIMPLE.test(text)) return [...text]
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return Array.from(segmenter.segment(text), part => part.segment)
}

/**
 * @param text any text
 * @returns its display width in terminal cells; wide characters count two
 */
export const widthOf = (text: string) => stringWidth(text)

/**
 * @param text any text
 * @param width cells available
 * @returns the text cut to `width` cells with an ellipsis when it does not fit, padded with spaces to exactly `width`
 */
export const fit = (text: string, width: number) => {
  if (width <= 0) return ""
  let result = ""
  let used = 0
  const full = widthOf(text) > width
  const limit = full ? width - 1 : width
  for (const piece of graphemes(text)) {
    const size = widthOf(piece)
    if (used + size > limit) break
    result += piece
    used += size
  }
  return full ? `${result}…${" ".repeat(Math.max(0, width - used - 1))}` : result + " ".repeat(width - used)
}

/**
 * Scrolls text sideways.
 * @param text any text
 * @param offset cells to drop from the start
 * @returns the text without its first `offset` cells; a wide character cut in half is dropped whole
 */
export const slide = (text: string, offset: number) => {
  if (offset <= 0) return text
  let dropped = 0
  const pieces = graphemes(text)
  let index = 0
  while (index < pieces.length && dropped < offset) dropped += widthOf(pieces[index++])
  return pieces.slice(index).join("")
}

/**
 * Splits text at a cell count.
 * @param text any text
 * @param cells cells the first part may take
 * @returns the graphemes that fit into `cells`, and the rest
 */
export const splitCells = (text: string, cells: number): [string, string] => {
  const pieces = graphemes(text)
  let used = 0
  let index = 0
  while (index < pieces.length && used + widthOf(pieces[index]) <= cells) used += widthOf(pieces[index++])
  return [pieces.slice(0, index).join(""), pieces.slice(index).join("")]
}

/** One grapheme of code placed on terminal cells. */
export interface PlacedText {
  /** The grapheme as written in the source; a tab stays a tab. */
  source: string
  /** What the terminal draws: the grapheme, or the spaces a tab expands to. */
  drawn: string
  /** First cell it covers, counted from the start of the code. */
  start: number
  /** Cells it covers. */
  width: number
}

/**
 * Places code on terminal cells; a tab reaches the next multiple of `tabWidth`.
 * @param text the code of one line
 * @param tabWidth cells between tab stops, at least 1
 * @param column the cell the text starts at, for tab stops when the line is drawn in pieces
 * @returns every grapheme with its cells
 */
export const placeText = (text: string, tabWidth: number, column = 0): PlacedText[] => {
  const placed: PlacedText[] = []
  for (const source of graphemes(text)) {
    const width = source === "\t" ? tabWidth - column % tabWidth : widthOf(source)
    placed.push({ source, drawn: source === "\t" ? " ".repeat(width) : source, start: column, width })
    column += width
  }
  return placed
}

/** The active theme's colours. */
export type Palette = ColorTokens

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
