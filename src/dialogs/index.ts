/**
 * Action dialogs as data: for every action, the fields its dialog shows
 * (built from the repository's state and what was clicked) and the git commands
 * the submitted values turn into.
 */
import type { Repository } from "@/protocol"

/** One option of a select or radio field. */
interface Choice {
  value: string
  label: string
}

/** A row of a checklist field. */
interface ChecklistItem {
  value: string
  label: string
  detail?: string
  checked: boolean
}

/** One control in a dialog. */
export type Field =
  | { type: "info"; label: string; text: string }
  | { type: "text"; key: string; label: string; value: string; placeholder?: string; required?: boolean }
  | { type: "select"; key: string; label: string; value: string; choices: Choice[] }
  | { type: "radio"; key: string; label: string; value: string; choices: Choice[] }
  | { type: "checkbox"; key: string; label: string; value: boolean; warning?: string }
  | { type: "checklist"; key: string; label: string; items: ChecklistItem[] }
  | { type: "warning"; text: string }

/** A dialog ready to draw. */
export interface DialogSpec {
  kind: DialogKind
  title: string
  fields: Field[]
  submit: string
  /** Submitting changes or loses work; the submit button is drawn as dangerous. */
  danger?: boolean
}

/** Every dialog gittt offers. */
export type DialogKind =
  | "commit" | "fetch" | "pull" | "push" | "branch" | "deleteBranches" | "merge" | "stash" | "tag"
  | "checkout" | "checkoutRemote" | "deleteBranch" | "deleteTag" | "renameBranch" | "reset"
  | "rebase" | "cherryPick" | "revert" | "stashApply" | "stashPop" | "stashDrop" | "pushTag"

/** What the dialog was opened on. */
export interface DialogTarget {
  hash?: string
  /** Branch, `remote/branch` or tag name. */
  ref?: string
  /** `branch`, `remote`, `tag`, `commit` or `stash`. */
  section?: string
  stash?: string
  /** Subject of the target commit, for wording. */
  subject?: string
}

/** Values the user submitted, keyed by field key. */
export type DialogValues = Record<string, string | boolean | string[]>

const short = (hash: string | undefined) => hash ? hash.slice(0, 7) : "HEAD"
const currentBranch = (repository: Repository) => repository.branches.find(branch => branch.current) ?? null
const remoteChoices = (repository: Repository): Choice[] => repository.remotes.map(remote => ({ value: remote.name, label: remote.name }))
const preferredRemote = (repository: Repository) => repository.remotes.find(remote => remote.name === "origin")?.name ?? repository.remotes[0]?.name ?? ""
const headLabel = (repository: Repository) => repository.head.branch ?? `${short(repository.head.hash ?? undefined)} (detached HEAD)`
const allRefs = (repository: Repository): Choice[] => [
  ...repository.branches.map(branch => ({ value: branch.name, label: branch.name })),
  ...repository.remotes.flatMap(remote => remote.branches.map(branch => ({ value: `${remote.name}/${branch.name}`, label: `${remote.name}/${branch.name}` }))),
  ...repository.tags.map(tag => ({ value: tag.name, label: `tag: ${tag.name}` })),
]

/**
 * Builds the dialog for an action.
 * @param kind the action
 * @param repository the repository it acts on
 * @param target what was clicked; toolbar actions pass `{}`
 * @returns the dialog to draw
 */
