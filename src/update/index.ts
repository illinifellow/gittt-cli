/**
 * Self-update: compares the running version with the latest GitHub release of
 * gittt-cli and installs a newer one in place. An npm-installed copy is
 * reinstalled from the release tag; a linked checkout pulls and rebuilds. The
 * running gittt restarts by itself when its bundle changes on disk (`cli.tsx`).
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository whose releases are checked and installed. */
export const UPDATE_REPOSITORY = "illinifellow/gittt-cli"

/** The package root of the running bundle: `dist/cli.js` lives one folder below it. */
const packageRoot = () => dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))

/** @returns the version in the running package's package.json, or "0.0.0" when it cannot be read */
export const currentVersion = (): string => {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string
  } catch {
    return "0.0.0"
  }
}

/**
 * Compares two dotted versions number by number.
 * @param left a version such as "0.1.2", an optional leading "v" is ignored
 * @param right the version to compare with
 * @returns a positive number when left is newer, negative when older, 0 when equal
 */
export const compareVersions = (left: string, right: string) => {
  const parts = (version: string) => version.replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/**
 * Asks GitHub for the latest release.
 * @param timeoutMs how long to wait before giving up
 * @returns the latest release's version without a leading "v", or null when offline, rate limited or on any error
 */
export const latestVersion = async (timeoutMs = 5000): Promise<string | null> => {
  try {
    const reply = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeoutMs) })
    if (!reply.ok) return null
    const tag = (await reply.json() as { tag_name?: string }).tag_name
    return tag ? tag.replace(/^v/, "") : null
  } catch {
    return null
  }
}

/**
 * Checks whether a newer release than the running one exists.
 * @returns the newer version, or null when the running one is current or the check failed
 */
export const availableUpdate = async (): Promise<string | null> => {
  const latest = await latestVersion()
  return latest && compareVersions(latest, currentVersion()) > 0 ? latest : null
}

const exec = (command: string, args: string[], cwd?: string) => new Promise<void>((resolve, reject) =>
  execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim().split("\n").slice(-2).join(" ") || error.message}`)) : resolve()))

/**
 * Installs the given release over the running copy. The bundle changes on disk,
 * which makes the running gittt restart itself with the same folder.
 * @param version the release to install, as returned by `availableUpdate`
 * @returns resolves when the new build is on disk; rejects with the failing command and its last error lines
 */
export const installUpdate = async (version: string) => {
  const root = packageRoot()
  if (existsSync(join(root, ".git"))) {
    await exec("git", ["pull", "--ff-only"], root)
    await exec("npm", ["install", "--no-audit", "--no-fund"], root)
    await exec("node", ["build.mjs"], root)
    return
  }
  await exec("npm", ["install", "--global", "--no-audit", "--no-fund", `github:${UPDATE_REPOSITORY}#${version}`])
}
