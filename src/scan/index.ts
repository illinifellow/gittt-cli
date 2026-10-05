/**
 * Finds git repositories under a folder: a folder holding `.git` (a directory,
 * or a file for worktrees and submodules) is a repository; the search goes on
 * inside it so nested repositories are found too.
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"

/**
 * Walks each root breadth-first down to `depth` levels, skipping excluded names and symbolic links.
 * @param roots folders to search
 * @param depth levels below each root to enter; 0 checks the roots only
 * @param exclude folder names never entered (`.git` is always skipped)
 * @returns repository roots sorted by path, each listed once even when roots overlap
 */
export const findRepositories = async (roots: string[], depth: number, exclude: string[]): Promise<string[]> => {
  const excluded = new Set([...exclude, ".git"])
  const found = new Set<string>()
  for (const root of roots) {
    let level: string[] = [root]
    for (let currentDepth = 0; currentDepth <= depth && level.length; currentDepth++) {
      const next: string[] = []
      await Promise.all(level.map(async folder => {
        const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
        if (entries.some(entry => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) found.add(folder)
        for (const entry of entries)
          if (entry.isDirectory() && !excluded.has(entry.name)) next.push(join(folder, entry.name))
      }))
      level = next
    }
  }
  return [...found].sort((first, second) => first.localeCompare(second))
}
