/**
 * Turns a graph row (lanes and edges from the graph layout) into terminal
 * cells drawn with box-drawing characters: two cells per lane, the lane's line
 * in the first and horizontal runs through the second, rounded corners where a
 * branch forks or merges.
 */
import type { GraphRow } from "@/graph"

/** One terminal cell of the graph column. */
interface Cell {
  char: string
  /** Index into the lane palette, or `null` for blank cells. */
  color: number | null
}

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

const GLYPHS: Record<number, string> = {
  [UP | DOWN]: "│", [LEFT | RIGHT]: "─", [UP | LEFT]: "╯", [UP | RIGHT]: "╰", [DOWN | LEFT]: "╮", [DOWN | RIGHT]: "╭",
  [UP | DOWN | LEFT]: "┤", [UP | DOWN | RIGHT]: "├", [UP | LEFT | RIGHT]: "┴", [DOWN | LEFT | RIGHT]: "┬", [UP | DOWN | LEFT | RIGHT]: "┼",
  [UP]: "╵", [DOWN]: "╷", [LEFT]: "─", [RIGHT]: "─",
}

/**
 * @param row the row's lanes and edges
 * @param marker node look: `head` ◉, `working` ◌, otherwise ●
 * @returns two cells per lane
 */
export const drawCells = (row: GraphRow, marker: "head" | "working" | "plain"): Cell[] => {
  const width = row.width * 2
  const masks = new Array<number>(width).fill(0)
  const colors = new Array<number | null>(width).fill(null)
  const mark = (cell: number, mask: number, color: number) => {
    masks[cell] |= mask
    colors[cell] = color
  }
  const run = (from: number, to: number, color: number) => {
    for (let cell = Math.min(from, to) + 1; cell < Math.max(from, to); cell++) mark(cell, LEFT | RIGHT, color)
  }
  for (const edge of row.edges) {
    const from = edge.from * 2
    const to = edge.to * 2
    if (edge.part === "full") mark(from, UP | DOWN, edge.color)
    else if (edge.part === "top") {
      if (from === to) mark(from, UP, edge.color)
      else {
        mark(from, UP | (from > to ? LEFT : RIGHT), edge.color)
        run(from, to, edge.color)
      }
    } else if (from === to) mark(from, DOWN, edge.color)
    else {
      mark(to, DOWN | (to > from ? LEFT : RIGHT), edge.color)
      run(from, to, edge.color)
    }
  }
  return masks.map((mask, cell) => {
    if (cell === row.column * 2) return { char: marker === "head" ? "◉" : marker === "working" ? "◌" : "●", color: marker === "working" ? null : row.color }
    return { char: mask ? GLYPHS[mask] ?? "┼" : " ", color: colors[cell] }
  })
}
