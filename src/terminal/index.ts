/**
 * Asks the terminal for its background colour (OSC 11) before the screen is
 * drawn, so every tint gittt lays on it (selection, labels, diff lines) is
 * mixed with the real background rather than a guess.
 */

const QUERY = "\x1b]11;?\x07"
const REPLY = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i
const WAIT_MS = 200

let detected: string | undefined

/** @returns the background found by `queryBackground`, or `undefined` before it ran or when the terminal stayed silent */
export const terminalBackground = () => detected

/** @returns the background as `#rrggbb`, or `null` when the terminal does not answer within 200 ms; remembered for `terminalBackground` */
export const queryBackground = () => new Promise<string | null>(resolve => {
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
  const timer = setTimeout(() => finish(null), WAIT_MS)
  process.stdin.setRawMode(true)
  process.stdin.on("data", listen)
  process.stdin.resume()
  process.stdout.write(QUERY)
})
