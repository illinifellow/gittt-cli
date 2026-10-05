/**
 * The changed-file list: sorted by path, by status
 * (conflicts first), or as a folder tree.
 */
import type { ChangedFile } from "@/protocol"

/** How the file list is ordered. */
export type FileView = "path" | "status" | "tree"

/** One row of the file list: a folder heading (tree view only) or a file. */
export type FileRow =
  | { kind: "folder"; depth: number; name: string }
  | { kind: "file"; depth: number; name: string; folder: string; file: ChangedFile }

/** Status letter, glyph, tone and word for each git status. */
export const FILE_STATUSES: Record<string, { glyph: string; tone: "added" | "modified" | "deleted" | "renamed" | "conflicted" | "untracked"; title: string }> = {
  A: { glyph: "+", tone: "added", title: "Added" },
  M: { glyph: "●", tone: "modified", title: "Modified" },
  D: { glyph: "−", tone: "deleted", title: "Deleted" },
  R: { glyph: "→", tone: "renamed", title: "Renamed" },
  C: { glyph: "→", tone: "renamed", title: "Copied" },
  T: { glyph: "●", tone: "modified", title: "Type changed" },
  U: { glyph: "⚠", tone: "conflicted", title: "Conflicted" },
  "?": { glyph: "?", tone: "untracked", title: "Untracked" },
}

const STATUS_ORDER = "UMADRCT?"

/**
 * @param files changed files
 * @param view `path` alphabetical, `status` grouped by status (conflicts first) then path, `tree` alphabetical for folder grouping
 * @returns a sorted copy
 */
const sortFiles = (files: ChangedFile[], view: FileView) =>
  [...files].sort((first, second) => view === "status" && first.status !== second.status
    ? STATUS_ORDER.indexOf(first.status) - STATUS_ORDER.indexOf(second.status)
    : first.path.localeCompare(second.path))

/**
 * @param files changed files
 * @param view list view
 * @returns rows to draw; folder headings appear only in the tree view, each once, before the first file inside
 */
export const fileRows = (files: ChangedFile[], view: FileView): FileRow[] => {
  const sorted = sortFiles(files, view)
  if (view !== "tree")
    return sorted.map(file => {
      const slash = file.path.lastIndexOf("/")
      return { kind: "file", depth: 0, name: file.path.slice(slash + 1), folder: file.path.slice(0, slash + 1), file }
    })
  const rows: FileRow[] = []
  const opened: string[] = []
  for (const file of sorted) {
    const folders = file.path.split("/").slice(0, -1)
    let shared = 0
    while (shared < opened.length && shared < folders.length && opened[shared] === folders[shared]) shared++
    opened.length = shared
    for (let depth = shared; depth < folders.length; depth++) {
      opened.push(folders[depth])
      rows.push({ kind: "folder", depth, name: folders[depth] })
    }
    rows.push({ kind: "file", depth: folders.length, name: file.path.slice(file.path.lastIndexOf("/") + 1), folder: "", file })
  }
  return rows
}
