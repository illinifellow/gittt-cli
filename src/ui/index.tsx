/**
 * The main screen: toolbar, repository tree on
 * the left, filter bar and commit log on the right, files and diff below, a
 * transient status at the right end of the toolbar. Every action opens a
 * dialog, except Refresh, which fetches and rereads every repository at once
 * and reports in the status; the context menu ("." or a right click) lists the actions for the
 * row; every element answers the mouse. Actions on one repository run one after
 * another; quitting waits for a running action unless asked twice.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { copyToClipboard } from "@/clipboard"
import { ConfigError, configProblems, loadConfig, resetConfig, saveConfig, type Config } from "@/config"
import { buildDialog, dialogCommands, validateDialog, type DialogKind, type DialogTarget } from "@/dialogs"
import { hasConflictMarkers, parseDiff, type ParsedDiff } from "@/diff"
import { rowFiles, type FileView } from "@/files"
import { readDetails, readDiff, readLog, readStashReference, readWholeFile } from "@/git"
import { DiffHighlighter, type Segment } from "@/highlight"
import { buildLog, collectBadges, commitNamer, describeOperation } from "@/history"
import { configureClicks, type MouseEvent } from "@/mouse"
import { Clickable } from "@/mouse/regions"
import { WORKING_TREE, type ChangedFile, type Commit, type CommitDetails, type Repository } from "@/protocol"
import { expandPath } from "@/scan"
import { applySettings, openUrl, settingsDialog, validateSettings } from "@/settings"
import type { ActionCommands, RepositoryStore } from "@/store"
import { readSyntaxTheme } from "@/syntax"
import { terminalBackground } from "@/terminal"
import { resolveTheme } from "@/theme"
import { availableUpdate, installUpdate } from "@/update"
import { DiffPane, FilesPane, diffLines, fileViewLines, filesOf, gutterWidth, lineCells, selectedText, sourceLines, type DetailsEvents, type DiffSelection } from "./details"
import { DialogBox, dialogActivate, dialogKey, dialogLink, dialogMove, openDialogState, type DialogState } from "./dialog"
import { useWindowStart } from "./window"
import { LogPane, graphWidth, logListHeight, type LogColumn, type LogEvents } from "./log"
import { MenuBox, type MenuItem, type MenuState } from "./menu"
import { fit } from "./text"
import { ThemeProvider } from "./theme"
import { TreePane, flattenTree, moveInTree, sectionKey, type TreeEvents, type TreeNode } from "./tree"

type Pane = "tree" | "log" | "files" | "diff"

const PANES: Pane[] = ["tree", "log", "files", "diff"]

/** The share of the body the lower panes take while `columns.details` is `null`. */
const DETAILS_SHARE = 0.42

/** Rows above the body: the toolbar and the rule under it. */
const TOOLBAR_HEIGHT = 2

/** The column each log divider right of the graph resizes. */
const COLUMN_AFTER = { description: "hash", hash: "author", author: "date" } as const

const highlighters = new Map<string, DiffHighlighter>()

/** @returns the highlighter for a syntax theme, created once per name */
const highlighterFor = (syntax: string) => {
  if (!highlighters.has(syntax)) highlighters.set(syntax, new DiffHighlighter(readSyntaxTheme(syntax)))
  return highlighters.get(syntax) as DiffHighlighter
}

/** @returns an error as one status line: its last lines, where git puts the reason */
const describeError = (error: unknown) => error instanceof Error ? error.message.split("\n").slice(-3).join(" ") : String(error)

/**
 * Follows a key that changes quickly: a change after a pause passes at once, a change within `ms` of the previous
 * one waits until the key stayed put for `ms`. Holding an arrow key, paging or scrolling reads only where the
 * cursor stops.
 * @param key the value to follow
 * @param ms the pause that counts as settled
 * @returns the settled key
 */
const useSettled = (key: string, ms: number) => {
  const [settled, setSettled] = useState(key)
  const lastChange = useRef(0)
  useEffect(() => {
    const now = Date.now()
    const quick = now - lastChange.current < ms
    lastChange.current = now
    if (!quick) return setSettled(key)
    const timer = setTimeout(() => setSettled(key), ms)
    return () => clearTimeout(timer)
  }, [key, ms])
  return settled
}

/**
 * The main screen.
 * @param props.store the catalogue of the chosen folder
 * @param props.onRestart replaces the running gittt with the newly installed one, keeping the folder
 */
