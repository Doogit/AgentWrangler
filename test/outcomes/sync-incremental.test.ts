/**
 * test/outcomes/sync-incremental.test.ts — P0-U13 outcomes-sync stage.
 *
 * Independent oracle: a stub GithubClient that COUNTS listPRs / getCheckConclusion
 * calls, and expected work_items / work_item_branch_keys rows that are
 * hand-computed from the stub GitHub state (never read back from the code under
 * test). Synthetic owner/repo only.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";
import type { GhPR, GhResult, GithubClient } from "../../src/outcomes/github/client.js";
import { syncWorkItems } from "../../src/outcomes/sync.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

type StubPR = GhPR & { updated_at?: string };

class CountingClient implements GithubClient {
  readonly enabled = true;
  prs: StubPR[] = [];
  /** head sha → conclusion; a missing entry or "FAIL" → {ok:false}. */
  checks = new Map<string, string>();
  listCalls = 0;
  checkRefs: string[] = [];

  async listPRs(): Promise<GhResult<GhPR[]>> {
    this.listCalls++;
    return { ok: true, data: this.prs.map((pr) => ({ ...pr, head: { ...pr.head } })) };
  }
  async getCheckConclusion(_o: string, _r: string, ref: string): Promise<GhResult<string>> {
    this.checkRefs.push(ref);
    const c = this.checks.get(ref);
    if (c === "DENY") return { ok: false, reason: "github-checks-error:403" };
    if (c === undefined || c === "FAIL") return { ok: false, reason: "github-checks-error:500" };
    return { ok: true, data: c };
  }
  resetCounts(): void {
    this.listCalls = 0;
    this.checkRefs = [];
  }
  async getPRHeadKey(): Promise<GhResult<string | null>> {
    throw new Error("unexpected getPRHeadKey");
  }
  async listPRCommits(): Promise<GhResult<{ sha: string; message: string }[]>> {
    throw new Error("unexpected listPRCommits");
  }
  async listPullsForCommit(): Promise<GhResult<number[]>> {
    throw new Error("unexpected listPullsForCommit");
  }
  async getPRBody(): Promise<GhResult<string>> {
    throw new Error("unexpected getPRBody");
  }
  async getPRDiff(): Promise<GhResult<string>> {
    throw new Error("unexpected getPRDiff");
  }
  async getReviewThreads(): Promise<GhResult<{ id: string; isResolved: boolean }[]>> {
    throw new Error("unexpected getReviewThreads");
  }
}

const WS = { workspace_id: "ws-alpha", repo_owner: "acme", repo_name: "repo-alpha" };
const WM_KEY = "gh_watermark:acme/repo-alpha";

function merged(n: number, updatedAt: string): StubPR {
  return {
    number: n,
    state: "closed",
    merged_at: "2026-08-01T00:00:00Z",
    closed_at: "2026-08-01T00:00:00Z",
    created_at: "2026-07-28T00:00:00Z",
    merge_commit_sha: `merge-${n}`,
    head: { sha: `head-${n}`, refKey: fingerprintBranchRef(`feature/pr-${n}`) },
    updated_at: updatedAt,
  };
}

function closedUnmerged(n: number, updatedAt: string): StubPR {
  return {
    number: n,
    state: "closed",
    merged_at: null,
    closed_at: "2026-08-02T00:00:00Z",
    created_at: "2026-07-29T00:00:00Z",
    merge_commit_sha: null,
    head: { sha: `head-${n}`, refKey: fingerprintBranchRef(`feature/pr-${n}`) },
    updated_at: updatedAt,
  };
}

function open(n: number, updatedAt: string): StubPR {
  return {
    number: n,
    state: "open",
    merged_at: null,
    closed_at: null,
    created_at: "2026-07-30T00:00:00Z",
    merge_commit_sha: null,
    head: { sha: `head-${n}`, refKey: fingerprintBranchRef(`feature/pr-${n}`) },
    updated_at: updatedAt,
  };
}

