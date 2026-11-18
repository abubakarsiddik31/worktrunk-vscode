# Worktrunk Worktrees for VS Code

A sidebar listing every git worktree of the open repository, with its pull request,
CI state, uncommitted changes and relation to the default branch. It reads
[Worktrunk](https://worktrunk.dev)'s `wt list --full --format=json`.

## Requirements

- `wt` (`brew install worktrunk`)
- `gh`, logged in, for PR and CI status

## Groups

| Group | Meaning |
|---|---|
| Active | Branch worktrees still being worked on, plus the main worktree |
| Detached checkouts | No branch checked out, typically a PR review checkout; the PR is found from the commit |
| Merged — safe to remove | Content already in the default branch |
| Missing folders — prunable | Git still lists them but the folder is gone; use **Prune** in the view's `…` menu |

## Row

`#519  ✎ +12 −3  ↑7 ↓2  ⇡3  2h`: PR number, uncommitted lines, commits ahead/behind the
default branch, commits not pushed (`⇡`) or not pulled (`⇣`), age of the last commit.
The icon is CI state when the branch has an open PR: green passed, red failed, yellow
running. Hover a row for the full picture.

## Build

```bash
npm install
npm run compile
npm run package
code --install-extension worktrunk-vscode.vsix
```
