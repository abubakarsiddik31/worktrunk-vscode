import * as vscode from "vscode";
import {
  age,
  describe,
  GroupKind,
  groupOf,
  GROUPS,
  hasUncommitted,
  isRemovable,
  STATE_TEXT,
  Worktree,
  worktreeLabel,
  withPr,
} from "./format";
import type { PullRequest, WorktreeList } from "./worktrunk";

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

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function tooltip({ item, pr }: Worktree, defaultBranch: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  const name = item.branch ?? `detached at ${item.head.short_sha}`;
  md.appendMarkdown(`**${escape(name)}**${item.worktree.current ? " — this window" : ""}\n\n`);
  md.appendMarkdown(`$(folder) \`${item.worktree.path}\`\n\n`);
  if (item.head?.subject) {
    md.appendMarkdown(`$(git-commit) ${escape(item.head.subject)} — ${age(item.head.committed_at)} ago (\`${item.head.short_sha}\`)\n\n`);
  }
  if (pr) {
    const title = pr.title ? ` ${escape(pr.title)}` : "";
    const facts = [
      pr.state ?? "open",
      pr.review && `review ${pr.review}`,
      item.checks?.status && `CI ${item.checks.status}${item.checks.stale ? " (stale)" : ""}`,
    ].filter(Boolean);
    md.appendMarkdown(`$(git-pull-request) [#${pr.number}](${pr.url})${title} — ${facts.join(", ")}\n\n`);
  }
  const state = item.display.state;
  const base = item.default_branch;
  const relation: string[] = [];
  if (base && !item.worktree.main) relation.push(`${base.ahead} ahead, ${base.behind} behind ${defaultBranch}`);
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

function contextValue({ item, pr }: Worktree): string {
  const flags = ["worktree"];
  if (!item.worktree.prunable) flags.push("present");
  if (pr?.url) flags.push("pr");
  if (item.branch) flags.push("branch");
  if (isRemovable(item)) flags.push("removable");
  if (!item.worktree.main && !item.worktree.prunable) flags.push(item.worktree.locked ? "locked" : "unlocked");
  return flags.join(":");
}

export class WorktreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private list: WorktreeList | undefined;
  private error: string | undefined;
  private extraPr: (sha: string) => PullRequest | null | undefined = () => undefined;
  private hidePrefix = true;

  setList(list: WorktreeList | undefined): void {
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
    return (this.list?.items ?? []).map((item) => withPr(item, this.extraPr));
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
    item.description = describe(node);
    item.iconPath = icon(node);
    item.tooltip = tooltip(node, this.list?.repo.default_branch ?? "main");
    item.contextValue = contextValue(node);
    return item;
  }
}
