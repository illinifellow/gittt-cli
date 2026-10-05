/**
 * Self-update version logic: decides whether the Update button appears.
 * Catches a release compared as text ("0.10.0" older than "0.9.0") or a "v" prefix breaking the comparison.
 */
import { describe, expect, it } from "vitest"
import { compareVersions } from "@/update"

describe("compareVersions", () => {
  /** Numbers compare as numbers, so 0.10.0 is newer than 0.9.0. */
  it("orders by number, not by text", () => expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0))
  /** Tags may carry a "v"; equal versions show no Update. */
  it("ignores a leading v and treats equal versions as equal", () => expect(compareVersions("v0.1.0", "0.1.0")).toBe(0))
  /** A missing part counts as zero. */
  it("treats a missing part as zero", () => expect(compareVersions("0.1", "0.1.1")).toBeLessThan(0))
})
