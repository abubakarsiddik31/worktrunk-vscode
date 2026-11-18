import { basename } from "node:path";
import type { PullRequest, WorktreeItem } from "./worktrunk";

export type GroupKind = "active" | "detached" | "merged" | "prunable";

export const GROUPS: { kind: GroupKind; title: string; expanded: boolean }[] = [
  { kind: "active", title: "Active", expanded: true },
  { kind: "detached", title: "Detached checkouts", expanded: true },
  { kind: "merged", title: "Merged — safe to remove", expanded: false },
  { kind: "prunable", title: "Missing folders — prunable", expanded: false },
];

export const STATE_TEXT: Record<string, string> = {
  is_main: "the main worktree",
  orphan: "shares no history with the default branch",
  empty: "same commit as the default branch and clean — safe to remove",
  integrated: "already merged into the default branch — safe to remove",
  would_conflict: "would conflict if merged into the default branch",
  same_commit: "same commit as the default branch, with uncommitted changes",
  diverged: "both ahead of and behind the default branch",
  ahead: "ahead of the default branch",
  behind: "behind the default branch",
};

export interface Worktree {
  item: WorktreeItem;
  pr: PullRequest | null;
}

export function isMerged(item: WorktreeItem): boolean {
  return !item.worktree.main && (item.display.state === "integrated" || item.display.state === "empty");
}

export function groupOf(item: WorktreeItem): GroupKind {
  if (item.worktree.prunable) {
    return "prunable";
  }
  if (isMerged(item)) {
    return "merged";
  }
  return item.worktree.detached ? "detached" : "active";
}

export function hasUncommitted(item: WorktreeItem): boolean {
  const c = item.worktree.changes;
  return !!c && (c.staged || c.modified || c.untracked || c.conflicted);
}

export function isRemovable(item: WorktreeItem): boolean {
  return !item.worktree.main && !item.worktree.locked && !item.worktree.prunable && !item.worktree.current;
}

export function compact(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const thousands = Math.round(n / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
}

export function age(iso: string | undefined, now = Date.now()): string {
  if (!iso) {
    return "";
  }
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 14) return `${Math.round(minutes / 1440)}d`;
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 10080)}w`;
  return `${Math.round(minutes / 43200)}mo`;
}

export function worktreeLabel(item: WorktreeItem, hidePrefix: boolean): string {
  if (!item.branch) {
    return basename(item.worktree.path);
  }
  const slash = item.branch.indexOf("/");
  return hidePrefix && slash > 0 ? item.branch.slice(slash + 1) : item.branch;
}

export function prBadge(pr: PullRequest): string {
  return pr.state && pr.state !== "open" ? `#${pr.number} ${pr.state}` : `#${pr.number}`;
}

export function describe({ item, pr }: Worktree, now = Date.now()): string {
  const parts: string[] = [];
  if (pr) parts.push(prBadge(pr));
  if (item.worktree.detached && !item.worktree.prunable) parts.push(`@${item.head.short_sha}`);
  const changes = item.worktree.changes;
  if (changes && hasUncommitted(item)) {
    const { added, deleted } = changes.diff;
    parts.push(added || deleted ? `✎ +${compact(added)} −${compact(deleted)}` : "✎");
  }
  const base = item.default_branch;
  if (base && !item.worktree.main && (base.ahead || base.behind)) {
    parts.push([base.ahead && `↑${base.ahead}`, base.behind && `↓${base.behind}`].filter(Boolean).join(" "));
  }
  const up = item.upstream;
  if (up && (up.ahead || up.behind)) {
    parts.push([up.ahead && `⇡${up.ahead}`, up.behind && `⇣${up.behind}`].filter(Boolean).join(" "));
  }
  const when = age(item.head?.committed_at, now);
  if (when) parts.push(when);
  return parts.join("  ");
}

export function withPr(item: WorktreeItem, lookup: (sha: string) => PullRequest | null | undefined): Worktree {
  const pr = item.pr?.url ? { ...item.pr, state: item.pr.state ?? "open" } : (item.head?.sha && lookup(item.head.sha)) || null;
  return { item, pr };
}
