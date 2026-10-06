/**
 * The catalogue of one scan folder: repositories found beneath it, plus those
 * added by path, minus those removed from the list, in the user's order;
 * summaries kept current by watching each repository's whole tree (FSEvents on
 * macOS) and, for linked worktrees and submodules, the git directories that live
 * outside it, so commits, checkouts, stashes, fetches and file edits show up
 * within about a second. A repository whose watcher fails is polled instead,
 * and the failure is reported. Changes git cannot see (ignored files, git's own
 * logs, locks and objects) are skipped. Each repository reads its summary once
 * at a time, reads across repositories share a small pool, and a repository
 * whose read is slow is read less often, so a busy tree never piles up git
 * processes; a summary read may run beside a fetch, which mostly waits on the
 * network. The user's actions on a repository run one after another, and a
 * fetch never runs beside one: an action stops a background fetch first. Remotes
 * are fetched in the background every `settings.fetchMinutes` per repository,
 * staggered, one fetch at a time, never while offline, less often after
 * failures; `refreshAll` fetches and reads every repository now.
 */
import { watch, type FSWatcher } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { availableParallelism, networkInterfaces } from "node:os"
import { basename, join, relative } from "node:path"
import { loadConfig, loadState, saveState, type Catalog, type Limits } from "@/config"
import { fetchRemotes, readGitDirectories, readRepositoryState, runActionCommand, runGit } from "@/git"
import type { Repository } from "@/protocol"
import { findRepositories } from "@/scan"

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

/** One repository's watchers and refresh bookkeeping. */
interface Watched {
  watchers: FSWatcher[]
  /** Set once the git directories outside the work tree are watched too (or found not to need it). */
  gitDirectoriesWatched: boolean
  /** Polls the repository after its watcher failed. */
  poll: ReturnType<typeof setInterval> | null
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
  /** Counts relevant changes seen, so views re-read what the summary's counts cannot show (a second edit of a modified file). */
  revision: number
  /** The revision listeners last heard of: the one the latest finished read started at. */
  publishedRevision: number
  /** The repository's summary reads so far, chained so they run one at a time. */
  reads: Promise<void>
  /** The repository's actions and fetches so far, chained so they run one at a time. */
  turn: Promise<void>
  /** Stops the fetch running for the repository, if any. */
  fetch: AbortController | null
  nextFetchAt: number
  fetchFailures: number
}

/** What `refreshAll` did. */
export interface RefreshResult {
  total: number
  fetched: number
  failed: number
}

/** Commands an action runs, or a function producing them right before they run (to resolve names that may have moved). */
export type ActionCommands = string[][] | (() => Promise<string[][]>)

/** Repository summaries for one folder, with change notifications. */
export class RepositoryStore {
  repositories: Repository[] = []
  scanning = false
  private found: string[] = []
  private watched = new Map<string, Watched>()
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(text: string) => void>()
  private revisionListeners = new Set<(path: string) => void>()
  private closed = false
  private poolActive = 0
  private poolQueue: (() => void)[] = []
  private limits: Limits = loadConfig().limits
  private fetchIntervalMs = 0
  private fetchTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = new AbortController()
  /** Rescans so far, chained so two never interleave and the last one asked for decides the list. */
  private scans: Promise<unknown> = Promise.resolve()

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

  /**
   * @param listener called with a sentence when something goes wrong in the background (a watcher failed, a folder
   *   could not be searched)
   * @returns a function removing the listener
   */
  onNotice(listener: (text: string) => void) {
    this.noticeListeners.add(listener)
    return () => void this.noticeListeners.delete(listener)
  }

  /**
   * @param listener called with a repository's path once a read finished after its working tree, index or refs
   *   changed, whether or not the summary changed; `revisionOf` gives the new revision
   * @returns a function removing the listener
   */
  onRevision(listener: (path: string) => void) {
    this.revisionListeners.add(listener)
    return () => void this.revisionListeners.delete(listener)
  }

