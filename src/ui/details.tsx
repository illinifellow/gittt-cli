/**
 * The lower half, read-only: the selected row's
 * files (sorted by path, by status, or as a tree) on the left; on the right the
 * commit header (or the stopped operation) and the selected file's diff, hunk
 * by hunk, with old and new line numbers and syntax colours.
 */
import { Text } from "ink"
import { prefixWidth, type ParsedDiff } from "@/diff"
import { FILE_STATUSES, fileRows, type FileRow, type FileView } from "@/files"
import type { Badge } from "@/history"
import type { Segment } from "@/highlight"
import { splitMessage } from "@/message"
import { formatDate } from "@/dates"
import { WORKING_TREE, type CommitDetails } from "@/protocol"
import { badgeColor, badgeGlyph, partColor } from "./log"
import type { MouseEvent } from "@/mouse"
import { Clickable, type LocalMouseEvent } from "@/mouse/regions"
import type { Theme } from "@/theme"
import { fit, mix, slide, widthOf } from "./text"
import { useTheme } from "./theme"
import { windowStart } from "./window"

/** One drawn line of the diff pane. */
interface DiffLine {
  segments: Segment[]
  /** The first two segments are line numbers and diff marks, which do not scroll sideways. */
  gutter?: boolean
  background?: string
  /** New-side line number, for opening the file there. */
  line?: number
  /** Text a click on the line copies to the clipboard. */
  copy?: string
}

/**
 * @param details commit or working-tree details
 * @param view list view
 * @returns the rows the files pane shows, folders included
 */
export const filesOf = (details: CommitDetails | null, view: FileView): FileRow[] => details ? fileRows(details.files, view) : []

/**
 * Builds every line of the diff pane.
 * @param details the selected row's details
 * @param badges refs on the commit
 * @param operation sentence describing a stopped operation, for the working tree
 * @param diff parsed diff of the selected file and its highlighted code, if loaded
 * @param gitmoji whether shortcodes in the message become emoji
 * @param theme colours and glyphs
 * @returns lines top to bottom
 */
export const diffLines = (details: CommitDetails | null, badges: Badge[], operation: string, diff: { file: string; parsed: ParsedDiff; highlights: Segment[][][] | null } | null, gitmoji: boolean, theme: Theme): DiffLine[] => {
  const { colors: palette, glyphs } = theme
  if (!details) return []
  const lines: DiffLine[] = []
  const field = (label: string, segments: Segment[]) => lines.push({ segments: [{ text: `${label.padStart(10)}: `, color: palette.textMuted }, ...segments] })
  if (details.hash === WORKING_TREE) {
    if (operation) lines.push({ segments: [{ text: ` ${glyphs.alert} ${operation}`, color: palette.stash, bold: true }] }, { segments: [] })
  } else {
    field("Commit", [{ text: details.hash }, { text: ` [${details.hash.slice(0, 7)}]`, color: palette.textMuted }])
    lines[lines.length - 1].copy = details.hash
    field(details.parents.length > 1 ? "Parents" : "Parent", [{ text: details.parents.map(parent => parent.slice(0, 7)).join(", ") || "none", color: palette.accent }])
    lines[lines.length - 1].copy = details.parents.join(" ")
    field("Author", [{ text: details.author }, { text: ` <${details.email}>`, color: palette.textMuted }])
    field("Date", [{ text: formatDate(details.authorTime, "absolute") }])
    if (details.committer !== details.author) field("Committer", [{ text: details.committer }])
    if (badges.length) field("Labels", badges.flatMap(badge => [{ text: ` ${badgeGlyph(badge, glyphs)}${badge.name} `, color: badgeColor(badge, palette), background: mix(badgeColor(badge, palette), palette.background, palette.labelGround), bold: badge.current }, { text: " " }]))
    lines.push({ segments: [] })
    for (const messageLine of details.message.split("\n"))
      lines.push({ segments: [{ text: "            " }, ...splitMessage(messageLine, gitmoji).map(part => ({ text: part.text, color: partColor(part, palette) ?? palette.text, bold: part.kind === "prefix" }))] })
    lines.push({ segments: [] })
  }
  if (!diff) return lines
  lines.push({ segments: [{ text: ` ${glyphs.file} ${diff.file}`, bold: true, color: palette.text }], background: palette.header, line: 1 })
  if (diff.parsed.binary) return [...lines, { segments: [{ text: "   Binary file", color: palette.textMuted }] }]
  if (!diff.parsed.hunks.length) return [...lines, { segments: [{ text: "   No content changes", color: palette.textMuted }] }]
  const prefix = prefixWidth(diff.parsed)
  diff.parsed.hunks.forEach((hunk, hunkIndex) => {
    const last = hunk.newStart + Math.max(hunk.newCount, 1) - 1
    lines.push({ segments: [] }, { segments: [{ text: ` Hunk ${hunkIndex + 1} : Lines ${hunk.newStart}-${last}`, color: palette.textMuted }], background: palette.header, line: hunk.newStart })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    hunk.lines.forEach((text, lineIndex) => {
      const marks = text.slice(0, prefix)
      const conflict = /^[+ -]{0,2}(<{7}|={7}|>{7}|\|{7})/.test(text)
      const kind = text[0] === "\\" ? "note" : conflict ? "conflict" : marks.includes("+") ? "add" : marks.includes("-") ? "remove" : "context"
      const left = kind === "add" || kind === "note" || kind === "conflict" ? "" : String(oldLine++)
      const right = kind === "remove" || kind === "note" ? "" : String(newLine++)
      const code = diff.highlights?.[hunkIndex]?.[lineIndex]
      const background = kind === "add" ? palette.addedBackground : kind === "remove" ? palette.deletedBackground : kind === "conflict" ? palette.deletedBackground : undefined
      lines.push({
        background,
        gutter: true,
        line: right ? Number(right) : undefined,
        segments: [
          { text: `${left.padStart(5)} ${right.padStart(5)} `, color: palette.textMuted },
          { text: marks, color: kind === "add" ? palette.added : kind === "remove" || kind === "conflict" ? palette.deleted : palette.textMuted, bold: kind === "conflict" },
          ...(kind === "note" ? [{ text: text, color: palette.textMuted, italic: true }] : code && kind !== "conflict" ? code : [{ text: text.slice(prefix), color: kind === "conflict" ? palette.stash : palette.text, bold: kind === "conflict" }]),
        ],
      })
    })
  })
  return lines
}

