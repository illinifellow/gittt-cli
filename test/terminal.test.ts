/**
 * The terminal background query. Catches a reply the parser misreads, a silent terminal that
 * blocks the start, and a query sent when there is no terminal to answer it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { queryBackground, terminalBackground } from "@/terminal"

const { stdin, stdout } = process
const saved = { stdinTTY: stdin.isTTY, stdoutTTY: stdout.isTTY, setRawMode: stdin.setRawMode }

/** Pretends both streams are a terminal; the query is written to the returned list instead of the real one. */
const pretendTerminal = () => {
  const written: string[] = []
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(() => stdin) })
  Object.assign(stdout, { isTTY: true })
  vi.spyOn(stdout, "write").mockImplementation(chunk => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(stdin, "resume").mockImplementation(() => stdin)
  vi.spyOn(stdin, "pause").mockImplementation(() => stdin)
  return written
}

afterEach(() => {
  Object.assign(stdin, { isTTY: saved.stdinTTY, setRawMode: saved.setRawMode })
  Object.assign(stdout, { isTTY: saved.stdoutTTY })
  vi.restoreAllMocks()
})

describe("queryBackground", () => {
  it("asks nothing and answers null without a terminal", async () => {
    Object.assign(stdin, { isTTY: false })
    await expect(queryBackground(50)).resolves.toBeNull()
  })

  it("reads the OSC 11 reply, in pieces, as #rrggbb and remembers it", async () => {
    const written = pretendTerminal()
    const answer = queryBackground(1000)
    expect(written).toEqual(["\x1b]11;?\x07"])
    stdin.emit("data", Buffer.from("\x1b]11;rgb:1515/"))
    stdin.emit("data", Buffer.from("1616/f8f8\x07"))
    await expect(answer).resolves.toBe("#1516f8")
    expect(terminalBackground()).toBe("#1516f8")
    expect(stdin.listenerCount("data")).toBe(0)
  })

  it("gives up after the wait when the terminal stays silent", async () => {
    pretendTerminal()
    await expect(queryBackground(30)).resolves.toBeNull()
    expect(terminalBackground()).toBeUndefined()
  })
})
