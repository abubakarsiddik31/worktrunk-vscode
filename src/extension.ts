import * as vscode from "vscode";
import { hasUncommitted, isMerged, Worktree, worktreeLabel } from "./format";
import { isWorktree, WorktreeProvider } from "./tree";
import {
  gitCommonDir,
  listWorktrees,
  localBranches,
  openPullRequests,
  PullRequestFinder,
  pruneWorktrees,
  removeWorktree,
  resolveBinary,
  SwitchResult,
  switchTo,
} from "./worktrunk";

const FOCUS_REFRESH_MIN_GAP_MS = 30_000;
const WATCH_DEBOUNCE_MS = 1_500;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Worktrunk");
  const provider = new WorktreeProvider();
  const view = vscode.window.createTreeView("worktrunk.worktrees", { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(output, view);

  const config = () => vscode.workspace.getConfiguration("worktrunk");
  const REPO_KEY = "worktrunk.repository";
  const repoRoot = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const chosen = context.workspaceState.get<string>(REPO_KEY);
    return (folders.find((f) => f.uri.fsPath === chosen) ?? folders[0])?.uri.fsPath;
  };
  const showRepoInTitle = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    void vscode.commands.executeCommand("setContext", "worktrunk.multiRoot", folders.length > 1);
    const root = repoRoot();
    view.title = folders.length > 1 && root ? `Worktrees · ${folders.find((f) => f.uri.fsPath === root)?.name}` : "Worktrees";
  };
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
    vscode.commands.registerCommand("worktrunk.selectRepository", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const current = repoRoot();
      const picked = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath === current ? "shown" : undefined, detail: f.uri.fsPath })),
        { title: "Show the worktrees of which repository?" },
      );
      if (!picked?.detail || picked.detail === current) return;
      await context.workspaceState.update(REPO_KEY, picked.detail);
      showRepoInTitle();
      provider.setList(undefined);
      void watch();
      await refresh();
    }),
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

  const tools = () => {
    const cwd = repoRoot();
    const wt = resolveBinary("wt", config().get<string>("executable", ""));
    const git = resolveBinary("git", "");
    if (!cwd || !wt || !git) {
      void vscode.window.showErrorMessage("Worktrunk needs an open git repository and the `wt` and `git` binaries.");
      return undefined;
    }
    return { cwd, wt, git };
  };

  const openCreated = async (result: SwitchResult) => {
    const uri = vscode.Uri.file(result.path);
    const mode = config().get<string>("openAfterCreate", "ask");
    const choice =
      mode === "ask"
        ? await vscode.window.showInformationMessage(
            `Worktree for ${result.branch} is ready at ${result.path}.`,
            "Open in New Window",
            "Open Here",
          )
        : mode;
    if (choice === "Open in New Window" || choice === "newWindow") {
      await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
    } else if (choice === "Open Here" || choice === "currentWindow") {
      await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
    }
  };

  const runSwitch = async (title: string, target: string, options: { create?: boolean; base?: string } = {}) => {
    const t = tools();
    if (!t) return;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        () => switchTo(t.wt, t.cwd, target, options),
      );
      log(`${result.action} ${result.branch} at ${result.path}`);
      void refresh();
      await openCreated(result);
    } catch (error) {
      log((error as Error).message);
      void vscode.window.showErrorMessage((error as Error).message);
    }
  };

  const pickBranch = async (branches: string[]): Promise<{ name: string; isNew: boolean } | undefined> => {
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { branch?: string }>();
    picker.title = "New worktree";
    picker.placeholder = "Type a new branch name, or pick an existing branch";
    const existing = branches.map((b) => ({ label: b, description: "existing branch", branch: b }));
    const render = () => {
      const typed = picker.value.trim();
      const exact = branches.includes(typed);
      picker.items = typed && !exact ? [{ label: `$(add) Create branch ${typed}`, alwaysShow: true }, ...existing] : existing;
    };
    picker.onDidChangeValue(render);
    render();
    return new Promise((resolve) => {
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        const typed = picker.value.trim();
        resolve(selected?.branch ? { name: selected.branch, isNew: false } : typed ? { name: typed, isNew: true } : undefined);
        picker.hide();
      });
      picker.onDidHide(() => {
        resolve(undefined);
        picker.dispose();
      });
      picker.show();
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("worktrunk.create", async () => {
      const t = tools();
      if (!t) return;
      const taken = new Set(provider.worktrees().map((w) => w.item.branch).filter(Boolean));
      let branches: string[];
      try {
        branches = (await localBranches(t.git, t.cwd)).filter((b) => !taken.has(b));
      } catch (error) {
        void vscode.window.showErrorMessage((error as Error).message);
        return;
      }
      const choice = await pickBranch(branches);
      if (!choice) return;
      if (!choice.isNew) {
        await runSwitch(`Creating a worktree for ${choice.name}…`, choice.name);
        return;
      }
      const defaultBranch = provider.current()?.repo.default_branch;
      const bases = [...new Set([defaultBranch, ...branches, ...taken].filter((b): b is string => !!b))];
      const base = await vscode.window.showQuickPick(
        bases.map((b) => ({ label: b, description: b === defaultBranch ? "default branch" : undefined })),
        { title: `Branch ${choice.name} from`, placeHolder: defaultBranch },
      );
      if (!base) return;
      await runSwitch(`Creating ${choice.name} from ${base.label}…`, choice.name, { create: true, base: base.label });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("worktrunk.checkoutPr", async () => {
      const t = tools();
      const gh = resolveBinary("gh", "");
      if (!t) return;
      if (!gh) {
        void vscode.window.showErrorMessage("Checking out a pull request needs the GitHub CLI (`gh`), logged in.");
        return;
      }
      const checkedOut = new Map(
        provider
          .worktrees()
          .filter((w) => w.pr && w.item.branch)
          .map((w) => [w.pr!.number, w.item.worktree.path]),
      );
      const pulls = Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading pull requests…" }, () =>
          openPullRequests(gh, t.cwd),
        ),
      );
      pulls.catch((error: Error) => {
        log(error.message);
        void vscode.window.showErrorMessage(error.message);
      });
      const picked = await vscode.window.showQuickPick(
        pulls.then(
          (list) =>
            list.map((pr) => ({
              label: `#${pr.number} ${pr.title}`,
              description: [pr.isDraft && "draft", pr.author.login, pr.headRefName].filter(Boolean).join(" · "),
              detail: checkedOut.has(pr.number) ? `$(check) already in ${checkedOut.get(pr.number)}` : undefined,
              pr,
            })),
          () => [],
        ),
        { title: "Check out a pull request into its own worktree", matchOnDescription: true },
      );
      if (!picked) return;
      await runSwitch(`Checking out #${picked.pr.number}…`, `pr:${picked.pr.number}`);
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
      showRepoInTitle();
      void watch();
      void refresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - lastRefresh > FOCUS_REFRESH_MIN_GAP_MS) void refresh();
    }),
  );

  showRepoInTitle();
  schedule();
  void watch();
  void refresh();
}

export function deactivate(): void {}