let db: Database.Database;
let client: CountingClient;

function setClock(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function workItems(): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT work_item_id, workspace_id, number, state, final_commit, checks_conclusion,
              opened_at, merged_at, closed_at, synced_at
         FROM work_items ORDER BY number`,
    )
    .all() as Array<Record<string, unknown>>;
}

function branchKeys(): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT work_item_id, head_ref_key, normalization_version, synced_at
         FROM work_item_branch_keys ORDER BY work_item_id`,
    )
    .all() as Array<Record<string, unknown>>;
}

function watermark(): string | undefined {
  return (
    db.prepare("SELECT value FROM user_config WHERE key = ?").get(WM_KEY) as
      | { value: string }
      | undefined
  )?.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  db = createInMemoryFixtureDb();
  db.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
  client = new CountingClient();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("syncWorkItems — incremental (P0-U13)", () => {
  it("(a) a second pass with no PR changes makes ≤1 list call and zero check calls", async () => {
    client.prs = [merged(1, "2026-08-01T00:00:00Z"), merged(2, "2026-08-03T00:00:00Z")];
    client.checks.set("head-1", "SUCCESS").set("head-2", "FAILURE");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs).toHaveLength(2);

    client.resetCounts();
    setClock("2026-09-01T00:10:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.listCalls).toBeLessThanOrEqual(1);
    expect(client.checkRefs).toEqual([]);
  });

  it("(b) a PR whose head SHA or updated_at changed gets exactly one check call", async () => {
    client.prs = [
      merged(1, "2026-08-01T00:00:00Z"),
      merged(2, "2026-08-02T00:00:00Z"),
      closedUnmerged(3, "2026-08-03T00:00:00Z"),
      merged(4, "2026-08-04T00:00:00Z"),
    ];
    for (const n of [1, 2, 3, 4]) client.checks.set(`head-${n}`, "SUCCESS");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);

    // PR 2: only updated_at moves (e.g. a post-merge comment).
    // PR 3: reopened-and-closed on a new head.
    const pr3 = closedUnmerged(3, "2026-08-20T00:00:00Z");
    pr3.head = { ...pr3.head, sha: "head-3b" };
    client.prs = [
      merged(1, "2026-08-01T00:00:00Z"),
      merged(2, "2026-08-21T00:00:00Z"),
      pr3,
      merged(4, "2026-08-04T00:00:00Z"),
    ];
    client.checks.set("head-3b", "FAILURE");
    client.resetCounts();
    setClock("2026-09-01T00:10:00.000Z");
    await syncWorkItems(db, client, WS);

    expect([...client.checkRefs].sort()).toEqual(["head-2", "head-3b"]);
  });

  it("(c) terminal PRs with a stored terminal checks_conclusion are never re-fetched", async () => {
    client.prs = [
      merged(1, "2026-08-01T00:00:00Z"),
      merged(2, "2026-08-02T00:00:00Z"),
      closedUnmerged(3, "2026-08-03T00:00:00Z"),
    ];
    client.checks.set("head-1", "SUCCESS").set("head-2", "FAILURE").set("head-3", "NONE");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);

    for (const t of ["2026-09-01T00:10:00.000Z", "2026-09-01T00:20:00.000Z"]) {
      client.resetCounts();
      setClock(t);
      await syncWorkItems(db, client, WS);
      expect(client.checkRefs).toEqual([]);
    }
  });

  it("(d) the watermark advances only after a successful sync; a failed check read stays retryable", async () => {
    client.prs = [merged(1, "2026-08-01T00:00:00Z")];
    client.checks.set("head-1", "SUCCESS");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);
    const wm1 = watermark();
    expect(wm1).toBe("2026-08-01T00:00:00Z");

    // Pass 2: a new PR appears but its check read fails.
    client.prs = [merged(2, "2026-08-10T00:00:00Z"), merged(1, "2026-08-01T00:00:00Z")];
    client.resetCounts();
    setClock("2026-09-01T00:10:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs).toEqual(["head-2"]);
    expect(watermark()).toBe(wm1);
    expect(workItems().map((r) => r.number)).toEqual([1]);

    // Pass 3: the read succeeds — PR 2 is retried and the watermark advances to
    // its updated_at.
    client.checks.set("head-2", "SUCCESS");
    client.resetCounts();
    setClock("2026-09-01T00:20:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs).toEqual(["head-2"]);
    expect(watermark()).toBe("2026-08-10T00:00:00Z");
    expect(workItems().map((r) => r.number)).toEqual([1, 2]);
  });

  it("(e) work_items + branch-key rows equal the hand-computed pre-change projection", async () => {
    const T1 = "2026-09-01T00:00:00.000Z";
    const T2 = "2026-09-01T00:10:00.000Z";
    const key = (n: number) => fingerprintBranchRef(`feature/pr-${n}`);
    const pr4 = open(4, "2026-08-05T00:00:00Z");
    pr4.head = { sha: "head-4", refKey: null };
    client.prs = [
      merged(1, "2026-08-01T00:00:00Z"),
      closedUnmerged(2, "2026-08-02T00:00:00Z"),
      open(3, "2026-08-04T00:00:00Z"),
      pr4,
    ];
    client.checks
      .set("head-1", "SUCCESS")
      .set("head-2", "NONE")
      .set("head-3", "PENDING")
      .set("head-4", "SUCCESS");
    setClock(T1);
    await syncWorkItems(db, client, WS);

    const row = (
      n: number,
      state: string,
      finalCommit: string,
      checks: string,
      openedAt: string,
      mergedAt: string | null,
      closedAt: string | null,
      syncedAt: string,
    ) => ({
      work_item_id: `gh:acme/repo-alpha#${n}`,
      workspace_id: "ws-alpha",
      number: n,
      state,
      final_commit: finalCommit,
      checks_conclusion: checks,
      opened_at: openedAt,
      merged_at: mergedAt,
      closed_at: closedAt,
      synced_at: syncedAt,
    });
    const bk = (n: number, syncedAt: string) => ({
      work_item_id: `gh:acme/repo-alpha#${n}`,
      head_ref_key: key(n),
      normalization_version: "branch-v1",
      synced_at: syncedAt,
    });

    expect(workItems()).toEqual([
      row(
        1,
        "MERGED",
        "merge-1",
        "SUCCESS",
        "2026-07-28T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        T1,
      ),
      row(2, "CLOSED", "head-2", "NONE", "2026-07-29T00:00:00Z", null, "2026-08-02T00:00:00Z", T1),
      row(3, "OPEN", "head-3", "PENDING", "2026-07-30T00:00:00Z", null, null, T1),
      row(4, "OPEN", "head-4", "SUCCESS", "2026-07-30T00:00:00Z", null, null, T1),
    ]);
    expect(branchKeys()).toEqual([bk(1, T1), bk(2, T1), bk(3, T1)]);

    // Pass 2 on changed state: PR 3 merges (checks resolve), PR 4 pushes a new
    // head whose checks read fails (COALESCE / failed-read semantics: the row
    // keeps its old projection), PR 5 is new, PRs 1-2 are unchanged.
    const pr3m: StubPR = {
      ...open(3, "2026-08-25T00:00:00Z"),
      state: "closed",
      merged_at: "2026-08-25T00:00:00Z",
      closed_at: "2026-08-25T00:00:00Z",
      merge_commit_sha: "merge-3",
    };
    const pr4b = open(4, "2026-08-26T00:00:00Z");
    pr4b.head = { sha: "head-4b", refKey: key(4) };
    client.prs = [
      merged(5, "2026-08-27T00:00:00Z"),
      pr4b,
      pr3m,
      closedUnmerged(2, "2026-08-02T00:00:00Z"),
      merged(1, "2026-08-01T00:00:00Z"),
    ];
    client.checks.set("head-3", "SUCCESS").set("head-4b", "FAIL").set("head-5", "FAILURE");
    setClock(T2);
    await syncWorkItems(db, client, WS);

    expect(workItems()).toEqual([
      // Unchanged terminal rows are not rewritten (synced_at stays T1).
      row(
        1,
        "MERGED",
        "merge-1",
        "SUCCESS",
        "2026-07-28T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        T1,
      ),
      row(2, "CLOSED", "head-2", "NONE", "2026-07-29T00:00:00Z", null, "2026-08-02T00:00:00Z", T1),
      row(
        3,
        "MERGED",
        "merge-3",
        "SUCCESS",
        "2026-07-30T00:00:00Z",
        "2026-08-25T00:00:00Z",
        "2026-08-25T00:00:00Z",
        T2,
      ),
      row(4, "OPEN", "head-4", "SUCCESS", "2026-07-30T00:00:00Z", null, null, T1),
      row(
        5,
        "MERGED",
        "merge-5",
        "FAILURE",
        "2026-07-28T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        T2,
      ),
    ]);
    expect(branchKeys()).toEqual([bk(1, T1), bk(2, T1), bk(3, T2), bk(5, T2)]);
  });

  it("(g) a repo whose check reads are denied (403) stops issuing check reads for the rest of the pass", async () => {
    // Measured cause: repos where the token cannot read check-runs 403 on every
    // PR, every pass — the same answer 100 times per repo.
    client.prs = Array.from({ length: 12 }, (_, i) => merged(i + 1, "2026-08-01T00:00:00Z"));
    for (let i = 1; i <= 12; i++) client.checks.set(`head-${i}`, "DENY");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs.length).toBeLessThanOrEqual(4);
    expect(workItems()).toEqual([]);
    expect(watermark()).toBeUndefined();

    // Still retryable next pass (bounded again), and lands once readable.
    client.resetCounts();
    setClock("2026-09-01T00:10:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs.length).toBeLessThanOrEqual(4);
    for (let i = 1; i <= 12; i++) client.checks.set(`head-${i}`, "SUCCESS");
    client.resetCounts();
    setClock("2026-09-01T00:20:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs).toHaveLength(12);
    expect(workItems()).toHaveLength(12);
  });

  it("(g2) a non-access check failure (500) does not stop the other PRs' reads", async () => {
    client.prs = Array.from({ length: 6 }, (_, i) => merged(i + 1, "2026-08-01T00:00:00Z"));
    for (let i = 1; i <= 6; i++) client.checks.set(`head-${i}`, "SUCCESS");
    client.checks.set("head-1", "FAIL");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);
    expect(client.checkRefs).toHaveLength(6);
    expect(workItems().map((r) => r.number)).toEqual([2, 3, 4, 5, 6]);
  });

  it("(f) a stored non-terminal conclusion is re-checked on the next pass with an unchanged head", async () => {
    client.prs = [
      merged(1, "2026-08-01T00:00:00Z"),
      open(2, "2026-08-02T00:00:00Z"),
      open(3, "2026-08-03T00:00:00Z"),
    ];
    client.checks.set("head-1", "PENDING").set("head-2", "PENDING").set("head-3", "SUCCESS");
    setClock("2026-09-01T00:00:00.000Z");
    await syncWorkItems(db, client, WS);

    client.checks.set("head-1", "SUCCESS").set("head-2", "SUCCESS");
    client.resetCounts();
    setClock("2026-09-01T00:10:00.000Z");
    await syncWorkItems(db, client, WS);

    // PENDING rows are re-read; an OPEN PR is always re-read (checks can be
    // re-run on the same head without bumping the PR's updated_at).
    expect([...client.checkRefs].sort()).toEqual(["head-1", "head-2", "head-3"]);
    expect(workItems().map((r) => r.checks_conclusion)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
  });
});
