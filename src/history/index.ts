/**
 * The log's model: ref badges per commit, the working-tree row with operation
 * and conflict badges, the graph layout, and the wording of a stopped operation.
 */
import { WORKING_TREE, type Commit, type Repository } from "@/protocol"
import { layoutGraph } from "@/graph"

/**
 * Describes a stopped operation and conflicts in words, as the working-tree header shows them.
 * @param repository summary with the operation and conflict count
 * @param nameOf turns a commit hash into the most telling ref name pointing at it, or a short hash
 * @returns a sentence, or `""` when nothing is in progress
 */
export const describeOperation = (repository: Repository, nameOf: (hash: string) => string) => {
  const operation = repository.operation
  const conflicts = repository.conflicts ? `${repository.conflicts} conflicted file${repository.conflicts === 1 ? "" : "s"}` : ""
  if (!operation) return conflicts
  const target = operation.target ? nameOf(operation.target) : ""
  const progress = operation.step && operation.total ? ` (${operation.step}/${operation.total})` : ""
  const sentence = {
    rebase: `Rebasing ${operation.branch ?? "HEAD"} onto ${target}${progress}`,
    merge: `Merging ${target} into ${repository.head.branch ?? "HEAD"}`,
    "cherry-pick": `Cherry-picking ${target}`,
    revert: `Reverting ${target}`,
    bisect: "Bisecting",
  }[operation.kind]
  return [sentence, conflicts].filter(Boolean).join(" · ")
}

/** A ref shown as a badge in front of a commit's subject. */
export interface Badge {
  kind: "branch" | "remote" | "tag" | "head" | "operation" | "conflict"
  name: string
  current: boolean
}

/** A row of the log: a commit, or the working tree. */
export interface LogEntry extends Commit {
  badges: Badge[]
}

/**
 * Collects the badges of every commit a ref points at.
 * @param repository summary with branches, remotes and tags
 * @returns badges by commit hash; current branch first, then local, remote, tags
 */
export const collectBadges = (repository: Repository) => {
  const badges = new Map<string, Badge[]>()
  const add = (hash: string, badge: Badge) => badges.set(hash, [...(badges.get(hash) ?? []), badge])
  const synced = new Set<string>()
  for (const branch of [...repository.branches].sort((first, second) => Number(second.current) - Number(first.current))) {
    const upstreamHash = branch.upstream && repository.remotes.flatMap(remote => remote.branches).find(remote => `${remote.remote}/${remote.name}` === branch.upstream)?.hash
    const isSynced = upstreamHash === branch.hash
    if (isSynced && branch.upstream) synced.add(branch.upstream)
    add(branch.hash, { kind: "branch", name: branch.name, current: branch.current })
  }
  for (const remote of repository.remotes)
    for (const branch of remote.branches) {
      const name = `${remote.name}/${branch.name}`
      if (!synced.has(name)) add(branch.hash, { kind: "remote", name, current: false })
    }
  for (const tag of repository.tags) add(tag.hash, { kind: "tag", name: tag.name, current: false })
  if (!repository.head.branch && repository.head.hash) badges.set(repository.head.hash, [{ kind: "head", name: "HEAD", current: true }, ...(badges.get(repository.head.hash) ?? [])])
  return badges
}

/**
 * @param repository summary whose refs name commits
 * @returns a function giving the first ref name pointing at a hash, or its short form
 */
export const commitNamer = (repository: Repository) => {
  const badges = collectBadges(repository)
  return (hash: string) => badges.get(hash)?.find(badge => badge.kind !== "head")?.name ?? hash.slice(0, 7)
}

/**
 * Builds the log rows: the working-tree row first when there are uncommitted changes, then the commits.
 * @param repository summary for badges, HEAD and the change count
 * @param commits loaded commits, newest first
 * @returns entries and their graph layout, same order
 */
export const buildLog = (repository: Repository, commits: Commit[]) => {
  const badges = collectBadges(repository)
  const entries: LogEntry[] = commits.map(commit => ({ ...commit, badges: badges.get(commit.hash) ?? [] }))
  const headHash = repository.head.hash
  if ((repository.changes || repository.operation) && (!headHash || commits.some(commit => commit.hash === headHash))) {
    const state: Badge[] = []
    if (repository.operation) state.push({ kind: "operation", name: describeOperation({ ...repository, conflicts: 0 }, commitNamer(repository)), current: false })
    if (repository.conflicts) state.push({ kind: "conflict", name: `${repository.conflicts} conflict${repository.conflicts === 1 ? "" : "s"}`, current: false })
    entries.unshift({ hash: WORKING_TREE, parents: headHash ? [headHash] : [], author: "", email: "", time: Date.now() / 1000, subject: repository.changes ? "Uncommitted changes" : "No uncommitted changes", badges: state })
  }
  return { entries, rows: layoutGraph(entries) }
}

