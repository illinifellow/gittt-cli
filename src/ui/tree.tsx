/**
 * The sidebar: every repository of the catalogue as a row
 * with its counts and head branch, and inside it WORKSPACE (File status,
 * History, Search), BRANCHES, REMOTES, TAGS and STASHES. Catalogue buttons sit
 * on top (Add, Rescan, move the selected repository up or down); the filter (`/`) shows at the bottom only while in use; every row,
 * twisty and button takes the mouse, and long names scroll sideways.
 */
import { Box, Text } from "ink"
import type { MouseEvent } from "@/mouse"
import { Clickable } from "@/mouse/regions"
import type { Repository } from "@/protocol"
import type { KeyBindings } from "@/config"
import type { GlyphTokens } from "@/theme"
import { fit, slide, widthOf, type Palette } from "./text"
import { useTheme } from "./theme"
import { windowStart } from "./window"

/** A right-aligned extra on a row; pills sit on a tinted ground. */
interface Meta {
  text: string
  color: string
  pill?: boolean
}

/** One visible row of the sidebar. */
export interface TreeNode {
  key: string
  kind: "repository" | "section" | "workspace" | "remoteGroup" | "branch" | "remote" | "tag" | "stash" | "error"
  depth: number
  label: string
  path: string
  /** Expansion key this row folds. */
  toggle?: string
  open?: boolean
  ref?: string
  hash?: string
  stash?: string
  current?: boolean
  /** WORKSPACE entries: which view they open. */
  view?: "status" | "history" | "search"
  meta?: Meta[]
}

/**
 * @param path repository root
 * @param section section name (`branches`, `remotes`, `remote:origin`…)
 * @returns the key under which the section's open state is kept
 */
export const sectionKey = (path: string, section: string) => `${path}|${section}`

/** Catalogue buttons above the sidebar list. */
const TREE_ACTIONS = ["add", "rescan", "up", "down"] as const

/** @returns the icon a row kind shows */
const glyphOf = (node: TreeNode, glyphs: GlyphTokens) => {
  if (node.kind === "section") return ({ WORKSPACE: glyphs.workspace, BRANCHES: glyphs.branch, REMOTES: glyphs.remote, TAGS: glyphs.tag, STASHES: glyphs.stash } as Record<string, string>)[node.label] ?? ""
  if (node.kind === "workspace") return node.view === "status" ? glyphs.fileStatus : node.view === "history" ? glyphs.history : glyphs.search
  return { repository: glyphs.repository, remoteGroup: glyphs.remote, branch: glyphs.branch, remote: glyphs.branch, tag: glyphs.tag, stash: glyphs.stash, error: glyphs.alert }[node.kind] ?? ""
}

const matches = (text: string, filter: string) => !filter || text.toLowerCase().includes(filter)

/**
 * Flattens the sidebar into rows.
 * @param repositories repositories in display order
 * @param expanded keys of open nodes
 * @param filterText filter typed by the user
 * @param palette colours for counts
 * @param glyphs ahead, behind and branch marks
 * @returns rows top to bottom
 */
