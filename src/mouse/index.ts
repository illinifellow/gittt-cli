/**
 * Mouse input for the terminal: switches on SGR mouse reporting, takes the
 * mouse reports out of stdin before ink sees them, and emits them as events.
 * Ink reads the remaining keystrokes from a TTY-like stream. Input arrives in
 * chunks that may split a report or a multi-byte character; both are joined
 * with the next chunk, so neither turns into stray keystrokes.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { StringDecoder } from "node:string_decoder"

/** One mouse report; coordinates are 0-based cells. */
export interface MouseEvent {
  x: number
  y: number
  kind: "down" | "up" | "drag" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight"
  button: "left" | "middle" | "right" | "none"
  /** A second press on the same row, a few cells away at most, within the configured double-click time. */
  double: boolean
  shift: boolean
}

/** How presses count as a double click. */
export interface ClickTiming {
  /** The longest gap between the two presses. */
  doubleClickMs: number
  /** How many cells sideways the second press may land from the first: a hand moves a little between presses. */
  doubleClickCells: number
}

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
const DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l"
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
/** The start of a mouse report the chunk ends in; it is completed by the next chunk. */
const PARTIAL_REPORT = /\x1b\[<[\d;]*$/
/** An escape at the end of a chunk: the Esc key, or the first byte of a report whose rest is still on its way. */
const TRAILING_ESCAPE = /\x1b\[?$/

/** Emits `mouse` with a MouseEvent. */
export const mouse = new EventEmitter()

/** What counts as a double click now; `startMouse` sets it, `configureClicks` changes it while gittt runs. */
let clicks: ClickTiming = { doubleClickMs: 0, doubleClickCells: 0 }

/** @param timing what counts as a double click from now on */
export const configureClicks = (timing: ClickTiming) => void (clicks = timing)

/** A stdin replacement for ink: keystrokes only, with the TTY methods ink calls. */
type KeyboardStream = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => KeyboardStream }

/**
 * Turns one SGR report into an event.
 * @param code the report's button code
 * @param column 1-based column
 * @param row 1-based row
 * @param final `M` for a press or motion, `m` for a release
 * @returns the event without the double-click flag
 */
const toEvent = (code: number, column: number, row: number, final: string): Omit<MouseEvent, "double"> => {
  const buttonCode = code & 3
  const wheel = (code & 64) !== 0
  const shift = (code & 4) !== 0
  const wheelKinds = shift ? (["wheelLeft", "wheelRight", "wheelLeft", "wheelRight"] as const) : (["wheelUp", "wheelDown", "wheelLeft", "wheelRight"] as const)
  return {
    x: column - 1,
    y: row - 1,
    kind: wheel ? wheelKinds[buttonCode] : (code & 32) !== 0 ? "drag" : final === "m" ? "up" : "down",
    button: wheel ? "none" : (["left", "middle", "right", "none"] as const)[buttonCode],
    shift,
  }
}

/**
 * Starts mouse reporting and splits stdin.
 * @param timing what counts as a double click; `configureClicks` changes it later
 * @param inputSplitMs how long an escape at the end of a chunk waits for the rest of a report before it counts as the Esc key
 * @returns the keyboard-only stream to hand to ink, and a function that switches mouse reporting off, stops reading
 *   stdin and ends the keyboard stream
 */
export const startMouse = (timing: ClickTiming, inputSplitMs: number) => {
  const keyboard = new PassThrough() as KeyboardStream
  keyboard.isTTY = true
  keyboard.setRawMode = mode => {
    process.stdin.setRawMode?.(mode)
    return keyboard
  }
  clicks = timing
  let lastPress = { x: -1, y: -1, time: 0 }
  const decoder = new StringDecoder("utf8")
  let pending = ""
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const handle = (text: string) => {
    const rest = text.replace(REPORT, (_whole, code: string, column: string, row: string, final: string) => {
      const event = toEvent(Number(code), Number(column), Number(row), final)
      let double = false
      if (event.kind === "down" && event.button === "left") {
        const now = Date.now()
        double = now - lastPress.time < clicks.doubleClickMs && lastPress.y === event.y && Math.abs(lastPress.x - event.x) <= clicks.doubleClickCells
        lastPress = double ? { x: -1, y: -1, time: 0 } : { x: event.x, y: event.y, time: now }
      }
      mouse.emit("mouse", { ...event, double } satisfies MouseEvent)
      return ""
    })
    if (rest) keyboard.write(rest)
  }
  const flush = () => {
    flushTimer = null
    const text = pending
    pending = ""
    if (text) handle(text)
  }
  const listener = (chunk: Buffer) => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    const text = pending + decoder.write(chunk)
    const tail = PARTIAL_REPORT.exec(text) ?? TRAILING_ESCAPE.exec(text)
    pending = tail ? text.slice(tail.index) : ""
    handle(tail ? text.slice(0, tail.index) : text)
    if (pending && TRAILING_ESCAPE.test(pending)) flushTimer = setTimeout(flush, inputSplitMs)
  }
  process.stdin.setRawMode?.(true)
  process.stdin.on("data", listener)
  process.stdin.resume()
  process.stdout.write(ENABLE)
  return {
    keyboard,
    stop: () => {
      if (flushTimer) clearTimeout(flushTimer)
      process.stdin.off("data", listener)
      process.stdout.write(DISABLE)
      keyboard.end()
    },
  }
}
