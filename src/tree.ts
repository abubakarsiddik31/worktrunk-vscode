import { basename } from "node:path";
import * as vscode from "vscode";
import type { PullRequest, WorktreeItem, WorktreeList } from "./worktrunk";

type GroupKind = "active" | "review" | "merged" | "prunable";

const GROUPS: { kind: GroupKind; title: string; expanded: boolean }[] = [
  { kind: "active", title: "Active", expanded: true },
  { kind: "review", title: "Detached checkouts", expanded: true },
  { kind: "merged", title: "Merged — safe to remove", expanded: false },
  { kind: "prunable", title: "Missing folders — prunable", expanded: false },
];

const STATE_TEXT: Record<string, string> = {
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

export class GroupNode {
  constructor(readonly kind: GroupKind, readonly title: string, readonly expanded: boolean, readonly worktrees: Worktree[]) {}
}

export class MessageNode {
  constructor(readonly text: string, readonly icon: string, readonly detail?: string) {}
}

export type Node = GroupNode | Worktree | MessageNode;

export function isWorktree(node: unknown): node is Worktree {
  return typeof node === "object" && node !== null && "item" in node;
}

function isMerged(item: WorktreeItem): boolean {
  return !item.worktree.main && (item.display.state === "integrated" || item.display.state === "empty");
}

function groupOf(item: WorktreeItem): GroupKind {
  if (item.worktree.prunable) {
    return "prunable";
  }
  if (isMerged(item)) {
    return "merged";
  }
  return item.worktree.detached ? "review" : "active";
}

function hasUncommitted(item: WorktreeItem): boolean {
  const c = item.worktree.changes;
  return !!c && (c.staged || c.modified || c.untracked || c.conflicted);
}

function compact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}K`.replace(".0K", "K") : String(n);
}

function age(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
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

function prBadge(pr: PullRequest): string {
  return pr.state && pr.state !== "open" ? `#${pr.number} ${pr.state}` : `#${pr.number}`;
}

function description({ item, pr }: Worktree): string {
  const parts: string[] = [];
  if (pr) parts.push(prBadge(pr));
  if (item.worktree.detached && !item.worktree.prunable) parts.push(`@${item.head.short_sha}`);
  const changes = item.worktree.changes;
  if (changes && hasUncommitted(item)) {
    const { added, deleted } = changes.diff;
    parts.push(added || deleted ? `✎ +${compact(added)} −${compact(deleted)}` : "✎");
  }
  const main = item.default_branch;
  if (main && !item.worktree.main && (main.ahead || main.behind)) {
    parts.push([main.ahead && `↑${main.ahead}`, main.behind && `↓${main.behind}`].filter(Boolean).join(" "));
  }
  const up = item.upstream;
  if (up && (up.ahead || up.behind)) {
    parts.push([up.ahead && `⇡${up.ahead}`, up.behind && `⇣${up.behind}`].filter(Boolean).join(" "));
  }
  const when = age(item.head?.committed_at);
  if (when) parts.push(when);
  return parts.join("  ");
}

function icon({ item, pr }: Worktree): vscode.ThemeIcon {
  const color = (id: string) => new vscode.ThemeColor(id);
  if (item.worktree.prunable) return new vscode.ThemeIcon("warning", color("list.warningForeground"));
  const checks = item.checks?.status;
  if (checks === "failed") return new vscode.ThemeIcon("error", color("testing.iconFailed"));
  if (checks === "running" || checks === "pending") return new vscode.ThemeIcon("clock", color("charts.yellow"));
  if (checks === "passed") return new vscode.ThemeIcon("pass-filled", color("testing.iconPassed"));
  if (pr?.state === "merged") return new vscode.ThemeIcon("git-merge", color("charts.purple"));
  if (pr?.state === "closed") return new vscode.ThemeIcon("git-pull-request-closed", color("disabledForeground"));
  if (pr) return new vscode.ThemeIcon("git-pull-request", color("charts.green"));
  if (item.worktree.locked) return new vscode.ThemeIcon("lock");
  if (item.worktree.main) return new vscode.ThemeIcon("home");
  if (item.worktree.detached) return new vscode.ThemeIcon("git-commit");
  return new vscode.ThemeIcon("git-branch");
}