export const buildDialog = (kind: DialogKind, repository: Repository, target: DialogTarget): DialogSpec => {
  const current = currentBranch(repository)
  const remote = preferredRemote(repository)
  const targetName = target.ref ?? short(target.hash)
  switch (kind) {
    case "commit": {
      const upstream = current?.upstream ?? (remote && current ? `${remote}/${current.name}` : "")
      return { kind, title: "Commit", submit: "Commit", fields: [
        { type: "info", label: "Branch", text: headLabel(repository) },
        { type: "info", label: "Staged", text: `${repository.staged} file${repository.staged === 1 ? "" : "s"}` },
        { type: "text", key: "message", label: "Message", value: "", placeholder: "what this commit changes" },
        { type: "checkbox", key: "amend", label: "Amend last commit", value: false, warning: "Replaces the last commit; pushing it rewrites the remote branch" },
        { type: "checkbox", key: "push", label: upstream ? `Push immediately to ${upstream}` : "Push immediately", value: false },
      ] }
    }
    case "fetch":
      return { kind, title: "Fetch", submit: "OK", fields: [
        { type: "checkbox", key: "all", label: "Fetch from all remotes", value: true },
        { type: "checkbox", key: "prune", label: "Prune tracking branches no longer present on remote(s)", value: true },
        { type: "checkbox", key: "tags", label: "Fetch and store all tags locally", value: true },
      ] }
    case "pull": {
      const upstream = current?.upstream ?? ""
      const upstreamRemote = upstream.split("/")[0] || remote
      const remoteBranches = repository.remotes.find(candidate => candidate.name === upstreamRemote)?.branches ?? []
      return { kind, title: "Pull", submit: "OK", fields: [
        { type: "select", key: "remote", label: "Pull from repository", value: upstreamRemote, choices: remoteChoices(repository) },
        { type: "select", key: "branch", label: "Remote branch to pull", value: upstream ? upstream.slice(upstreamRemote.length + 1) : current?.name ?? "", choices: remoteBranches.map(branch => ({ value: branch.name, label: branch.name })) },
        { type: "info", label: "Pull into local branch", text: headLabel(repository) },
        { type: "checkbox", key: "commit", label: "Commit merged changes immediately", value: true },
        { type: "checkbox", key: "log", label: "Include messages from commits being merged in merge commit", value: false },
        { type: "checkbox", key: "noFastForward", label: "Create new commit even if fast-forward merge", value: false },
        { type: "checkbox", key: "rebase", label: "Rebase instead of merge", value: false, warning: "Rebasing rewrites local commits that are not pushed yet" },
      ] }
    }
    case "push":
      return { kind, title: "Push", submit: "OK", fields: [
        { type: "select", key: "remote", label: "Push to repository", value: remote, choices: remoteChoices(repository) },
        { type: "checklist", key: "branches", label: "Branches to push", items: repository.branches.map(branch => ({
          value: branch.name,
          label: branch.name,
          detail: branch.upstream ? `→ ${branch.upstream}${branch.ahead ? `, ${branch.ahead} ahead` : ""}${branch.behind ? `, ${branch.behind} behind` : ""}` : "→ new remote branch",
          checked: branch.current,
        })) },
        { type: "checkbox", key: "track", label: "Track pushed branches that have no upstream", value: true },
        { type: "checkbox", key: "tags", label: "Push all tags", value: false },
        { type: "checkbox", key: "force", label: "Force push", value: false, warning: "Overwrites commits on the remote; --force-with-lease protects work pushed by others since your last fetch" },
      ] }
    case "branch":
      return { kind, title: "New Branch", submit: "Create Branch", fields: [
        { type: "info", label: "Current branch", text: headLabel(repository) },
        { type: "text", key: "name", label: "New branch", value: "", placeholder: "feature/name", required: true },
        { type: "radio", key: "start", label: "Commit", value: target.hash || target.ref ? "specified" : "head", choices: [{ value: "head", label: "Working copy parent" }, { value: "specified", label: "Specified commit" }] },
        { type: "text", key: "commit", label: "Specified commit", value: target.ref ?? target.hash ?? "", placeholder: "hash or ref" },
        { type: "checkbox", key: "checkout", label: "Checkout new branch", value: true },
      ] }
    case "deleteBranches":
      return { kind, title: "Delete Branches", submit: "Delete Branches", danger: true, fields: [
        { type: "checklist", key: "branches", label: "Branches", items: [
          ...repository.branches.filter(branch => !branch.current).map(branch => ({ value: branch.name, label: branch.name, detail: "local", checked: false })),
          ...repository.remotes.flatMap(group => group.branches.map(branch => ({ value: `${group.name}/${branch.name}`, label: `${group.name}/${branch.name}`, detail: "remote", checked: false }))),
        ] },
        { type: "checkbox", key: "force", label: "Force delete regardless of merge status", value: false, warning: "Commits only these branches hold become unreachable" },
      ] }
    case "merge":
      return { kind, title: "Merge", submit: "OK", fields: [
        { type: "info", label: "Merge into", text: headLabel(repository) },
        { type: "select", key: "ref", label: "Merge from", value: target.ref ?? target.hash ?? allRefs(repository).find(choice => choice.value !== current?.name)?.value ?? "", choices: target.hash && !target.ref ? [{ value: target.hash, label: `${short(target.hash)} ${target.subject ?? ""}` }, ...allRefs(repository)] : allRefs(repository) },
        { type: "checkbox", key: "commit", label: "Commit merged changes immediately", value: true },
        { type: "checkbox", key: "log", label: "Include messages from commits being merged in merge commit", value: false },
        { type: "checkbox", key: "noFastForward", label: "Create a new commit even if fast-forward is possible", value: false },
        { type: "checkbox", key: "rebase", label: "Rebase instead of merge", value: false, warning: "Rebasing rewrites the current branch's commits that are not on the target" },
      ] }
    case "stash":
      return { kind, title: "Stash Changes", submit: "Stash", fields: [
        { type: "info", label: "Changes", text: `${repository.changes} uncommitted file${repository.changes === 1 ? "" : "s"}` },
        { type: "text", key: "message", label: "Message", value: "", placeholder: "optional" },
        { type: "checkbox", key: "keepIndex", label: "Keep staged changes", value: false },
        { type: "checkbox", key: "untracked", label: "Include untracked files", value: false },
      ] }
    case "tag":
      return { kind, title: "Add Tag", submit: "Add", fields: [
        { type: "text", key: "name", label: "Tag Name", value: "", placeholder: "v1.0.0", required: true },
        { type: "radio", key: "start", label: "Commit", value: target.hash ? "specified" : "head", choices: [{ value: "head", label: "Working copy parent" }, { value: "specified", label: "Specified commit" }] },
        { type: "text", key: "commit", label: "Specified commit", value: target.hash ?? "", placeholder: "hash or ref" },
        { type: "checkbox", key: "push", label: `Push tag${remote ? ` to ${remote}` : ""}`, value: false },
        { type: "checkbox", key: "lightweight", label: "Lightweight tag (not recommended)", value: false },
        { type: "text", key: "message", label: "Message", value: "", placeholder: "annotation" },
        { type: "checkbox", key: "force", label: "Move existing tag", value: false },
      ] }
    case "checkout": {
      const branchHere = repository.branches.filter(branch => branch.hash === target.hash && !branch.current)
      return { kind, title: "Checkout", submit: "OK", fields: branchHere.length
        ? [{ type: "select", key: "ref", label: "Checkout branch", value: branchHere[0].name, choices: branchHere.map(branch => ({ value: branch.name, label: branch.name })) }, { type: "checkbox", key: "detach", label: "Detach HEAD at this commit instead", value: false }]
        : [{ type: "info", label: "Commit", text: `${short(target.hash ?? target.ref)} ${target.subject ?? target.ref ?? ""}` }, { type: "warning", text: "Checking out a commit leaves HEAD detached: new commits belong to no branch until you create one." }, { type: "checkbox", key: "detach", label: "Detach HEAD", value: true }] }
    }
    case "checkoutRemote": {
      const remoteName = repository.remotes.find(group => target.ref?.startsWith(`${group.name}/`))?.name ?? remote
      const localName = target.ref ? target.ref.slice(remoteName.length + 1) : ""
      return { kind, title: "Checkout New Branch", submit: "OK", fields: [
        { type: "info", label: "Checkout remote branch", text: target.ref ?? "" },
        { type: "text", key: "name", label: "New local branch name", value: localName, required: true },
        { type: "checkbox", key: "track", label: "Local branch should track remote branch", value: true },
      ] }
    }
    case "deleteBranch":
      return { kind, title: "Delete Branch", submit: "OK", danger: true, fields: [
        { type: "info", label: "Branch", text: targetName },
        { type: "checkbox", key: "force", label: "Force delete regardless of merge status", value: false, warning: "Commits only this branch holds become unreachable" },
        ...(repository.branches.find(branch => branch.name === target.ref)?.upstream ? [{ type: "checkbox" as const, key: "remote", label: `Also delete ${repository.branches.find(branch => branch.name === target.ref)?.upstream} on the remote`, value: false }] : []),
      ] }
    case "deleteTag":
      return { kind, title: "Remove Tag", submit: "OK", danger: true, fields: [
        { type: "info", label: "Tag", text: targetName },
        { type: "checkbox", key: "remote", label: `Remove tag from all remotes`, value: false },
      ] }
    case "renameBranch":
      return { kind, title: "Rename Branch", submit: "Rename", fields: [
        { type: "info", label: "Branch", text: targetName },
        { type: "text", key: "name", label: "New name", value: target.ref ?? "", required: true },
      ] }
    case "reset":
      return { kind, title: "Reset to Commit", submit: "OK", danger: true, fields: [
        { type: "info", label: "Reset", text: `${headLabel(repository)} → ${short(target.hash)} ${target.subject ?? ""}` },
        { type: "radio", key: "mode", label: "Using mode", value: "mixed", choices: [
          { value: "soft", label: "Soft - keep all local changes" },
          { value: "mixed", label: "Mixed - keep working copy but reset index" },
          { value: "hard", label: "Hard - discard all working copy changes" },
        ] },
        { type: "warning", text: "Hard discards every uncommitted change; commits after the target leave the branch in every mode." },
      ] }
    case "rebase":
      return { kind, title: "Confirm Rebase", submit: "OK", danger: true, fields: [
        { type: "info", label: "Rebase", text: `${headLabel(repository)} onto ${targetName}` },
        { type: "warning", text: "Rebasing rewrites the current branch's commits; rewrite only commits nobody else has." },
      ] }
    case "cherryPick":
      return { kind, title: "Confirm cherry pick", submit: "OK", fields: [
        { type: "info", label: "Cherry-pick", text: `${short(target.hash)} ${target.subject ?? ""} onto ${headLabel(repository)}` },
        { type: "checkbox", key: "commit", label: "Commit immediately", value: true },
        { type: "checkbox", key: "reference", label: "Add \"cherry picked from\" to the message", value: false },
      ] }
    case "revert":
      return { kind, title: "Confirm backout", submit: "OK", fields: [
        { type: "info", label: "Reverse commit", text: `${short(target.hash)} ${target.subject ?? ""}` },
        { type: "checkbox", key: "commit", label: "Commit immediately", value: true },
      ] }
    case "stashApply":
      return { kind, title: "Apply Stash", submit: "OK", fields: [
        { type: "info", label: "Stash", text: `${target.stash ?? ""} ${target.subject ?? ""}` },
        { type: "checkbox", key: "drop", label: "Delete after applying", value: false },
        { type: "checkbox", key: "index", label: "Restore the staged state too", value: false },
      ] }
    case "stashPop":
      return { kind, title: "Pop Stash", submit: "OK", fields: [{ type: "info", label: "Stash", text: `${target.stash ?? ""} ${target.subject ?? ""}` }] }
    case "stashDrop":
      return { kind, title: "Delete Stash", submit: "OK", danger: true, fields: [
        { type: "info", label: "Stash", text: `${target.stash ?? ""} ${target.subject ?? ""}` },
        { type: "warning", text: "The stashed changes are lost." },
      ] }
    case "pushTag":
      return { kind, title: "Push Tag", submit: "OK", fields: [
        { type: "info", label: "Tag", text: targetName },
        { type: "select", key: "remote", label: "Push to repository", value: remote, choices: remoteChoices(repository) },
      ] }
  }
}

