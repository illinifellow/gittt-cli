/**
 * Keeping summaries current without flooding the machine with git: the watcher
 * and refresh scheduling of the repository store, and the git runner's limits.
 * Catches overlapping summary reads of one repository (git processes piling up
 * while a slow `git status` still runs), reads across many repositories all
 * started at once, refreshes triggered by files git ignores or by git's own
 * bookkeeping inside `.git`, background fetches running side by side or next
 * to a read of the same repository, Refresh not bringing in what others pushed,
 * and huge diffs read whole into memory.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const reads = vi.hoisted(() => {
  process.env.XDG_CONFIG_HOME = `${process.env.TMPDIR ?? "/tmp"}/gittt-store-test-${process.pid}`
  return { delayMs: 0, active: new Map<string, number>(), running: 0, peakPerRepository: 0, peakTotal: 0, total: 0, fetches: 0, fetching: 0, peakFetching: 0 }
})

vi.mock("@/git", async importOriginal => {
  const actual = await importOriginal<typeof import("@/git")>()
  /** Counts a repository's git work, reads and fetches alike, to catch two of them overlapping. */
  const enter = (path: string) => {
    reads.active.set(path, (reads.active.get(path) ?? 0) + 1)
    reads.peakPerRepository = Math.max(reads.peakPerRepository, reads.active.get(path) ?? 0)
  }
  const leave = (path: string) => reads.active.set(path, (reads.active.get(path) ?? 1) - 1)
  return {
    ...actual,
    fetchRemotes: async (path: string, signal?: AbortSignal) => {
      reads.fetches++
      reads.fetching++
      reads.peakFetching = Math.max(reads.peakFetching, reads.fetching)
      enter(path)
      try {
        if (reads.delayMs) await new Promise(resolve => setTimeout(resolve, reads.delayMs))
        return await actual.fetchRemotes(path, signal)
      } finally {
        reads.fetching--
        leave(path)
      }
    },
    readRepositoryState: async (path: string) => {
      reads.total++
      reads.running++
      enter(path)
      reads.peakTotal = Math.max(reads.peakTotal, reads.running)
      try {
        if (reads.delayMs) await new Promise(resolve => setTimeout(resolve, reads.delayMs))
        return await actual.readRepositoryState(path)
      } finally {
        reads.running--
        leave(path)
      }
    },
  }
})

const { readDiff, runGitOutput } = await import("@/git")
const { RepositoryStore, isIrrelevantChange } = await import("@/store")

const ENVIRONMENT = { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENVIRONMENT })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Makes a repository with one commit of `a.txt` and an ignored `cache/` folder that already holds a file. */
const makeRepository = (path: string) => {
  mkdirSync(join(path, "cache"), { recursive: true })
  git(path, "init", "-q", "-b", "main")
  writeFileSync(join(path, ".gitignore"), "cache/\n")
  writeFileSync(join(path, "a.txt"), "one\n")
  writeFileSync(join(path, "cache", "old.bin"), "x")
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gittt-store-"))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  Object.assign(reads, { delayMs: 0, running: 0, peakPerRepository: 0, peakTotal: 0, total: 0, fetches: 0, fetching: 0, peakFetching: 0 })
  reads.active.clear()
})

