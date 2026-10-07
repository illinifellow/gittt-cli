/**
 * A terminal for rendering ink components in tests: a fixed-size screen that keeps the last frame
 * as plain text, and a keyboard that feeds key presses to `useInput`.
 */
import { EventEmitter } from "node:events"
import { render } from "ink"
import { createElement, type ReactElement } from "react"
import { loadDefaults } from "@/config"
import { resolveTheme } from "@/theme"
import { ThemeProvider } from "@/ui/theme"

/** The default theme, as the app resolves it with no terminal background known. */
export const THEME = resolveTheme(loadDefaults(), undefined)

/** Escape sequences ink writes for colour and style. */
const STYLE_SEQUENCE = /\x1b\[[0-9;]*m/g

/** A terminal for ink: a fixed size, the last frame kept. */
class Screen extends EventEmitter {
  columns = 100
  rows = 30
  frame = ""
  write = (frame: string) => void (this.frame = frame)
}

/** Keyboard input for ink. */
class Keyboard extends EventEmitter {
  isTTY = true
  private pending: string | null = null
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const data = this.pending
    this.pending = null
    return data
  }
  press = (data: string) => {
    this.pending = data
    this.emit("readable")
  }
}

/** Keys as a terminal sends them. */
export const KEYS = { up: "\x1b[A", down: "\x1b[B", tab: "\t", enter: "\r", escape: "\x1b", backspace: "\x7f" }

/** Lets ink and React settle after an input. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 30))

/**
 * Renders an element inside the default theme.
 * @param element what to draw
 * @returns the current frame as plain text, a key presser, and a closer
 */
export const draw = (element: ReactElement) => {
  const screen = new Screen()
  const keyboard = new Keyboard()
  const instance = render(createElement(ThemeProvider, { value: THEME }, element), { stdout: screen as unknown as NodeJS.WriteStream, stdin: keyboard as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false })
  return {
    text: () => screen.frame.replace(STYLE_SEQUENCE, ""),
    press: async (...keys: string[]) => {
      for (const key of keys) {
        keyboard.press(key)
        await settle()
      }
    },
    close: () => instance.unmount(),
    exited: instance.waitUntilExit(),
  }
}
