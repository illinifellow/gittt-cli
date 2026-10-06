/**
 * Sidebar keyboard navigation with Left and Right, for every kind of row.
 * Catches a kind of row where Left neither collapses nor climbs to the parent,
 * Right that does not step into an expanded row, and Right that acts on rows
 * without children.
 */
import { describe, expect, it } from "vitest"
import { loadDefaults } from "@/config"
import type { Repository } from "@/protocol"
import { resolveTheme } from "@/theme"
import { flattenTree, moveInTree, sectionKey, type TreeNode } from "@/ui/tree"

const { colors, glyphs } = resolveTheme(loadDefaults(), "#000000")

const REPOSITORY: Repository = {
  path: "/work/app",
  name: "app",
  head: { branch: "main", hash: "a1" },
  changes: 0,
  staged: 0,
  conflicts: 0,
  operation: null,
  branches: [{ name: "main", hash: "a1", upstream: "origin/main", current: true, ahead: 0, behind: 0, gone: false }, { name: "feature", hash: "b2", upstream: null, current: false, ahead: 0, behind: 0, gone: false }],
  remotes: [{ name: "origin", branches: [{ remote: "origin", name: "main", hash: "a1" }] }],
  tags: [{ name: "v1", hash: "a1" }],
  stashes: [{ reference: "stash@{0}", hash: "c3", message: "WIP on main" }],
  error: null,
}

const path = REPOSITORY.path
const ALL_OPEN = new Set([path, ...["workspace", "branches", "remotes", "remote:origin", "tags", "stashes"].map(name => sectionKey(path, name))])

const rows = (expanded: Set<string>) => flattenTree([REPOSITORY], expanded, "", colors, glyphs)
const indexOf = (nodes: TreeNode[], key: string) => {
  const index = nodes.findIndex(node => node.key === key)
  if (index === -1) throw new Error(`row ${key} is not visible`)
  return index
}
const press = (expanded: Set<string>, key: string, direction: "left" | "right") => {
  const nodes = rows(expanded)
  const moved = moveInTree(nodes, indexOf(nodes, key), expanded, direction)
  return { key: rows(moved.expanded)[moved.cursor].key, expanded: moved.expanded }
}

/** Every row with children: its key, its parent's key, its first child's key. */
const FOLDERS = [
  { name: "repository", key: path, parent: null, child: sectionKey(path, "workspace") },
  { name: "WORKSPACE", key: sectionKey(path, "workspace"), parent: path, child: `${path}#w:status` },
  { name: "BRANCHES", key: sectionKey(path, "branches"), parent: path, child: `${path}#b:main` },
  { name: "REMOTES", key: sectionKey(path, "remotes"), parent: path, child: sectionKey(path, "remote:origin") },
  { name: "remote group", key: sectionKey(path, "remote:origin"), parent: sectionKey(path, "remotes"), child: `${path}#r:origin/main` },
  { name: "TAGS", key: sectionKey(path, "tags"), parent: path, child: `${path}#t:v1` },
  { name: "STASHES", key: sectionKey(path, "stashes"), parent: path, child: `${path}#s:stash@{0}` },
]

/** Every row without children and its parent's key. */
const LEAVES = [
  { name: "workspace entry", key: `${path}#w:history`, parent: sectionKey(path, "workspace") },
  { name: "branch", key: `${path}#b:feature`, parent: sectionKey(path, "branches") },
  { name: "remote branch", key: `${path}#r:origin/main`, parent: sectionKey(path, "remote:origin") },
  { name: "tag", key: `${path}#t:v1`, parent: sectionKey(path, "tags") },
  { name: "stash", key: `${path}#s:stash@{0}`, parent: sectionKey(path, "stashes") },
]

describe("sidebar Left and Right", () => {
  for (const folder of FOLDERS) {
    /** Left on an expanded row folds it and keeps the selection on it. */
    it(`Left collapses an expanded ${folder.name}`, () => {
      const result = press(ALL_OPEN, folder.key, "left")
      expect(result.key).toBe(folder.key)
      expect(result.expanded.has(folder.key)).toBe(false)
    })
    /** Left on a collapsed row climbs to its parent, so repeated Left always walks up the tree. */
    it(`Left on a collapsed ${folder.name} moves to its parent`, () => {
      const collapsed = new Set([...ALL_OPEN].filter(key => key !== folder.key))
      const result = press(collapsed, folder.key, "left")
      expect(result.key).toBe(folder.parent ?? folder.key)
      expect(result.expanded).toEqual(collapsed)
    })
    /** Right on a collapsed row unfolds it in place. */
    it(`Right expands a collapsed ${folder.name}`, () => {
      const collapsed = new Set([...ALL_OPEN].filter(key => key !== folder.key))
      const result = press(collapsed, folder.key, "right")
      expect(result.key).toBe(folder.key)
      expect(result.expanded.has(folder.key)).toBe(true)
    })
    /** Right on an expanded row steps into its first child. */
    it(`Right on an expanded ${folder.name} moves to its first child`, () => {
      const result = press(ALL_OPEN, folder.key, "right")
      expect(result.key).toBe(folder.child)
      expect(result.expanded).toBe(ALL_OPEN)
    })
  }
  for (const leaf of LEAVES) {
    /** Left on a row without children moves to its parent. */
    it(`Left on a ${leaf.name} moves to its parent`, () => {
      const result = press(ALL_OPEN, leaf.key, "left")
      expect(result.key).toBe(leaf.parent)
      expect(result.expanded).toBe(ALL_OPEN)
    })
    /** Right on a row without children changes nothing. */
    it(`Right on a ${leaf.name} does nothing`, () => {
      const result = press(ALL_OPEN, leaf.key, "right")
      expect(result.key).toBe(leaf.key)
      expect(result.expanded).toBe(ALL_OPEN)
    })
  }
})