describe("repository store", () => {
  /**
   * A tree changing every 400 ms while each summary read takes 600 ms used to start a new read (six git
   * processes) before the last one finished, so git processes piled up without bound. One read at a time per
   * repository, spaced by its duration, keeps the count of reads well under the count of changes.
   */
  it("never overlaps reads of one repository and spaces reads of a slow one", async () => {
    const folder = join(root, "storm")
    makeRepository(join(folder, "repo"))
    const store = new RepositoryStore(folder)
    await store.rescan()
    reads.total = 0
    reads.delayMs = 600
    for (let change = 0; change < 15; change++) {
      writeFileSync(join(folder, "repo", "a.txt"), `change ${change}\n`)
      await sleep(400)
    }
    await sleep(3000)
    store.close()
    expect(reads.peakPerRepository).toBe(1)
    expect(reads.total).toBeGreaterThan(0)
    expect(reads.total).toBeLessThanOrEqual(6)
    expect(store.repositories[0].changes).toBe(1)
  })

  /** Opening a folder of many repositories used to start every summary read at once: six git processes each. */
  it("reads many repositories through a small pool", async () => {
    const folder = join(root, "many")
    for (let index = 0; index < 12; index++) makeRepository(join(folder, `repo${index}`))
    reads.delayMs = 100
    const store = new RepositoryStore(folder)
    await store.rescan()
    store.close()
    expect(store.repositories).toHaveLength(12)
    expect(store.repositories.every(repository => repository.error === null && repository.head.branch === "main")).toBe(true)
    expect(reads.peakTotal).toBeLessThanOrEqual(4)
  })

  /** Build output, caches and logs in git-ignored folders change nothing git shows, so they must not start git at all. */
  it("ignores changes inside git-ignored folders and still notices real edits", async () => {
    const folder = join(root, "ignored")
    makeRepository(join(folder, "repo"))
    const store = new RepositoryStore(folder)
    await store.rescan()
    await sleep(1500)
    await vi.waitFor(() => expect(reads.running).toBe(0), { timeout: 5000 })
    reads.total = 0
    for (let index = 0; index < 20; index++) {
      writeFileSync(join(folder, "repo", "cache", `chunk${index}.js`), String(index))
      await sleep(60)
    }
    await sleep(1500)
    expect(reads.total).toBe(0)
    writeFileSync(join(folder, "repo", "a.txt"), "edited\n")
    await vi.waitFor(() => expect(store.repositories[0].changes).toBe(1), { timeout: 5000, interval: 100 })
    store.close()
  })

  /** A summary read that finds nothing new must not redraw the screen. */
  it("tells listeners only about summaries that changed", async () => {
    const folder = join(root, "quiet")
    makeRepository(join(folder, "repo"))
    const store = new RepositoryStore(folder)
    await store.rescan()
    let notified = 0
    store.subscribe(() => notified++)
    await store.refresh(join(folder, "repo"))
    expect(notified).toBe(0)
    writeFileSync(join(folder, "repo", "b.txt"), "new\n")
    await store.refresh(join(folder, "repo"))
    expect(notified).toBe(1)
    store.close()
  })

  /** Git's own bookkeeping (objects, reflogs, locks, fsmonitor cookies) must not trigger reads; refs, the index and the stash must. */
  it("tells relevant paths from irrelevant ones", () => {
    const ignored = new Set(["cache/", "debug.log", "deep/out/"])
    const prefixes = ["node_modules"]
    for (const path of [".git/objects/ab/cdef", ".git/index.lock", ".git/logs/HEAD", ".git/fsmonitor--daemon/cookies/1-2", "node_modules/x/y.js", "packages/a/node_modules/b.js", "cache/a/b.js", "debug.log", "deep/out/x"])
      expect(isIrrelevantChange(path, prefixes, ignored), path).toBe(true)
    for (const path of [".git/index", ".git/HEAD", ".git/refs/heads/main", ".git/packed-refs", ".git/logs/refs/stash", ".git/MERGE_HEAD", ".git/info/exclude", "src/a.ts", "cache.ts", "deep/outside.ts", "debug.log.ts"])
      expect(isIrrelevantChange(path, prefixes, ignored), path).toBe(false)
  })
})

/** Makes `count` repositories under `folder`, each cloned from its own bare remote; returns the remotes. */
const makeClones = (folder: string, count: number) => Array.from({ length: count }, (_, index) => {
  const remote = join(folder, "remotes", `origin${index}.git`)
  const seed = join(folder, "seeds", `seed${index}`)
  mkdirSync(seed, { recursive: true })
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote])
  git(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, "a.txt"), "one\n")
  git(seed, "add", ".")
  git(seed, "commit", "-q", "-m", "first")
  git(seed, "remote", "add", "origin", remote)
  git(seed, "push", "-q", "-u", "origin", "main")
  execFileSync("git", ["clone", "-q", remote, join(folder, "work", `repo${index}`)], { env: ENVIRONMENT })
  return seed
})

