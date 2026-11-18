import * as assert from "node:assert/strict";
import { describe as suite, test } from "node:test";
import { age, compact, describe, groupOf, isRemovable, prBadge, withPr, worktreeLabel } from "../format";
import type { WorktreeItem } from "../worktrunk";

const NOW = Date.parse("2026-01-10T12:00:00Z");

function item(overrides: {
  branch?: string | null;
  state?: string;
  worktree?: Partial<WorktreeItem["worktree"]>;
  default_branch?: WorktreeItem["default_branch"];
  upstream?: WorktreeItem["upstream"];
  pr?: WorktreeItem["pr"];
}): WorktreeItem {
  return {
    branch: overrides.branch === undefined ? "alice/fix-login" : overrides.branch,
    head: { sha: "a".repeat(40), short_sha: "aaaaaaa", subject: "fix: log in", committed_at: "2026-01-10T10:00:00Z" },
    worktree: {
      path: "/work/app.fix-login",
      main: false,
      current: false,
      detached: false,
      locked: null,
      prunable: null,
      ...overrides.worktree,
    },
    default_branch: overrides.default_branch,
    upstream: overrides.upstream,
    pr: overrides.pr,
    display: { state: overrides.state },
  };
}

suite("compact", () => {
  test("keeps small numbers as they are", () => assert.equal(compact(999), "999"));
  test("abbreviates thousands", () => assert.equal(compact(1000), "1K"));
  test("keeps one decimal when it matters", () => assert.equal(compact(1540), "1.5K"));
});

suite("age", () => {
  test("is empty without a date", () => assert.equal(age(undefined, NOW), ""));
  test("uses minutes under an hour", () => assert.equal(age("2026-01-10T11:45:00Z", NOW), "15m"));
  test("uses hours under a day", () => assert.equal(age("2026-01-10T10:00:00Z", NOW), "2h"));
  test("uses days under two weeks", () => assert.equal(age("2026-01-07T12:00:00Z", NOW), "3d"));
  test("uses weeks under two months", () => assert.equal(age("2025-12-20T12:00:00Z", NOW), "3w"));
  test("uses months beyond", () => assert.equal(age("2025-09-10T12:00:00Z", NOW), "4mo"));
});

suite("groupOf", () => {
  test("puts a missing folder in prunable first", () =>
    assert.equal(groupOf(item({ state: "integrated", worktree: { prunable: { reason: "gone" } } })), "prunable"));
  test("puts an integrated branch in merged", () => assert.equal(groupOf(item({ state: "integrated" })), "merged"));
  test("puts an empty branch in merged", () => assert.equal(groupOf(item({ state: "empty" })), "merged"));
  test("never puts the main worktree in merged", () =>
    assert.equal(groupOf(item({ state: "empty", worktree: { main: true } })), "active"));
  test("puts a detached checkout in detached", () =>
    assert.equal(groupOf(item({ branch: null, state: "diverged", worktree: { detached: true } })), "detached"));
  test("puts a branch with work in active", () => assert.equal(groupOf(item({ state: "ahead" })), "active"));
});

suite("isRemovable", () => {
  test("allows an ordinary worktree", () => assert.equal(isRemovable(item({})), true));
  test("refuses the main worktree", () => assert.equal(isRemovable(item({ worktree: { main: true } })), false));
  test("refuses the worktree this window has open", () => assert.equal(isRemovable(item({ worktree: { current: true } })), false));
  test("refuses a locked worktree", () => assert.equal(isRemovable(item({ worktree: { locked: { reason: "busy" } } })), false));
  test("refuses a prunable worktree", () => assert.equal(isRemovable(item({ worktree: { prunable: {} } })), false));
});

suite("worktreeLabel", () => {
  test("drops the branch prefix when asked", () => assert.equal(worktreeLabel(item({}), true), "fix-login"));
  test("keeps the full branch otherwise", () => assert.equal(worktreeLabel(item({}), false), "alice/fix-login"));
  test("uses the folder name of a detached checkout", () =>
    assert.equal(worktreeLabel(item({ branch: null, worktree: { detached: true, path: "/work/pr-42" } }), true), "pr-42"));
});

suite("prBadge", () => {
  test("shows only the number of an open PR", () => assert.equal(prBadge({ number: 7, url: "u", state: "open" }), "#7"));
  test("names a merged PR", () => assert.equal(prBadge({ number: 7, url: "u", state: "merged" }), "#7 merged"));
});

suite("describe", () => {
  test("lists PR, changes, divergence, remote and age", () => {
    const row = withPr(
      item({
        worktree: {
          changes: { staged: false, modified: true, untracked: false, conflicted: false, diff: { added: 1200, deleted: 30 } },
        },
        default_branch: { ahead: 3, behind: 1, diff: { added: 0, deleted: 0 }, orphan: false, merge_conflicts: false },
        upstream: { remote: "origin", branch: "alice/fix-login", ahead: 2, behind: 0 },
        pr: { number: 12, url: "https://example.test/pull/12" },
      }),
      () => undefined,
    );
    assert.equal(describe(row, NOW), "#12  ✎ +1.2K −30  ↑3 ↓1  ⇡2  2h");
  });

  test("shows the commit of a detached checkout and its looked-up PR", () => {
    const row = withPr(item({ branch: null, worktree: { detached: true } }), () => ({
      number: 40,
      url: "https://example.test/pull/40",
      state: "merged",
    }));
    assert.equal(describe(row, NOW), "#40 merged  @aaaaaaa  2h");
  });
});
