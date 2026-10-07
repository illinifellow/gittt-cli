/**
 * Self-update: decides whether the Update button appears and where a release is installed from.
 * Catches a release compared as text ("0.10.0" older than "0.9.0"), a "v" prefix breaking the
 * comparison, an offline or rate-limited check that throws at the screen, and an Update offered
 * for a version that is not newer.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { availableUpdate, compareVersions, currentVersion, latestVersion, releaseTarball } from "@/update"

afterEach(() => vi.unstubAllGlobals())

/** Makes GitHub answer the latest-release request with the given status and tag. */
const githubAnswers = (status: number, tag?: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(tag ? { tag_name: tag } : {}), { status })))

describe("compareVersions", () => {
  /** Numbers compare as numbers, so 0.10.0 is newer than 0.9.0. */
  it("orders by number, not by text", () => expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0))
  /** Tags may carry a "v"; equal versions show no Update. */
  it("ignores a leading v and treats equal versions as equal", () => expect(compareVersions("v0.1.0", "0.1.0")).toBe(0))
  /** A missing part counts as zero. */
  it("treats a missing part as zero", () => expect(compareVersions("0.1", "0.1.1")).toBeLessThan(0))
})

describe("latestVersion", () => {
  it("reads the tag of the latest release without its v", async () => {
    githubAnswers(200, "v1.2.3")
    await expect(latestVersion()).resolves.toBe("1.2.3")
  })

  it("stays silent when GitHub refuses, answers without a tag or cannot be reached", async () => {
    githubAnswers(403, "1.0.0")
    await expect(latestVersion()).resolves.toBeNull()
    githubAnswers(200)
    await expect(latestVersion()).resolves.toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
    await expect(latestVersion()).resolves.toBeNull()
  })
})

describe("availableUpdate", () => {
  it("offers nothing when the latest release is not newer than the running version", async () => {
    githubAnswers(200, currentVersion())
    await expect(availableUpdate()).resolves.toBeNull()
    githubAnswers(200, "v0.0.0")
    await expect(availableUpdate()).resolves.toBeNull()
  })

  it("offers a newer release to an installed copy", async () => {
    githubAnswers(200, "999.0.0")
    await expect(availableUpdate()).resolves.toBe("999.0.0")
  })
})

describe("releaseTarball", () => {
  it("points at the tarball attached to the release, or to the latest one", () => {
    expect(releaseTarball("0.4.1")).toBe("https://github.com/illinifellow/gittt-cli/releases/download/0.4.1/gittt-cli.tgz")
    expect(releaseTarball("latest")).toBe("https://github.com/illinifellow/gittt-cli/releases/latest/download/gittt-cli.tgz")
  })
})
