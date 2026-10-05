/**
 * Unified and combined (conflict) diff parsing into hunks with line numbers.
 */

/** One hunk of a file diff. */
export interface Hunk {
  header: string
  oldStart: number
  newStart: number
  newCount: number
  lines: string[]
}

/** A file diff split into its header and hunks. */
export interface ParsedDiff {
  header: string[]
  hunks: Hunk[]
  binary: boolean
  /** A combined diff of a conflicted file: two prefix columns per line. */
  combined: boolean
}

/**
 * Splits `git diff` output for one file into its header lines and hunks; understands combined (`diff --cc`) conflict diffs.
 * @param text unified or combined diff text
 * @returns header lines (up to the first hunk), hunks with their start lines, binary and combined flags
 */
export const parseDiff = (text: string): ParsedDiff => {
  const header: string[] = []
  const hunks: Hunk[] = []
  let binary = false
  for (const line of text.split("\n")) {
    const start = /^@@@? -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )?\+(\d+)(?:,(\d+))? @@@?/.exec(line)
    if (start) hunks.push({ header: line, oldStart: Number(start[1]), newStart: Number(start[2]), newCount: Number(start[3] ?? 1), lines: [] })
    else if (hunks.length) hunks[hunks.length - 1].lines.push(line)
    else {
      if (line.startsWith("Binary files")) binary = true
      if (line) header.push(line)
    }
  }
  const last = hunks[hunks.length - 1]
  if (last && last.lines[last.lines.length - 1] === "") last.lines.pop()
  return { header, hunks, binary, combined: header.some(line => line.startsWith("diff --cc") || line.startsWith("diff --combined")) }
}

/**
 * @param diff parsed diff
 * @returns how many prefix columns each hunk line carries: 2 for combined conflict diffs, else 1
 */
export const prefixWidth = (diff: ParsedDiff) => diff.combined ? 2 : 1
