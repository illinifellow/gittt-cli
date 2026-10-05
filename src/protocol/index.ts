/**
 * Shapes the git layer returns and the screen draws: repository summaries,
 * log entries, commit details and view settings.
 */

/** A local branch with its upstream state. */
export interface Branch {
  name: string
  hash: string
  upstream: string | null
  ahead: number
  behind: number
  /** The upstream branch was deleted on the remote. */
  gone: boolean
  current: boolean
}

/** A remote-tracking branch, `name` without the remote prefix. */
interface RemoteBranch {
  remote: string
  name: string
  hash: string
}

/** A tag; `hash` is the commit it points to after peeling annotated tags. */
export interface Tag {
  name: string
  hash: string
}

/** One `git stash list` entry. */
export interface Stash {
  /** `stash@{N}` */
  reference: string
  hash: string
  message: string
}

/** Everything the repository tree shows for one repository. */
export interface Repository {
  path: string
  name: string
  head: { branch: string | null; hash: string | null }
  /** Count of changed and untracked entries in the working tree. */
  changes: number
  /** Count of entries with changes in the index, ready to commit. */
  staged: number
  /** Count of unmerged (conflicted) paths. */
  conflicts: number
  /** A rebase, merge, cherry-pick, revert or bisect stopped half way, or `null`. */
  operation: Operation | null
  branches: Branch[]
  remotes: { name: string; branches: RemoteBranch[] }[]
  tags: Tag[]
  stashes: Stash[]
  /** Set when git refused to describe the repository. */
  error: string | null
}

/** An operation in progress, read from the files git keeps in its directory while it runs. */
export interface Operation {
  kind: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect"
  /** Commit being merged, picked or reverted, or the commit a rebase replays onto. */
  target: string | null
  /** Branch a rebase rewrites. */
  branch: string | null
  /** Rebase progress, 1-based. */
  step: number | null
  total: number | null
}

/** A commit as the log needs it. */
export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  time: number
  subject: string
}

/** One changed file of a commit or of the working tree. */
export interface ChangedFile {
  /** Single-letter git status: A, M, D, R, C, T, U (conflicted), or `?` for untracked. */
  status: string
  path: string
  previousPath: string | null
  /** Working tree only: the index holds changes of this file. */
  staged: boolean
  /** Working tree only: the file has changes the index does not hold (untracked files included). */
  unstaged: boolean
}

/** A commit's metadata and changed files; for the working tree the author fields are empty. */
export interface CommitDetails {
  hash: string
  parents: string[]
  author: string
  email: string
  authorTime: number
  committer: string
  message: string
  files: ChangedFile[]
}

/** View settings the filter bar toggles. */
export interface ViewSettings {
  branches: "all" | "current"
  showRemoteBranches: boolean
  order: "ancestor" | "date"
  compact: boolean
  dateFormat: "relative" | "absolute"
  gitmoji: boolean
}

/** Pseudo hash of the working-tree row in the log. */
export const WORKING_TREE = "*"