/** Pushes a new commit from a seed checkout to its remote, so clones fall one commit behind. */
const pushCommit = (seed: string, message: string) => {
  writeFileSync(join(seed, "a.txt"), `${message}\n`)
  git(seed, "commit", "-q", "-am", message)
  git(seed, "push", "-q")
}

describe("fetching remotes", () => {
  /** Refresh brings in what others pushed, so ahead and behind counts are current without opening the fetch dialog. */
  it("fetches every repository and rereads it on refresh", async () => {
    const folder = join(root, "refresh")
    const seeds = makeClones(folder, 3)
    const store = new RepositoryStore(join(folder, "work"))
    await store.rescan()
    store.configureFetch(0)
    seeds.forEach(seed => pushCommit(seed, "second"))
    const result = await store.refreshAll()
    store.close()
    expect(result).toEqual({ total: 3, fetched: 3, failed: 0 })
    expect(store.repositories.map(repository => repository.branches.find(branch => branch.current)?.behind)).toEqual([1, 1, 1])
    expect(reads.peakPerRepository).toBe(1)
  })

  /**
   * Background fetches keep remotes current on their own, but one at a time across repositories and never next to
   * another git process of the same repository, so they cannot bring back the pile of git processes.
   */
  it("fetches in the background one at a time, never beside a read of the same repository", async () => {
    const folder = join(root, "background")
    const seeds = makeClones(folder, 3)
    const store = new RepositoryStore(join(folder, "work"))
    await store.rescan()
    seeds.forEach(seed => pushCommit(seed, "second"))
    reads.delayMs = 150
    store.configureFetch(1.5 / 60)
    await vi.waitFor(() => expect(store.repositories.every(repository => repository.branches.find(branch => branch.current)?.behind === 1)).toBe(true), { timeout: 15000, interval: 200 })
    store.close()
    expect(reads.fetches).toBeGreaterThanOrEqual(3)
    expect(reads.peakFetching).toBe(1)
    expect(reads.peakPerRepository).toBe(1)
  })

  /** Setting the interval to 0 stops background fetching entirely. */
  it("never fetches in the background when switched off", async () => {
    const folder = join(root, "off")
    makeClones(folder, 2)
    const store = new RepositoryStore(join(folder, "work"))
    await store.rescan()
    store.configureFetch(0)
    await sleep(2500)
    store.close()
    expect(reads.fetches).toBe(0)
  })
})

describe("git runner limits", () => {
  /** A diff of a multi-megabyte file used to be read whole into memory and cut afterwards. */
  it("stops reading a diff at the configured size", async () => {
    const path = join(root, "large")
    mkdirSync(path, { recursive: true })
    git(path, "init", "-q", "-b", "main")
    writeFileSync(join(path, "big.txt"), `${"0123456789abcdef\n".repeat(200_000)}`)
    git(path, "add", ".")
    git(path, "commit", "-q", "-m", "big")
    const hash = git(path, "rev-parse", "HEAD").trim()
    const text = await readDiff(path, hash, { status: "A", path: "big.txt", previousPath: null, staged: false, unstaged: false }, 64)
    expect(text.endsWith("\\ diff cut at 64 KB")).toBe(true)
    expect(text.length).toBeLessThan(64 * 1024 + 100)
    const whole = await runGitOutput(path, ["show", "--format=", hash], { maxBytes: 1024 })
    expect(whole.cut).toBe(true)
    expect(whole.stdout.length).toBeLessThanOrEqual(1024)
  })

  /** A read the screen no longer needs is stopped instead of running to the end. */
  it("rejects an aborted run with an AbortError", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runGitOutput(root, ["--version"], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})