const text = (values: DialogValues, key: string) => String(values[key] ?? "").trim()
const flag = (values: DialogValues, key: string) => values[key] === true
const list = (values: DialogValues, key: string) => Array.isArray(values[key]) ? values[key] as string[] : []

/**
 * Checks submitted values before running anything.
 * @param spec the dialog that was shown
 * @param values submitted values
 * @param repository the repository, for checks that depend on its state (staged files for a commit)
 * @returns a message naming the first problem, or `null`
 */
export const validateDialog = (spec: DialogSpec, values: DialogValues, repository?: Repository) => {
  if (spec.kind === "commit" && !flag(values, "amend")) {
    if (!text(values, "message")) return "Write a commit message"
    if (repository && repository.staged === 0) return "Stage at least one file: tick its checkbox in the file list"
  }
  for (const field of spec.fields) {
    if (field.type === "text" && field.required && !text(values, field.key)) return `${field.label} is required`
    if (field.type === "text" && field.required && /\s/.test(text(values, field.key)) && spec.kind !== "stash") return `${field.label} holds no spaces`
  }
  if ((spec.kind === "branch" || spec.kind === "tag") && values.start === "specified" && !text(values, "commit")) return "Specified commit is empty"
  if ((spec.kind === "push" || spec.kind === "deleteBranches") && !list(values, "branches").length && !flag(values, "tags")) return "Select at least one branch"
  return null
}