  /**
   * @param path a repository
   * @returns a number that moves whenever a read finished after a relevant change; 0 for a repository not listed
   */
  revisionOf(path: string) {
    return this.watched.get(path)?.publishedRevision ?? 0
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  private notice(text: string) {
    this.noticeListeners.forEach(listener => listener(text))
  }

  private get catalog(): Catalog {
    const stored: Partial<Catalog> = loadState().catalogs[this.root] ?? {}
    return { order: stored.order ?? [], hidden: stored.hidden ?? [], added: stored.added ?? [] }
  }

  /** @throws ConfigError when the settings file cannot be written; the list changes in memory only then */
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

  /** Summary reads running at once across every repository: `limits.summaryReads`, fewer on a small machine. */
  private get poolSize() {
    return Math.min(this.limits.summaryReads, Math.max(2, Math.floor(availableParallelism() / 2)))
  }

  /** Runs a summary read when a pool slot is free; a finished read hands its slot straight to the next one waiting. */
  private async pooled<T>(task: () => Promise<T>) {
    if (this.poolActive >= this.poolSize) await new Promise<void>(resolve => this.poolQueue.push(resolve))
    else this.poolActive++
    try {
      return await task()
    } finally {
      const next = this.poolQueue.shift()
      if (next) next()
      else this.poolActive--
    }
  }

  /** Runs a task after the ones already queued on the same chain of one repository. */
  private queued<T>(entry: Watched, chain: "reads" | "turn", task: () => Promise<T>): Promise<T> {
    const run = entry[chain].then(task, task)
    entry[chain] = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Reads one summary after the repository's earlier reads and in the pool, remembers what git ignores there, and
   * watches git directories outside the tree.
   */
  private async readSummary(path: string, entry: Watched) {
    let started = 0
    const { repository, ignored } = await this.queued(entry, "reads", () => this.pooled(() => {
      started = Date.now()
      return readRepositoryState(path)
    }))
    entry.ignored = new Set(ignored)
    entry.lastReadMs = Date.now() - started
    entry.finishedAt = Date.now()
    if (!entry.gitDirectoriesWatched && !repository.error) await this.watchGitDirectories(path, entry)
    return repository
  }

  /** Records a relevant change and schedules a read. */
  private changed(path: string) {
    const entry = this.watched.get(path)
    if (!entry) return
    entry.revision++
    this.schedule(path)
  }

  /** Switches a repository to polling after its watcher failed, and says so once. */
  private watchFailed(path: string, entry: Watched, error: unknown) {
    entry.watchers.forEach(watcher => watcher.close())
    entry.watchers = []
    if (entry.poll || this.closed || this.watched.get(path) !== entry) return
    entry.poll = setInterval(() => this.changed(path), this.limits.pollSeconds * 1000)
    this.notice(`${basename(path)} is checked every ${this.limits.pollSeconds} s: watching it failed (${error instanceof Error ? error.message : String(error)})`)
  }

  /**
   * Watches a folder for changes that matter to `path`'s summary.
   * @param folder the work tree or a git directory
   * @param relevant decides from the changed file's path relative to `folder`; a change without a name always counts
   */
  private watchFolder(path: string, entry: Watched, folder: string, relevant: (file: string) => boolean) {
    try {
      const watcher = watch(folder, { recursive: true }, (_event, file) => {
        if (file === null || relevant(String(file))) this.changed(path)
      })
      watcher.on("error", error => this.watchFailed(path, entry, error))
      entry.watchers.push(watcher)
    } catch (error) {
      this.watchFailed(path, entry, error)
    }
  }

  /** Lists a repository as watched and starts its work-tree watcher (or its polling, when the watcher cannot start). */
  private watchRepository(path: string) {
    const entry: Watched = { watchers: [], gitDirectoriesWatched: false, poll: null, ignored: new Set(), timer: null, reading: null, stale: false, changed: false, lastReadMs: 0, finishedAt: 0, revision: 0, publishedRevision: 0, reads: Promise.resolve(), turn: Promise.resolve(), fetch: null, nextFetchAt: 0, fetchFailures: 0 }
    this.watched.set(path, entry)
    this.watchFolder(path, entry, path, file => !isIrrelevantChange(file, this.limits.watchIgnore, entry.ignored))
  }

  /** A linked worktree or submodule keeps its HEAD, index and refs outside its tree: watch those folders too. */
  private async watchGitDirectories(path: string, entry: Watched) {
    entry.gitDirectoriesWatched = true
    const { gitDirectory, commonDirectory } = await readGitDirectories(path)
    const tree = await realpath(path)
    for (const folder of new Set([gitDirectory, commonDirectory])) {
      if (!relative(tree, folder).startsWith("..") || this.closed || this.watched.get(path) !== entry || entry.poll) continue
      this.watchFolder(path, entry, folder, file => !isQuietGitPath(`.git/${file}`))
    }
  }

  private unwatch(path: string) {
    const entry = this.watched.get(path)
    if (!entry) return
    entry.watchers.forEach(watcher => watcher.close())
    if (entry.poll) clearInterval(entry.poll)
    if (entry.timer) clearTimeout(entry.timer)
    this.watched.delete(path)
  }

  /**
   * Searches the folder again, adds repositories added by path, rewatches and reads every summary. Rescans run one
   * after another, so the list always comes from the last one asked for.
   * @returns the repository count and how many of them were not listed before
   */
  rescan(): Promise<{ total: number; added: number }> {
    const run = this.scans.then(() => this.scanOnce())
    this.scans = run.catch(() => undefined)
    return run
  }

  private async scanOnce() {
    const before = new Set(this.found)
    this.scanning = true
    this.emit()
    const { settings: { scanDepth, scanExclude, fetchMinutes }, limits } = loadConfig()
    this.limits = limits
    const scanned = await findRepositories([this.root], scanDepth, scanExclude, limits.scanConcurrency)
    if (scanned.failures.length) this.notice(`could not search ${scanned.failures.length} folder${scanned.failures.length === 1 ? "" : "s"}: ${scanned.failures[0]}`)
    const { added, hidden } = this.catalog
    const extra = (await Promise.all(added.map(async path => (await stat(join(path, ".git")).catch(() => null)) ? path : null)))
      .filter((path): path is string => path !== null && !scanned.repositories.includes(path))
    if (this.closed) return { total: 0, added: 0 }
    this.found = this.sortByOrder([...scanned.repositories, ...extra].filter(path => !hidden.includes(path)), path => path)
    const listed = new Set(this.found)
    for (const path of [...this.watched.keys()]) if (!listed.has(path)) this.unwatch(path)
    for (const path of this.found) if (!this.watched.has(path)) this.watchRepository(path)
    const repositories = await Promise.all(this.found.map(path => this.readSummary(path, this.watched.get(path) as Watched)))
    if (this.closed) return { total: this.found.length, added: 0 }
    this.repositories = repositories.filter(repository => this.found.includes(repository.path))
    this.scanning = false
    this.emit()
    this.configureFetch(fetchMinutes)
    return { total: this.found.length, added: this.found.filter(path => !before.has(path)).length }
  }

  /**
   * @param paths repository paths in their new order
   * @throws ConfigError when the order cannot be saved; it still applies until gittt quits
   */
  reorder(paths: string[]) {
    this.found = paths.filter(path => this.found.includes(path))
    this.repositories = this.found.map(path => this.repositories.find(repository => repository.path === path)).filter((repository): repository is Repository => Boolean(repository))
    this.emit()
    this.saveCatalog({ order: paths })
  }

  /**
   * @param path repository to drop from the list; the folder stays untouched
   * @throws ConfigError when the list cannot be saved; the repository stays hidden until gittt quits
   */
  hide(path: string) {
    const { hidden, added } = this.catalog
    this.found = this.found.filter(candidate => candidate !== path)
    this.repositories = this.repositories.filter(repository => repository.path !== path)
    this.unwatch(path)
    this.emit()
    this.saveCatalog({ hidden: [...new Set([...hidden, path])], added: added.filter(candidate => candidate !== path) })
  }

  /**
   * Adds the repository holding a folder.
   * @param folder any folder inside a work tree
   * @returns the root added; rejects when the folder is in no repository or the list cannot be saved
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
   * @returns the repository count and how many of them were not listed before; rejects when the list cannot be saved
   */
  async restore() {
    this.saveCatalog({ hidden: [] })
    return this.rescan()
  }

  /**
   * Reads a repository's summary again now; a read already in flight is followed by exactly one more.
   * Listeners hear about it only when the summary changed; revision listeners when a relevant change was seen since
   * they last heard.
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
          const revision = entry.revision
          const summary = await this.readSummary(path, entry)
          if (this.closed || this.watched.get(path) !== entry) return
          const index = this.repositories.findIndex(repository => repository.path === path)
          if (index !== -1 && JSON.stringify(this.repositories[index]) !== JSON.stringify(summary)) {
            this.repositories = this.repositories.map(repository => repository.path === path ? summary : repository)
            this.emit()
          }
          if (revision === entry.publishedRevision) continue
          entry.publishedRevision = revision
          this.revisionListeners.forEach(listener => listener(path))
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

  /** Marks a repository as changed (views re-read its working tree) and reads it now. */
  private invalidate(path: string) {
    const entry = this.watched.get(path)
    if (entry) entry.revision++
    return this.refresh(path)
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
    }, Math.max(this.limits.refreshDelayMs, spacing))
  }