export const flattenTree = (repositories: Repository[], expanded: Set<string>, filterText: string, palette: Palette, glyphs: GlyphTokens): TreeNode[] => {
  const filter = filterText.trim().toLowerCase()
  const nodes: TreeNode[] = []
  for (const repository of repositories) {
    const { path } = repository
    const branches = repository.branches.filter(branch => matches(branch.name, filter))
    const remotes = repository.remotes.map(remote => ({ ...remote, branches: remote.branches.filter(branch => matches(`${remote.name}/${branch.name}`, filter)) })).filter(remote => remote.branches.length)
    const tags = repository.tags.filter(tag => matches(tag.name, filter))
    const stashes = repository.stashes.filter(stash => matches(stash.message, filter))
    const nameMatches = matches(repository.name, filter)
    if (!nameMatches && !branches.length && !remotes.length && !tags.length && !stashes.length) continue
    const forced = Boolean(filter) && !nameMatches
    const isOpen = (key: string) => forced || expanded.has(key)
    const current = repository.branches.find(branch => branch.current)
    nodes.push({ key: path, kind: "repository", depth: 0, label: repository.name, path, toggle: path, open: isOpen(path), meta: [
      ...(repository.changes ? [{ text: String(repository.changes), color: palette.modified, pill: true }] : []),
      ...(current?.ahead ? [{ text: `${current.ahead}${glyphs.ahead}`, color: palette.added, pill: true }] : []),
      ...(current?.behind ? [{ text: `${current.behind}${glyphs.behind}`, color: palette.stash, pill: true }] : []),
      { text: `${glyphs.branch} ${repository.head.branch ?? repository.head.hash?.slice(0, 7) ?? "empty"}`, color: palette.head },
    ] })
    if (!isOpen(path)) continue
    if (repository.error) nodes.push({ key: `${path}#error`, kind: "error", depth: 1, label: repository.error, path })
    const section = (name: string, label: string, count: number | null) => {
      const key = sectionKey(path, name)
      nodes.push({ key, kind: "section", depth: 1, label, path, toggle: key, open: isOpen(key), meta: count === null ? [] : [{ text: String(count), color: palette.textMuted }] })
      return isOpen(key)
    }
    if (section("workspace", "WORKSPACE", null)) {
      nodes.push({ key: `${path}#w:status`, kind: "workspace", depth: 2, label: "File status", path, view: "status", meta: repository.changes ? [{ text: String(repository.changes), color: palette.modified, pill: true }] : [] })
      nodes.push({ key: `${path}#w:history`, kind: "workspace", depth: 2, label: "History", path, view: "history" })
      nodes.push({ key: `${path}#w:search`, kind: "workspace", depth: 2, label: "Search", path, view: "search" })
    }
    if (section("branches", "BRANCHES", branches.length))
      for (const branch of branches)
        nodes.push({ key: `${path}#b:${branch.name}`, kind: "branch", depth: 2, label: branch.name, path, ref: branch.name, hash: branch.hash, current: branch.current, meta: [
          ...(branch.gone ? [{ text: "gone", color: palette.stash }] : []),
          ...(branch.ahead ? [{ text: `${branch.ahead}${glyphs.ahead}`, color: palette.added, pill: true }] : []),
          ...(branch.behind ? [{ text: `${branch.behind}${glyphs.behind}`, color: palette.stash, pill: true }] : []),
        ] })
    if (section("remotes", "REMOTES", remotes.length))
      for (const remote of remotes) {
        const key = sectionKey(path, `remote:${remote.name}`)
        nodes.push({ key, kind: "remoteGroup", depth: 2, label: remote.name, path, toggle: key, open: isOpen(key), meta: [{ text: String(remote.branches.length), color: palette.textMuted }] })
        if (isOpen(key))
          for (const branch of remote.branches)
            nodes.push({ key: `${path}#r:${remote.name}/${branch.name}`, kind: "remote", depth: 3, label: branch.name, path, ref: `${remote.name}/${branch.name}`, hash: branch.hash })
      }
    if (section("tags", "TAGS", tags.length))
      for (const tag of tags) nodes.push({ key: `${path}#t:${tag.name}`, kind: "tag", depth: 2, label: tag.name, path, ref: tag.name, hash: tag.hash })
    if (section("stashes", "STASHES", stashes.length))
      for (const stash of stashes) nodes.push({ key: `${path}#s:${stash.reference}`, kind: "stash", depth: 2, label: stash.message, path, stash: stash.reference, hash: stash.hash })
  }
  return nodes
}

/** What the sidebar reports to the screen. */
export interface TreeEvents {
  onRow: (index: number, gesture: "click" | "double" | "right", event: MouseEvent) => void
  onToggle: (index: number) => void
  /** A repository row dragged `rows` rows up (negative) or down and dropped. */
  onMove: (index: number, rows: number) => void
  onWheel: (step: number, event: MouseEvent) => void
  onFilter: () => void
  onAction: (action: (typeof TREE_ACTIONS)[number]) => void
}

/**
 * Draws the sidebar: catalogue buttons, the visible rows, and the filter while it is in use.
 * @param props.nodes rows from `flattenTree`
 * @param props.cursor index of the highlighted row
 * @param props.selectedPath repository whose log is shown, tinted
 * @param props.width pane width in cells
 * @param props.height pane height in rows
 * @param props.focused whether the pane has the keyboard
 * @param props.filter filter text
 * @param props.filtering whether the filter is being typed
 * @param props.scrollX cells the labels scrolled sideways
 * @param props.keys the keys shown on the catalogue buttons
 * @param props.events row gestures, twisty clicks, repository drags, buttons, wheel and filter clicks
 */
