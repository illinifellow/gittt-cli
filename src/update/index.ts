/**
 * Self-update: compares the running version with the latest GitHub release of
 * gittt-cli and installs a newer one in place. An npm-installed copy is
 * reinstalled from the tarball attached to the release; a linked checkout on its default branch pulls and
 * rebuilds (a checkout on any other branch is left to its owner). The running gittt restarts once the
 * install finished (`cli.tsx`).
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository whose releases are checked and installed. */
export const UPDATE_REPOSITORY = "illinifellow/gittt-cli"

/**
 * The built package attached to a release: `npm pack` output renamed to `gittt-cli.tgz`, so installing needs no build tools.
 * @param version a release tag, or "latest"
 * @returns the download URL
 */
export const releaseTarball = (version: string) => version === "latest"
  ? `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/gittt-cli.tgz`
  : `https://github.com/${UPDATE_REPOSITORY}/releases/download/${version}/gittt-cli.tgz`

/** The package root of the running bundle: `dist/app.js` lives one folder below it. */
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

const exec = (command: string, args: string[], cwd?: string) => new Promise<string>((resolve, reject) =>
  execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim().split("\n").slice(-2).join(" ") || error.message}`)) : resolve(stdout.trim())))

/** @returns whether the running package is a git checkout (installed with `npm link`) rather than an npm install */
export const isCheckout = () => existsSync(join(packageRoot(), ".git"))

/**
 * @param root the checkout
 * @returns whether it is on its remote's default branch, the one releases are cut from; a checkout on another branch
 *   never changes version by pulling, so it is offered no update
 */
const onReleaseBranch = async (root: string) => {
  const [current, remoteDefault] = await Promise.all([exec("git", ["branch", "--show-current"], root), exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)]).catch(() => ["", ""])
  return current !== "" && remoteDefault === `origin/${current}`
}

/**
 * Checks whether a newer release than the running one exists and can be installed here.
 * @returns the newer version, or null when the running one is current, the check failed, or a checkout is off its
 *   default branch
 */
export const availableUpdate = async (): Promise<string | null> => {
  const latest = await latestVersion()
  if (!latest || compareVersions(latest, currentVersion()) <= 0) return null
  return !isCheckout() || await onReleaseBranch(packageRoot()) ? latest : null
}

/**
 * Installs the given release over the running copy, into the npm prefix it lives in; the caller restarts gittt once
 * it resolved.
 * @param version the release to install, as returned by `availableUpdate`
 * @returns resolves when the new build is on disk; rejects with the failing command and its last error lines
 */
export const installUpdate = async (version: string) => {
  const root = packageRoot()
  if (isCheckout()) {
    await exec("git", ["pull", "--ff-only"], root)
    await exec("npm", ["install", "--no-audit", "--no-fund"], root)
    await exec("node", ["build.mjs"], root)
    return
  }
  const prefix = root.split(sep).at(-3) === "lib" ? dirname(dirname(dirname(root))) : null
  await exec("npm", ["install", "--global", ...(prefix ? ["--prefix", prefix] : []), "--no-audit", "--no-fund", releaseTarball(version)])
}
