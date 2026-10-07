/**
 * The log pane: the columns Graph, Description,
 * Commit, Author and Date under a header whose dividers drag, and only the rows
 * in view drawn. The graph is box-drawing characters in lane colours; ref
 * labels on tinted grounds and highlighted subjects fill the description, which
 * scrolls sideways when it does not fit.
 */
import { Box, Text } from "ink"
import type { ReactNode } from "react"
import type { Config } from "@/config"
import { formatDate } from "@/dates"
import type { GraphRow } from "@/graph"
import type { Badge, LogEntry } from "@/history"
import { drawCells } from "@/lanes"
import { splitMessage, type MessagePart } from "@/message"
import type { MouseEvent } from "@/mouse"
import { Clickable } from "@/mouse/regions"
import { WORKING_TREE, type ViewSettings } from "@/protocol"
import type { GlyphTokens } from "@/theme"
import { fit, mix, slide, widthOf, type Palette } from "./text"
import { useTheme } from "./theme"

/**
 * @param badge a ref label
 * @param glyphs the theme's icons
 * @returns the icon and space in front of the label's name
 */
export const badgeGlyph = (badge: Badge, glyphs: GlyphTokens) => `${{ branch: glyphs.branch, remote: glyphs.remote, tag: glyphs.tag, head: glyphs.commit, operation: glyphs.sync, conflict: glyphs.alert }[badge.kind]} `

/**
 * @param badge a ref label
 * @param palette colours
 * @returns its colour: the current branch, other branches, remotes, tags, HEAD and states each their own token
 */
export const badgeColor = (badge: Badge, palette: Palette) => ({ branch: badge.current ? palette.currentBranch : palette.branch, remote: palette.remote, tag: palette.tag, head: palette.danger, operation: palette.tag, conflict: palette.danger })[badge.kind]

/**
 * @param part a piece of a commit message
 * @param palette colours
 * @returns its colour, or `undefined` for plain text and emoji
 */
export const partColor = (part: MessagePart, palette: Palette) => ({ text: undefined, emoji: undefined, code: palette.tag, shortcode: palette.textMuted, url: palette.accent, prefix: palette.accent, quoted: palette.tag, issue: palette.remote, hash: palette.head })[part.kind]

/**
 * @param rows graph rows of the rows in view
 * @param columns configured widths; a width set by dragging wins
 * @param compact one cell per lane instead of two
 * @returns the graph column width in cells: configured, or what the visible rows need plus one cell, between 4 and 30
 */
export const graphWidth = (rows: GraphRow[], columns: Config["columns"], compact = false) => columns.graph ?? Math.min(30, Math.max(4, Math.max(1, ...rows.map(row => row.width)) * (compact ? 1 : 2) + 1))

/**
 * @param height pane height, header included
 * @returns rows the log list has below its header
 */
export const logListHeight = (height: number) => Math.max(1, height - 1)

/**
 * @param width pane width
 * @param graph graph column width
 * @param columns configured widths
 * @returns the description column width
 */
export const descriptionWidth = (width: number, graph: number, columns: Config["columns"]) => Math.max(10, width - (graph + columns.hash + columns.author + columns.date + 4))

/** Columns whose right edge drags. */
export type LogColumn = "graph" | "description" | "hash" | "author"

/** What the log reports to the screen. */
export interface LogEvents {
  onRow: (index: number, gesture: "click" | "double" | "right", event: MouseEvent) => void
  onWheel: (step: number, event: MouseEvent) => void
  onColumnPress: (column: LogColumn, event: MouseEvent) => ((event: MouseEvent) => void) | void
  /** A click on a row's hash: copy the full hash. */
  onHash: (index: number) => void
}

/**
 * Draws the log pane: the column header with draggable dividers and the visible rows.
 * @param props.entries log rows from `buildLog`, working tree first when there are changes
 * @param props.rows their graph layout, same order
 * @param props.cursor index of the selected row
 * @param props.start first visible row, from `useWindowStart` in the screen so drawing and graph width agree
 * @param props.width pane width in cells
 * @param props.height pane height in rows, header included
 * @param props.focused whether the pane has the keyboard
 * @param props.headHash HEAD's commit, drawn with a ring
 * @param props.settings view settings (dates, gitmoji, compact)
 * @param props.columns configured column widths
 * @param props.found indexes of rows matching the search
 * @param props.query the search text; non-matching rows dim while it is set
 * @param props.truncated whether more commits exist than were loaded
 * @param props.scrollX cells the description scrolled sideways
 * @param props.events row clicks, hash clicks, wheel and divider drags
 */
