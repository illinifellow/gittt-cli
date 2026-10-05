/**
 * Turns a graph row (lanes and edges from the graph layout) into terminal
 * cells: two cells per lane, the lane's line in the first and horizontal runs
 * through the second, corners where a branch forks or merges. The characters
 * come from the theme.
 */
import type { GraphRow } from "@/graph"
import type { GlyphTokens } from "@/theme"

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

/** @returns the character for a set of connections, from the theme's graph glyphs */
const glyphFor = (mask: number, graph: GlyphTokens["graph"]) => ({
  [UP | DOWN]: graph.vertical, [LEFT | RIGHT]: graph.horizontal, [UP | LEFT]: graph.upLeft, [UP | RIGHT]: graph.upRight, [DOWN | LEFT]: graph.downLeft, [DOWN | RIGHT]: graph.downRight,
  [UP | DOWN | LEFT]: graph.teeLeft, [UP | DOWN | RIGHT]: graph.teeRight, [UP | LEFT | RIGHT]: graph.teeUp, [DOWN | LEFT | RIGHT]: graph.teeDown, [UP | DOWN | LEFT | RIGHT]: graph.cross,
  [UP]: graph.endUp, [DOWN]: graph.endDown, [LEFT]: graph.horizontal, [RIGHT]: graph.horizontal,
} as Record<number, string>)[mask] ?? graph.cross

/**
 * @param row the row's lanes and edges
 * @param marker node look: `head`, `working` or a plain commit
 * @param graph the theme's graph characters
 * @returns two cells per lane
 */
export const drawCells = (row: GraphRow, marker: "head" | "working" | "plain", graph: GlyphTokens["graph"]): Cell[] => {
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
    if (cell === row.column * 2) return { char: marker === "head" ? graph.head : marker === "working" ? graph.working : graph.node, color: marker === "working" ? null : row.color }
    return { char: mask ? glyphFor(mask, graph) : " ", color: colors[cell] }
  })
}
