/**
 * Asks the terminal for its background colour (OSC 11) before the screen is
 * drawn, so every tint gittt lays on it (selection, labels, diff lines) is
 * mixed with the real background rather than a guess.
 */

const QUERY = "\x1b]11;?\x07"
const REPLY = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i

let detected: string | undefined

/** @returns the background found by `queryBackground`, or `undefined` before it ran or when the terminal stayed silent */
export const terminalBackground = () => detected

/**
 * @param waitMs how long to wait for the answer
 * @returns the background as `#rrggbb`, or `null` when the terminal does not answer in time; remembered for `terminalBackground`
 */
export const queryBackground = (waitMs: number) => new Promise<string | null>(resolve => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve(null)
  let reply = ""
  const finish = (color: string | null) => {
    clearTimeout(timer)
    process.stdin.off("data", listen)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    detected = color ?? undefined
    resolve(color)
  }
  const listen = (chunk: Buffer) => {
    reply += chunk.toString("latin1")
    const match = REPLY.exec(reply)
    if (match) finish(`#${match.slice(1, 4).map(channel => channel.slice(0, 2)).join("")}`)
  }
  const timer = setTimeout(() => finish(null), waitMs)
  process.stdin.setRawMode(true)
  process.stdin.on("data", listen)
  process.stdin.resume()
  process.stdout.write(QUERY)
})
