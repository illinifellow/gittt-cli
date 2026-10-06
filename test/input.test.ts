/**
 * Terminal input and text layout: mouse reports split across reads, multi-byte
 * characters split across reads, the Esc key, double clicks, and code laid out
 * on terminal cells. Catches half a mouse report reaching the keyboard as Esc
 * plus digits (closing dialogs, flipping filters), pasted Cyrillic turning into
 * replacement marks, an Esc key that never arrives, a listener left on stdin
 * after stopping, and tabs, wide characters or emoji breaking widths, selection
 * and copying.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mouse, startMouse, type MouseEvent } from "@/mouse"
import { lineCells, selectedText } from "@/ui/details"
import { fit, graphemes, placeText, slide, splitCells, widthOf } from "@/ui/text"

describe("mouse input", () => {
  let session: ReturnType<typeof startMouse>
  let typed: string
  let events: MouseEvent[]
  const listener = (event: MouseEvent) => events.push(event)
  const send = (text: string | Buffer) => process.stdin.emit("data", typeof text === "string" ? Buffer.from(text) : text)

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    typed = ""
    events = []
    session = startMouse({ doubleClickMs: 400, doubleClickCells: 2 }, 20)
    session.keyboard.on("data", (chunk: Buffer) => void (typed += chunk.toString("utf8")))
    mouse.on("mouse", listener)
  })

  afterEach(() => {
    session.stop()
    process.stdin.pause()
    mouse.off("mouse", listener)
    vi.restoreAllMocks()
  })

  /** A report cut in two by the terminal is joined with its rest instead of reaching the keyboard. */
  it("joins a mouse report split across reads", async () => {
    send("\x1b[<0;12;")
    send("5M")
    send("\x1b")
    send("[<0;12;5m")
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(events.map(event => [event.kind, event.x, event.y])).toEqual([["down", 11, 4], ["up", 11, 4]])
    expect(typed).toBe("")
  })

  /** A character whose bytes arrive in two reads stays one character. */
  it("joins a character split across reads", async () => {
    const bytes = Buffer.from("жёлтый")
    send(bytes.subarray(0, 3))
    send(bytes.subarray(3))
    await new Promise(resolve => setImmediate(resolve))
    expect(typed).toBe("жёлтый")
  })

  /** A lone Esc is the Esc key: it reaches the keyboard once the split window passed. */
  it("passes a lone Esc on after a short wait", async () => {
    send("\x1b")
    expect(typed).toBe("")
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(typed).toBe("\x1b")
  })

  /** Two presses on one row within the time and a couple of cells make a double click. */
  it("detects a double click", () => {
    send("\x1b[<0;10;3M\x1b[<0;10;3m\x1b[<0;11;3M")
    expect(events.filter(event => event.kind === "down").map(event => event.double)).toEqual([false, true])
  })

  /** Stopping leaves stdin to others: no listener stays behind. */
  it("detaches from stdin when stopped", () => {
    const before = process.stdin.listenerCount("data")
    session.stop()
    expect(process.stdin.listenerCount("data")).toBe(before - 1)
    session = startMouse({ doubleClickMs: 400, doubleClickCells: 2 }, 20)
  })
})

describe("text on cells", () => {
  /** An emoji made of several code points is one piece two cells wide; CJK characters are two cells. */
  it("measures and cuts by grapheme", () => {
    const family = "👨‍👩‍👧"
    expect(graphemes(`a${family}b`)).toEqual(["a", family, "b"])
    expect(widthOf(fit(`${family}${family}${family}`, 5))).toBe(5)
    expect(fit("漢字テキスト", 7)).toBe("漢字テ…")
    expect(slide("漢字abc", 2)).toBe("字abc")
    expect(splitCells("src/漢字.ts", 6)).toEqual(["src/漢", "字.ts"])
  })

  /** A tab reaches the next tab stop and counts as the cells it covers. */
  it("expands tabs to the next stop", () => {
    expect(placeText("a\tb", 4).map(piece => [piece.drawn, piece.start, piece.width])).toEqual([["a", 0, 1], ["    ".slice(1), 1, 3], ["b", 4, 1]])
    expect(placeText("\t", 4, 6)[0].width).toBe(2)
  })

  /** A selection in cells copies what was drawn, with tabs intact; a wide character the selection touches is copied whole. */
  it("copies a selection made in cells", () => {
    const line = (text: string) => ({ gutter: true, segments: [{ text: "    1     1 " }, { text: " " }, { text }] })
    const lines = [line("\tif (漢字) {"), line("\t\treturn")]
    expect(lineCells(lines[0], 4)).toBe(4 + 4 + 4 + 3)
    expect(selectedText(lines, { anchor: { line: 0, column: 4 }, focus: { line: 0, column: 12 } }, 4)).toBe("if (漢字)")
    expect(selectedText(lines, { anchor: { line: 0, column: 9 }, focus: { line: 1, column: 9 } }, 4)).toBe("漢字) {\n\t\tre")
  })
})
