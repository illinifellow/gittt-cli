/**
 * The executable end to end, in a pseudo-terminal: gittt starts on the folder prompt in the
 * alternate screen and gives the terminal back on Esc. Catches a start that crashes before the
 * first frame and a quit that leaves the terminal in the alternate screen or with gittt's title.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as esbuild from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const ALTERNATE_SCREEN = { enter: "\x1b[?1049h", leave: "\x1b[?1049l" }
const RESTORE_TITLE = "\x1b[23;0t"

/** The bundle sits under node_modules so its external packages resolve as in `dist/`. */
const BUNDLE = join(process.cwd(), "node_modules", ".cache", "gittt-cli-test", "app.mjs")

let config: string
beforeAll(async () => {
  config = mkdtempSync(join(tmpdir(), "gittt-cli-"))
  await esbuild.build({ entryPoints: ["src/cli.tsx"], outfile: BUNDLE, bundle: true, platform: "node", format: "esm", target: "node22", jsx: "automatic", packages: "external", tsconfig: "tsconfig.json", logLevel: "silent" })
})
afterAll(() => rmSync(config, { recursive: true, force: true }))

/**
 * Runs a command in a pseudo-terminal of 100 x 30 cells, presses the keys once the folder prompt
 * is drawn, and prints everything written; exits with the command's own code. Python's `pty`
 * module is on every CI image, and `script` cannot take its input from a socket.
 */
const PTY_DRIVER = `
import os, pty, sys, select, struct, fcntl, termios, time
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execvp(sys.argv[1], sys.argv[1:])
output, pressed, deadline = b"", False, time.time() + 15
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if not pressed and b"Where should gittt look for repositories?" in output:
        pressed = True
        time.sleep(0.3)
        os.write(fd, os.environ["GITTT_TEST_KEYS"].encode())
sys.stdout.buffer.write(output)
for _ in range(50):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        sys.exit(os.waitstatus_to_exitcode(status))
    time.sleep(0.1)
os.kill(pid, 9)
sys.exit(124)
`

/**
 * Runs gittt in a pseudo-terminal, presses keys once the prompt is drawn, and collects what it wrote.
 * @param keys what to press after the first frame
 * @returns the output and the exit code
 */
const runInTerminal = (keys: string) => new Promise<{ output: string; code: number | null }>(resolve => {
  const child = spawn("python3", ["-c", PTY_DRIVER, process.execPath, BUNDLE, config], { env: { ...process.env, XDG_CONFIG_HOME: config, NODE_ENV: "production", TERM: "xterm-256color", GITTT_TEST_KEYS: keys } })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")))
  child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")))
  child.on("close", code => resolve({ output, code }))
})

describe("gittt in a terminal", () => {
  it("opens on the folder prompt and gives the terminal back on Esc", async () => {
    const { output, code } = await runInTerminal("\x1b")
    expect(code, `gittt wrote:\n${JSON.stringify(output)}`).toBe(0)
    expect(output).toContain(ALTERNATE_SCREEN.enter)
    expect(output).toContain(config)
    expect(output.lastIndexOf(ALTERNATE_SCREEN.leave)).toBeGreaterThan(output.lastIndexOf(ALTERNATE_SCREEN.enter))
    expect(output).toContain(RESTORE_TITLE)
  })
})
