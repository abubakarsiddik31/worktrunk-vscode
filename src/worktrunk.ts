import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type ChecksStatus = "passed" | "failed" | "running" | "pending" | "skipped" | "unknown" | string;

export interface PullRequest {
  number: number;
  url: string;
  title?: string;
  review?: string | null;
  state?: "open" | "merged" | "closed";
}

export interface WorktreeItem {
  branch: string | null;
  head: { sha: string; short_sha: string; subject: string; committed_at: string };
  worktree: {
    path: string;
    main: boolean;
    current: boolean;
    detached: boolean;
    locked: { reason?: string } | null;
    prunable: { reason?: string } | null;
    changes?: {
      staged: boolean;
      modified: boolean;
      untracked: boolean;
      conflicted: boolean;
      diff: { added: number; deleted: number };
    };
  };
  default_branch?: {
    ahead: number;
    behind: number;
    diff: { added: number; deleted: number };
    orphan: boolean;
    merge_conflicts: boolean;
  };
  upstream?: { remote: string; branch: string; ahead: number; behind: number } | null;
  pr?: PullRequest | null;
  checks?: { status: ChecksStatus; stale?: boolean } | null;
  display: { state?: string | null; symbols?: string };
}

export interface WorktreeList {
  repo: {
    default_branch: string;
    forge?: { provider: string; owner: string; name: string; url: string } | null;
  };
  items: WorktreeItem[];
}

const LOCAL_TIMEOUT_MS = 30_000;
const FULL_TIMEOUT_MS = 90_000;
const GH_TIMEOUT_MS = 15_000;
const SWITCH_TIMEOUT_MS = 5 * 60_000;
const MAX_BRANCHES = 500;
const MAX_OPEN_PRS = 100;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PR_LOOKUPS = 40;
const PR_LOOKUP_CONCURRENCY = 4;

const EXTRA_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".cargo", "bin")];

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [process.env.PATH ?? "", ...EXTRA_PATH_DIRS].filter(Boolean).join(delimiter),
  NO_COLOR: "1",
  CLICOLOR_FORCE: "0",
};

export function resolveBinary(name: string, configured: string): string | undefined {
  if (configured) {
    return existsSync(configured) ? configured : undefined;
  }
  const dirs = (childEnv.PATH ?? "").split(delimiter);
  return dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
}

export class CommandError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

function run(binary: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, env: childEnv }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new CommandError(`${binary} ${args.join(" ")} failed: ${detail}`, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function listWorktrees(wt: string, cwd: string, full: boolean): Promise<WorktreeList> {
  const args = ["list", "--format=json", ...(full ? ["--full"] : [])];
  const stdout = await run(wt, args, cwd, full ? FULL_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  return JSON.parse(stdout) as WorktreeList;
}

export interface SwitchResult {
  action: string;
  branch: string;
  path: string;
}

export async function switchTo(
  wt: string,
  cwd: string,
  target: string,
  options: { create?: boolean; base?: string } = {},
): Promise<SwitchResult> {
  const args = ["switch", target, "--no-cd", "--format=json"];
  if (options.create) args.push("--create");
  if (options.base) args.push("--base", options.base);
  return JSON.parse(await run(wt, args, cwd, SWITCH_TIMEOUT_MS)) as SwitchResult;
}

export async function localBranches(git: string, cwd: string): Promise<string[]> {
  const stdout = await run(
    git,
    ["for-each-ref", "--sort=-committerdate", `--count=${MAX_BRANCHES}`, "--format=%(refname:short)", "refs/heads"],
    cwd,
    LOCAL_TIMEOUT_MS,
  );
  return stdout.split("\n").filter(Boolean);
}

export interface OpenPullRequest {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  author: { login: string };
}

export async function openPullRequests(gh: string, cwd: string): Promise<OpenPullRequest[]> {
  const stdout = await run(
    gh,
    ["pr", "list", "--state", "open", "--limit", String(MAX_OPEN_PRS), "--json", "number,title,headRefName,isDraft,author"],
    cwd,
    GH_TIMEOUT_MS,
  );
  return JSON.parse(stdout) as OpenPullRequest[];
}

export async function removeWorktree(wt: string, cwd: string, path: string): Promise<void> {
  await run(wt, ["remove", path, "--foreground"], cwd, LOCAL_TIMEOUT_MS);
}

export async function gitCommonDir(git: string, cwd: string): Promise<string> {
  const stdout = await run(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, LOCAL_TIMEOUT_MS);
  return stdout.trim();
}

export async function pruneWorktrees(git: string, cwd: string): Promise<void> {
  await run(git, ["worktree", "prune"], cwd, LOCAL_TIMEOUT_MS);
}

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged_at: string | null;
}

export class PullRequestFinder {
  private readonly bySha = new Map<string, PullRequest | null>();

  constructor(private readonly gh: string) {}

  cached(sha: string): PullRequest | null | undefined {
    return this.bySha.get(sha);
  }

  async findAll(owner: string, name: string, shas: string[], cwd: string, onError: (error: Error) => void): Promise<void> {
    const pending = [...new Set(shas)].filter((sha) => !this.bySha.has(sha)).slice(0, MAX_PR_LOOKUPS);
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const sha = pending[next++];
        try {
          this.bySha.set(sha, await this.lookup(owner, name, sha, cwd));
        } catch (error) {
          onError(error as Error);
        }
      }
    };
    await Promise.all(Array.from({ length: PR_LOOKUP_CONCURRENCY }, worker));
  }

  private async lookup(owner: string, name: string, sha: string, cwd: string): Promise<PullRequest | null> {
    let stdout: string;
    try {
      stdout = await run(this.gh, ["api", `repos/${owner}/${name}/commits/${sha}/pulls`], cwd, GH_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CommandError && error.stderr.includes("No commit found")) {
        return null;
      }
      throw error;
    }
    const pulls = JSON.parse(stdout) as GhPull[];
    const pull = pulls.find((p) => p.state === "open") ?? pulls[0];
    if (!pull) {
      return null;
    }
    return {
      number: pull.number,
      url: pull.html_url,
      title: pull.title,
      state: pull.state === "open" ? "open" : pull.merged_at ? "merged" : "closed",
    };
  }
}
