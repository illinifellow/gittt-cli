/**
 * Which slice of a list a pane shows, computed one way for drawing and for
 * mouse hit-testing so a click lands on the row that is drawn there.
 */

/**
 * @param cursor index the pane keeps in view
 * @param total list length
 * @param visible rows the pane has
 * @param bias fraction of the pane above the cursor (1/2 centres it)
 * @returns index of the first visible row
 */
export const windowStart = (cursor: number, total: number, visible: number, bias: number) =>
  Math.max(0, Math.min(cursor - Math.floor(visible * bias), total - visible))
