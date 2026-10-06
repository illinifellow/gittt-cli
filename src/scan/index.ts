/**
 * Finds git repositories under a folder: a folder holding `.git` (a directory,
 * or a file for worktrees and submodules) is a repository; the search goes on
 * inside it so nested repositories are found too. Also expands the paths the
 * user types.
 */
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Folders the search may skip without saying so: gone meanwhile, or not ours to read. */
const QUIET_ERRORS = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"])

/**
 * @param path a typed path; a leading `~` means the home folder, a relative path starts in the current folder
 * @returns the absolute path
 */
export const expandPath = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()))

/** What a search found. */
export interface ScanResult {
  /** Repository roots sorted by path, each listed once even when roots overlap. */
  repositories: string[]
  /** Folders that could not be read for a reason other than being gone or forbidden, each with the reason. */
  failures: string[]
}

/**
 * Walks each root breadth-first down to `depth` levels, skipping excluded names and symbolic links, reading at most
 * `concurrency` folders at a time so a wide tree never runs out of file handles.
 * @param roots folders to search
 * @param depth levels below each root to enter; 0 checks the roots only
 * @param exclude folder names never entered (`.git` is always skipped)
 * @param concurrency folders read at once, at least 1
 * @returns the repositories found and the folders that failed
 */
export const findRepositories = async (roots: string[], depth: number, exclude: string[], concurrency: number): Promise<ScanResult> => {
  const excluded = new Set([...exclude, ".git"])
  const found = new Set<string>()
  const failures: string[] = []
  for (const root of roots) {
    let level: string[] = [root]
    for (let currentDepth = 0; currentDepth <= depth && level.length; currentDepth++) {
      const queue = [...level]
      const next: string[] = []
      const worker = async () => {
        for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
          const entries = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (!QUIET_ERRORS.has(error.code ?? "")) failures.push(`${folder}: ${error.message}`)
            return []
          })
          if (entries.some(entry => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) found.add(folder)
          for (const entry of entries) if (entry.isDirectory() && !excluded.has(entry.name)) next.push(join(folder, entry.name))
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
      level = next
    }
  }
  return { repositories: [...found].sort((first, second) => first.localeCompare(second)), failures }
}