export const TreePane = ({ nodes, cursor, selectedPath, width, height, focused, filter, filtering, scrollX, keys, events }: {
  nodes: TreeNode[]
  cursor: number
  selectedPath: string | null
  width: number
  height: number
  focused: boolean
  filter: string
  filtering: boolean
  scrollX: number
  keys: Pick<KeyBindings, "add" | "rescan" | "moveUp" | "moveDown">
  events: TreeEvents
}) => {
  const { colors: palette, glyphs, spacing } = useTheme()
  const buttons: Record<(typeof TREE_ACTIONS)[number], [string, string]> = { add: [`${glyphs.add} Add`, keys.add], rescan: [`${glyphs.rescan} Rescan`, keys.rescan], up: [glyphs.moveUp, keys.moveUp], down: [glyphs.moveDown, keys.moveDown] }
  const showFilter = filtering || Boolean(filter)
  const listHeight = Math.max(1, height - 1 - (showFilter ? 1 : 0))
  const start = windowStart(cursor, nodes.length, listHeight, 1 / 2)
  const visible = nodes.slice(start, start + listHeight)
  return (
    <Clickable flexDirection="column" width={width} height={height} onWheel={events.onWheel}>
      <Box height={1} overflow="hidden">
        {TREE_ACTIONS.map(action => (
          <Clickable key={action} onClick={() => events.onAction(action)}>
            <Text> <Text color={palette.accent}>{buttons[action][0]}</Text><Text color={palette.textMuted}> {buttons[action][1]}</Text> </Text>
          </Clickable>
        ))}
      </Box>
      <Box flexDirection="column" height={listHeight}>
        {visible.map((node, offset) => {
          const index = start + offset
          const atCursor = index === cursor
          const selectedRepository = node.kind === "repository" && node.path === selectedPath
          const background = atCursor ? (focused ? palette.selection : palette.selectionInactive) : selectedRepository ? palette.repositoryRow : undefined
          const indent = " ".repeat(node.depth * spacing.indent)
          const twisty = node.toggle ? `${node.open ? glyphs.open : glyphs.closed} ` : "  "
          const glyph = glyphOf(node, glyphs)
          const bullet = node.kind === "branch" ? (node.current ? `${glyphs.currentBranch} ` : "  ") : ""
          const meta = node.meta ?? []
          const available = width - (indent.length + 2 + widthOf(bullet) + (glyph ? widthOf(glyph) + 1 : 0) + 1)
          const pillsWidth = meta.reduce((total, part) => total + 1 + (part.pill ? widthOf(` ${part.text} `) : 1), 0)
          const textWidth = meta.reduce((total, part) => total + (part.pill ? 0 : widthOf(part.text)), 0)
          const textRoom = Math.max(0, Math.min(textWidth, available - pillsWidth - Math.min(widthOf(node.label), Math.ceil(available / 2))))
          const labelWidth = Math.max(1, available - pillsWidth - textRoom)
          return (
            <Clickable key={node.key} height={1} width={width} onPress={node.kind === "repository" ? () => event => {
              if (event.kind === "up" && event.localY !== 0) events.onMove(index, event.localY)
            } : undefined} onClick={event => events.onRow(index, "click", event)} onDoubleClick={event => events.onRow(index, "double", event)} onRightClick={event => events.onRow(index, "right", event)}>
              <Text backgroundColor={background}>{indent}</Text>
              <Clickable onClick={() => events.onToggle(index)}>
                <Text backgroundColor={background} color={palette.textMuted}>{twisty}</Text>
              </Clickable>
              <Text backgroundColor={background} wrap="truncate-end">
                {bullet ? <Text color={palette.accent}>{bullet}</Text> : null}
                {glyph ? <Text color={node.kind === "repository" ? palette.accent : palette.textMuted}>{glyph} </Text> : null}
                <Text color={node.kind === "section" ? palette.textMuted : node.kind === "error" ? palette.stash : palette.text} bold={node.kind === "repository" || node.current}>{fit(slide(node.label, scrollX), labelWidth)}</Text>
                {meta.map((part, partIndex) => (
                  <Text key={partIndex}>
                    <Text> </Text>
                    {part.pill ? <Text backgroundColor={part.color} color={palette.pillText} bold>{` ${part.text} `}</Text> : <Text color={part.color}>{fit(part.text, Math.floor(textRoom * widthOf(part.text) / Math.max(1, textWidth)))}</Text>}
                  </Text>
                ))}
                <Text> </Text>
              </Text>
            </Clickable>
          )
        })}
      </Box>
      {showFilter ? (
        <Clickable height={1} onClick={events.onFilter}>
          <Text color={palette.accent} backgroundColor={palette.field}>{fit(` ${glyphs.search} ${filter}${filtering ? glyphs.cursor : ""}`, width)}</Text>
        </Clickable>
      ) : null}
    </Clickable>
  )
}
