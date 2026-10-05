/**
 * Mouse input for the terminal: switches on SGR mouse reporting, takes the
 * mouse reports out of stdin before ink sees them, and emits them as events.
 * Ink reads the remaining keystrokes from a TTY-like stream.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

/** One mouse report; coordinates are 0-based cells. */
export interface MouseEvent {
  x: number
  y: number
  kind: "down" | "up" | "drag" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight"
  button: "left" | "middle" | "right" | "none"
  /** A second press on the same row, at most two cells away, within the configured double-click time. */
  double: boolean
  shift: boolean
}

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
const DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l"
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

/** Emits `mouse` with a MouseEvent. */
export const mouse = new EventEmitter()

/** A stdin replacement for ink: keystrokes only, with the TTY methods ink calls. */
type KeyboardStream = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => KeyboardStream }

/** How many cells sideways the second press of a double click may land from the first: a hand moves a little between presses. */
const DOUBLE_CLICK_SLACK = 2

/**
 * Starts mouse reporting and splits stdin.
 * @param doubleClickMs the longest gap between two presses on one row, at most two cells apart, that still makes a double click
 * @returns the keyboard-only stream to hand to ink, and a function that switches mouse reporting off again
 */
export const startMouse = (doubleClickMs: number) => {
  const keyboard = new PassThrough() as KeyboardStream
  keyboard.isTTY = true
  keyboard.setRawMode = mode => {
    process.stdin.setRawMode?.(mode)
    return keyboard
  }
  let lastPress = { x: -1, y: -1, time: 0 }
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on("data", (chunk: Buffer) => {
    const rest = chunk.toString("utf8").replace(REPORT, (_whole, code: string, column: string, row: string, final: string) => {
      const value = Number(code)
      const x = Number(column) - 1
      const y = Number(row) - 1
      const buttonCode = value & 3
      const motion = (value & 32) !== 0
      const wheel = (value & 64) !== 0
      const button = wheel ? "none" : (["left", "middle", "right", "none"] as const)[buttonCode]
      const shift = (value & 4) !== 0
      const wheelKinds = shift ? (["wheelLeft", "wheelRight", "wheelLeft", "wheelRight"] as const) : (["wheelUp", "wheelDown", "wheelLeft", "wheelRight"] as const)
      const kind = wheel ? wheelKinds[buttonCode] : motion ? "drag" : final === "m" ? "up" : "down"
      let double = false
      if (kind === "down" && button === "left") {
        const now = Date.now()
        double = now - lastPress.time < doubleClickMs && lastPress.y === y && Math.abs(lastPress.x - x) <= DOUBLE_CLICK_SLACK
        lastPress = double ? { x: -1, y: -1, time: 0 } : { x, y, time: now }
      }
      mouse.emit("mouse", { x, y, kind, button, double, shift } satisfies MouseEvent)
      return ""
    })
    if (rest) keyboard.write(rest)
  })
  process.stdout.write(ENABLE)
  return { keyboard, stop: () => process.stdout.write(DISABLE) }
}