export const App = ({ store, onRestart }: { store: RepositoryStore; onRestart: () => void }) => {
  const { exit } = useApp()
  const { columns: screenWidth, rows: screenHeight } = useWindowSize()
  const [config, setConfig] = useState<Config>(loadConfig)
  const theme = useMemo(() => resolveTheme(config, terminalBackground()), [config])
  const { colors: palette, glyphs, spacing } = theme
  const { settings, limits } = config
  const [dragColumns, setDragColumns] = useState<Partial<Config["columns"]> | null>(null)
  const columns = dragColumns ? { ...config.columns, ...dragColumns } : config.columns
  const [repositories, setRepositories] = useState<Repository[]>(store.repositories)
  const [scanning, setScanning] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeCursor, setTreeCursor] = useState(0)
  const [filter, setFilter] = useState("")
  const [filtering, setFiltering] = useState(false)
  const [commits, setCommits] = useState<Commit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [logCursor, setLogCursor] = useState(0)
  const [query, setQuery] = useState("")
  const [jumping, setJumping] = useState(false)
  const [loaded, setLoaded] = useState<{ path: string; details: CommitDetails } | null>(null)
  const [fileCursor, setFileCursor] = useState(0)
  const [diff, setDiff] = useState<{ file: string; parsed: ParsedDiff; highlights: Segment[][][] | null } | null>(null)
  const [diffCursor, setDiffCursor] = useState(0)
  const lastDiffText = useRef("")
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [viewing, setViewing] = useState<{ key: string; file: ChangedFile; text: string; cutAt: number | null; highlights: Segment[][] | null } | null>(null)
  const viewRequest = useRef(0)
  const [focus, setFocus] = useState<Pane>("log")
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [prompt, setPrompt] = useState<{ label: string; value: string; onSubmit: (value: string) => void } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const running = useRef(0)
  const quitting = useRef(false)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [update, setUpdate] = useState<string | null>(null)
  const signature = useRef("")

  const reportError = useCallback((error: unknown) => setStatus({ text: describeError(error), error: true }), [])

  useEffect(() => {
    const problems = configProblems()
    if (problems.length) setStatus({ text: problems.length > 1 ? `${problems[0]} (and ${problems.length - 1} more)` : problems[0], error: true })
    return store.onNotice(text => setStatus({ text, error: true }))
  }, [store])

  useEffect(() => {
    const check = () => void availableUpdate().then(version => setUpdate(version))
    check()
    const timer = setInterval(check, limits.updateCheckHours * 60 * 60 * 1000)
    return () => clearInterval(timer)
  }, [limits.updateCheckHours])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), status.error ? limits.errorStatusMs : limits.statusMs)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => configureClicks({ doubleClickMs: limits.doubleClickMs, doubleClickCells: limits.doubleClickCells }), [limits.doubleClickMs, limits.doubleClickCells])

  /**
   * Runs a job the toolbar reports as busy; the label shows the newest running job, and a quit asked for while jobs
   * run happens once the last one finished.
   */
  const track = useCallback(async <Result,>(label: string, job: () => Promise<Result>) => {
    running.current++
    setBusy(label)
    try {
      return await job()
    } finally {
      running.current--
      if (!running.current) {
        setBusy(null)
        if (quitting.current) exit()
      }
    }
  }, [exit])

  /** Leaves gittt; with an action running, waits for it, unless asked a second time. */
  const quit = () => {
    if (!running.current || quitting.current) return exit()
    quitting.current = true
    setStatus({ text: `quitting once ${busy} finished; ${config.keys.quit} again quits now`, error: false })
  }

  /** Installs the newer release and restarts gittt in place once it is on disk. */
  const applyUpdate = useCallback(() => {
    if (!update || busy) return
    void track(`updating to ${update}`, () => installUpdate(update)).then(onRestart, reportError)
  }, [update, busy, track, onRestart, reportError])

  const copy = (text: string, done = `copied ${text}`) => void copyToClipboard(text).then(
    route => setStatus({ text: route === "terminal" ? `${done} through the terminal` : done, error: false }),
    reportError,
  )

  /** Changes the configuration in memory at once and saves it; a settings file gittt cannot parse is left alone and the status says why. */
  const updateConfig = useCallback((change: (draft: Config) => void) => {
    const next = structuredClone(loadConfig())
    change(next)
    setConfig(next)
    try {
      saveConfig(next)
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      reportError(error)
    }
  }, [reportError])

  /** Runs a catalogue change that also saves; when the save is refused the change still holds until gittt quits. */
  const persist = (change: () => void) => {
    try {
      change()
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      reportError(error)
    }
  }

  useEffect(() => store.subscribe(() => {
    setRepositories([...store.repositories])
    setScanning(store.scanning)
  }), [store])
  useEffect(() => {
    void store.rescan()
    return () => store.close()
  }, [store])
  useEffect(() => store.configureFetch(settings.fetchMinutes), [store, settings.fetchMinutes])

  const scanSettings = JSON.stringify([settings.scanDepth, settings.scanExclude])
  const scannedWith = useRef(scanSettings)
  useEffect(() => {
    if (scannedWith.current === scanSettings) return
    scannedWith.current = scanSettings
    void store.rescan()
  }, [store, scanSettings])

  /** Fetches every repository's remotes and reads every summary again, with the outcome in the status. */
  const refreshAll = useCallback(() => {
    if (busy) return
    setStatus(null)
    void track("refreshing", () => store.refreshAll()).then(({ total, fetched, failed }) => {
      const repositoriesText = `${total} repositor${total === 1 ? "y" : "ies"}`
      setStatus({ text: `refreshed ${repositoriesText}, fetched ${fetched}${failed ? `, ${failed} could not be fetched` : ""}`, error: failed > 0 })
    }, reportError)
  }, [store, busy, track, reportError])

  const repository = repositories.find(candidate => candidate.path === selectedPath) ?? null
  useEffect(() => {
    if (!selectedPath && repositories[0]) {
      setSelectedPath(repositories[0].path)
      setExpanded(previous => new Set([...previous, repositories[0].path, sectionKey(repositories[0].path, "branches")]))
    }
  }, [repositories, selectedPath])

  const log = useMemo(() => repository ? buildLog(repository, commits) : { entries: [], rows: [] }, [repository, commits])
  const entry = log.entries[Math.min(logCursor, log.entries.length - 1)] ?? null

  const logReading = useRef<AbortController | null>(null)
  const loadLog = useCallback(async (path: string) => {
    logReading.current?.abort()
    const reading = new AbortController()
    logReading.current = reading
    const result = await readLog(path, settings, settings.maxCommits, reading.signal).catch((error: unknown) => {
      if (!reading.signal.aborted) reportError(error)
      return { commits: [], truncated: false }
    })
    if (reading.signal.aborted) return
    setCommits(result.commits)
    setTruncated(result.truncated)
  }, [settings, reportError])
  useEffect(() => () => logReading.current?.abort(), [])

  useEffect(() => {
    if (!repository) return
    const next = JSON.stringify([repository.path, repository.head, repository.branches.map(branch => [branch.name, branch.hash]), repository.remotes, repository.tags, repository.stashes.map(stash => stash.hash), repository.operation, settings.branches, settings.showRemoteBranches, settings.order, settings.maxCommits])
    if (next === signature.current) return
    const switched = !signature.current.startsWith(JSON.stringify([repository.path]).slice(0, -1))
    signature.current = next
    if (switched) setLogCursor(0)
    void loadLog(repository.path)
  }, [repository, loadLog, settings.branches, settings.showRemoteBranches, settings.order, settings.maxCommits])

  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!selectedPath) return
    setRevision(store.revisionOf(selectedPath))
    return store.onRevision(path => path === selectedPath && setRevision(store.revisionOf(path)))
  }, [store, selectedPath])

  const entryKey = repository && entry ? `${repository.path}\0${entry.hash}` : ""
  const settledKey = useSettled(entryKey, limits.settleMs)
  const entryHash = settledKey === entryKey && entry ? entry.hash : null
  /** Moves on every change the store saw in the selected repository, so its working tree is read again even when the counts stay the same. */
  const workingRevision = entryHash === WORKING_TREE ? revision : undefined
  /** Details belong to the repository they were read in; another repository's never show, and never stage. */
  const details = loaded && loaded.path === repository?.path ? loaded.details : null
  useEffect(() => {
    if (!repository || !entryHash) {
      if (!entryKey) setLoaded(null)
      return
    }
    const path = repository.path
    const reading = new AbortController()
    void readDetails(path, entryHash, reading.signal).then(result => !reading.signal.aborted && setLoaded({ path, details: result }), error => {
      if (reading.signal.aborted) return
      setLoaded(null)
      reportError(error)
    })
    return () => reading.abort()
  }, [repository?.path, entryHash, workingRevision])

  const fileView = settings.fileView as FileView
  const fileRowsList = useMemo(() => filesOf(details, fileView), [details, fileView])
  const fileRow = fileRowsList[Math.min(fileCursor, fileRowsList.length - 1)]
  const firstFile = fileRowsList.find(row => row.kind === "file")
  const selectedFile = fileRow?.kind === "file" ? fileRow.file : firstFile?.kind === "file" ? firstFile.file : null
  const selectionKey = `${repository?.path}\0${details?.hash}\0${selectedFile?.path}`
  /** The whole-file viewer shows only while the file it was opened on stays selected. */
  const shownFile = viewing?.key === selectionKey ? viewing : null
  useEffect(() => setFileCursor(Math.max(0, fileRowsList.findIndex(row => row.kind === "file"))), [repository?.path, details?.hash])
  useEffect(() => setSelection(null), [selectionKey])

  /** Holding an arrow key in the files pane reads the diff only where the cursor stops. */
  const settledFileCursor = useSettled(String(fileCursor), limits.settleMs)
  useEffect(() => {
    if (!repository || !details || !selectedFile) {
      lastDiffText.current = ""
      setDiff(null)
      return
    }
    if (settledFileCursor !== String(fileCursor)) return
    const reading = new AbortController()
    const { signal } = reading
    const path = repository.path
    const file = selectedFile
    let finished = false
    void (async () => {
      const text = await readDiff(path, details.hash, file, limits.diffKilobytes, signal)
      if (signal.aborted) return
      const key = `${theme.syntax}\0${file.path}\0${text}`
      if (lastDiffText.current === key) return void (finished = true)
      lastDiffText.current = key
      const parsed = parseDiff(text)
      setDiff({ file: file.path, parsed, highlights: null })
      const highlights = await highlighterFor(theme.syntax).highlight(file.path, text, parsed, limits, { signal, onProgress: partial => setDiff({ file: file.path, parsed, highlights: partial }) })
      if (signal.aborted) return
      finished = true
      if (highlights) setDiff({ file: file.path, parsed, highlights })
    })().catch((error: unknown) => {
      if (signal.aborted) return
      setDiff(null)
      reportError(error)
    })
    return () => {
      reading.abort()
      if (!finished) lastDiffText.current = ""
    }
  }, [repository?.path, details, selectedFile?.path, settledFileCursor, fileCursor, theme.syntax, limits.diffKilobytes])

  const treeNodes = useMemo(() => flattenTree(repositories, expanded, filter, palette, glyphs), [repositories, expanded, filter, palette, glyphs])
  const node: TreeNode | undefined = treeNodes[Math.min(treeCursor, treeNodes.length - 1)]
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return new Set(needle ? log.entries.flatMap((candidate, index) => candidate.subject.toLowerCase().includes(needle) || candidate.author.toLowerCase().includes(needle) || candidate.hash.startsWith(needle) || candidate.badges.some(badge => badge.name.toLowerCase().includes(needle)) ? [index] : []) : [])
  }, [query, log.entries])
  const badges = repository && details ? collectBadges(repository).get(details.hash) ?? [] : []
  const operation = repository && details?.hash === WORKING_TREE ? describeOperation(repository, commitNamer(repository)) : ""
  const lines = useMemo(() => shownFile ? fileViewLines(shownFile.file.path, shownFile.text, shownFile.cutAt, shownFile.highlights, theme) : diffLines(details, badges, operation, diff, settings.gitmoji, theme), [shownFile, details, diff, operation, settings.gitmoji, theme, badges.length])

  /** Runs an action's git commands in the repository's turn, with the outcome in the status. */
  const run = useCallback((path: string, label: string, commands: ActionCommands, quiet = false) => {
    setStatus(null)
    void track(label, () => store.runAction(path, commands)).then(() => !quiet && setStatus({ text: `${label}: done`, error: false }), reportError)
  }, [store, track, reportError])

  const openDialog = useCallback((kind: DialogKind, target: DialogTarget = {}, path = selectedPath) => {
    const owner = repositories.find(candidate => candidate.path === path)
    if (!owner || !path) return
    setMenu(null)
    setDialog(openDialogState(path, buildDialog(kind, owner, target), target))
  }, [repositories, selectedPath])

  const submitDialog = useCallback((state: DialogState) => {
    if (state.spec.kind === "settings") {
      const problem = validateSettings(loadConfig(), state.values)
      if (problem) return setDialog({ ...state, error: problem })
      setDialog(null)
      if (state.values.reset !== true) updateConfig(draft => Object.assign(draft, applySettings(draft, state.values)))
      else {
        try {
          setConfig(resetConfig())
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error
          return reportError(error)
        }
      }
      return setStatus({ text: state.values.reset === true ? "settings reset to defaults" : "settings saved", error: false })
    }
    const owner = repositories.find(candidate => candidate.path === state.path)
    if (!owner) return setDialog(null)
    const spec = buildDialog(state.spec.kind, owner, state.target)
    const problem = validateDialog(spec, state.values, owner)
    if (problem) return setDialog({ ...state, error: problem })
    setDialog(null)
    const { hash, stash } = state.target
    // A stash's number shifts when stashes are made or dropped meanwhile: find it again by its commit right before running.
    const commands: ActionCommands = stash && hash
      ? async () => dialogCommands(spec, state.values, owner, { ...state.target, stash: await readStashReference(state.path, hash) })
      : dialogCommands(spec, state.values, owner, state.target)
    run(state.path, spec.title.toLowerCase(), commands)
  }, [repositories, run, updateConfig, reportError])

  /** Opens the settings dialog over the main screen. */
  const openSettings = useCallback(() => {
    setMenu(null)
    setDialog(openDialogState(selectedPath ?? "", settingsDialog(loadConfig()), {}))
  }, [selectedPath])

  const checkout = useCallback((target: DialogTarget, path = selectedPath) => {
    if (!path) return
    if (target.section === "branch" && target.ref) return void run(path, `checkout ${target.ref}`, [["switch", target.ref]])
    openDialog(target.section === "remote" ? "checkoutRemote" : "checkout", target, path)
  }, [openDialog, run, selectedPath])

  /** Opens a whole file in the diff pane, at a line if given, highlighted in the theme's syntax colours. */
  const openFile = useCallback(async (file: ChangedFile | null | undefined, line?: number) => {
    if (!repository || !details || !file) return
    const request = ++viewRequest.current
    const key = `${repository.path}\0${details.hash}\0${file.path}`
    const read = await readWholeFile(repository.path, details.hash, file, limits.diffKilobytes).catch((error: unknown) => {
      if (request === viewRequest.current) reportError(error)
      return null
    })
    if (!read || request !== viewRequest.current) return
    const view = { key, file, text: read.text, cutAt: read.cut ? limits.diffKilobytes : null, highlights: null as Segment[][] | null }
    setViewing(view)
    setSelection(null)
    setFocus("diff")
    setDiffCursor(line ?? 1)
    const source = sourceLines(read.text)
    const parsed = { header: [], hunks: [{ header: "", oldStart: 1, newStart: 1, newCount: source.length, lines: source.map(code => ` ${code}`) }], binary: false, combined: false }
    const stillOpen = (current: typeof viewing) => current?.key === key && request === viewRequest.current
    const highlighted = await highlighterFor(theme.syntax).highlight(file.path, `whole\0${read.text}`, parsed, limits, { onProgress: partial => setViewing(current => stillOpen(current) ? { ...view, highlights: partial[0] } : current) }).catch(() => null)
    if (highlighted) setViewing(current => stillOpen(current) ? { ...view, highlights: highlighted[0] } : current)
  }, [repository, details, limits, theme.syntax, reportError])

  const closeViewer = () => {
    viewRequest.current++
    setViewing(null)
  }

  /**
   * Stages working-tree files, or unstages them when all their changes are staged; staging a conflicted file that
   * still holds conflict markers is refused. Only the working tree's own file list stages.
   * @param group the files, `null` for every change
   */
  const toggleStage = useCallback((group: ChangedFile[] | null) => {
    if (!repository || details?.hash !== WORKING_TREE) return
    const files = group ?? details.files
    if (!files.length) return
    const path = repository.path
    const paths = group ? group.flatMap(file => file.previousPath ? [file.previousPath, file.path] : [file.path]) : ["."]
    const label = group ? "" : " all"
    if (files.every(file => file.staged && !file.unstaged)) return run(path, `unstage${label}`, [repository.head.hash ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths]], true)
    const conflicted = files.filter(file => file.status === "U")
    run(path, `stage${label}`, async () => {
      for (const file of conflicted)
        if (hasConflictMarkers(await readFile(join(path, file.path), "utf8").catch(() => ""))) throw new Error(`${file.path} still holds conflict markers; resolve them before marking it resolved`)
      return [["add", "-A", "--", ...paths]]
    }, true)
  }, [repository, details, run])

  const toggleStageAll = () => toggleStage(null)

  const commitMenu = (target = log.entries[logCursor]): MenuItem[] => {
    if (!target || !repository) return []
    const dialogTarget: DialogTarget = { hash: target.hash, section: "commit", subject: target.subject }
    if (target.hash === WORKING_TREE) return [{ label: "Commit…", run: () => openDialog("commit") }, { label: "Stage All", run: toggleStageAll }, { label: "Stash Changes…", run: () => openDialog("stash") }]
    return [
      { label: "Checkout…", run: () => checkout(dialogTarget) },
      { label: "Merge…", run: () => openDialog("merge", dialogTarget), separator: true },
      { label: "Rebase…", run: () => openDialog("rebase", dialogTarget) },
      { label: "Branch…", run: () => openDialog("branch", dialogTarget), separator: true },
      { label: "Tag…", run: () => openDialog("tag", dialogTarget) },
      { label: "Cherry Pick…", run: () => openDialog("cherryPick", dialogTarget), separator: true },
      { label: "Reverse Commit…", run: () => openDialog("revert", dialogTarget) },
      { label: "Reset Current Branch to This Commit…", run: () => openDialog("reset", dialogTarget) },
      { label: "Copy SHA-1 to Clipboard", run: () => copy(target.hash), separator: true },
      { label: "Copy Commit Message", run: () => void readDetails(repository.path, target.hash).then(read => copy(read.message, "copied the commit message"), reportError) },
    ]
  }

  const treeMenu = (target = treeNodes[treeCursor]): MenuItem[] => {
    if (!target) return []
    const dialogTarget: DialogTarget = { hash: target.hash, ref: target.ref, section: target.kind, stash: target.stash, subject: target.label }
    switch (target.kind) {
      case "repository":
        return [
          { label: "Remove from List", run: () => persist(() => store.hide(target.path)) },
          { label: "Move Up", run: () => {
            setSelectedPath(target.path)
            moveRepository(-1)
          } },
          { label: "Move Down", run: () => {
            setSelectedPath(target.path)
            moveRepository(1)
          } },
          { label: "Copy Path", run: () => copy(target.path), separator: true },
          { label: "Add Repository…", run: () => askAddRepository(), separator: true },
          { label: "Rescan Folder", run: () => treeEvents.onAction("rescan") },
        ]
      case "branch":
        return [
          { label: `Checkout ${target.ref}`, run: () => checkout(dialogTarget, target.path) },
          { label: "Merge into Current Branch…", run: () => openDialog("merge", dialogTarget, target.path), separator: true },
          { label: "Rebase Current Branch onto This…", run: () => openDialog("rebase", dialogTarget, target.path) },
          { label: "New Branch Here…", run: () => openDialog("branch", dialogTarget, target.path), separator: true },
          { label: "Rename…", run: () => openDialog("renameBranch", dialogTarget, target.path) },
          { label: "Delete…", run: () => openDialog("deleteBranch", dialogTarget, target.path) },
          { label: "Copy Branch Name", run: () => copy(target.ref ?? ""), separator: true },
        ]
      case "remote":
        return [
          { label: `Checkout ${target.ref}…`, run: () => checkout(dialogTarget, target.path) },
          { label: "Merge into Current Branch…", run: () => openDialog("merge", dialogTarget, target.path), separator: true },
          { label: "Rebase Current Branch onto This…", run: () => openDialog("rebase", dialogTarget, target.path) },
          { label: "Delete Branches…", run: () => openDialog("deleteBranches", dialogTarget, target.path), separator: true },
          { label: "Copy Branch Name", run: () => copy(target.ref ?? "") },
        ]
      case "tag":
        return [
          { label: `Checkout ${target.ref}…`, run: () => checkout(dialogTarget, target.path) },
          { label: "New Branch Here…", run: () => openDialog("branch", dialogTarget, target.path) },
          { label: "Push Tag…", run: () => openDialog("pushTag", dialogTarget, target.path), separator: true },
          { label: "Delete Tag…", run: () => openDialog("deleteTag", dialogTarget, target.path) },
          { label: "Copy Tag Name", run: () => copy(target.ref ?? ""), separator: true },
        ]
      case "stash":
        return [
          { label: "Apply Stash…", run: () => openDialog("stashApply", dialogTarget, target.path) },
          { label: "Pop Stash…", run: () => openDialog("stashPop", dialogTarget, target.path) },
          { label: "Delete Stash…", run: () => openDialog("stashDrop", dialogTarget, target.path), separator: true },
        ]
      default:
        return []
    }
  }

  /** Moves the selected repository one place up (-1) or down (1) the list, keeping the cursor on it. */
  const moveRepository = (step: number) => {
    const moving = selectedPath
    if (!moving) return
    const paths = repositories.map(candidate => candidate.path)
    const index = paths.indexOf(moving)
    const next = index + step
    if (index === -1 || next < 0 || next >= paths.length) return
    paths.splice(index, 1)
    paths.splice(next, 0, moving)
    persist(() => store.reorder(paths))
    const nextNode = flattenTree(store.repositories, expanded, filter, palette, glyphs).findIndex(candidate => candidate.key === moving)
    if (nextNode !== -1) setTreeCursor(nextNode)
  }

  const askAddRepository = () => setPrompt({
    label: "Add repository at path",
    value: `${store.root}/`,
    onSubmit: value => void store.add(expandPath(value)).then(root => setStatus({ text: `added ${root}`, error: false }), reportError),
  })

  /** WORKSPACE rows: File status selects the working-tree row, History the HEAD commit, Search starts the commit search. */
  const openWorkspace = (target: TreeNode) => {
    setSelectedPath(target.path)
    if (target.view === "search") return setJumping(true)
    setFocus("log")
    const owner = repositories.find(candidate => candidate.path === target.path)
    const index = target.view === "status" ? log.entries.findIndex(candidate => candidate.hash === WORKING_TREE) : log.entries.findIndex(candidate => candidate.hash === owner?.head.hash)
    setLogCursor(Math.max(0, index))
  }

  const toggleNode = (target: TreeNode | undefined, open?: boolean) => {
    if (!target?.toggle) return
    const key = target.toggle
    setExpanded(previous => {
      const next = new Set(previous)
      if (open ?? !next.has(key)) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const cycleSetting = (key: "branches" | "showRemoteBranches" | "order" | "compact" | "dateFormat" | "gitmoji" | "fileView") => updateConfig(draft => {
    const options: Record<string, unknown[]> = { branches: ["all", "current"], showRemoteBranches: [true, false], order: ["ancestor", "date"], compact: [false, true], dateFormat: ["absolute", "relative"], gitmoji: [true, false], fileView: ["path", "status", "tree"] }
    const list = options[key]
    const current = draft.settings[key]
    ;(draft.settings as unknown as Record<string, unknown>)[key] = list[(list.indexOf(current) + 1) % list.length]
  })

  const width = screenWidth
  const bodyHeight = screenHeight - TOOLBAR_HEIGHT
  const minimumWidth = spacing.sidebarMinWidth + 1 + 2 * spacing.paneMinWidth + 1
  const minimumHeight = TOOLBAR_HEIGHT + 2 + 2 * spacing.paneMinHeight
  const tooSmall = width < minimumWidth || screenHeight < minimumHeight
  const clamp = (value: number, lowest: number, highest: number) => Math.max(lowest, Math.min(highest, value))
  const widestSidebar = width - 2 * spacing.paneMinWidth - 2
  const treeWidth = clamp(Math.min(columns.tree, Math.floor(width / 2)), spacing.sidebarMinWidth, widestSidebar)
  const mainWidth = width - treeWidth
  const tallestDetails = bodyHeight - 2 - spacing.paneMinHeight
  const detailsHeight = clamp(columns.details ?? Math.floor(bodyHeight * DETAILS_SHARE), spacing.paneMinHeight, tallestDetails)
  const logHeight = bodyHeight - detailsHeight - 2
  const widestFiles = mainWidth - spacing.paneMinWidth - 1
  const filesWidth = clamp(columns.files, spacing.paneMinWidth, widestFiles)
  const current = repository?.branches.find(branch => branch.current)
  const diffScroll = useWindowStart(diffCursor, lines.length, detailsHeight)
  const logStart = useWindowStart(logCursor, log.entries.length, logListHeight(logHeight))
  const graph = graphWidth(log.rows.slice(logStart, logStart + logListHeight(logHeight)), columns, settings.compact)

  const resizeColumn = (column: "graph" | "author" | "date" | "tree", step: number) => updateConfig(draft => {
    const change = step * spacing.resizeStep
    if (column === "graph") draft.columns.graph = clamp((draft.columns.graph ?? graph) + change, spacing.columnMinWidth, spacing.columnMaxWidth)
    else if (column === "tree") draft.columns.tree = clamp(treeWidth + change, spacing.sidebarMinWidth, widestSidebar)
    else draft.columns[column] = clamp(draft.columns[column] + change, spacing.columnMinWidth, spacing.columnMaxWidth)
  })

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) return setPrompt(null)
      if (key.return) {
        prompt.onSubmit(prompt.value)
        return setPrompt(null)
      }
      if (key.backspace || key.delete) return setPrompt({ ...prompt, value: prompt.value.slice(0, -1) })
      if (input && !key.ctrl && !key.meta) setPrompt({ ...prompt, value: prompt.value + input })
      return
    }
    if (dialog) {
      const next = dialogKey(dialog, input, key)
      if ("action" in next) return next.action === "open" ? openUrl(next.url) : next.action === "cancel" ? setDialog(null) : submitDialog(dialog)
      return setDialog(next)
    }
    if (menu) {
      if (key.escape) return setMenu(null)
      if (key.upArrow || key.downArrow) return setMenu({ ...menu, cursor: (menu.cursor + (key.downArrow ? 1 : -1) + menu.items.length) % menu.items.length })
      if (key.return) {
        setMenu(null)
        menu.items[menu.cursor]?.run()
      }
      return
    }
    if (filtering) {
      if (key.escape) {
        setFilter("")
        return setFiltering(false)
      }
      if (key.return) return setFiltering(false)
      if (key.backspace || key.delete) return setFilter(filter.slice(0, -1))
      if (input && !key.ctrl && !key.meta) {
        setTreeCursor(0)
        setFilter(filter + input)
      }
      return
    }
    if (jumping) {
      if (key.escape) {
        setQuery("")
        return setJumping(false)
      }
      if (key.return) {
        const matches = [...found]
        const next = matches.find(index => index > logCursor) ?? matches[0]
        if (next !== undefined) setLogCursor(next)
        return
      }
      if (key.backspace || key.delete) return setQuery(query.slice(0, -1))
      if (input && !key.ctrl && !key.meta) setQuery(query + input)
      return
    }
    if (key.escape && shownFile) return closeViewer()
    const keys = config.keys
    if (input === keys.quit || (key.ctrl && input === "c")) return quit()
    if (tooSmall) return
    if (key.tab) return setFocus(PANES[(PANES.indexOf(focus) + (key.shift ? PANES.length - 1 : 1)) % PANES.length])
    if (input === keys.fetch) return openDialog("fetch")
    if (input === keys.refresh) return refreshAll()
    if (input === keys.pull) return openDialog("pull")
    if (input === keys.push) return openDialog("push")
    if (input === keys.branch) return openDialog("branch", focus === "log" && entry && entry.hash !== WORKING_TREE ? { hash: entry.hash } : {})
    if (input === keys.merge) return openDialog("merge")
    if (input === keys.stash) return openDialog("stash")
    if (input === keys.tag) return openDialog("tag", focus === "log" && entry && entry.hash !== WORKING_TREE ? { hash: entry.hash, subject: entry.subject } : {})
    if (input === keys.commit) return openDialog("commit")
    if (input === keys.settings) return openSettings()
    if (input === keys.rescan) return treeEvents.onAction("rescan")
    if (input === keys.moveUp || input === keys.moveDown) return moveRepository(input === keys.moveUp ? -1 : 1)
    if (input === keys.add) return askAddRepository()
    if (input === keys.branches) return cycleSetting("branches")
    if (input === keys.remotes) return cycleSetting("showRemoteBranches")
    if (input === keys.order) return cycleSetting("order")
    if (input === keys.view) return cycleSetting("compact")
    if (input === keys.dates) return cycleSetting("dateFormat")
    if (input === keys.gitmoji) return cycleSetting("gitmoji")
    if (input === keys.fileView) return cycleSetting("fileView")
    if (input === keys.graphNarrower || input === keys.graphWider) return resizeColumn("graph", input === keys.graphWider ? 1 : -1)
    if (input === keys.authorNarrower || input === keys.authorWider) return resizeColumn("author", input === keys.authorWider ? 1 : -1)
    if (input === keys.dateNarrower || input === keys.dateWider) return resizeColumn("date", input === keys.dateWider ? 1 : -1)
    if (input === keys.sidebarNarrower || input === keys.sidebarWider) return resizeColumn("tree", input === keys.sidebarWider ? 1 : -1)
    if (input === keys.menu || input === " " && (focus === "log" || focus === "diff")) {
      const items = focus === "tree" ? treeMenu() : focus === "log" ? commitMenu() : []
      if (items.length) setMenu({ title: focus === "tree" ? node?.label ?? "" : entry?.subject ?? "", items, cursor: 0 })
      return
    }
    if (input === keys.search) return focus === "tree" ? setFiltering(true) : setJumping(true)
    if (input === keys.copyHash && entry && entry.hash !== WORKING_TREE) return copy(entry.hash)
    const page = Math.max(1, Math.floor(screenHeight / 2))
    const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -page : key.pageDown ? page : 0
    if (focus !== "tree" && (key.leftArrow || key.rightArrow)) return shiftPane(focus, key.leftArrow ? -1 : 1)
    if (focus === "tree") {
      if (step) return setTreeCursor(Math.max(0, Math.min(treeNodes.length - 1, treeCursor + step)))
      if (key.shift && (key.leftArrow || key.rightArrow)) return shiftPane("tree", key.leftArrow ? -1 : 1)
      if (input === keys.remove && node?.kind === "repository") return persist(() => store.hide(node.path))
      if (key.leftArrow || key.rightArrow) {
        const moved = moveInTree(treeNodes, Math.min(treeCursor, treeNodes.length - 1), expanded, key.leftArrow ? "left" : "right")
        if (moved.expanded !== expanded) setExpanded(moved.expanded)
        return setTreeCursor(moved.cursor)
      }
      if (input === " ") return toggleNode(node)
      if (key.return && node) {
        if (node.kind === "workspace") return openWorkspace(node)
        if (node.kind === "repository" || node.kind === "section" || node.kind === "remoteGroup") {
          if (node.kind === "repository") setSelectedPath(node.path)
          return toggleNode(node, node.kind === "repository" ? true : undefined)
        }
        if (node.kind === "stash") return openDialog("stashApply", { stash: node.stash, hash: node.hash, subject: node.label }, node.path)
        return checkout({ section: node.kind, ref: node.ref, hash: node.hash }, node.path)
      }
      if (node && node.path !== selectedPath && (step || key.return)) setSelectedPath(node.path)
    }
    if (focus === "log") {
      if (step) return setLogCursor(Math.max(0, Math.min(log.entries.length - 1, logCursor + step)))
      if (key.home) return setLogCursor(0)
      if (key.end) return setLogCursor(log.entries.length - 1)
      if (key.return && entry && entry.hash !== WORKING_TREE) return checkout({ section: "commit", hash: entry.hash, subject: entry.subject })
    }
    if (focus === "files") {
      if (step) return setFileCursor(Math.max(0, Math.min(fileRowsList.length - 1, fileCursor + step)))
      if (key.return) return void openFile(selectedFile)
      if (input === " " && fileRow && details?.hash === WORKING_TREE) return toggleStage(rowFiles(fileRowsList, fileCursor))
    }
    if (focus === "diff") {
      if (step) return setDiffCursor(Math.max(0, Math.min(lines.length - 1, diffCursor + step)))
      if (key.return && !shownFile) return void openFile(selectedFile, lines[diffCursor]?.line)
    }
  })

  useEffect(() => {
    const repositoryOfCursor = node?.path
    if (focus === "tree" && repositoryOfCursor && repositoryOfCursor !== selectedPath && node?.kind === "repository") setSelectedPath(repositoryOfCursor)
  }, [node?.path, node?.kind, focus])

  useEffect(() => {
    if (focus !== "tree" || !node?.hash || node.path !== selectedPath) return
    const index = log.entries.findIndex(candidate => candidate.hash === node.hash)
    if (index !== -1) setLogCursor(index)
  }, [node?.key, log.entries])

  const [scrollX, setScrollX] = useState<Record<Pane, number>>({ tree: 0, log: 0, files: 0, diff: 0 })
  const shiftPane = (pane: Pane, step: number) => setScrollX(previous => ({ ...previous, [pane]: Math.max(0, previous[pane] + step * 4) }))
  const wheel = (pane: Pane, move: (step: number) => void) => (step: number, event: MouseEvent) => {
    if (event.kind === "wheelLeft" || event.kind === "wheelRight") return shiftPane(pane, step)
    move(step * 3)
  }
  const clampTree = (value: number) => clamp(value, 0, treeNodes.length - 1)
  const clampLog = (value: number) => clamp(value, 0, log.entries.length - 1)
  const clampFiles = (value: number) => clamp(value, 0, fileRowsList.length - 1)
  const clampDiff = (value: number) => clamp(value, 0, lines.length - 1)

  const tools: { label: string; key: string; count?: number; run: () => void }[] = [
    { label: "Commit", key: config.keys.commit, count: repository?.changes, run: () => openDialog("commit") },
    { label: "Pull", key: config.keys.pull, count: current?.behind, run: () => openDialog("pull") },
    { label: "Push", key: config.keys.push, count: current?.ahead, run: () => openDialog("push") },
    { label: "Fetch", key: config.keys.fetch, run: () => openDialog("fetch") },
    { label: "Refresh", key: config.keys.refresh, run: refreshAll },
    { label: "Branch", key: config.keys.branch, run: () => openDialog("branch") },
    { label: "Merge", key: config.keys.merge, run: () => openDialog("merge") },
    { label: "Stash", key: config.keys.stash, count: repository?.stashes.length, run: () => openDialog("stash") },
    { label: "Tag", key: config.keys.tag, run: () => openDialog("tag") },
    { label: "Settings", key: config.keys.settings, run: openSettings },
  ]
  const filters: { key: "branches" | "showRemoteBranches" | "order" | "compact" | "dateFormat" | "gitmoji"; label: string }[] = [
    { key: "branches", label: settings.branches === "all" ? "All Branches" : "Current Branch" },
    { key: "showRemoteBranches", label: settings.showRemoteBranches ? "Show Remote Branches" : "Hide Remote Branches" },
    { key: "order", label: settings.order === "ancestor" ? "Ancestor Order" : "Date Order" },
    { key: "compact", label: settings.compact ? "Compact View" : "Large View" },
    { key: "dateFormat", label: settings.dateFormat === "absolute" ? "Absolute Dates" : "Relative Dates" },
    { key: "gitmoji", label: settings.gitmoji ? "Gitmoji" : "Shortcodes" },
  ]

  /**
   * A press on a divider: the returned function follows the drag, resizing on screen only, and saves the size once
   * the button is released after a move.
   * @param size the columns a pointer position sets
   */
  const divider = (size: (event: MouseEvent, start: MouseEvent) => Partial<Config["columns"]>) => (start: MouseEvent) => {
    let moved = false
    return (event: MouseEvent) => {
      const change = size(event, start)
      if (event.kind !== "up") {
        moved = true
        return setDragColumns(previous => ({ ...previous, ...change }))
      }
      setDragColumns(null)
      if (moved) updateConfig(draft => Object.assign(draft.columns, change))
    }
  }
  const treeDivider = divider(event => ({ tree: clamp(event.x, spacing.sidebarMinWidth, widestSidebar) }))
  const detailsDivider = divider(event => ({ details: clamp(screenHeight - 2 - event.y, spacing.paneMinHeight, tallestDetails) }))
  const filesDivider = divider(event => ({ files: clamp(event.x - treeWidth, spacing.paneMinWidth, widestFiles) }))
  const columnDivider = (column: LogColumn, start: MouseEvent) => {
    const initial = { graph, hash: columns.hash, author: columns.author, date: columns.date }
    return divider(event => {
      const delta = event.x - start.x
      if (column === "graph") return { graph: clamp(initial.graph + delta, spacing.columnMinWidth, spacing.columnMaxWidth) }
      // Right of the description the columns hang from the pane's right edge: each divider sizes the column after it.
      const after = COLUMN_AFTER[column]
      return { [after]: clamp(initial[after] - delta, spacing.columnMinWidth, spacing.columnMaxWidth) }
    })(start)
  }

  const treeEvents: TreeEvents = {
    onWheel: wheel("tree", step => setTreeCursor(clampTree(treeCursor + step))),
    onFilter: () => setFiltering(true),
    onAction: action => {
      if (action === "add") return askAddRepository()
      if (action === "up" || action === "down") return moveRepository(action === "up" ? -1 : 1)
      void track("rescanning", () => store.restore()).then(({ total, added }) => {
        setStatus({ text: `found ${total} repositor${total === 1 ? "y" : "ies"}${added ? `, ${added} new` : ", nothing new"}`, error: false })
      }, reportError)
    },
    onMove: (index, rows) => {
      const moving = treeNodes[index]
      const target = treeNodes[clampTree(index + rows)]
      if (moving?.kind !== "repository" || !target || target.path === moving.path) return
      const paths = repositories.map(candidate => candidate.path).filter(path => path !== moving.path)
      paths.splice(paths.indexOf(target.path) + (rows > 0 ? 1 : 0), 0, moving.path)
      persist(() => store.reorder(paths))
      setStatus({ text: `moved ${moving.label}`, error: false })
    },
    onToggle: index => {
      setFocus("tree")
      setTreeCursor(index)
      toggleNode(treeNodes[index])
    },
    onRow: (index, gesture) => {
      const target = treeNodes[index]
      if (!target) return
      setFocus("tree")
      setTreeCursor(index)
      if (target.path !== selectedPath) setSelectedPath(target.path)
      if (gesture === "right") {
        const items = treeMenu(target)
        if (items.length) setMenu({ title: target.label, items, cursor: 0 })
        return
      }
      if (target.kind === "workspace") return openWorkspace(target)
      if (gesture === "click" && (target.kind === "section" || target.kind === "remoteGroup")) return toggleNode(target)
      if (gesture !== "double") return
      if (target.kind === "stash") return openDialog("stashApply", { stash: target.stash, hash: target.hash, subject: target.label }, target.path)
      if (target.kind === "branch" || target.kind === "remote" || target.kind === "tag") return checkout({ section: target.kind, ref: target.ref, hash: target.hash }, target.path)
      toggleNode(target)
    },
  }

  const logEvents: LogEvents = {
    onWheel: wheel("log", step => setLogCursor(clampLog(logCursor + step))),
    onColumnPress: columnDivider,
    onHash: index => {
      const target = log.entries[index]
      if (target && target.hash !== WORKING_TREE) copy(target.hash)
    },
    onRow: (index, gesture) => {
      const target = log.entries[index]
      if (!target) return
      setFocus("log")
      setLogCursor(index)
      if (gesture === "right") {
        const items = commitMenu(target)
        if (items.length) setMenu({ title: target.subject, items, cursor: 0 })
        return
      }
      if (gesture === "double" && target.hash !== WORKING_TREE) checkout({ section: "commit", hash: target.hash, subject: target.subject })
    },
  }

  const detailsEvents: DetailsEvents = {
    onFilesHeader: () => cycleSetting("fileView"),
    onFilesWheel: wheel("files", step => setFileCursor(clampFiles(fileCursor + step))),
    onDiffWheel: wheel("diff", step => setDiffCursor(clampDiff(diffCursor + step))),
    onFile: (index, gesture) => {
      setFocus("files")
      setFileCursor(index)
      const row = fileRowsList[index]
      closeViewer()
      if (gesture === "double" && row?.kind === "file") void openFile(row.file)
    },
    onStage: index => toggleStage(rowFiles(fileRowsList, index)),
    onStageAll: toggleStageAll,
    onSelect: start => {
      const point = (event: { localX: number; localY: number }) => {
        const line = clamp(diffScroll + event.localY, 0, lines.length - 1)
        const drawn = lines[line] ?? { segments: [] }
        return { line, column: clamp(event.localX - gutterWidth(drawn) + scrollX.diff, 0, lineCells(drawn, limits.tabWidth) - 1) }
      }
      const anchor = point(start)
      let current: DiffSelection | null = null
      return event => {
        current = { anchor, focus: point(event) }
        if (event.kind !== "up") return setSelection(current)
        if (current.anchor.line === current.focus.line && current.anchor.column === current.focus.column) return setSelection(null)
        const text = selectedText(lines, current, limits.tabWidth)
        setSelection(current)
        copy(text, `copied ${text.split("\n").length} line${text.includes("\n") ? "s" : ""}, ${text.length} characters`)
      }
    },
    onLine: (index, gesture) => {
      setSelection(null)
      setFocus("diff")
      setDiffCursor(index)
      if (lines[index]?.copy) return copy(lines[index].copy as string)
      if (gesture === "double" && !shownFile) void openFile(selectedFile, lines[index]?.line)
    },
  }

  useEffect(() => {
    if (repository) process.stdout.write(`\x1b]0;${repository.name} (Git)\x07`)
  }, [repository?.name])

  const overlay = dialog ? (
    <DialogBox state={dialog} width={width} height={bodyHeight}
      onActivate={(stop, choice) => {
        const url = dialogLink(dialog, stop)
        if (url) openUrl(url)
        setDialog(dialogActivate(dialog, stop, choice))
      }}
      onCancel={() => setDialog(null)}
      onSubmit={() => submitDialog(dialog)}
      onWheel={step => setDialog(dialogMove(dialog, step))} />
  ) : menu ? (
    <MenuBox state={menu} width={width} height={bodyHeight}
      onChoose={index => {
        setMenu(null)
        menu.items[index]?.run()
      }}
      onClose={() => setMenu(null)} />
  ) : prompt ? (
    <Box width={width} height={bodyHeight} justifyContent="center" alignItems="flex-start" paddingTop={2}>
      <Box flexDirection="column" width={Math.min(spacing.dialogWidth + 6, width - 4)} borderStyle="round" borderColor={palette.accent} borderBackgroundColor={palette.background} backgroundColor={palette.background} paddingX={1}>
        <Text bold color={palette.text}>{prompt.label}</Text>
        <Text backgroundColor={palette.field} color={palette.text}>{fit(`${prompt.value}${glyphs.cursor}`, Math.min(spacing.dialogWidth + 2, width - 8))}</Text>
        <Box justifyContent="flex-end" gap={2}>
          <Clickable onClick={() => setPrompt(null)}><Text color={palette.text}> Cancel </Text></Clickable>
          <Clickable onClick={() => {
            prompt.onSubmit(prompt.value)
            setPrompt(null)
          }}><Text bold color={palette.accent} backgroundColor={palette.field}> Add </Text></Clickable>
        </Box>
      </Box>
    </Box>
  ) : null

  if (tooSmall) return (
    <ThemeProvider value={theme}>
      <Box width={width} height={screenHeight} backgroundColor={theme.surface}>
        <Text color={palette.danger} wrap="wrap">{`gittt needs a terminal of at least ${minimumWidth} × ${minimumHeight} cells; this one is ${width} × ${screenHeight}. ${config.keys.quit} quits.`}</Text>
      </Box>
    </ThemeProvider>
  )

  return (
    <ThemeProvider value={theme}>
    <Box flexDirection="column" width={width} height={screenHeight} backgroundColor={theme.surface}>
      <Box height={1} width={width} overflow="hidden">
        <Text color={palette.accent} bold>{" gittt   "}</Text>
        {tools.map(tool => (
          <Clickable key={tool.label} onClick={tool.run}>
            <Text>
              <Text color={palette.accent} bold>{tool.key}</Text>
              <Text color={palette.text}> {tool.label}</Text>
              {tool.count ? <Text color={palette.accent} bold>{` ${tool.count}`}</Text> : null}
              <Text>{" ".repeat(spacing.toolbarGap)}</Text>
            </Text>
          </Clickable>
        ))}
        <Box flexGrow={1} />
        <Text color={status?.error ? palette.danger : palette.textMuted} wrap="truncate-start">{busy ? `${glyphs.sync} ${busy}… ` : status ? `${status.text} ` : scanning ? "searching repositories… " : ""}</Text>
        {update ? <Clickable flexShrink={0} onClick={applyUpdate}><Text backgroundColor={palette.accent} color={palette.accentText} bold>{" Update "}</Text><Text> </Text></Clickable> : null}
      </Box>
      <Text color={palette.border}>{glyphs.rule.repeat(width)}</Text>
      {overlay ?? (
        <Box height={bodyHeight}>
          <TreePane nodes={treeNodes} cursor={treeCursor} selectedPath={selectedPath} width={treeWidth - 1} height={bodyHeight} focused={focus === "tree"} filter={filter} filtering={filtering} scrollX={scrollX.tree} keys={config.keys} events={treeEvents} />
          <Clickable width={1} height={bodyHeight} flexDirection="column" onPress={treeDivider}>
            <Text color={focus === "tree" ? palette.accent : palette.border}>{`${glyphs.divider}\n`.repeat(bodyHeight).trimEnd()}</Text>
          </Clickable>
          <Box flexDirection="column" width={mainWidth}>
            <Box height={1} overflow="hidden">
              {filters.map(item => (
                <Clickable key={item.key} flexShrink={0} onClick={() => cycleSetting(item.key)}>
                  <Text color={palette.text}> {item.label} <Text color={palette.accent}>{glyphs.dropdown}</Text> </Text>
                </Clickable>
              ))}
              {jumping || query ? (
                <Text>
                  <Text color={palette.textMuted}>  {glyphs.search} </Text>
                  <Text backgroundColor={palette.field} color={palette.accent}>{fit(`${query}${jumping ? glyphs.cursor : ""}${query ? ` ${found.size}` : ""}`, spacing.searchWidth)}</Text>
                </Text>
              ) : null}
            </Box>
            <LogPane entries={log.entries} rows={log.rows} cursor={logCursor} start={logStart} width={mainWidth} height={logHeight} focused={focus === "log"} headHash={repository?.head.hash ?? null} settings={settings} columns={columns} found={found} query={query} truncated={truncated} scrollX={scrollX.log} events={logEvents} />
            <Clickable height={1} width={mainWidth} onPress={detailsDivider}>
              <Text color={palette.border}>{glyphs.splitter.repeat(mainWidth)}</Text>
            </Clickable>
            <Box height={detailsHeight}>
              <FilesPane rows={fileRowsList} cursor={fileCursor} width={filesWidth} height={detailsHeight} focused={focus === "files"} view={fileView} working={details?.hash === WORKING_TREE} scrollX={scrollX.files} viewKey={config.keys.fileView} events={detailsEvents} />
              <Clickable width={1} height={detailsHeight} flexDirection="column" onPress={filesDivider}>
                <Text color={palette.border}>{`${glyphs.divider}\n`.repeat(detailsHeight).trimEnd()}</Text>
              </Clickable>
              <DiffPane lines={lines} scroll={diffScroll} scrollX={scrollX.diff} cursorLine={diffCursor} selection={selection} width={mainWidth - filesWidth - 1} height={detailsHeight} focused={focus === "diff"} tabWidth={limits.tabWidth} events={detailsEvents} />
            </Box>
          </Box>
        </Box>
      )}
    </Box>
    </ThemeProvider>
  )
}