export const LogPane = ({ entries, rows, cursor, start, width, height, focused, headHash, settings, columns, found, query, truncated, scrollX, events }: {
  entries: LogEntry[]
  rows: GraphRow[]
  cursor: number
  start: number
  width: number
  height: number
  focused: boolean
  headHash: string | null
  settings: ViewSettings
  columns: Config["columns"]
  found: Set<number>
  query: string
  truncated: boolean
  scrollX: number
  events: LogEvents
}) => {
  const { colors: palette, glyphs } = useTheme()
  const listHeight = logListHeight(height)
  const graph = graphWidth(rows.slice(start, start + listHeight), columns, settings.compact)
  const description = descriptionWidth(width, graph, columns)
  const headerColumns: [string, number, LogColumn | null][] = [["Graph", graph, "graph"], ["Description", description, "description"], ["Commit", columns.hash, "hash"], ["Author", columns.author, "author"], ["Date", columns.date, null]]
  const headerGround = palette.header
  return (
    <Clickable flexDirection="column" width={width} height={height} onWheel={events.onWheel}>
      <Box height={1} overflow="hidden">
        {headerColumns.map(([label, size, column]) => (
          <Box key={label}>
            <Text backgroundColor={headerGround} color={focused ? palette.text : palette.textMuted} bold>{fit(` ${label}`, column ? size : Math.max(1, size))}</Text>
            {column ? (
              <Clickable onPress={event => events.onColumnPress(column, event)}>
                <Text backgroundColor={headerGround} color={palette.textMuted}>{glyphs.divider}</Text>
              </Clickable>
            ) : null}
          </Box>
        ))}
      </Box>
      {!entries.length ? <Text color={palette.textMuted}>{fit("  No commits yet", width)}</Text> : null}
      {entries.slice(start, start + listHeight).map((entry, offset) => {
        const index = start + offset
        const working = entry.hash === WORKING_TREE
        const selected = index === cursor
        const background = selected ? (focused ? palette.selection : palette.selectionInactive) : undefined
        const dimmed = Boolean(query) && !found.has(index)
        const drawn = drawCells(rows[index], working ? "working" : entry.hash === headHash ? "head" : "plain", glyphs.graph)
        const cells = (settings.compact ? drawn.filter((_, cell) => cell % 2 === 0) : drawn).slice(0, graph)
        const parts = working ? [{ kind: "text" as const, text: entry.subject }] : splitMessage(entry.subject, settings.gitmoji)
        let skip = scrollX
        let remaining = description
        const pieces: ReactNode[] = []
        const place = (text: string, draw: (piece: string) => ReactNode) => {
          const shown = slide(text, skip)
          skip = Math.max(0, skip - widthOf(text))
          if (!shown || remaining <= 0) return
          const piece = widthOf(shown) > remaining ? fit(shown, remaining) : shown
          remaining -= widthOf(piece)
          pieces.push(draw(piece))
        }
        entry.badges.forEach((badge, badgeIndex) => {
          place(` ${badgeGlyph(badge, glyphs)}${badge.name} `, piece => <Text key={`badge${badgeIndex}`} backgroundColor={mix(badgeColor(badge, palette), palette.background, palette.labelGround)} color={badgeColor(badge, palette)} bold={badge.current || badge.kind === "head"}>{piece}</Text>)
          place(" ", piece => <Text key={`gap${badgeIndex}`}>{piece}</Text>)
        })
        parts.forEach((part, partIndex) => place(part.text, piece => <Text key={`part${partIndex}`} color={working ? palette.textMuted : partColor(part, palette) ?? palette.text} italic={working} bold={part.kind === "prefix"} underline={Boolean(query) && found.has(index)}>{piece}</Text>))
        const author = entry.email && !settings.compact ? `${entry.author} <${entry.email}>` : entry.author
        return (
          <Clickable key={entry.hash} height={1} width={width} onClick={event => events.onRow(index, "click", event)} onDoubleClick={event => events.onRow(index, "double", event)} onRightClick={event => events.onRow(index, "right", event)}>
            <Text backgroundColor={background} dimColor={dimmed} wrap="truncate-end">
              {cells.map((cell, cellIndex) => <Text key={cellIndex} color={cell.color === null ? palette.textMuted : palette.lanes[cell.color % palette.lanes.length]}>{cell.char}</Text>)}
              <Text>{" ".repeat(Math.max(0, graph - cells.length) + 1)}</Text>
              {pieces}
              <Text>{" ".repeat(Math.max(0, remaining) + 1)}</Text>
            </Text>
            <Clickable onClick={() => events.onHash(index)}>
              <Text backgroundColor={background} dimColor={dimmed} color={selected ? palette.text : palette.textMuted}>{fit(working ? "" : entry.hash.slice(0, 7), columns.hash)}</Text>
            </Clickable>
            <Text backgroundColor={background} dimColor={dimmed} color={selected ? palette.text : palette.textMuted} wrap="truncate-end"> {fit(author, columns.author)} {fit(working ? "" : formatDate(entry.time, settings.dateFormat), columns.date)}</Text>
          </Clickable>
        )
      })}
      {truncated && start + listHeight >= entries.length ? <Text color={palette.textMuted}>{fit("  more commits than maxCommits", width)}</Text> : null}
    </Clickable>
  )
}
