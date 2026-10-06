/**
 * The catalogue of one scan folder: repositories found beneath it, plus those
 * added by path, minus those removed from the list, in the user's order;
 * summaries kept current by watching each repository's whole tree (FSEvents on
 * macOS), so commits, checkouts, stashes, fetches and file edits show up within
 * about a second. Changes git cannot see (ignored files, git's own logs, locks
 * and objects) are skipped; each repository runs at most one git process at a
 * time (summary reads and fetches take turns), reads across repositories share a
 * small pool, and a repository whose read is slow is read less often, so a busy
 * tree never piles up git processes. Remotes are fetched in the background every
 * `settings.fetchMinutes` per repository, staggered, one fetch at a time, never
 * while offline, less often after failures; `refreshAll` fetches and reads every
 * repository now.
 */
import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import { availableParallelism, networkInterfaces } from "node:os"
import { join } from "node:path"
import { loadConfig, loadState, saveState, type Catalog } from "@/config"
import { fetchRemotes, readRepositoryState, runGit } from "@/git"
import type { Repository } from "@/protocol"
import { findRepositories } from "@/scan"

/** Summary reads running at once across every repository; each read runs two git processes. */
const READ_POOL_SIZE = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))

/** Fetches `refreshAll` runs at once; fetches wait on the network, not the processor. */
const REFRESH_FETCHES = 3

/** A fetch still running after this long is stopped: a remote that hangs must not hold the repository. */
const FETCH_TIMEOUT_MS = 2 * 60 * 1000

/** A repository whose background fetch failed waits up to this many times its interval before trying again. */
const MAX_FETCH_BACKOFF = 8

/** @returns whether any network interface other than loopback has an address */
const isOnline = () => Object.values(networkInterfaces()).some(addresses => addresses?.some(address => !address.internal))

/** Paths inside `.git` whose changes never alter a summary: objects, reflogs (except the stash's), locks, hooks, LFS and fsmonitor files. */
const isQuietGitPath = (file: string) =>
  file.startsWith(".git/") && (file.endsWith(".lock") || /^\.git\/(objects|hooks|lfs|fsmonitor--daemon)(\/|$)/.test(file) || (file.startsWith(".git/logs/") && file !== ".git/logs/refs/stash"))

/**
 * @param file path relative to the repository root, `/`-separated
 * @param prefixes configured folder names skipped anywhere in the tree
 * @param ignored paths git ignores in this repository (folders end in `/`)
 * @returns whether a change at `file` cannot alter the repository's summary
 */
