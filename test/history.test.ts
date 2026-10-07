/**
 * The log's model: ref badges, the working-tree row and the sentence for a stopped operation.
 * Catches a remote branch drawn twice next to its synced local branch, a detached HEAD without
 * its badge, a working-tree row shown for a history that does not hold HEAD, and a stopped
 * rebase or merge described with the wrong names.
 */
import { describe, expect, it } from "vitest"
import { buildLog, collectBadges, commitNamer, describeOperation } from "@/history"
import { WORKING_TREE, type Commit, type Repository } from "@/protocol"

/** A repository summary with nothing in progress; each test overrides what it needs. */
const repository = (overrides: Partial<Repository> = {}): Repository => ({
  path: "/r", name: "r", head: { branch: "main", hash: "c2" }, changes: 0, staged: 0, conflicts: 0, operation: null,
  branches: [{ name: "main", hash: "c2", upstream: "origin/main", ahead: 0, behind: 0, gone: false, current: true }],
  remotes: [{ name: "origin", branches: [{ remote: "origin", name: "main", hash: "c2" }, { remote: "origin", name: "old", hash: "c1" }] }],
  tags: [{ name: "1.0.0", hash: "c1" }], stashes: [], error: null, ...overrides,
})

const COMMITS: Commit[] = [
  { hash: "c2", parents: ["c1"], author: "Ada", email: "a@x", time: 2, subject: "second" },
  { hash: "c1", parents: [], author: "Ada", email: "a@x", time: 1, subject: "first" },
]

describe("badges", () => {
  it("hides a remote branch that sits on its synced local branch and keeps the others", () => {
    const badges = collectBadges(repository())
    expect(badges.get("c2")?.map(badge => badge.name)).toEqual(["main"])
    expect(badges.get("c1")?.map(badge => `${badge.kind}:${badge.name}`)).toEqual(["remote:origin/old", "tag:1.0.0"])
  })

  it("puts a detached HEAD first and names commits by their first ref or short hash", () => {
    const detached = repository({ head: { branch: null, hash: "c1" }, branches: [] })
    expect(collectBadges(detached).get("c1")?.[0]).toEqual({ kind: "head", name: "HEAD", current: true })
    const name = commitNamer(detached)
    expect(name("c1")).toBe("origin/old")
    expect(name("abcdef123456")).toBe("abcdef1")
  })
})

describe("describeOperation", () => {
  const nameOf = (hash: string) => `<${hash}>`

  it("names the branch, the target and the step of a stopped rebase, with the conflicts", () => {
    const stopped = repository({ conflicts: 2, operation: { kind: "rebase", target: "c1", branch: "feature", step: 3, total: 5 } })
    expect(describeOperation(stopped, nameOf)).toBe("Rebasing feature onto <c1> (3/5) · 2 conflicted files")
  })

  it("describes merges, cherry-picks, reverts and bisects, and conflicts alone", () => {
    const operation = (kind: "merge" | "cherry-pick" | "revert" | "bisect") => describeOperation(repository({ operation: { kind, target: "c1", branch: null, step: null, total: null } }), nameOf)
    expect([operation("merge"), operation("cherry-pick"), operation("revert"), operation("bisect")]).toEqual(["Merging <c1> into main", "Cherry-picking <c1>", "Reverting <c1>", "Bisecting"])
    expect(describeOperation(repository({ conflicts: 1 }), nameOf)).toBe("1 conflicted file")
    expect(describeOperation(repository(), nameOf)).toBe("")
  })
})

describe("buildLog", () => {
  it("adds the working-tree row with operation and conflict badges when HEAD is in the history", () => {
    const { entries, rows } = buildLog(repository({ changes: 3, conflicts: 1, operation: { kind: "merge", target: "c1", branch: null, step: null, total: null } }), COMMITS)
    expect(entries[0].hash).toBe(WORKING_TREE)
    expect(entries[0].subject).toBe("Uncommitted changes")
    expect(entries[0].badges.map(badge => badge.kind)).toEqual(["operation", "conflict"])
    expect(rows).toHaveLength(3)
  })

  it("adds no working-tree row for a clean tree or a history without HEAD", () => {
    expect(buildLog(repository(), COMMITS).entries[0].hash).toBe("c2")
    expect(buildLog(repository({ changes: 1, head: { branch: "main", hash: "elsewhere" } }), COMMITS).entries[0].hash).toBe("c2")
  })
})
