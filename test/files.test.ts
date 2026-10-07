/**
 * The changed-file list. Catches conflicts not sorted first in the status view, a folder heading
 * repeated or missing in the tree view, and a folder box that stages files outside its folder.
 */
import { describe, expect, it } from "vitest"
import { fileRows, rowFiles } from "@/files"
import type { ChangedFile } from "@/protocol"

const file = (path: string, status = "M"): ChangedFile => ({ status, path, previousPath: null, staged: false, unstaged: true })
const FILES = [file("src/ui/log.tsx"), file("README.md", "A"), file("src/git/index.ts", "U"), file("src/ui/tree.tsx", "D")]

describe("fileRows", () => {
  it("sorts by path, splitting each path into folder and name", () => {
    expect(fileRows(FILES, "path").map(row => row.kind === "file" && `${row.folder}|${row.name}`)).toEqual(["|README.md", "src/git/|index.ts", "src/ui/|log.tsx", "src/ui/|tree.tsx"])
  })

  it("puts conflicts first in the status view, then modified, added and deleted", () => {
    expect(fileRows(FILES, "status").map(row => row.kind === "file" && row.file.status)).toEqual(["U", "M", "A", "D"])
  })

  it("opens each folder once in the tree view, nested by depth", () => {
    expect(fileRows(FILES, "tree").map(row => `${row.depth}:${row.name}`)).toEqual(["0:README.md", "0:src", "1:git", "2:index.ts", "1:ui", "2:log.tsx", "2:tree.tsx"])
  })
})

describe("rowFiles", () => {
  const rows = fileRows(FILES, "tree")

  it("gives a folder row every file under it and nothing beyond", () => {
    expect(rowFiles(rows, 4).map(changed => changed.path)).toEqual(["src/ui/log.tsx", "src/ui/tree.tsx"])
    expect(rowFiles(rows, 1).map(changed => changed.path)).toEqual(["src/git/index.ts", "src/ui/log.tsx", "src/ui/tree.tsx"])
  })

  it("gives a file row its file and an index outside the list nothing", () => {
    expect(rowFiles(rows, 0).map(changed => changed.path)).toEqual(["README.md"])
    expect(rowFiles(rows, 99)).toEqual([])
  })
})
