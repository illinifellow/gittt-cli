/**
 * Commit graph layout and its terminal drawing. Catches lanes that jump
 * columns, merges joined to the wrong lane, rows that do not connect, and
 * box-drawing characters that point the wrong way.
 */
import { describe, expect, it } from "vitest"
import { layoutGraph } from "@/graph"
import { loadDefaults } from "@/config"
import { drawCells } from "@/lanes"

const GRAPH = loadDefaults().themes.dark.glyphs!.graph!
import { DEFAULT_COLUMNS } from "./columns"
import { graphWidth } from "@/ui/log"

const commit = (hash: string, ...parents: string[]) => ({ hash, parents })

describe("layoutGraph", () => {
  /** A straight history stays in one lane. */
  it("keeps a linear history in the first lane", () => {
    const rows = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")])
    expect(rows.map(row => row.column)).toEqual([0, 0, 0])
    expect(rows.every(row => row.width === 1)).toBe(true)
  })

  /** A branch keeps its own lane down to the fork, where both lanes meet, and both lanes meet at the fork commit. */
  it("converges lanes at the fork commit", () => {
    const rows = layoutGraph([commit("m", "a", "f"), commit("f", "a"), commit("a")])
    expect(rows[1].column).toBe(1)
    expect(rows[2].edges.filter(edge => edge.part === "top").map(edge => edge.from).sort()).toEqual([0, 1])
  })

  /** Every lane leaving a row arrives in the next one. */
  it("connects every row to the next one", () => {
    const rows = layoutGraph([commit("h", "g", "e"), commit("g", "f"), commit("e", "d"), commit("f", "c", "d"), commit("d", "c"), commit("c", "b"), commit("b", "a"), commit("a")])
    rows.slice(0, -1).forEach((row, index) => {
      const leaving = [...new Set(row.edges.filter(edge => edge.part !== "top").map(edge => edge.to))].sort()
      const arriving = [...new Set(rows[index + 1].edges.filter(edge => edge.part !== "bottom").map(edge => edge.from))].sort()
      expect(arriving).toEqual(leaving)
    })
  })

  /** An octopus merge opens one lane per extra parent. */
  it("opens a lane for every parent of an octopus merge", () => {
    const rows = layoutGraph([commit("o", "a", "b", "c"), commit("c", "a"), commit("b", "a"), commit("a")])
    expect(rows[0].edges.filter(edge => edge.part === "bottom").map(edge => edge.to).sort()).toEqual([0, 1, 2])
  })
})

describe("drawCells", () => {
  /** A merge row draws its node, a horizontal run and a corner turning down into the new lane. */
  it("draws a merge with a corner", () => {
    const [row] = layoutGraph([commit("m", "a", "f")])
    expect(drawCells(row, "plain", GRAPH).map(cell => cell.char).join("").trimEnd()).toBe("●─╮")
  })

  /** The fork row draws the incoming lane bending up-left into the node. */
  it("draws a fork with a closing corner", () => {
    const rows = layoutGraph([commit("m", "a", "f"), commit("f", "a"), commit("a")])
    expect(drawCells(rows[2], "head", GRAPH).map(cell => cell.char).join("").trimEnd()).toBe("◉─╯")
  })
})

describe("graphWidth", () => {
  /** The column fits the rows in view: one lane needs three cells, never less than four. */
  it("fits the lanes of the visible rows", () => {
    const rows = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")])
    expect(graphWidth(rows, DEFAULT_COLUMNS)).toBe(4)
  })

  /** A burst of parallel branches outside the view does not widen the column for the rows on screen. */
  it("ignores lanes of rows out of view", () => {
    const wide = layoutGraph([commit("o", "a", "b", "c", "d", "e"), commit("e", "a"), commit("d", "a"), commit("c", "a"), commit("b", "a"), commit("a", "z"), commit("z")])
    expect(graphWidth(wide.slice(0, 1), DEFAULT_COLUMNS)).toBe(11)
    expect(graphWidth(wide.slice(6), DEFAULT_COLUMNS)).toBe(4)
  })

  /** A width set by dragging the divider wins over the computed one. */
  it("keeps a dragged width", () => {
    expect(graphWidth(layoutGraph([commit("a")]), { ...DEFAULT_COLUMNS, graph: 17 })).toBe(17)
  })
})
