/**
 * The catalogue of one scan folder: repositories found beneath it, plus those
 * added by path, minus those removed from the list, in the user's order;
 * summaries kept current by watching each repository's whole tree (FSEvents on
 * macOS), so commits, checkouts, stashes, fetches and file edits show up within
 * about a second.
 */
import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { loadConfig, loadState, saveState, type Catalog } from "@/config"
import { readRepository, runGit } from "@/git"
import type { Repository } from "@/protocol"
import { findRepositories } from "@/scan"


/** Repository summaries for one folder, with change notifications. */
export class RepositoryStore {
  repositories: Repository[] = []
  scanning = false
  private found: string[] = []
  private watchers: FSWatcher[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()

  /** @param root the folder repositories are searched under */
  constructor(readonly root: string) {}

  /**
   * @param listener called after the list or any summary changed
   * @returns a function removing the listener
   */
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  private get catalog(): Catalog {
    const stored: Partial<Catalog> = loadState().catalogs[this.root] ?? {}
    return { order: stored.order ?? [], hidden: stored.hidden ?? [], added: stored.added ?? [] }
  }

  private saveCatalog(change: Partial<Catalog>) {
    const state = loadState()
    state.catalogs[this.root] = { ...this.catalog, ...change }
    saveState(state)
  }

  private sortByOrder<Item>(items: Item[], pathOf: (item: Item) => string) {
    const order = this.catalog.order
    const rank = (path: string) => order.includes(path) ? order.indexOf(path) : Number.MAX_SAFE_INTEGER
    return [...items].sort((first, second) => rank(pathOf(first)) - rank(pathOf(second)) || pathOf(first).localeCompare(pathOf(second)))
  }

  /**
   * Searches the folder again, adds repositories added by path, rewatches and reads every summary.
   * @returns the repository count and how many of them were not listed before
   */
  async rescan() {
    const before = new Set(this.found)
    this.scanning = true
    this.emit()
    const { scanDepth, scanExclude } = loadConfig().settings
    const scanned = await findRepositories([this.root], scanDepth, scanExclude)
    const { added, hidden } = this.catalog
    const extra = (await Promise.all(added.map(async path => (await stat(join(path, ".git")).catch(() => null)) ? path : null)))
      .filter((path): path is string => path !== null && !scanned.includes(path))
    this.found = this.sortByOrder([...scanned, ...extra].filter(path => !hidden.includes(path)), path => path)
    const ignoredPaths = loadConfig().limits.watchIgnore
    const ignored = (file: string) => ignoredPaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`) || file.includes(`/${prefix}/`))
    this.watchers.forEach(watcher => watcher.close())
    this.watchers = this.found.flatMap(path => {
      try {
        return [watch(path, { recursive: true }, (_event, file) => {
          if (file && !ignored(String(file))) this.schedule(path)
        })]
      } catch {
        return []
      }
    })
    this.repositories = await Promise.all(this.found.map(path => readRepository(path)))
    this.scanning = false
    this.emit()
    return { total: this.found.length, added: this.found.filter(path => !before.has(path)).length }
  }

  /** @param paths repository paths in their new order */
  reorder(paths: string[]) {
    this.saveCatalog({ order: paths })
    this.found = this.sortByOrder(this.found, path => path)
    this.repositories = this.sortByOrder(this.repositories, repository => repository.path)
    this.emit()
  }

  /** @param path repository to drop from the list; the folder stays untouched */
  hide(path: string) {
    const { hidden, added } = this.catalog
    this.saveCatalog({ hidden: [...new Set([...hidden, path])], added: added.filter(candidate => candidate !== path) })
    this.found = this.found.filter(candidate => candidate !== path)
    this.repositories = this.repositories.filter(repository => repository.path !== path)
    this.emit()
  }

  /**
   * Adds the repository holding a folder.
   * @param folder any folder inside a work tree
   * @returns the root added; rejects when the folder is in no repository
   */
  async add(folder: string) {
    const root = (await runGit(folder, ["rev-parse", "--show-toplevel"]).catch(() => {
      throw new Error(`${folder} is not inside a git repository`)
    })).trim()
    const { added, hidden, order } = this.catalog
    this.saveCatalog({ added: [...new Set([...added, root])], hidden: hidden.filter(path => path !== root), order: order.includes(root) ? order : [...this.found, root] })
    await this.rescan()
    return root
  }

  /**
   * Rescans the folder and brings back every repository removed from the list.
   * @returns the repository count and how many of them were not listed before
   */
  async restore() {
    this.saveCatalog({ hidden: [] })
    return this.rescan()
  }

  /** @param path repository whose summary is read again now */
  async refresh(path: string) {
    if (!this.found.includes(path)) return
    const summary = await readRepository(path)
    this.repositories = this.repositories.map(repository => repository.path === path ? summary : repository)
    this.emit()
  }

  /** @param path repository to refresh after a quiet period */
  schedule(path: string) {
    clearTimeout(this.timers.get(path))
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path)
      void this.refresh(path)
    }, loadConfig().limits.refreshDelayMs))
  }

  /** Stops watching. */
  close() {
    this.watchers.forEach(watcher => watcher.close())
    this.timers.forEach(timer => clearTimeout(timer))
  }
}
