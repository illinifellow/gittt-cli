/**
 * The main screen: toolbar, repository tree on
 * the left, filter bar and commit log on the right, files and diff below, a
 * transient status at the right end of the toolbar. Every action opens a
 * dialog; the context menu ("." or a right click) lists the actions for the
 * row; every element answers the mouse.
 */
import { spawn } from "node:child_process"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadConfig, resetConfig, saveConfig, type Config } from "@/config"
import { buildDialog, dialogCommands, validateDialog, type DialogKind, type DialogTarget } from "@/dialogs"
import { parseDiff, type ParsedDiff } from "@/diff"
import { rowFiles, type FileView } from "@/files"
import { readDetails, readDiff, readLog, readWholeFile, runGit } from "@/git"
import { DiffHighlighter, type Segment } from "@/highlight"
import { buildLog, collectBadges, commitNamer, describeOperation } from "@/history"
import { WORKING_TREE, type ChangedFile, type Commit, type CommitDetails, type Repository } from "@/protocol"
import type { RepositoryStore } from "@/store"
import { readSyntaxTheme } from "@/syntax"
import { DiffPane, FilesPane, diffLines, fileViewLines, filesOf, gutterWidth, lineText, selectedText, type DetailsEvents, type DiffSelection } from "./details"
import type { MouseEvent } from "@/mouse"
import { Clickable } from "@/mouse/regions"
import { DialogBox, dialogActivate, dialogKey, dialogLink, openDialogState, type DialogState } from "./dialog"
import { applySettings, openUrl, settingsDialog, validateSettings } from "@/settings"
import { LogPane, graphWidth, visibleRange, type LogColumn, type LogEvents } from "./log"
import { MenuBox, type MenuItem, type MenuState } from "./menu"
import { terminalBackground } from "@/terminal"
import { resolveTheme } from "@/theme"
import { availableUpdate, installUpdate } from "@/update"
import { fit } from "./text"
import { ThemeProvider } from "./theme"
import { TreePane, flattenTree, sectionKey, type TreeEvents, type TreeNode } from "./tree"

/** How often a running gittt asks GitHub for a newer release: every six hours. */
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000

type Pane = "tree" | "log" | "files" | "diff"

const PANES: Pane[] = ["tree", "log", "files", "diff"]
const highlighters = new Map<string, DiffHighlighter>()

/** @returns the highlighter for a syntax theme, created once per name */
const highlighterFor = (syntax: string) => {
  if (!highlighters.has(syntax)) highlighters.set(syntax, new DiffHighlighter(readSyntaxTheme(syntax), loadConfig().limits))
  return highlighters.get(syntax) as DiffHighlighter
}

const toClipboard = (text: string) => {
  const child = spawn(process.platform === "darwin" ? "pbcopy" : "xclip", process.platform === "darwin" ? [] : ["-selection", "clipboard"])
  child.stdin.end(text)
}

/**
 * The main screen.
 * @param props.store the catalogue of the chosen folder
 */
/** The column each log divider right of the graph resizes. */
const COLUMN_AFTER = { description: "hash", hash: "author", author: "date" } as const

