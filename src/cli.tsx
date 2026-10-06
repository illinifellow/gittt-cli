/**
 * `gittt`: asks which folder to search for repositories (prefilled with the
 * current directory or the path given as the first argument), remembers it
 * among recent folders, then opens the main screen in the terminal's alternate
 * screen with mouse reporting on. After an update, and in a checkout whenever
 * `dist/app.js` is rebuilt, gittt replaces itself in place (same process, same
 * folder). Leaving by any route, a crash included, stops the git processes still
 * running and gives the terminal back as it was: normal screen, no mouse
 * reporting, the window title restored.
 */
import { realpathSync, unwatchFile, watchFile } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { render, useWindowSize } from "ink"
import { useState } from "react"
import { ConfigError, loadConfig, loadState, saveState } from "@/config"
import { stopGit } from "@/git"
import { mouse, startMouse } from "@/mouse"
import { dispatchMouse } from "@/mouse/regions"
import { RepositoryStore } from "@/store"
import { queryBackground, terminalBackground } from "@/terminal"
import { App } from "@/ui"
import { FolderPicker } from "@/ui/picker"
import { resolveTheme } from "@/theme"
import { ThemeProvider } from "@/ui/theme"
import { isCheckout } from "@/update"

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[H"
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l"
/** xterm's title stack: gittt pushes the title before setting its own and pops it on the way out. */
const SAVE_TITLE = "\x1b[22;0t"
const RESTORE_TITLE = "\x1b[23;0t"

/** The folder being browsed, carried over a restart; set by `GITTT_FOLDER` or the folder picker. */
let folder = process.env.GITTT_FOLDER

const Root = ({ initial, resumed, onRestart }: { initial: string; resumed: boolean; onRestart: () => void }) => {
  const [store, setStore] = useState<RepositoryStore | null>(() => resumed ? new RepositoryStore(initial) : null)
  const { columns } = useWindowSize()
  if (store) return <App store={store} onRestart={onRestart} />
  return (
    <ThemeProvider value={resolveTheme(loadConfig(), terminalBackground())}>
    <FolderPicker initial={initial} recent={loadState().recent} width={columns} onPick={picked => {
      const state = loadState()
      try {
        saveState({ ...state, recent: [picked, ...state.recent.filter(path => path !== picked)].slice(0, loadConfig().limits.recentFolders) })
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error
      }
      folder = picked
      setStore(new RepositoryStore(picked))
    }} />
    </ThemeProvider>
  )
}

const { limits } = loadConfig()
await queryBackground(limits.backgroundQueryMs)
process.stdout.write(SAVE_TITLE + ENTER_ALTERNATE_SCREEN)
const { keyboard, stop } = startMouse({ doubleClickMs: limits.doubleClickMs, doubleClickCells: limits.doubleClickCells }, limits.inputSplitMs)
mouse.on("mouse", dispatchMouse)

let terminalRestored = false
/** Gives the terminal back as gittt found it and stops git; runs once, whichever way gittt leaves. */
const restoreTerminal = () => {
  if (terminalRestored) return
  terminalRestored = true
  stop()
  process.stdout.write(LEAVE_ALTERNATE_SCREEN + RESTORE_TITLE)
  process.stdin.setRawMode?.(false)
  stopGit()
}
process.on("exit", restoreTerminal)

let restarting = false
/** Leaves the screen so the closing handler can start the new gittt in this process. */
const restart = () => {
  if (restarting) return
  restarting = true
  instance.unmount()
}

const instance = render(<Root initial={folder ?? resolve(process.argv[2] ?? process.cwd())} resumed={Boolean(folder)} onRestart={restart} />, { exitOnCtrlC: true, stdin: keyboard as unknown as NodeJS.ReadStream })

/** An error nothing caught: the screen goes, the terminal comes back, and the error is printed where it stays readable. */
const crash = (error: unknown) => {
  instance.unmount()
  restoreTerminal()
  process.stderr.write(`gittt stopped on an unexpected error:\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}
process.on("uncaughtException", crash)
process.on("unhandledRejection", crash)
for (const signal of ["SIGTERM", "SIGHUP"] as const) process.once(signal, () => instance.unmount())

const bundle = realpathSync(fileURLToPath(import.meta.url))
if (isCheckout()) watchFile(bundle, { interval: 1000 }, (current, previous) => {
  if (current.mtimeMs !== previous.mtimeMs) setTimeout(restart, limits.refreshDelayMs)
})

void instance.waitUntilExit().finally(() => {
  unwatchFile(bundle)
  restoreTerminal()
  if (!restarting) process.exit(0)
  try {
    if (!process.execve) throw new Error("this Node has no process.execve")
    process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, ...(folder ? { GITTT_FOLDER: folder } : {}) })
  } catch (error) {
    process.stdout.write(`gittt cannot restart itself here (${(error as Error).message}); start it again to use the new version\n`)
    process.exit(0)
  }
})