function tooltip({ item, pr }: Worktree, defaultBranch: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  const name = item.branch ?? `detached at ${item.head.short_sha}`;
  md.appendMarkdown(`**${escape(name)}**${item.worktree.current ? " — this window" : ""}\n\n`);
  md.appendMarkdown(`$(folder) \`${item.worktree.path}\`\n\n`);
  if (item.head?.subject) {
    md.appendMarkdown(`$(git-commit) ${escape(item.head.subject)} — ${age(item.head.committed_at)} ago (\`${item.head.short_sha}\`)\n\n`);
  }
  if (pr) {
    const title = pr.title ? ` ${escape(pr.title)}` : "";
    const facts = [
      pr.state && pr.state !== "open" ? pr.state : "open",
      pr.review && `review ${pr.review}`,
      item.checks?.status && `CI ${item.checks.status}${item.checks.stale ? " (stale)" : ""}`,
    ].filter(Boolean);
    md.appendMarkdown(`$(git-pull-request) [#${pr.number}](${pr.url})${title} — ${facts.join(", ")}\n\n`);
  }
  const state = item.display.state;
  const main = item.default_branch;
  const relation: string[] = [];
  if (main && !item.worktree.main) relation.push(`${main.ahead} ahead, ${main.behind} behind ${defaultBranch}`);
  if (state && STATE_TEXT[state]) relation.push(STATE_TEXT[state]);
  if (relation.length) md.appendMarkdown(`$(git-compare) ${relation.join(" · ")}\n\n`);
  const changes = item.worktree.changes;
  if (changes && hasUncommitted(item)) {
    const kinds = [changes.staged && "staged", changes.modified && "modified", changes.untracked && "untracked", changes.conflicted && "conflicted"].filter(Boolean);
    md.appendMarkdown(`$(edit) Uncommitted: +${changes.diff.added} −${changes.diff.deleted} (${kinds.join(", ")})\n\n`);
  }
  const up = item.upstream;
  if (up) md.appendMarkdown(`$(cloud) ${up.remote}/${escape(up.branch)}: ${up.ahead} to push, ${up.behind} to pull\n\n`);
  if (item.worktree.locked) md.appendMarkdown(`$(lock) Locked${item.worktree.locked.reason ? `: ${escape(item.worktree.locked.reason)}` : ""}\n\n`);
  if (item.worktree.prunable) md.appendMarkdown(`$(warning) Folder is gone${item.worktree.prunable.reason ? `: ${escape(item.worktree.prunable.reason)}` : ""} — run Prune\n\n`);
  return md;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function contextValue({ item, pr }: Worktree): string {
  const flags = ["worktree"];
  if (!item.worktree.prunable) flags.push("present");
  if (pr?.url) flags.push("pr");
  if (item.branch) flags.push("branch");
  if (!item.worktree.main && !item.worktree.locked && !item.worktree.prunable && !item.worktree.current) flags.push("removable");
  return flags.join(":");
}

export class WorktreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private list: WorktreeList | undefined;
  private error: string | undefined;
  private extraPr: (sha: string) => PullRequest | null | undefined = () => undefined;
  private hidePrefix = true;

  setList(list: WorktreeList): void {
    this.list = list;
    this.error = undefined;
    this.changed.fire();
  }

  setError(message: string | undefined): void {
    this.error = message;
    this.changed.fire();
  }

  setExtraPrLookup(lookup: (sha: string) => PullRequest | null | undefined): void {
    this.extraPr = lookup;
  }

  setHidePrefix(hide: boolean): void {
    this.hidePrefix = hide;
    this.changed.fire();
  }

  refreshView(): void {
    this.changed.fire();
  }

  current(): WorktreeList | undefined {
    return this.list;
  }

  worktrees(): Worktree[] {
    return (this.list?.items ?? []).map((item) => ({
      item,
      pr: item.pr?.url ? { ...item.pr, state: item.pr.state ?? "open" } : this.extraPr(item.head?.sha) ?? null,
    }));
  }

  getChildren(node?: Node): Node[] {
    if (node instanceof GroupNode) {
      return node.worktrees;
    }
    if (node) {
      return [];
    }
    const nodes: Node[] = [];
    if (this.error) {
      nodes.push(new MessageNode("Worktrunk failed — see Output › Worktrunk", "error", this.error));
    }
    if (!this.list) {
      if (!this.error) nodes.push(new MessageNode("Loading worktrees…", "loading~spin"));
      return nodes;
    }
    const byGroup = new Map<GroupKind, Worktree[]>();
    for (const worktree of this.worktrees()) {
      const kind = groupOf(worktree.item);
      byGroup.set(kind, [...(byGroup.get(kind) ?? []), worktree]);
    }
    for (const group of GROUPS) {
      const members = byGroup.get(group.kind);
      if (!members?.length) continue;
      members.sort(
        (a, b) =>
          Number(b.item.worktree.main) - Number(a.item.worktree.main) ||
          Date.parse(b.item.head?.committed_at ?? "0") - Date.parse(a.item.head?.committed_at ?? "0"),
      );
      nodes.push(new GroupNode(group.kind, group.title, group.expanded, members));
    }
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof GroupNode) {
      const item = new vscode.TreeItem(
        node.title,
        node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `group:${node.kind}`;
      item.description = String(node.worktrees.length);
      item.contextValue = `group:${node.kind}`;
      return item;
    }
    if (node instanceof MessageNode) {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.detail;
      return item;
    }
    const label = worktreeLabel(node.item, this.hidePrefix);
    const item = new vscode.TreeItem(
      node.item.worktree.current ? { label, highlights: [[0, label.length]] } : label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `worktree:${node.item.worktree.path}`;
    item.description = description(node);
    item.iconPath = icon(node);
    item.tooltip = tooltip(node, this.list?.repo.default_branch ?? "main");
    item.contextValue = contextValue(node);
    return item;
  }
}