export const App = ({ store }: { store: RepositoryStore }) => {
  const { exit } = useApp()
  const { columns: screenWidth, rows: screenHeight } = useWindowSize()
  const [config, setConfig] = useState<Config>(loadConfig)
  const theme = useMemo(() => resolveTheme(config, terminalBackground()), [config])
  const { colors: palette, glyphs } = theme
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
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [fileCursor, setFileCursor] = useState(0)
  const [diff, setDiff] = useState<{ file: string; parsed: ParsedDiff; highlights: Segment[][][] | null } | null>(null)
  const [diffCursor, setDiffCursor] = useState(0)
  const lastDiffText = useRef({ key: "" })
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [viewing, setViewing] = useState<{ file: ChangedFile; text: string; highlights: Segment[][] | null } | null>(null)
  const [focus, setFocus] = useState<Pane>("log")
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [prompt, setPrompt] = useState<{ label: string; value: string; onSubmit: (value: string) => void } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [update, setUpdate] = useState<string | null>(null)

  useEffect(() => {
    const check = () => void availableUpdate().then(version => setUpdate(version))
    check()
    const timer = setInterval(check, UPDATE_CHECK_MS)
    return () => clearInterval(timer)
  }, [])

  /** Installs the newer release; the bundle changing on disk restarts gittt with the same folder. */
  const applyUpdate = useCallback(() => {
    if (!update || busy) return
    setBusy(`updating to ${update}`)
    void installUpdate(update).then(() => setStatus({ text: `updated to ${update}, restarting`, error: false }), (error: Error) => setStatus({ text: error.message, error: true })).finally(() => setBusy(null))
  }, [update, busy])
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), status.error ? config.limits.errorStatusMs : config.limits.statusMs)
    return () => clearTimeout(timer)
  }, [status])
  const signature = useRef("")

  const settings = config.settings
  const copy = (text: string) => {
    toClipboard(text)
    setStatus({ text: `copied ${text}`, error: false })
  }
  const updateConfig = useCallback((change: (draft: Config) => void) => {
    const next = structuredClone(loadConfig())
    change(next)
    saveConfig(next)
    setConfig(next)
  }, [])

  useEffect(() => store.subscribe(() => {
    setRepositories([...store.repositories])
    setScanning(store.scanning)
  }), [store])
  useEffect(() => void store.rescan(), [store])

  const repository = repositories.find(candidate => candidate.path === selectedPath) ?? null
  useEffect(() => {
    if (!selectedPath && repositories[0]) {
      setSelectedPath(repositories[0].path)
      setExpanded(previous => new Set([...previous, repositories[0].path, sectionKey(repositories[0].path, "branches")]))
    }
  }, [repositories, selectedPath])

  const log = useMemo(() => repository ? buildLog(repository, commits) : { entries: [], rows: [] }, [repository, commits])
  const entry = log.entries[Math.min(logCursor, log.entries.length - 1)] ?? null

  const loadLog = useCallback(async (path: string) => {
    const result = await readLog(path, settings, settings.maxCommits).catch(() => ({ commits: [], truncated: false }))
    setCommits(result.commits)
    setTruncated(result.truncated)
  }, [settings])

  useEffect(() => {
    if (!repository) return
    const next = JSON.stringify([repository.path, repository.head, repository.branches.map(branch => [branch.name, branch.hash]), repository.remotes, repository.tags, repository.stashes.map(stash => stash.hash), repository.operation, settings.branches, settings.showRemoteBranches, settings.order])
    if (next === signature.current) return
    const switched = !signature.current.startsWith(JSON.stringify([repository.path]).slice(0, -1))
    signature.current = next
    if (switched) setLogCursor(0)
    void loadLog(repository.path)
  }, [repository, loadLog, settings.branches, settings.showRemoteBranches, settings.order])

  const entryHash = entry?.hash ?? null
  const changes = repository?.changes ?? 0
  useEffect(() => {
    if (!repository || !entryHash) {
      setDetails(null)
      return
    }
    let current = true
    void readDetails(repository.path, entryHash).then(result => current && setDetails(result), () => current && setDetails(null))
    return () => {
      current = false
    }
  }, [repository?.path, entryHash, changes, repository?.staged, repository?.conflicts])

  const fileView = settings.fileView as FileView
  const fileRowsList = useMemo(() => filesOf(details, fileView), [details, fileView])
  const fileRow = fileRowsList[Math.min(fileCursor, fileRowsList.length - 1)]
  const selectedFile = fileRow?.kind === "file" ? fileRow.file : fileRowsList.find(row => row.kind === "file")?.kind === "file" ? (fileRowsList.find(row => row.kind === "file") as { file: CommitDetails["files"][number] }).file : null
  useEffect(() => setFileCursor(Math.max(0, fileRowsList.findIndex(row => row.kind === "file"))), [details?.hash])
  useEffect(() => setSelection(null), [details?.hash, selectedFile?.path])
  useEffect(() => {
    if (!repository || !details || !selectedFile) {
      lastDiffText.current = { key: "" }
      setDiff(null)
      return
    }
    let current = true
    void (async () => {
      const text = await readDiff(repository.path, details.hash, selectedFile, config.limits.diffKilobytes)
      if (!current) return
      if (lastDiffText.current.key === `${theme.syntax}\0${selectedFile.path}\0${text}`) return
      lastDiffText.current = { key: `${theme.syntax}\0${selectedFile.path}\0${text}` }
      const parsed = parseDiff(text)
      setDiff({ file: selectedFile.path, parsed, highlights: null })
      const highlights = await highlighterFor(theme.syntax).highlight(selectedFile.path, text, parsed, partial => current && setDiff({ file: selectedFile.path, parsed, highlights: partial }))
      if (current && highlights) setDiff({ file: selectedFile.path, parsed, highlights })
    })().catch(() => current && setDiff(null))
    return () => {
      current = false
    }
  }, [repository?.path, details, selectedFile?.path, theme.syntax])

  const treeNodes = useMemo(() => flattenTree(repositories, expanded, filter, palette, glyphs), [repositories, expanded, filter, palette, glyphs])
  const node: TreeNode | undefined = treeNodes[Math.min(treeCursor, treeNodes.length - 1)]
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return new Set(needle ? log.entries.flatMap((candidate, index) => candidate.subject.toLowerCase().includes(needle) || candidate.author.toLowerCase().includes(needle) || candidate.hash.startsWith(needle) || candidate.badges.some(badge => badge.name.toLowerCase().includes(needle)) ? [index] : []) : [])
  }, [query, log.entries])
  const badges = repository && details ? collectBadges(repository).get(details.hash) ?? [] : []
  const operation = repository && details?.hash === WORKING_TREE ? describeOperation(repository, commitNamer(repository)) : ""
  const lines = useMemo(() => viewing ? fileViewLines(viewing.file.path, viewing.text, viewing.highlights, theme) : diffLines(details, badges, operation, diff, settings.gitmoji, theme), [viewing, details, diff, operation, settings.gitmoji, palette, badges.length])

  const run = useCallback(async (path: string, label: string, commands: string[][], quiet = false) => {
    setBusy(label)
    setStatus(null)
    try {
      for (const command of commands) await runGit(path, command)
      if (!quiet) setStatus({ text: `${label}: done`, error: false })
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message.split("\n").slice(-3).join(" ") : String(error), error: true })
    } finally {
      setBusy(null)
      void store.refresh(path)
    }
  }, [store])

  const openDialog = useCallback((kind: DialogKind, target: DialogTarget = {}, path = selectedPath) => {
    const owner = repositories.find(candidate => candidate.path === path)
    if (!owner || !path) return
    setMenu(null)
    setDialog(openDialogState(path, buildDialog(kind, owner, target), target))
  }, [repositories, selectedPath])

  const submitDialog = useCallback((state: DialogState) => {
    if (state.spec.kind === "settings") {
      const problem = validateSettings(state.values)
      if (problem) return setDialog({ ...state, error: problem })
      setDialog(null)
      if (state.values.reset === true) setConfig(resetConfig())
      else updateConfig(draft => Object.assign(draft, applySettings(draft, state.values)))
      return setStatus({ text: state.values.reset === true ? "settings reset to defaults" : "settings saved", error: false })
    }
    const owner = repositories.find(candidate => candidate.path === state.path)
    if (!owner) return setDialog(null)
    const spec = buildDialog(state.spec.kind, owner, state.target)
    const problem = validateDialog(spec, state.values, owner)
    if (problem) return setDialog({ ...state, error: problem })
    setDialog(null)
    void run(state.path, spec.title.toLowerCase(), dialogCommands(spec, state.values, owner, state.target))
  }, [repositories, run, updateConfig])

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
    const text = await readWholeFile(repository.path, details.hash, file, config.limits.diffKilobytes).catch((error: Error) => {
      setStatus({ text: error.message.split("\n").slice(-2).join(" "), error: true })
      return null
    })
    if (text === null) return
    const view = { file, text, highlights: null as Segment[][] | null }
    setViewing(view)
    setSelection(null)
    setFocus("diff")
    setDiffCursor(line ?? 1)
    const source = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
    const parsed = { header: [], hunks: [{ header: "", oldStart: 1, newStart: 1, newCount: source.length, lines: source.map(code => ` ${code}`) }], binary: false, combined: false }
    const highlighted = await highlighterFor(theme.syntax).highlight(file.path, `whole\0${text}`, parsed, partial => setViewing(current => current?.file === file ? { ...view, highlights: partial[0] } : current)).catch(() => null)
    if (highlighted) setViewing(current => current?.file === file ? { ...view, highlights: highlighted[0] } : current)
  }, [repository, details, config.limits.diffKilobytes, theme.syntax])

  /** Stages a working-tree file, or unstages it when all its changes are staged. */
  const toggleStage = useCallback((group: ChangedFile[]) => {
    if (!repository || !group.length) return
    const paths = group.flatMap(file => file.previousPath ? [file.previousPath, file.path] : [file.path])
    const unstage = group.every(file => file.staged && !file.unstaged)
    void run(repository.path, unstage ? "unstage" : "stage", [unstage ? (repository.head.hash ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths]) : ["add", "-A", "--", ...paths]], true)
  }, [repository, run])

  /** Stages every working-tree change, or unstages everything when all of it is staged. */
  const toggleStageAll = useCallback(() => {
    if (!repository || !details) return
    const unstage = details.files.length > 0 && details.files.every(file => file.staged && !file.unstaged)
    void run(repository.path, unstage ? "unstage all" : "stage all", [unstage ? (repository.head.hash ? ["restore", "--staged", "--", "."] : ["rm", "--cached", "-r", "-q", "--", "."]) : ["add", "-A"]], true)
  }, [repository, details, run])

  const commitMenu = (entry = log.entries[logCursor]): MenuItem[] => {
    if (!entry || !repository) return []
    const target: DialogTarget = { hash: entry.hash, section: "commit", subject: entry.subject }
    if (entry.hash === WORKING_TREE) return [{ label: "Commit…", run: () => openDialog("commit") }, { label: "Stage All", run: toggleStageAll }, { label: "Stash Changes…", run: () => openDialog("stash") }]
    return [
      { label: "Checkout…", run: () => checkout(target) },
      { label: "Merge…", run: () => openDialog("merge", target), separator: true },
      { label: "Rebase…", run: () => openDialog("rebase", target) },
      { label: "Branch…", run: () => openDialog("branch", target), separator: true },
      { label: "Tag…", run: () => openDialog("tag", target) },
      { label: "Cherry Pick…", run: () => openDialog("cherryPick", target), separator: true },
      { label: "Reverse Commit…", run: () => openDialog("revert", target) },
      { label: "Reset Current Branch to This Commit…", run: () => openDialog("reset", target) },
      { label: "Copy SHA-1 to Clipboard", run: () => copy(entry.hash), separator: true },
      { label: "Copy Commit Message", run: () => copy(entry.subject) },
    ]
  }

  const treeMenu = (node = treeNodes[treeCursor]): MenuItem[] => {
    if (!node) return []
    const target: DialogTarget = { hash: node.hash, ref: node.ref, section: node.kind, stash: node.stash, subject: node.label }
    switch (node.kind) {
      case "repository":
        return [
          { label: "Remove from List", run: () => store.hide(node.path) },
          { label: "Move Up", run: () => {
            setSelectedPath(node.path)
            moveRepository(-1)
          } },
          { label: "Move Down", run: () => {
            setSelectedPath(node.path)
            moveRepository(1)
          } },
          { label: "Copy Path", run: () => copy(node.path), separator: true },
          { label: "Add Repository…", run: () => askAddRepository(), separator: true },
          { label: "Rescan Folder", run: () => treeEvents.onAction("rescan") },
        ]
      case "branch":
        return [
          { label: `Checkout ${node.ref}`, run: () => checkout(target, node.path) },
          { label: "Merge into Current Branch…", run: () => openDialog("merge", target, node.path), separator: true },
          { label: "Rebase Current Branch onto This…", run: () => openDialog("rebase", target, node.path) },
          { label: "New Branch Here…", run: () => openDialog("branch", target, node.path), separator: true },
          { label: "Rename…", run: () => openDialog("renameBranch", target, node.path) },
          { label: "Delete…", run: () => openDialog("deleteBranch", target, node.path) },
          { label: "Copy Branch Name", run: () => copy(node.ref ?? ""), separator: true },
        ]
      case "remote":
        return [
          { label: `Checkout ${node.ref}…`, run: () => checkout(target, node.path) },
          { label: "Merge into Current Branch…", run: () => openDialog("merge", target, node.path), separator: true },
          { label: "Rebase Current Branch onto This…", run: () => openDialog("rebase", target, node.path) },
          { label: "Delete Branches…", run: () => openDialog("deleteBranches", target, node.path), separator: true },
          { label: "Copy Branch Name", run: () => copy(node.ref ?? "") },
        ]
      case "tag":
        return [
          { label: `Checkout ${node.ref}…`, run: () => checkout(target, node.path) },
          { label: "New Branch Here…", run: () => openDialog("branch", target, node.path) },
          { label: "Push Tag…", run: () => openDialog("pushTag", target, node.path), separator: true },
          { label: "Delete Tag…", run: () => openDialog("deleteTag", target, node.path) },
          { label: "Copy Tag Name", run: () => copy(node.ref ?? ""), separator: true },
        ]
      case "stash":
        return [
          { label: "Apply Stash…", run: () => openDialog("stashApply", target, node.path) },
          { label: "Pop Stash…", run: () => openDialog("stashPop", target, node.path) },
          { label: "Delete Stash…", run: () => openDialog("stashDrop", target, node.path), separator: true },
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
    store.reorder(paths)
    const nextNode = flattenTree(store.repositories, expanded, filter, palette, glyphs).findIndex(candidate => candidate.key === moving)
    if (nextNode !== -1) setTreeCursor(nextNode)
  }

  const askAddRepository = () => setPrompt({
    label: "Add repository at path",
    value: `${store.root}/`,
    onSubmit: value => void store.add(value).then(root => setStatus({ text: `added ${root}`, error: false }), error => setStatus({ text: String(error.message ?? error), error: true })),
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

  const resizeColumn = (column: "graph" | "author" | "date" | "tree", step: number) => updateConfig(draft => {
    if (column === "graph") draft.columns.graph = Math.max(4, Math.min(60, (draft.columns.graph ?? 12) + step))
    else draft.columns[column] = Math.max(4, Math.min(80, draft.columns[column] + step))
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
    const keys = config.keys
    if (input === keys.quit || (key.ctrl && input === "c")) return exit()
    if (key.tab) return setFocus(PANES[(PANES.indexOf(focus) + (key.shift ? PANES.length - 1 : 1)) % PANES.length])
    if (input === keys.fetch) return openDialog("fetch")
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
    if (input === keys.graphNarrower || input === keys.graphWider) return resizeColumn("graph", input === keys.graphWider ? 2 : -2)
    if (input === keys.authorNarrower || input === keys.authorWider) return resizeColumn("author", input === keys.authorWider ? 2 : -2)
    if (input === keys.dateNarrower || input === keys.dateWider) return resizeColumn("date", input === keys.dateWider ? 2 : -2)
    if (input === keys.sidebarNarrower || input === keys.sidebarWider) return resizeColumn("tree", input === keys.sidebarWider ? 2 : -2)
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
      if (input === keys.remove && node?.kind === "repository") return store.hide(node.path)
      if (key.rightArrow) return toggleNode(node, true)
      if (key.leftArrow) return toggleNode(node, false)
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
      if (key.escape && viewing) return setViewing(null)
      if (key.return && !viewing) return void openFile(selectedFile, lines[diffCursor]?.line)
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

  const width = screenWidth
  const height = screenHeight
  const toolbarHeight = 2
  const statusHeight = 0
  const bodyHeight = Math.max(8, height - toolbarHeight - statusHeight)
  const treeWidth = Math.min(Math.max(20, config.columns.tree), Math.floor(width / 2))
  const mainWidth = width - treeWidth
  const detailsHeight = Math.max(3, Math.min(bodyHeight - 6, config.columns.details ?? Math.floor(bodyHeight * 0.42)))
  const logHeight = bodyHeight - detailsHeight - 2
  const filesWidth = Math.min(config.columns.files, mainWidth - 20)
  const current = repository?.branches.find(branch => branch.current)
  const diffScroll = Math.max(0, Math.min(diffCursor - Math.floor(detailsHeight / 3), lines.length - detailsHeight))

  const [scrollX, setScrollX] = useState<Record<Pane, number>>({ tree: 0, log: 0, files: 0, diff: 0 })
  const shiftPane = (pane: Pane, step: number) => setScrollX(previous => ({ ...previous, [pane]: Math.max(0, previous[pane] + step * 4) }))
  const wheel = (pane: Pane, move: (step: number) => void) => (step: number, event: MouseEvent) => {
    if (event.kind === "wheelLeft" || event.kind === "wheelRight") return shiftPane(pane, step)
    move(step * 3)
  }
  const clampTree = (value: number) => Math.max(0, Math.min(treeNodes.length - 1, value))
  const clampLog = (value: number) => Math.max(0, Math.min(log.entries.length - 1, value))
  const clampFiles = (value: number) => Math.max(0, Math.min(fileRowsList.length - 1, value))
  const clampDiff = (value: number) => Math.max(0, Math.min(lines.length - 1, value))
  const shownRows = visibleRange(logCursor, log.entries.length, logHeight)
  const graph = graphWidth(log.rows.slice(shownRows.start, shownRows.end), config.columns, settings.compact)

  const commitAction = () => openDialog("commit")
  const TOOLS: { label: string; key: string; count?: number; run: () => void }[] = [
    { label: "Commit", key: config.keys.commit, count: changes, run: commitAction },
    { label: "Pull", key: config.keys.pull, count: current?.behind, run: () => openDialog("pull") },
    { label: "Push", key: config.keys.push, count: current?.ahead, run: () => openDialog("push") },
    { label: "Fetch", key: config.keys.fetch, run: () => openDialog("fetch") },
    { label: "Branch", key: config.keys.branch, run: () => openDialog("branch") },
    { label: "Merge", key: config.keys.merge, run: () => openDialog("merge") },
    { label: "Stash", key: config.keys.stash, count: repository?.stashes.length, run: () => openDialog("stash") },
    { label: "Tag", key: config.keys.tag, run: () => openDialog("tag") },
    { label: "Settings", key: config.keys.settings, run: openSettings },
  ]
  const FILTERS: { key: "branches" | "showRemoteBranches" | "order" | "compact" | "dateFormat" | "gitmoji"; label: string }[] = [
    { key: "branches", label: settings.branches === "all" ? "All Branches" : "Current Branch" },
    { key: "showRemoteBranches", label: settings.showRemoteBranches ? "Show Remote Branches" : "Hide Remote Branches" },
    { key: "order", label: settings.order === "ancestor" ? "Ancestor Order" : "Date Order" },
    { key: "compact", label: settings.compact ? "Compact View" : "Large View" },
    { key: "dateFormat", label: settings.dateFormat === "absolute" ? "Absolute Dates" : "Relative Dates" },
    { key: "gitmoji", label: settings.gitmoji ? "Gitmoji" : "Shortcodes" },
  ]

  /** A press on a divider: the returned function follows the drag and stores the new size. */
  const divider = (apply: (event: MouseEvent, start: MouseEvent) => void) => (start: MouseEvent) => (event: MouseEvent) => apply(event, start)
  const treeDivider = divider(event => updateConfig(draft => { draft.columns.tree = Math.max(16, Math.min(width - 40, event.x)) }))
  const detailsDivider = divider(event => updateConfig(draft => { draft.columns.details = Math.max(3, Math.min(bodyHeight - 6, height - 2 - event.y)) }))
  const filesDivider = divider(event => updateConfig(draft => { draft.columns.files = Math.max(12, Math.min(mainWidth - 20, event.x - treeWidth)) }))
  const columnDivider = (column: LogColumn, start: MouseEvent) => {
    const initial = { graph, hash: config.columns.hash, author: config.columns.author, date: config.columns.date }
    return (event: MouseEvent) => updateConfig(draft => {
      const delta = event.x - start.x
      if (column === "graph") return void (draft.columns.graph = Math.max(3, Math.min(80, initial.graph + delta)))
      // Right of the description the columns hang from the pane's right edge: each divider sizes the column after it.
      const after = COLUMN_AFTER[column]
      draft.columns[after] = Math.max(4, Math.min(80, initial[after] - delta))
    })
  }

  const treeEvents: TreeEvents = {
    onWheel: wheel("tree", step => setTreeCursor(clampTree(treeCursor + step))),
    onFilter: () => setFiltering(true),
    onAction: action => {
      if (action === "add") return askAddRepository()
      if (action === "up" || action === "down") return moveRepository(action === "up" ? -1 : 1)
      setBusy("rescanning")
      void store.restore().then(({ total, added }) => {
        setBusy(null)
        setStatus({ text: `found ${total} repositor${total === 1 ? "y" : "ies"}${added ? `, ${added} new` : ", nothing new"}`, error: false })
      })
    },
    onMove: (index, rows) => {
      const moving = treeNodes[index]
      const target = treeNodes[Math.max(0, Math.min(treeNodes.length - 1, index + rows))]
      if (moving?.kind !== "repository" || !target || target.path === moving.path) return
      const paths = repositories.map(candidate => candidate.path).filter(path => path !== moving.path)
      paths.splice(paths.indexOf(target.path) + (rows > 0 ? 1 : 0), 0, moving.path)
      store.reorder(paths)
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
      setViewing(null)
      if (gesture === "double" && row?.kind === "file") void openFile(row.file)
    },
    onStage: index => toggleStage(rowFiles(fileRowsList, index)),
    onStageAll: toggleStageAll,
    onSelect: start => {
      const point = (event: { localX: number; localY: number }) => {
        const line = Math.max(0, Math.min(lines.length - 1, diffScroll + event.localY))
        const text = [...lineText(lines[line] ?? { segments: [] })]
        return { line, column: Math.max(0, Math.min(text.length - 1, event.localX - gutterWidth(lines[line] ?? { segments: [] }) + scrollX.diff)) }
      }
      const anchor = point(start)
      let current: DiffSelection | null = null
      return event => {
        current = { anchor, focus: point(event) }
        if (event.kind !== "up") return setSelection(current)
        if (current.anchor.line === current.focus.line && current.anchor.column === current.focus.column) return setSelection(null)
        const text = selectedText(lines, current)
        toClipboard(text)
        setSelection(current)
        setStatus({ text: `copied ${text.split("\n").length} line${text.includes("\n") ? "s" : ""}, ${text.length} characters`, error: false })
      }
    },
    onLine: (index, gesture) => {
      setSelection(null)
      setFocus("diff")
      setDiffCursor(index)
      if (lines[index]?.copy) return copy(lines[index].copy as string)
      if (gesture === "double" && !viewing) void openFile(selectedFile, lines[index]?.line)
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
      onSubmit={() => submitDialog(dialog)} />
  ) : menu ? (
    <MenuBox state={menu} width={width} height={bodyHeight}
      onChoose={index => {
        setMenu(null)
        menu.items[index]?.run()
      }}
      onClose={() => setMenu(null)} />
  ) : prompt ? (
    <Box width={width} height={bodyHeight} justifyContent="center" alignItems="flex-start" paddingTop={2}>
      <Box flexDirection="column" width={Math.min(theme.spacing.dialogWidth + 6, width - 4)} borderStyle="round" borderColor={palette.accent} borderBackgroundColor={palette.background} backgroundColor={palette.background} paddingX={1}>
        <Text bold color={palette.text}>{prompt.label}</Text>
        <Text backgroundColor={palette.field} color={palette.text}>{fit(`${prompt.value}${glyphs.cursor}`, Math.min(theme.spacing.dialogWidth + 2, width - 8))}</Text>
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

  return (
    <ThemeProvider value={theme}>
    <Box flexDirection="column" width={width} height={height} backgroundColor={theme.surface}>
      <Box height={1} width={width} overflow="hidden">
        <Text color={palette.accent} bold>{" gittt   "}</Text>
        {TOOLS.map(tool => (
          <Clickable key={tool.label} onClick={tool.run}>
            <Text>
              <Text color={palette.accent} bold>{tool.key}</Text>
              <Text color={palette.text}> {tool.label}</Text>
              {tool.count ? <Text color={palette.accent} bold>{` ${tool.count}`}</Text> : null}
              <Text>{" ".repeat(theme.spacing.toolbarGap)}</Text>
            </Text>
          </Clickable>
        ))}
        <Box flexGrow={1} />
        <Text color={status?.error ? palette.stash : palette.textMuted} wrap="truncate-start">{busy ? `⟳ ${busy}… ` : status ? `${status.text} ` : scanning ? "searching repositories… " : ""}</Text>
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
              {FILTERS.map(item => (
                <Clickable key={item.key} flexShrink={0} onClick={() => cycleSetting(item.key)}>
                  <Text color={palette.text}> {item.label} <Text color={palette.accent}>{glyphs.dropdown}</Text> </Text>
                </Clickable>
              ))}
              {jumping || query ? (
                <Text>
                  <Text color={palette.textMuted}>  {glyphs.search} </Text>
                  <Text backgroundColor={palette.field} color={palette.accent}>{fit(`${query}${jumping ? glyphs.cursor : ""}${query ? ` ${found.size}` : ""}`, theme.spacing.searchWidth)}</Text>
                </Text>
              ) : null}
            </Box>
            <LogPane entries={log.entries} rows={log.rows} cursor={logCursor} width={mainWidth} height={logHeight} focused={focus === "log"} headHash={repository?.head.hash ?? null} settings={settings} columns={config.columns} found={found} query={query} truncated={truncated} scrollX={scrollX.log} events={logEvents} />
            <Clickable height={1} width={mainWidth} onPress={detailsDivider}>
              <Text color={palette.border}>{glyphs.splitter.repeat(mainWidth)}</Text>
            </Clickable>
            <Box height={detailsHeight}>
              <FilesPane rows={fileRowsList} cursor={fileCursor} width={filesWidth} height={detailsHeight} focused={focus === "files"} view={fileView} working={details?.hash === WORKING_TREE} scrollX={scrollX.files} viewKey={config.keys.fileView} events={detailsEvents} />
              <Clickable width={1} height={detailsHeight} flexDirection="column" onPress={filesDivider}>
                <Text color={palette.border}>{`${glyphs.divider}\n`.repeat(detailsHeight).trimEnd()}</Text>
              </Clickable>
              <DiffPane lines={lines} scroll={diffScroll} scrollX={scrollX.diff} cursorLine={diffCursor} selection={selection} width={mainWidth - filesWidth - 1} height={detailsHeight} focused={focus === "diff"} events={detailsEvents} />
            </Box>
          </Box>
        </Box>
      )}
    </Box>
    </ThemeProvider>
  )
}
