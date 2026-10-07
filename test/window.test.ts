/**
 * The slice of a list a pane shows. Catches a window that scrolls on every cursor step instead of
 * letting the highlight move, which pins the selected row mid-pane and makes arrow keys feel
 * like scrolling.
 */
import { describe, expect, it } from "vitest"
import { windowStart } from "@/ui/window"

/** Walks the cursor through a list the way repeated key presses do, returning every window start. */
const walk = (cursors: number[], total: number, visible: number) =>
  cursors.reduce<number[]>((starts, cursor) => [...starts, windowStart(cursor, total, visible, starts.at(-1) ?? 0)], [])

describe("windowStart", () => {
  it("keeps the window still while the cursor moves inside it", () => {
    expect(walk([0, 1, 5, 19], 80, 20)).toEqual([0, 0, 0, 0])
  })

  it("scrolls one row at a time once the cursor passes the bottom edge", () => {
    expect(walk([19, 20, 21, 25], 80, 20)).toEqual([0, 1, 2, 6])
  })

  it("keeps the window still when the cursor turns back up inside it", () => {
    expect(walk([25, 20, 15, 6], 80, 20)).toEqual([6, 6, 6, 6])
  })

  it("scrolls up only as far as the cursor above the top edge", () => {
    expect(walk([25, 5, 0], 80, 20)).toEqual([6, 5, 0])
  })

  it("brings a far jump into view and never runs past the end of the list", () => {
    expect(walk([79], 80, 20)).toEqual([60])
    expect(windowStart(3, 10, 20, 0)).toBe(0)
  })
})
