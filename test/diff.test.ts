/**
 * Diff lines and their grounds. Catches an added line drawn as a deleted or conflicting one
 * because of what it contains: a Markdown setext underline is a run of `=` that looks like a
 * conflict marker, and only a combined diff of a conflicted file carries real markers.
 */
import { describe, expect, it } from "vitest"
import { loadDefaults } from "@/config"
import { isConflictMarkerLine, parseDiff } from "@/diff"
import { WORKING_TREE, type CommitDetails } from "@/protocol"
import { resolveTheme } from "@/theme"
import { diffLines } from "@/ui/details"

const THEME = resolveTheme(loadDefaults(), undefined)

/** The working tree as the details pane receives it, with no stopped operation. */
const DETAILS: CommitDetails = { hash: WORKING_TREE, parents: [], author: "", email: "", authorTime: 0, committer: "", message: "", files: [] }

const UNIFIED = [
  "diff --git a/History.md b/History.md",
  "--- a/History.md",
  "+++ b/History.md",
  "@@ -1,2 +1,6 @@",
  "+1.1.0 / 2026-02-01",
  "+==================",
  "+=======",
  "+",
  " 1.0.0 / 2026-01-01",
  " ==================",
].join("\n")

const COMBINED = [
  "diff --cc notes.txt",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@@ -1,1 -1,1 +1,5 @@@",
  "++<<<<<<< HEAD",
  " +ours",
  "++=======",
  "+ theirs",
  "++>>>>>>> feature",
].join("\n")

/** Draws a parsed diff and returns each hunk line's mark column and ground. */
const drawn = (text: string) => {
  const parsed = parseDiff(text)
  return diffLines(DETAILS, [], "", { file: "f", parsed, highlights: null }, false, THEME)
    .filter(line => line.gutter)
    .map(line => ({ marks: line.segments[1].text, background: line.background }))
}

describe("conflict markers", () => {
  it("never reads a run of = in an ordinary diff as a conflict marker", () => {
    const parsed = parseDiff(UNIFIED)
    expect(parsed.hunks[0].lines.map(line => isConflictMarkerLine(parsed, line))).toEqual([false, false, false, false, false, false])
  })

  it("recognises the markers git writes into a conflicted file", () => {
    const parsed = parseDiff(COMBINED)
    expect(parsed.hunks[0].lines.map(line => isConflictMarkerLine(parsed, line))).toEqual([true, false, true, false, true])
  })
})

describe("diff grounds", () => {
  it("keeps every added line on the added ground with its + sign, setext underlines included", () => {
    expect(drawn(UNIFIED).slice(0, 4)).toEqual(Array(4).fill({ marks: "+", background: THEME.colors.addedBackground }))
  })
})
