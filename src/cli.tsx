/**
 * `gittt`: asks which folder to search for repositories (prefilled with the
 * current directory or the path given as the first argument), remembers it
 * among recent folders, then opens the main screen in the
 * terminal's alternate screen with mouse reporting on. A new build of gittt
 * replaces the running one in place, keeping the chosen folder.
 */
import { spawn } from "node:child_process"
import { realpathSync, unwatchFile, watchFile } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { render, useWindowSize } from "ink"
import { useState } from "react"
import { loadConfig, saveConfig } from "@/config"
import { mouse, startMouse } from "@/mouse"
import { dispatchMouse } from "@/mouse/regions"
import { RepositoryStore } from "@/store"
import { queryBackground, terminalBackground } from "@/terminal"
import { App } from "@/ui"
import { FolderPicker } from "@/ui/picker"
import { paletteOf } from "@/ui/text"

const Root = ({ initial, resumed }: { initial: string; resumed: boolean }) => {
  const [store, setStore] = useState<RepositoryStore | null>(() => resumed ? new RepositoryStore(initial) : null)
  const { columns } = useWindowSize()
  const config = loadConfig()
  if (store) return <App store={store} />
  return (
    <FolderPicker initial={initial} recent={config.recent} width={columns} palette={paletteOf(config.tokens, terminalBackground())} onPick={folder => {
      const next = loadConfig()
      next.recent = [folder, ...next.recent.filter(path => path !== folder)].slice(0, 12)
      saveConfig(next)
      process.env.GITTT_FOLDER = folder
      setStore(new RepositoryStore(folder))
    }} />
  )
}

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[H"
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l"

await queryBackground()
process.stdout.write(ENTER_ALTERNATE_SCREEN)
const { keyboard, stop } = startMouse()
mouse.on("mouse", dispatchMouse)
const resumedFolder = process.env.GITTT_FOLDER
const instance = render(<Root initial={resumedFolder ?? resolve(process.argv[2] ?? process.cwd())} resumed={Boolean(resumedFolder)} />, { exitOnCtrlC: true, stdin: keyboard as unknown as NodeJS.ReadStream })
let restarting = false

const bundle = realpathSync(fileURLToPath(import.meta.url))
watchFile(bundle, { interval: 1000 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs || restarting) return
  restarting = true
  setTimeout(() => instance.unmount(), 300)
})

void instance.waitUntilExit().finally(() => {
  unwatchFile(bundle)
  stop()
  process.stdout.write(LEAVE_ALTERNATE_SCREEN)
  if (!restarting) process.exit(0)
  process.stdin.setRawMode?.(false)
  process.stdin.pause()
  const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit", env: process.env })
  child.on("exit", code => process.exit(code ?? 0))
})
