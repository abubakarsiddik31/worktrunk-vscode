import * as vscode from "vscode";
import { prBadge, Worktree } from "./format";

const CHECK_ICONS: Record<string, string> = {
  passed: "$(pass-filled)",
  failed: "$(error)",
  running: "$(clock)",
  pending: "$(clock)",
};

export class PrStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("worktrunk.pr", vscode.StatusBarAlignment.Left, 50);
  private url: string | undefined;

  constructor() {
    this.item.name = "Worktrunk: Pull Request";
    this.item.command = "worktrunk.openCurrentPr";
  }

  get currentUrl(): string | undefined {
    return this.url;
  }

  update(worktrees: Worktree[], enabled: boolean): void {
    const current = worktrees.find((w) => w.item.worktree.current);
    const pr = current?.pr;
    this.url = pr?.url;
    if (!enabled || !current || !pr) {
      this.item.hide();
      return;
    }
    const checks = current.item.checks?.status;
    this.item.text = ["$(git-pull-request)", prBadge(pr), checks && CHECK_ICONS[checks]].filter(Boolean).join(" ");
    this.item.tooltip = [pr.title ?? `Pull request #${pr.number}`, checks && `CI ${checks}`, "Click to open on GitHub"]
      .filter(Boolean)
      .join("\n");
    this.item.backgroundColor = checks === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