/** What the lower panes report to the screen. */
export interface DetailsEvents {
  onFile: (index: number, gesture: "click" | "double", event: MouseEvent) => void
  onFilesHeader: () => void
  onFilesWheel: (step: number, event: MouseEvent) => void
  onLine: (index: number, gesture: "click" | "double", event: MouseEvent) => void
  onDiffWheel: (step: number, event: MouseEvent) => void
  /** A press in the diff: returns the drag that extends the selection and copies it on release. */
  onSelect: (event: LocalMouseEvent) => ((event: LocalMouseEvent) => void) | void
}

/**
 * Draws the files pane: a header naming the view (a click cycles it) and the visible rows.
 * @param props.rows file and folder rows from `filesOf`
 * @param props.cursor index of the highlighted row
 * @param props.width pane width in cells
 * @param props.height pane height in rows, header included
 * @param props.focused whether the pane has the keyboard
 * @param props.view current list view, for the header
 * @param props.working whether the rows are pending files ("Pending files") or a commit's ("Files")
 * @param props.scrollX cells scrolled sideways
 * @param props.viewKey the key that cycles the view, shown in the header
 * @param props.events clicks, double clicks and wheel
 */
export const FilesPane = ({ rows, cursor, width, height, focused, view, working, scrollX, viewKey, events }: {
  rows: FileRow[]
  cursor: number
  width: number
  height: number
  focused: boolean
  view: FileView
  working: boolean
  scrollX: number
  viewKey: string
  events: DetailsEvents
}) => {
  const { colors: palette, glyphs, spacing } = useTheme()
  const listHeight = Math.max(1, height - 1)
  const start = windowStart(cursor, rows.length, listHeight, 1 / 2)
  const noun = working ? "Pending files" : "Files"
  const sort: Record<FileView, string> = { path: "sorted by path", status: "sorted by file status", tree: "tree view" }
  const fileCount = rows.filter(row => row.kind === "file").length
  return (
    <Clickable flexDirection="column" width={width} height={height} onWheel={events.onFilesWheel}>
      <Clickable height={1} onClick={events.onFilesHeader}>
        <Text color={focused ? palette.accent : palette.textMuted} bold>{fit(` ${noun}, ${sort[view]} ${glyphs.dropdown} (${viewKey})`, width - 5)}{String(fileCount).padStart(5)}</Text>
      </Clickable>
      {!rows.length ? <Text color={palette.textMuted}>{fit(working ? "   Nothing to commit" : "   No files changed", width)}</Text> : null}
      {rows.slice(start, start + listHeight).map((row, offset) => {
        const index = start + offset
        const selected = index === cursor
        const background = selected ? (focused ? palette.selection : palette.selectionInactive) : undefined
        const indent = " ".repeat(row.depth * spacing.indent + 1)
        if (row.kind === "folder")
          return (
            <Clickable key={`folder:${index}`} height={1} onClick={event => events.onFile(index, "click", event)}>
              <Text backgroundColor={background} color={palette.textMuted}>{fit(slide(`${indent}${glyphs.folder} ${row.name}/`, scrollX), width)}</Text>
            </Clickable>
          )
        const status = FILE_STATUSES[row.file.status] ?? FILE_STATUSES.M
        const tone = palette[status.tone]
        const name = slide(`${row.folder}${row.name}`, scrollX)
        const folderShown = Math.max(0, widthOf(row.folder) - scrollX)
        return (
          <Clickable key={row.file.path} height={1} width={width} onClick={event => events.onFile(index, "click", event)} onDoubleClick={event => events.onFile(index, "double", event)}>
            <Text backgroundColor={background} wrap="truncate-end">
              <Text>{indent}</Text>
              <Text color={tone} bold>{glyphs.status[status.tone]} </Text>
              <Text color={palette.textMuted}>{[...name].slice(0, folderShown).join("")}</Text>
              <Text color={palette.text}>{fit([...name].slice(folderShown).join(""), Math.max(1, width - indent.length - 2 - folderShown))}</Text>
            </Text>
          </Clickable>
        )
      })}
    </Clickable>
  )
}

