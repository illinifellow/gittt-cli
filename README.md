<div align="center">

# gittt

**A git browser for the terminal.**

Every repository under a folder in one sidebar, a commit graph, changed files and highlighted diffs, a dialog for every action, and full mouse support.

[![CI](https://github.com/illinifellow/gittt-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/illinifellow/gittt-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff905c.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-88bd66.svg)](https://nodejs.org)

<img width="900" alt="gittt showing the express repository: the sidebar with three repositories, the commit graph with branch and tag labels, the files and message of the selected commit" src="https://github.com/user-attachments/assets/752fb8e4-76f6-4c8f-a89f-3b16f4df7e86" />

</div>

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Run](#run)
- [The screen](#the-screen)
- [Dialogs](#dialogs)
- [Keyboard](#keyboard)
- [Mouse](#mouse)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

- **One catalogue for many repositories:** every repository under a folder, in an order you choose. Repositories can be added from anywhere by path and removed from the list without touching the folder.
- **Commit graph:** lanes in their own colours, merges and forks drawn with rounded corners. Branch, remote and tag labels sit on tinted grounds.
- **Live:** edits, commits, checkouts, fetches and new refs show up within about a second.
- **States made visible:** uncommitted changes, a rebase, merge, cherry-pick, revert or bisect stopped half way, conflicts, a detached HEAD.
- **Files and diffs:** sorted by path, by status or as a tree, with old and new line numbers. Code is highlighted in the colours of your VS Code theme.
- **A dialog for every action:** fetch, pull, push, branch, merge, stash, tag, checkout, reset, rebase, cherry-pick, revert and more.
- **Mouse everywhere:** clicks, double clicks, right-click menus, wheel and sideways scrolling, draggable dividers and columns, text selection in diffs.
- **Fast on large files:** highlighting runs in pieces that never block input.

## Requirements

- Node.js 20 or newer and `git` on `PATH`.
- A terminal with true colour and SGR mouse reporting. Tested in iTerm2 and the VS Code integrated terminal on macOS.
- Optional: the `code` command, to open files in VS Code.

## Install

From GitHub:

```sh
npm install --global github:illinifellow/gittt-cli
```

From a clone:

```sh
git clone https://github.com/illinifellow/gittt-cli.git
cd gittt-cli
npm install
npm link
```

## Run

```sh
gittt            # asks which folder to search, prefilled with the current one
gittt ~/code     # prefills that folder instead
```

The first screen asks for the folder to search. Tab completes a path, the arrows or the mouse pick a recent folder, and Enter starts. The folder is searched three levels deep. `node_modules`, build output and tool caches are skipped.

## The screen

| Area       | What it shows                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar    | Commit, Pull, Push, Fetch, Branch, Merge, Stash, Tag with their counts. Short messages appear at the right end (copied hash, finished action, errors).                                                   |
| Sidebar    | One row per repository with its change count, ahead/behind and current branch. Inside: WORKSPACE (File status, History, Search), BRANCHES, REMOTES, TAGS, STASHES. Above the list: Add, Rescan, ↑ and ↓. |
| Filter bar | All / Current Branch, Show / Hide Remote Branches, Ancestor / Date Order, Large / Compact View, Absolute / Relative Dates, Gitmoji / Shortcodes.                                                         |
| Log        | Graph, Description, Commit, Author, Date. The working tree is its own row; a stopped operation and its conflicts are shown on it.                                                                        |
| Files      | The selected commit's files or the pending ones: by path, by status (conflicts first) or as a folder tree.                                                                                               |
| Diff       | Commit header (Commit, Parents, Author, Date, Labels, message) and the selected file's diff, hunk by hunk.                                                                                               |

Compact View draws the graph one cell per lane and shows authors without email. Highlighting uses the theme VS Code is set to, `editor.tokenColorCustomizations` included, and falls back to Dark+ without VS Code.

## Dialogs

| Action                      | Options                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Fetch                       | all remotes, prune, tags                                                              |
| Pull                        | remote and branch, commit merged changes, include messages, no fast-forward, rebase   |
| Push                        | remote, branches with their upstreams, track new branches, all tags, force with lease |
| New Branch                  | name, from the working copy parent or a specified commit, checkout                    |
| Delete Branches             | local and remote branches, force                                                      |
| Merge                       | branch or commit, commit merged changes, include messages, no fast-forward, rebase    |
| Stash                       | message, keep staged changes, include untracked files                                 |
| Add Tag                     | name, commit, push, lightweight, message, move an existing tag                        |
| Checkout                    | branch at the commit or a detached HEAD; remote branch as a new tracking branch       |
| Rename / Delete Branch      | new name; force, also delete the upstream                                             |
| Remove / Push Tag           | from all remotes; to a chosen remote                                                  |
| Reset                       | soft, mixed or hard                                                                   |
| Rebase, Cherry-pick, Revert | confirmation; commit immediately, add "cherry picked from"                            |
| Apply / Pop / Delete Stash  | delete after applying, restore the staged state                                       |

Checking out a local branch needs no dialog. Errors from git show in the toolbar. Staging, committing and resolving conflicts are left to git or your editor.

## Keyboard

| Key                             | Action                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `Tab` `Shift+Tab`               | next / previous pane                                            |
| `↑` `↓` `PgUp` `PgDn`           | move                                                            |
| `Home` `End`                    | first / last commit                                             |
| `←` `→`                         | fold / unfold in the sidebar, scroll sideways elsewhere         |
| `Shift+←` `Shift+→`             | scroll the sidebar sideways                                     |
| `Enter`                         | open a repository or section, check out, open a file in VS Code |
| `Space`                         | fold / unfold in the sidebar, context menu elsewhere            |
| `.`                             | context menu for the row                                        |
| `/`                             | filter the sidebar, or search commits in the log                |
| `y`                             | copy the selected commit's full hash                            |
| `f` `p` `P` `b` `m` `s` `t`     | Fetch, Pull, Push, Branch, Merge, Stash, Tag                    |
| `a` `x`                         | add a repository by path; remove the repository from the list   |
| `K` `J`                         | move the selected repository up / down the list                 |
| `r`                             | rescan: new repositories appear, removed ones come back         |
| `1` – `6`                       | branches, remote branches, order, view, dates, gitmoji          |
| `v`                             | file list: by path, by status, tree                             |
| `[` `]` `{` `}` `(` `)` `<` `>` | narrow / widen the graph, author, date and sidebar columns      |
| `q` `Ctrl+C`                    | quit                                                            |

## Mouse

| Gesture                 | Action                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| click                   | select, press a button, toggle a filter or a dialog option                        |
| double-click            | check out a branch, tag or commit; open a file in VS Code (at the line in a diff) |
| right-click             | context menu                                                                      |
| wheel                   | scroll the pane under the pointer                                                 |
| `Shift`+wheel, trackpad | scroll sideways                                                                   |
| drag a divider          | resize the sidebar, the log and files, the files and diff, any column             |
| drag a repository row   | move the repository up or down the list                                           |
| drag in the diff        | select text; it is copied to the clipboard on release                             |
| click a hash            | copy the full hash                                                                |
| `⌥` drag (iTerm2)       | the terminal's own selection anywhere                                             |

## Configuration

All configuration lives in one file, `settings.json`, in two places of the same shape:

| File                                    | Holds                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `config/settings.json` (in the package) | every default: settings, limits, columns, keys, themes, icon sets                                         |
| `~/.config/gittt-cli/settings.json`     | only what you changed, plus what gittt remembers (`state`: recent folders, each folder's repository list) |

The two are merged on start. Toggles and drags in the app write the user file; it can also be edited by hand, and removing a value puts it back to its default. `$XDG_CONFIG_HOME` moves the user file.

| Section    | What it holds                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings` | `theme`, `icons`, branches, remote branches, order, compact view, date format, gitmoji, file view, `maxCommits`, `scanDepth`, `scanExclude` |
| `limits`   | diff size cap, highlighting batch and cache sizes, refresh delay, double-click time, status message times, watched paths to ignore          |
| `columns`  | sidebar, graph, commit, author, date and files widths, lower panes' height (`null` sizes automatically)                                     |
| `keys`     | the key for every action                                                                                                                    |
| `themes`   | every theme in full: `colors`, `glyphs`, `spacing`                                                                                          |
| `iconSets` | icon replacements, e.g. `nerd` for terminals with a Nerd Font                                                                               |
| `tokens`   | single `colors`, `glyphs` or `spacing` values laid over the active theme                                                                    |

### Themes

Two themes ship: **golden-brown** (the default, warm orange on brown-tinted grounds) and **light**. `settings.theme` is `auto` by default: gittt asks the terminal for its background and picks `light` on a light one and `golden-brown` otherwise. A theme of your own is another entry under `themes`; anything it leaves out comes from the shipped themes.

- `colors`: background, text, muted text, borders, accent, selections, header and field grounds, branch, current branch, remote, tag, HEAD, stash, file states, diff grounds, label and pill colours, and `lanes` (the graph palette).
- `glyphs`: every icon, mark and graph character (nodes, lines, corners, checkboxes, radio buttons, folders, file states).
- `spacing`: sidebar indent, toolbar gaps, dialog and menu widths, checklist rows, search field width.

## Development

```sh
npm install
npm run build       # dist/cli.js
npm run typecheck
npm test            # graph layout and drawing, dialogs and the git layer against real repositories
```

A running `gittt` restarts itself in place when `dist/cli.js` changes, keeping the chosen folder.

## Contributing

Every change starts as an issue, a [bug report](https://github.com/illinifellow/gittt-cli/issues/new?template=bug_report.yml) or a [feature request](https://github.com/illinifellow/gittt-cli/issues/new?template=feature_request.yml). The work for an issue happens on its own branch and lands through a pull request that closes it; the branch is deleted on merge.

## License

[MIT](LICENSE)
