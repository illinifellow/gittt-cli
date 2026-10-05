/**
 * Commit graph: assigns every commit a lane and every row the line segments
 * passing through it. Lanes keep their column from row to row, so straight
 * lines continue across rows and only merges and forks bend.
 */
/** A line segment inside one row: the upper half ends at the commit, the lower half starts there. */
interface GraphEdge {
  from: number
  to: number
  part: "top" | "bottom" | "full"
  color: number
}

/** Layout of one row of the log. */
export interface GraphRow {
  column: number
  color: number
  edges: GraphEdge[]
  /** Lanes the row spans, for the graph column width. */
  width: number
}

const firstFree = (lanes: (string | null)[], from: number) => {
  for (let index = from; index < lanes.length; index++) if (lanes[index] === null) return index
  return lanes.length
}

/**
 * Lays out commits ordered children-first (as `git log --topo-order` or `--date-order` gives them).
 * A branch keeps its own lane down to the fork point, where every lane waiting
 * for that commit bends into it; a merge's second parent joins the lane already heading there.
 * A parent missing from the list (beyond the loaded range) keeps its lane open to the bottom.
 * @param commits hashes and parent hashes, newest first
 * @returns one row per commit, same order
 */
export const layoutGraph = (commits: { hash: string; parents: string[] }[]): GraphRow[] => {
  const lanes: (string | null)[] = []
  const laneColors: number[] = []
  let nextColor = 0
  return commits.map(commit => {
    let column = lanes.indexOf(commit.hash)
    const continued = column !== -1
    if (!continued) {
      column = firstFree(lanes, 0)
      lanes[column] = commit.hash
      laneColors[column] = nextColor++
    }
    const color = laneColors[column]
    const edges: GraphEdge[] = []
    lanes.forEach((hash, index) => {
      if (hash === null) return
      if (hash !== commit.hash) edges.push({ from: index, to: index, part: "full", color: laneColors[index] })
      else if (index !== column || continued) edges.push({ from: index, to: column, part: "top", color: laneColors[index] })
    })
    lanes.forEach((hash, index) => {
      if (hash === commit.hash) lanes[index] = null
    })
    commit.parents.forEach((parent, parentIndex) => {
      const existing = parentIndex === 0 ? -1 : lanes.indexOf(parent)
      if (existing !== -1) {
        edges.push({ from: column, to: existing, part: "bottom", color: parentIndex === 0 ? color : laneColors[existing] })
        return
      }
      const slot = parentIndex === 0 ? column : firstFree(lanes, column + 1)
      lanes[slot] = parent
      laneColors[slot] = parentIndex === 0 ? color : nextColor++
      edges.push({ from: column, to: slot, part: "bottom", color: laneColors[slot] })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(column, ...edges.map(edge => Math.max(edge.from, edge.to))) + 1
    return { column, color, edges, width }
  })
}
