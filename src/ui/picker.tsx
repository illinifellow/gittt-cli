/**
 * The first screen: asks which folder to search for repositories, prefilled
 * with the current directory, with recent folders below. Tab completes a
 * folder name, ↑ ↓ pick a recent folder, Enter starts, Esc quits.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useRef, useState } from "react"
import { mouse, type MouseEvent } from "@/mouse"
import { fit } from "./text"
import { useTheme } from "./theme"

const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()))

const complete = (typed: string) => {
  const path = expand(typed)
  const folder = typed.endsWith("/") ? path : dirname(path)
  const prefix = typed.endsWith("/") ? "" : basename(path)
  try {
    const matches = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith("."))).map(entry => entry.name)
    if (!matches.length) return typed
    let shared = matches[0]
    for (const match of matches) while (!match.startsWith(shared)) shared = shared.slice(0, -1)
    const completed = join(folder, shared)
    return matches.length === 1 ? `${completed}/` : completed
  } catch {
    return typed
  }
}

/**
 * @param props.initial folder the input starts with
 * @param props.recent recently opened folders, newest first
 * @param props.onPick called with the chosen folder once it exists
 * @param props.width screen width in cells
 */
export const FolderPicker = ({ initial, recent, onPick, width }: { initial: string; recent: string[]; onPick: (folder: string) => void; width: number }) => {
  const { colors: palette, glyphs } = useTheme()
  const { exit } = useApp()
  const [value, setValue] = useState(initial)
  const [cursor, setCursor] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const choices = recent.filter(folder => folder !== initial).slice(0, 8)
  useInput((input, key) => {
    if (key.escape) return exit()
    if (key.return) {
      const folder = expand(value)
      if (!existsSync(folder) || !statSync(folder).isDirectory()) return setError(`${folder} is not a folder`)
      return onPick(folder)
    }
    if (key.tab) return setValue(complete(value))
    if (key.upArrow || key.downArrow) {
      const next = Math.max(-1, Math.min(choices.length - 1, cursor + (key.downArrow ? 1 : -1)))
      setCursor(next)
      setValue(next === -1 ? initial : choices[next])
      return
    }
    if (key.backspace || key.delete) return setValue(value.slice(0, -1))
    if (input && !key.ctrl && !key.meta) {
      setError(null)
      setValue(value + input)
    }
  })
  const firstRecentRow = 9 + (error ? 1 : 0)
  const handler = useRef((_event: MouseEvent) => undefined as void)
  handler.current = event => {
    if (event.kind !== "down" || event.button !== "left") return
    const index = event.y - firstRecentRow
    if (index < 0 || index >= choices.length) return
    setCursor(index)
    setValue(choices[index])
    if (event.double) onPick(choices[index])
  }
  useEffect(() => {
    const listener = (event: MouseEvent) => handler.current(event)
    mouse.on("mouse", listener)
    return () => void mouse.off("mouse", listener)
  }, [])
  const boxWidth = Math.min(90, width - 4)
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width={width} minHeight={process.stdout.rows ?? 24} backgroundColor={palette.background}>
      <Text color={palette.accent} bold>gittt</Text>
      <Text color={palette.text}>Where should gittt look for repositories?</Text>
      <Box borderStyle="round" borderColor={palette.accent} borderBackgroundColor={palette.background} backgroundColor={palette.background} width={boxWidth} marginTop={1}>
        <Text color={palette.text}>{fit(`${value}${glyphs.cursor}`, boxWidth - 2)}</Text>
      </Box>
      {error ? <Text color={palette.stash}>{glyphs.error} {error}</Text> : null}
      {choices.length ? <Text color={palette.textMuted}>Recent</Text> : null}
      {choices.map((folder, index) => <Text key={folder} color={index === cursor ? palette.accent : palette.text}>{index === cursor ? `${glyphs.pointer} ` : "  "}{folder}</Text>)}
      <Text color={palette.textMuted}>{"\n"}enter start · tab complete · ↑↓ or click recent · double-click opens · esc quit</Text>
    </Box>
  )
}