/** A text selection in the diff pane: line indexes into the pane's lines, character columns into their text. */
export interface DiffSelection {
  anchor: { line: number; column: number }
  focus: { line: number; column: number }
}

/** @returns the selection with its start before its end */
const ordered = (selection: DiffSelection) => {
  const { anchor, focus } = selection
  return anchor.line < focus.line || (anchor.line === focus.line && anchor.column <= focus.column) ? [anchor, focus] : [focus, anchor]
}

/**
 * @param line a line of the diff pane
 * @returns the line's selectable text: the code without line numbers and marks for diff lines, everything otherwise
 */
export const lineText = (line: DiffLine) => (line.gutter ? line.segments.slice(2) : line.segments).map(segment => segment.text).join("")

/**
 * @param line a line of the diff pane
 * @returns the width in cells of its pinned gutter (line numbers and marks), 0 for lines without one
 */
export const gutterWidth = (line: DiffLine) => line.gutter ? widthOf(line.segments.slice(0, 2).map(segment => segment.text).join("")) : 0

/**
 * @param lines the pane's lines
 * @param selection the selection
 * @returns the selected text, lines joined with newlines
 */
export const selectedText = (lines: DiffLine[], selection: DiffSelection) => {
  const [start, end] = ordered(selection)
  return lines.slice(start.line, end.line + 1).map((line, offset) => {
    const index = start.line + offset
    const text = [...lineText(line)]
    return text.slice(index === start.line ? start.column : 0, index === end.line ? end.column + 1 : text.length).join("")
  }).join("\n")
}

/**
 * Draws the visible part of the diff pane; line numbers stay put while the code scrolls sideways, and a dragged selection is highlighted character by character.
 * @param props.lines every line of the pane from `diffLines`
 * @param props.scroll index of the first visible line
 * @param props.scrollX characters scrolled sideways
 * @param props.cursorLine line with the keyboard cursor
 * @param props.selection the current text selection, or `null`
 * @param props.width pane width in cells
 * @param props.height pane height in rows
 * @param props.focused whether the pane has the keyboard (the cursor line is drawn only then)
 * @param props.events clicks, double clicks, wheel and the selection drag
 */
export const DiffPane = ({ lines, scroll, scrollX, cursorLine, selection, width, height, focused, events }: {
  lines: DiffLine[]
  scroll: number
  scrollX: number
  cursorLine: number
  selection: DiffSelection | null
  width: number
  height: number
  focused: boolean
  events: DetailsEvents
}) => {
  const { colors: palette } = useTheme()
  const range = selection ? ordered(selection) : null
  return (
    <Clickable flexDirection="column" width={width} height={height} onWheel={events.onDiffWheel} onPress={event => events.onSelect(event)}>
      {lines.slice(scroll, scroll + height).map((line, offset) => {
        const index = scroll + offset
        const cursor = focused && index === cursorLine && !selection
        const pinned = line.gutter ? line.segments.slice(0, 2) : []
        const body = line.gutter ? line.segments.slice(2) : line.segments
        const selectedFrom = range && index >= range[0].line && index <= range[1].line ? (index === range[0].line ? range[0].column : 0) : Infinity
        const selectedTo = range && index >= range[0].line && index <= range[1].line ? (index === range[1].line ? range[1].column : Infinity) : -1
        const runs: { text: string; segment: Segment; selected: boolean }[] = []
        let used = pinned.reduce((total, segment) => total + widthOf(segment.text), 0)
        let position = 0
        walk: for (const segment of body) {
          if (position + segment.text.length <= scrollX) {
            position += segment.text.length
            continue
          }
          for (const character of segment.text) {
            if (position++ < scrollX) continue
            const size = widthOf(character)
            if (used + size > width) break walk
            used += size
            const selected = position - 1 >= selectedFrom && position - 1 <= selectedTo
            const last = runs[runs.length - 1]
            if (last && last.segment === segment && last.selected === selected) last.text += character
            else runs.push({ text: character, segment, selected })
          }
        }
        return (
          <Clickable key={index} height={1} width={width} onClick={event => events.onLine(index, "click", event)} onDoubleClick={event => events.onLine(index, "double", event)}>
            <Text backgroundColor={cursor ? palette.selection : line.background} wrap="truncate-end">
              {pinned.map((segment, segmentIndex) => <Text key={`pin${segmentIndex}`} color={segment.color ?? palette.text} bold={segment.bold}>{segment.text}</Text>)}
              {runs.map((run, runIndex) => <Text key={runIndex} color={run.segment.color ?? palette.text} backgroundColor={run.selected ? palette.selection : run.segment.background} bold={run.segment.bold} italic={run.segment.italic}>{run.text}</Text>)}
              <Text>{" ".repeat(Math.max(0, width - used))}</Text>
            </Text>
          </Clickable>
        )
      })}
    </Clickable>
  )
}