export const isIrrelevantChange = (file: string, prefixes: string[], ignored: Set<string>) => {
  if (isQuietGitPath(file)) return true
  if (prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`) || file.includes(`/${prefix}/`))) return true
  if (!ignored.size) return false
  if (ignored.has(file)) return true
  for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1))
    if (ignored.has(file.slice(0, slash + 1))) return true
  return false
}

/** One repository's watcher and refresh bookkeeping. */
interface Watched {
  watcher: FSWatcher | null
  ignored: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** The read in flight, if any. */
  reading: Promise<void> | null
  /** `refresh` was called while reading; read once more right after. */
  stale: boolean
  /** The tree changed while reading; schedule another read after it. */
  changed: boolean
  /** How long the last read took, to space reads of slow repositories. */
  lastReadMs: number
  finishedAt: number
  /** The repository's git work so far, chained so only one git process runs for it at a time. */
  turn: Promise<void>
  fetching: boolean
  nextFetchAt: number
  fetchFailures: number
}

/** What `refreshAll` did. */
export interface RefreshResult {
  total: number
  fetched: number
  failed: number
}

/** Repository summaries for one folder, with change notifications. */
export class RepositoryStore {
  repositories: Repository[] = []
  scanning = false
  private found: string[] = []
  private watched = new Map<string, Watched>()
  private listeners = new Set<() => void>()
  private closed = false
  private poolActive = 0
  private poolQueue: (() => void)[] = []
  private refreshDelayMs = 0
  private watchIgnore: string[] = []
  private fetchIntervalMs = 0
  private fetchTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = new AbortController()

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

  /** Runs a summary read when a pool slot is free; a finished read hands its slot straight to the next one waiting. */
  private async pooled<T>(task: () => Promise<T>) {
    if (this.poolActive >= READ_POOL_SIZE) await new Promise<void>(resolve => this.poolQueue.push(resolve))
    else this.poolActive++
    try {
      return await task()
    } finally {
      const next = this.poolQueue.shift()
      if (next) next()
      else this.poolActive--
    }
  }

  /** Runs a repository's git work after the work already queued for it. */
  private inTurn<T>(path: string, task: () => Promise<T>): Promise<T> {
    const entry = this.watched.get(path)
    if (!entry) return task()
    const run = entry.turn.then(task, task)
    entry.turn = run.then(() => undefined, () => undefined)
    return run
  }

  /** Reads one summary in the repository's turn and in the pool, and remembers what git ignores there. */
  private async readSummary(path: string) {
    const { repository, ignored, readMs } = await this.inTurn(path, () => this.pooled(async () => {
      const started = Date.now()
      return { ...await readRepositoryState(path), readMs: Date.now() - started }
    }))
    const entry = this.watched.get(path)
    if (entry) {
      entry.ignored = new Set(ignored)
      entry.lastReadMs = readMs
      entry.finishedAt = Date.now()
    }
    return repository
  }

  private watchRepository(path: string): Watched {
    const entry: Watched = { watcher: null, ignored: new Set(), timer: null, reading: null, stale: false, changed: false, lastReadMs: 0, finishedAt: 0, turn: Promise.resolve(), fetching: false, nextFetchAt: 0, fetchFailures: 0 }
    try {
      entry.watcher = watch(path, { recursive: true }, (_event, file) => {
        if (file && !isIrrelevantChange(String(file), this.watchIgnore, entry.ignored)) this.schedule(path)
      })
      entry.watcher.on("error", () => entry.watcher?.close())
    } catch {
      entry.watcher = null
    }
    return entry
  }

  private unwatch(path: string) {
    const entry = this.watched.get(path)
    if (!entry) return
    entry.watcher?.close()
    if (entry.timer) clearTimeout(entry.timer)
    this.watched.delete(path)
  }

  /**
   * Searches the folder again, adds repositories added by path, rewatches and reads every summary.
   * @returns the repository count and how many of them were not listed before
   */
  async rescan() {
    const before = new Set(this.found)
    this.scanning = true
    this.emit()
    const { settings: { scanDepth, scanExclude, fetchMinutes }, limits } = loadConfig()
    this.refreshDelayMs = limits.refreshDelayMs
    this.watchIgnore = limits.watchIgnore
    const scanned = await findRepositories([this.root], scanDepth, scanExclude)
    const { added, hidden } = this.catalog
    const extra = (await Promise.all(added.map(async path => (await stat(join(path, ".git")).catch(() => null)) ? path : null)))
      .filter((path): path is string => path !== null && !scanned.includes(path))
    this.found = this.sortByOrder([...scanned, ...extra].filter(path => !hidden.includes(path)), path => path)
    const listed = new Set(this.found)
    for (const path of [...this.watched.keys()]) if (!listed.has(path)) this.unwatch(path)
    for (const path of this.found) if (!this.watched.has(path)) this.watched.set(path, this.watchRepository(path))
    const repositories = await Promise.all(this.found.map(path => this.readSummary(path)))
    if (this.closed) return { total: this.found.length, added: 0 }
    this.repositories = repositories.filter(repository => this.found.includes(repository.path))
    this.scanning = false
    this.emit()
    this.configureFetch(fetchMinutes)
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
    this.unwatch(path)
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

  /**
   * Reads a repository's summary again now; a read already in flight is followed by exactly one more.
   * Listeners hear about it only when the summary changed.
   * @param path repository to read
   * @returns once a summary read after this call has been applied
   */
  async refresh(path: string): Promise<void> {
    const entry = this.watched.get(path)
    if (!entry || this.closed) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.reading) {
      entry.stale = true
      return entry.reading
    }
    entry.reading = (async () => {
      try {
        do {
          entry.stale = false
          const summary = await this.readSummary(path)
          if (this.closed || this.watched.get(path) !== entry) return
          const index = this.repositories.findIndex(repository => repository.path === path)
          if (index === -1 || JSON.stringify(this.repositories[index]) === JSON.stringify(summary)) continue
          this.repositories = this.repositories.map(repository => repository.path === path ? summary : repository)
          this.emit()
        } while (entry.stale)
      } finally {
        entry.reading = null
        if (entry.changed) {
          entry.changed = false
          this.schedule(path)
        }
      }
    })()
    return entry.reading
  }

  /**
   * Refreshes a repository after a quiet period of `limits.refreshDelayMs`; a repository whose last read took long
   * waits at least twice that long after it, so slow trees are not read back to back. A change during a read
   * schedules one more read once it finished.
   * @param path repository whose tree changed
   */
  schedule(path: string) {
    const entry = this.watched.get(path)
    if (!entry || this.closed) return
    if (entry.reading) {
      entry.changed = true
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    const spacing = entry.finishedAt + 2 * entry.lastReadMs - Date.now()
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.refresh(path)
    }, Math.max(this.refreshDelayMs, spacing))
  }

  /**
   * Sets how often each repository's remotes are fetched in the background and spreads the next fetches evenly
   * over one interval.
   * @param minutes minutes between two fetches of one repository; 0 stops background fetching
   */
  configureFetch(minutes: number) {
    this.fetchIntervalMs = Math.max(0, minutes) * 60 * 1000
    const paths = [...this.watched.keys()]
    paths.forEach((path, index) => {
      const entry = this.watched.get(path) as Watched
      entry.nextFetchAt = Date.now() + this.fetchIntervalMs * (index + 1) / paths.length
    })
    this.armFetchTimer()
  }

  private armFetchTimer() {
    if (this.fetchTimer) clearTimeout(this.fetchTimer)
    this.fetchTimer = null
    if (!this.fetchIntervalMs || this.closed || !this.watched.size) return
    const next = Math.min(...[...this.watched.values()].map(entry => entry.nextFetchAt))
    this.fetchTimer = setTimeout(() => void this.fetchNextDue(), Math.max(1000, next - Date.now()))
  }

  /** Whether the repository has anything to fetch from, judged by its summary. */
  private hasRemotes(path: string) {
    const repository = this.repositories.find(candidate => candidate.path === path)
    return Boolean(repository && (repository.remotes.length || repository.branches.some(branch => branch.upstream)))
  }

  /** Fetches the repository whose background fetch is due first, then waits for the next one. */
  private async fetchNextDue() {
    this.fetchTimer = null
    const due = [...this.watched.entries()].filter(([, entry]) => entry.nextFetchAt <= Date.now()).sort(([, first], [, second]) => first.nextFetchAt - second.nextFetchAt)[0]
    if (due) {
      const [path, entry] = due
      if (isOnline() && !entry.fetching && this.hasRemotes(path)) await this.fetchRepository(path, entry).catch(() => undefined)
      entry.nextFetchAt = Date.now() + this.fetchIntervalMs * Math.min(MAX_FETCH_BACKOFF, 2 ** entry.fetchFailures)
    }
    this.armFetchTimer()
  }

  /** Fetches one repository in its turn; a failure is counted for the backoff and passed on. */
  private async fetchRepository(path: string, entry: Watched) {
    entry.fetching = true
    try {
      await this.inTurn(path, () => fetchRemotes(path, AbortSignal.any([this.stopping.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])))
      entry.fetchFailures = 0
    } catch (error) {
      entry.fetchFailures++
      throw error
    } finally {
      entry.fetching = false
    }
  }

  /**
   * Fetches every repository that has remotes, a few at a time, and reads every summary again.
   * @returns how many repositories there are, how many were fetched and how many fetches failed (offline, no access)
   */
  async refreshAll(): Promise<RefreshResult> {
    const paths = [...this.found]
    const result: RefreshResult = { total: paths.length, fetched: 0, failed: 0 }
    const online = isOnline()
    const queue = [...paths]
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const entry = this.watched.get(path)
        if (entry && online && !entry.fetching && this.hasRemotes(path)) {
          await this.fetchRepository(path, entry).then(() => result.fetched++, () => result.failed++)
          entry.nextFetchAt = Date.now() + this.fetchIntervalMs
        }
        await this.refresh(path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(REFRESH_FETCHES, paths.length) }, worker))
    this.armFetchTimer()
    return result
  }

  /** Stops watching and fetching, and drops every pending refresh. */
  close() {
    this.closed = true
    this.stopping.abort()
    if (this.fetchTimer) clearTimeout(this.fetchTimer)
    for (const path of [...this.watched.keys()]) this.unwatch(path)
  }
}
