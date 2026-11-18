# Changelog

## 0.1.1

- Log every refresh to Output › Worktrunk, so a slow refresh can be told from a stuck one.
- Show the Open Folder prompt instead of loading forever when no folder is open.

## 0.1.0

First release.

- Sidebar listing every worktree, grouped into active, detached, merged and prunable.
- PR number, CI and review state per worktree; PRs found by commit for detached and merged worktrees.
- Create a worktree for a new or existing branch, or check out a pull request into one.
- Remove a worktree, optionally discarding changes or deleting an unmerged branch; remove all merged worktrees at once.
- Lock, unlock and prune worktrees.
- Status bar item for the open worktree's PR and CI.
- Refresh on worktree changes from outside the editor, on focus, and on an interval.
- Multi-root workspace support and Windows support for `git-wt`.
