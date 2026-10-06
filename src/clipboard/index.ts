/**
 * Copying to the system clipboard: through the platform's clipboard program
 * (pbcopy, clip, wl-copy, xclip), or through the terminal itself with OSC 52
 * when no program can reach the clipboard (an ssh session, a machine without
 * one). A missing program or a refusal is reported, never thrown at the screen.
 */
import { spawn } from "node:child_process"

/** A clipboard program and its arguments. */
type Program = [command: string, ...args: string[]]

/** @returns the clipboard program for this machine, or `null` when only the terminal can reach a clipboard */
const clipboardProgram = (): Program | null => {
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return null
  if (process.platform === "darwin") return ["pbcopy"]
  if (process.platform === "win32") return ["clip"]
  if (process.env.WAYLAND_DISPLAY) return ["wl-copy"]
  if (process.env.DISPLAY) return ["xclip", "-selection", "clipboard"]
  return null
}

/** Hands text to the terminal's clipboard (OSC 52); terminals that do not support it ignore the sequence. */
const copyThroughTerminal = (text: string) => void process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`)

/**
 * Runs a clipboard program with the text on its standard input.
 * @returns once it exited with 0; rejects with what went wrong, with `code` set to `ENOENT` when it is not installed
 */
const runProgram = ([command, ...args]: Program, text: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] })
  let errors = ""
  child.stderr.on("data", (chunk: Buffer) => void (errors += chunk.toString("utf8")))
  child.on("error", (error: NodeJS.ErrnoException) => reject(Object.assign(new Error(`${command} cannot run: ${error.message}`), { code: error.code })))
  child.stdin.on("error", error => reject(new Error(`${command} did not take the text: ${error.message}`)))
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} failed: ${errors.trim() || `exit code ${code}`}`)))
  child.stdin.end(text)
})

/**
 * Copies text to the clipboard.
 * @param text what to copy
 * @returns how it was copied: `program` through the clipboard program, `terminal` through OSC 52 (when there is no
 *   program to use); rejects with the program's error when it is there but fails
 */
export const copyToClipboard = async (text: string): Promise<"program" | "terminal"> => {
  const program = clipboardProgram()
  if (!program) {
    copyThroughTerminal(text)
    return "terminal"
  }
  try {
    await runProgram(program, text)
    return "program"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      copyThroughTerminal(text)
      return "terminal"
    }
    throw error
  }
}
