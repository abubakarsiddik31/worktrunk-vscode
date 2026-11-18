import * as vscode from "vscode";
import { hasUncommitted, isMerged, Worktree, worktreeLabel } from "./format";
import { isWorktree, WorktreeProvider } from "./tree";
import { gitCommonDir, listWorktrees, PullRequestFinder, pruneWorktrees, removeWorktree, resolveBinary } from "./worktrunk";

const FOCUS_REFRESH_MIN_GAP_MS = 30_000;
const WATCH_DEBOUNCE_MS = 1_500;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Worktrunk");
  const provider = new WorktreeProvider();
  const view = vscode.window.createTreeView("worktrunk.worktrees", { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(output, view);

  const config = () => vscode.workspace.getConfiguration("worktrunk");
  const repoRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let finder: PullRequestFinder | undefined;
  let lastRefresh = 0;
  let running: Promise<void> | undefined;
  let rerun = false;

  provider.setHidePrefix(config().get<boolean>("hideBranchPrefix", true));
  provider.setExtraPrLookup((sha) => finder?.cached(sha));

  const log = (message: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);

  const summarize = () => {
    const worktrees = provider.worktrees();
    const openPrs = worktrees.filter((w) => w.item.pr?.url).length;
    const failing = worktrees.filter((w) => w.item.checks?.status === "failed").length;
    const removable = worktrees.filter((w) => isMerged(w.item)).length;
    view.description = [`${openPrs} open PR${openPrs === 1 ? "" : "s"}`, removable && `${removable} merged`]
      .filter(Boolean)
      .join(" · ");
    view.badge = failing ? { value: failing, tooltip: `${failing} worktree PR${failing === 1 ? "" : "s"} failing CI` } : undefined;
  };

  const load = async () => {
    const cwd = repoRoot();
    if (!cwd) {
      return;
    }
    const wt = resolveBinary("wt", config().get<string>("executable", ""));
    if (!wt) {
      provider.setError("Could not find the `wt` binary. Install Worktrunk (brew install worktrunk) or set worktrunk.executable.");
      return;
    }
    lastRefresh = Date.now();
    try {
      provider.setList(await listWorktrees(wt, cwd, false));
      summarize();
      const full = await listWorktrees(wt, cwd, true);
      provider.setList(full);
      summarize();
      const forge = full.repo.forge;
      const gh = resolveBinary("gh", "");
      if (config().get<boolean>("findPrsForOtherWorktrees", true) && gh && forge?.provider === "github") {
        finder ??= new PullRequestFinder(gh);
        const shas = full.items
          .filter((item) => !item.pr?.url && !item.worktree.main && !item.worktree.prunable && item.head?.sha)
          .map((item) => item.head.sha);
        await finder.findAll(forge.owner, forge.name, shas, cwd, (error) => log(error.message));
        provider.refreshView();
      }
    } catch (error) {
      const message = (error as Error).message;
      log(message);
      provider.setError(message);
    }
  };

  const refresh = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await load();
      } while (rerun);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  let debounce: NodeJS.Timeout | undefined;
  const refreshSoon = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), WATCH_DEBOUNCE_MS);
  };

  let watchers: vscode.Disposable[] = [];
  const watch = async () => {
    watchers.forEach((w) => w.dispose());
    watchers = [];
    const cwd = repoRoot();
    const git = resolveBinary("git", "");
    if (!cwd || !git) return;
    let common: string;
    try {
      common = await gitCommonDir(git, cwd);
    } catch (error) {
      log(`not watching for worktree changes: ${(error as Error).message}`);
      return;
    }
    const base = vscode.Uri.file(common);
    const watched: [pattern: string, onChange: boolean][] = [
      ["worktrees", false],
      ["worktrees/*", false],
      ["worktrees/*/locked", false],
      ["worktrees/*/HEAD", true],
      ["HEAD", true],
    ];
    for (const [pattern, onChange] of watched) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern), false, !onChange, false);
      watcher.onDidCreate(refreshSoon);
      watcher.onDidDelete(refreshSoon);
      watcher.onDidChange(refreshSoon);
      watchers.push(watcher);
    }
  };
  context.subscriptions.push({
    dispose: () => {
      watchers.forEach((w) => w.dispose());
      if (debounce) clearTimeout(debounce);
    },
  });

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const seconds = config().get<number>("refreshIntervalSeconds", 120);
    timer = seconds > 0 ? setInterval(() => void refresh(), seconds * 1000) : undefined;
  };
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  const target = (node: unknown): Worktree | undefined => (isWorktree(node) ? node : undefined);
  const uriOf = (w: Worktree) => vscode.Uri.file(w.item.worktree.path);

  const register = (id: string, handler: (w: Worktree) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (node: unknown) => {
        const w = target(node);
        return w ? handler(w) : undefined;
      }),
    );

  context.subscriptions.push(
    vscode.commands.registerCommand("worktrunk.refresh", () => refresh()),
    vscode.commands.registerCommand("worktrunk.showInTerminal", () => {
      const terminal = vscode.window.createTerminal({ name: "wt list", cwd: repoRoot() });
      terminal.show();
      terminal.sendText("wt list --full");
    }),
    vscode.commands.registerCommand("worktrunk.prune", async () => {
      const cwd = repoRoot();
      const git = resolveBinary("git", "");
      const missing = provider.worktrees().filter((w) => w.item.worktree.prunable);
      if (!cwd || !git) return;
      if (!missing.length) {
        void vscode.window.showInformationMessage("No worktree has a missing folder.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Forget ${missing.length} worktree${missing.length === 1 ? "" : "s"} whose folder no longer exists?`,
        { modal: true, detail: missing.map((w) => w.item.worktree.path).join("\n") },
        "Prune",
      );
      if (choice !== "Prune") return;
      try {
        await pruneWorktrees(git, cwd);
      } catch (error) {
        log((error as Error).message);
        void vscode.window.showErrorMessage((error as Error).message);
      }
      await refresh();
    }),
  );

  register("worktrunk.openNewWindow", (w) => vscode.commands.executeCommand("vscode.openFolder", uriOf(w), { forceNewWindow: true }));
  register("worktrunk.openHere", (w) => vscode.commands.executeCommand("vscode.openFolder", uriOf(w), { forceNewWindow: false }));
  register("worktrunk.openPr", (w) => w.pr?.url && vscode.env.openExternal(vscode.Uri.parse(w.pr.url)));
  register("worktrunk.revealInFinder", (w) => vscode.commands.executeCommand("revealFileInOS", uriOf(w)));
  register("worktrunk.copyPath", (w) => vscode.env.clipboard.writeText(w.item.worktree.path));
  register("worktrunk.copyBranch", (w) => w.item.branch && vscode.env.clipboard.writeText(w.item.branch));
  register("worktrunk.openTerminal", (w) => {
    const terminal = vscode.window.createTerminal({ name: worktreeLabel(w.item, true), cwd: w.item.worktree.path });
    terminal.show();
  });
  register("worktrunk.remove", async (w) => {
    const cwd = repoRoot();
    const wt = resolveBinary("wt", config().get<string>("executable", ""));
    if (!cwd || !wt) return;
    if (hasUncommitted(w.item)) {
      void vscode.window.showWarningMessage(
        `${worktreeLabel(w.item, false)} has uncommitted changes. Commit, stash or discard them first; nothing was removed.`,
      );
      return;
    }
    const merged = isMerged(w.item);
    const choice = await vscode.window.showWarningMessage(
      `Remove worktree ${worktreeLabel(w.item, false)}?`,
      {
        modal: true,
        detail: [
          `Deletes the folder ${w.item.worktree.path}.`,
          w.item.branch
            ? merged
              ? `Its branch ${w.item.branch} is merged and will be deleted too.`
              : `Its branch ${w.item.branch} is not merged and will be kept.`
            : `It is a detached checkout at ${w.item.head.short_sha}; no branch is touched.`,
        ].join("\n"),
      },
      "Remove",
    );
    if (choice !== "Remove") return;
    try {
      await removeWorktree(wt, cwd, w.item.worktree.path);
      log(`removed ${w.item.worktree.path}`);
    } catch (error) {
      log((error as Error).message);
      void vscode.window.showErrorMessage((error as Error).message);
    }
    await refresh();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("worktrunk.refreshIntervalSeconds")) schedule();
      if (event.affectsConfiguration("worktrunk.hideBranchPrefix")) {
        provider.setHidePrefix(config().get<boolean>("hideBranchPrefix", true));
      }
      if (event.affectsConfiguration("worktrunk.executable") || event.affectsConfiguration("worktrunk.findPrsForOtherWorktrees")) {
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void watch();
      void refresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - lastRefresh > FOCUS_REFRESH_MIN_GAP_MS) void refresh();
    }),
  );

  schedule();
  void watch();
  void refresh();
}

export function deactivate(): void {}
