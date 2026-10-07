/**
 * Which slice of a list a pane shows, computed one way for drawing and for
 * mouse hit-testing so a click lands on the row that is drawn there.
 */
import { useRef } from "react"

/**
 * The window stays where it was while the cursor moves inside it and scrolls only as far as
 * needed to bring the cursor back into view, the way every list in a desktop client behaves.
 *
 * @param cursor index the pane keeps in view
 * @param total list length
 * @param visible rows the pane has
 * @param previous first visible row of the last draw
 * @returns index of the first visible row
 */
export const windowStart = (cursor: number, total: number, visible: number, previous: number) => {
  const follow = cursor < previous ? cursor : cursor >= previous + visible ? cursor - visible + 1 : previous
  return Math.max(0, Math.min(follow, total - visible))
}

/**
 * {@link windowStart} with the last draw's first row remembered between renders.
 *
 * @param cursor index the pane keeps in view
 * @param total list length
 * @param visible rows the pane has
 * @returns index of the first visible row
 */
export const useWindowStart = (cursor: number, total: number, visible: number) => {
  const start = useRef(0)
  start.current = windowStart(cursor, total, visible, start.current)
  return start.current
}