  /**
   * Runs a user action: its commands in order in the repository's turn, after the actions queued before it; a fetch
   * running for the repository is stopped first. Commands that talk to a remote run unattended and stop after
   * `limits.fetchTimeoutSeconds`. The repository is read again afterwards, whatever happened.
   * @param path repository the action changes
   * @param commands argument lists for git, or a function producing them once the action's turn came
   * @returns once every command finished; rejects with the first failing command's error, and the rest do not run
   */
  async runAction(path: string, commands: ActionCommands) {
    const entry = this.watched.get(path)
    const run = async () => {
      for (const command of typeof commands === "function" ? await commands() : commands) await runActionCommand(path, command, this.limits.fetchTimeoutSeconds * 1000)
    }
    entry?.fetch?.abort()
    try {
      await (entry ? this.queued(entry, "turn", run) : run())
    } finally {
      void this.invalidate(path)
    }
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
      if (isOnline() && !entry.fetch && this.hasRemotes(path)) await this.fetchRepository(path, entry).catch(() => undefined)
      entry.nextFetchAt = Date.now() + this.fetchIntervalMs * Math.min(this.limits.fetchBackoff, 2 ** entry.fetchFailures)
    }
    this.armFetchTimer()
  }

  /**
   * Fetches one repository in its turn, stopped after `limits.fetchTimeoutSeconds` or when an action needs the turn.
   * A failure is counted for the backoff and passed on; a fetch an action stopped counts as no failure.
   */
  private async fetchRepository(path: string, entry: Watched) {
    const controller = new AbortController()
    entry.fetch = controller
    try {
      await this.queued(entry, "turn", () => fetchRemotes(path, AbortSignal.any([controller.signal, this.stopping.signal, AbortSignal.timeout(this.limits.fetchTimeoutSeconds * 1000)])))
      entry.fetchFailures = 0
    } catch (error) {
      if (!controller.signal.aborted) entry.fetchFailures++
      throw error
    } finally {
      entry.fetch = null
    }
  }

  /**
   * Fetches every repository that has remotes, a few at a time, and reads every summary and working tree again.
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
        if (entry && online && !entry.fetch && this.hasRemotes(path)) {
          await this.fetchRepository(path, entry).then(() => result.fetched++, () => result.failed++)
          entry.nextFetchAt = Date.now() + this.fetchIntervalMs
        }
        await this.invalidate(path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.limits.refreshFetches, paths.length) }, worker))
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
