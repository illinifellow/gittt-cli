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

/** A line git writes around conflicting changes: `<<<<<<<`, `|||||||`, `=======` or `>>>>>>>`, alone or before a label. */
const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/m

/**
 * @param text a file's text
 * @returns whether it still holds a conflict marker line, so marking it resolved would commit the markers
 */
export const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text)

/**
 * @param diff the parsed diff the line belongs to
 * @param line one hunk line, prefix columns included
 * @returns whether the line is a conflict marker git wrote into a conflicted file: only combined
 *   diffs carry them, so a Markdown setext underline or any other run of `=` stays an ordinary line
 */
export const isConflictMarkerLine = (diff: ParsedDiff, line: string) => diff.combined && CONFLICT_MARKER.test(line.slice(prefixWidth(diff)))