/**
 * Turns submitted values into git commands, run in order; the first failure stops the rest.
 * @param spec the dialog that was shown (its kind decides the commands)
 * @param values submitted values
 * @param repository the repository, for upstreams and remotes
 * @param target what the dialog was opened on
 * @returns argument lists for `git`
 */
export const dialogCommands = (spec: DialogSpec, values: DialogValues, repository: Repository, target: DialogTarget): string[][] => {
  const remote = text(values, "remote") || preferredRemote(repository)
  const mergeOptions = [...(flag(values, "commit") ? [] : ["--no-commit"]), ...(flag(values, "log") ? ["--log"] : []), ...(flag(values, "noFastForward") ? ["--no-ff"] : [])]
  switch (spec.kind) {
    case "commit": {
      const message = text(values, "message")
      const commit = ["commit", ...(flag(values, "amend") ? ["--amend"] : []), ...(message ? ["-m", message] : ["--no-edit"])]
      if (!flag(values, "push")) return [commit]
      const branch = repository.branches.find(candidate => candidate.current)
      if (!branch) return [commit]
      return [commit, branch.upstream ? ["push", ...(flag(values, "amend") ? ["--force-with-lease"] : [])] : ["push", "--set-upstream", remote, branch.name]]
    }
    case "fetch":
      return [["fetch", ...(flag(values, "all") ? ["--all"] : [remote]), ...(flag(values, "prune") ? ["--prune"] : []), ...(flag(values, "tags") ? ["--tags"] : [])]]
    case "pull":
      return [["pull", ...(flag(values, "rebase") ? ["--rebase"] : ["--no-rebase", "--no-edit", ...mergeOptions]), remote, text(values, "branch")]]
    case "push": {
      const branches = list(values, "branches")
      const commands = branches.map(name => {
        const branch = repository.branches.find(candidate => candidate.name === name)
        const upstream = branch?.upstream && branch.upstream.startsWith(`${remote}/`) ? branch.upstream.slice(remote.length + 1) : name
        return ["push", ...(flag(values, "force") ? ["--force-with-lease"] : []), ...(!branch?.upstream && flag(values, "track") ? ["--set-upstream"] : []), remote, `${name}:${upstream}`]
      })
      return flag(values, "tags") ? [...commands, ["push", remote, "--tags"]] : commands
    }
    case "branch": {
      const start = values.start === "specified" ? [text(values, "commit")] : []
      return flag(values, "checkout") ? [["switch", "-c", text(values, "name"), ...start]] : [["branch", text(values, "name"), ...start]]
    }
    case "deleteBranches":
      return list(values, "branches").map(name => {
        const group = repository.remotes.find(candidate => name.startsWith(`${candidate.name}/`) && repository.branches.every(branch => branch.name !== name))
        return group ? ["push", group.name, "--delete", name.slice(group.name.length + 1)] : ["branch", flag(values, "force") ? "-D" : "-d", name]
      })
    case "merge":
      return flag(values, "rebase") ? [["rebase", text(values, "ref")]] : [["merge", "--no-edit", ...mergeOptions, text(values, "ref")]]
    case "stash":
      return [["stash", "push", ...(flag(values, "keepIndex") ? ["--keep-index"] : []), ...(flag(values, "untracked") ? ["--include-untracked"] : []), ...(text(values, "message") ? ["-m", text(values, "message")] : [])]]
    case "tag": {
      const name = text(values, "name")
      const start = values.start === "specified" ? [text(values, "commit")] : []
      const message = text(values, "message") || name
      const create = ["tag", ...(flag(values, "force") ? ["-f"] : []), ...(flag(values, "lightweight") ? [] : ["-a", "-m", message]), name, ...start]
      return flag(values, "push") && remote ? [create, ["push", ...(flag(values, "force") ? ["--force"] : []), remote, `refs/tags/${name}`]] : [create]
    }
    case "checkout":
      return flag(values, "detach") || !text(values, "ref") ? [["switch", "--detach", target.hash ?? target.ref ?? "HEAD"]] : [["switch", text(values, "ref")]]
    case "checkoutRemote": {
      const name = text(values, "name")
      if (repository.branches.some(branch => branch.name === name)) return [["switch", name]]
      return [["switch", "-c", name, ...(flag(values, "track") ? ["--track"] : ["--no-track"]), target.ref ?? ""]]
    }
    case "deleteBranch": {
      const branch = repository.branches.find(candidate => candidate.name === target.ref)
      const upstream = branch?.upstream
      const upstreamRemote = upstream ? repository.remotes.find(group => upstream.startsWith(`${group.name}/`))?.name : undefined
      const commands = [["branch", flag(values, "force") ? "-D" : "-d", target.ref ?? ""]]
      return flag(values, "remote") && upstream && upstreamRemote ? [...commands, ["push", upstreamRemote, "--delete", upstream.slice(upstreamRemote.length + 1)]] : commands
    }
    case "deleteTag":
      return [["tag", "-d", target.ref ?? ""], ...(flag(values, "remote") ? repository.remotes.map(group => ["push", group.name, "--delete", `refs/tags/${target.ref}`]) : [])]
    case "renameBranch":
      return [["branch", "-m", target.ref ?? "", text(values, "name")]]
    case "reset":
      return [["reset", `--${text(values, "mode") || "mixed"}`, target.hash ?? "HEAD"]]
    case "rebase":
      return [["rebase", target.ref ?? target.hash ?? ""]]
    case "cherryPick":
      return [["cherry-pick", ...(flag(values, "commit") ? [] : ["--no-commit"]), ...(flag(values, "reference") ? ["-x"] : []), target.hash ?? ""]]
    case "revert":
      return [["revert", ...(flag(values, "commit") ? ["--no-edit"] : ["--no-commit"]), target.hash ?? ""]]
    case "stashApply":
      return [["stash", "apply", ...(flag(values, "index") ? ["--index"] : []), target.stash ?? ""], ...(flag(values, "drop") ? [["stash", "drop", target.stash ?? ""]] : [])]
    case "stashPop":
      return [["stash", "pop", target.stash ?? ""]]
    case "stashDrop":
      return [["stash", "drop", target.stash ?? ""]]
    case "pushTag":
      return [["push", remote, `refs/tags/${target.ref}`]]
  }
}

/**
 * @param spec the dialog
 * @returns each field's initial value keyed by field key, as the dialog starts
 */
export const initialValues = (spec: DialogSpec): DialogValues =>
  Object.fromEntries(spec.fields.flatMap((field): [string, DialogValues[string]][] => {
    if (field.type === "info" || field.type === "warning") return []
    if (field.type === "checklist") return [[field.key, field.items.filter(item => item.checked).map(item => item.value)]]
    return [[field.key, field.value]]
  }))
