<p align="center">
  <img src="media/icon.png" width="128" alt="Worktrunk Worktrees logo">
</p>

<h1 align="center">Worktrunk Worktrees for VS Code</h1>

<p align="center">
  Every git worktree of your repository in one sidebar — with its pull request, CI state,
  uncommitted changes and whether it is already merged.
</p>

---

If you keep several worktrees around (one per branch, one per review, one per AI agent),
it gets hard to remember which is which. This extension lists them all, says which pull
request each one belongs to and whether its checks pass, and lets you open, create, check
out, lock and clean them up without leaving the editor.

It is a front end for the [Worktrunk](https://worktrunk.dev) CLI (`wt`) and reads its
`wt list --full --format=json`. It is an independent project, not affiliated with Worktrunk.

## Features

- **One list, grouped by what you can do with it**
  - **Active** — branches still being worked on, plus the main worktree
  - **Detached checkouts** — review checkouts with no branch; their PR is found from the commit
  - **Merged — safe to remove** — content already in the default branch
  - **Missing folders — prunable** — git still lists them but the folder is gone
- **Pull request and CI at a glance** — the icon is the CI state of the branch's open PR
  (passed, failed, running); merged and closed PRs are named. A badge on the activity bar counts
  failing PRs.
- **A compact row** — `#42  ✎ +12 −3  ↑7 ↓2  ⇡3  2h` reads as: PR #42, uncommitted lines,
  commits ahead of/behind the default branch, commits not pushed, age of the last commit.
  Hover for the full picture.
- **New worktree** — pick an existing branch or type a new one and choose its base.
- **Check out a pull request** — pick from the repository's open PRs; it lands in its own worktree.
- **Remove safely** — never the main worktree, the one this window has open, or a locked one.
  Uncommitted changes are discarded only when you say so, and Worktrunk keeps a backup ref. An
  unmerged branch is kept unless you ask for it to be deleted, and that asks twice.
- **Remove all merged worktrees** in one step, skipping any that are locked or dirty.
- **Lock and unlock** a worktree, with a reason.
- **Status bar** — the PR and CI state of the worktree this window has open; click to open the PR.
- **Stays current** — refreshes when a worktree is added or removed from a terminal, when the
  window regains focus, and every two minutes while focused.
- Open in a new window or this one, open a terminal there, reveal it, copy its path or branch.
- Multi-root workspaces: choose which repository the view shows.

## Requirements

| Tool | Why | Install |
|---|---|---|
| [Worktrunk](https://worktrunk.dev) `wt` | Lists, creates and removes worktrees | `brew install worktrunk` · Windows: `winget install max-sixty.worktrunk` (installs as `git-wt`) |
| [GitHub CLI](https://cli.github.com) `gh`, logged in | PR numbers and CI state | `brew install gh && gh auth login` |
| git | Locking, pruning, branch list | — |

Without `gh` the view still works; it just shows no PRs. The PR lookup for detached and
merged worktrees uses GitHub; on other forges you see what Worktrunk itself reports.

## Install

The extension is not on the Marketplace yet. Download the latest
`worktrunk-vscode-<version>.vsix` from [Releases](https://github.com/abubakarsiddik31/worktrunk-vscode/releases), then either

```bash
code --install-extension worktrunk-vscode-0.1.0.vsix
```

or run **Extensions: Install from VSIX…** from the command palette. Reload the window and
click the tree icon in the activity bar.

## Settings

| Setting | Default | |
|---|---|---|
| `worktrunk.executable` | *(empty)* | Path to `wt`/`git-wt`. Empty searches `PATH`, Homebrew and Cargo. |
| `worktrunk.refreshIntervalSeconds` | `120` | Background refresh while the window is focused. `0` turns it off. |
| `worktrunk.findPrsForOtherWorktrees` | `true` | Look up the PR behind detached and merged worktrees with `gh`. |
| `worktrunk.hideBranchPrefix` | `true` | Show `alice/fix-login` as `fix-login`. |
| `worktrunk.openAfterCreate` | `ask` | `ask`, `newWindow`, `currentWindow` or `none`. |
| `worktrunk.statusBar` | `true` | Show the open worktree's PR and CI in the status bar. |

## Troubleshooting

Every command the extension runs and every failure is written to **Output › Worktrunk**.

- *The view asks to install Worktrunk, but it is installed.* VS Code may not see your shell's
  `PATH` when started from the Dock. Use **Choose the wt Binary…** or set `worktrunk.executable`.
- *No PRs appear.* Run `gh auth status` in a terminal.

## Development

```bash
npm install
npm test            # compile and run the unit tests
npm run package     # build worktrunk-vscode-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code with this folder open to start an Extension Development Host.
Pull requests are welcome; keep commits in [Conventional Commits](https://www.conventionalcommits.org) form.

## License

[MIT](LICENSE)
