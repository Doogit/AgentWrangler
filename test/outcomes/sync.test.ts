/**
 * test/outcomes/sync.test.ts — syncWorkItems: upsert idempotent + disabled → 0 rows.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import type { FetchFn } from "../../src/outcomes/github/client.js";
import type { GithubClient } from "../../src/outcomes/github/client.js";
import { backfillMissingWorkItemBranchKeys, syncWorkItems } from "../../src/outcomes/sync.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function fakePR(number: number, state: "open" | "closed" | "merged" = "merged") {
  return {
    number,
    state: state === "merged" ? "closed" : state,
    merged_at: state === "merged" ? "2026-08-01T00:00:00Z" : null,
    closed_at: state === "closed" ? "2026-08-01T00:00:00Z" : null,
    created_at: "2026-07-28T00:00:00Z",
    merge_commit_sha: state === "merged" ? `sha-pr${number}` : null,
    head: { sha: `head-sha-${number}`, ref: `feature/pr-${number}` },
  };
}

function makeFetch(prs: unknown[]): FetchFn {
  return async (_input) =>
    ({
      ok: true,
      status: 200,
      json: async () => prs,
      text: async () => JSON.stringify(prs),
      headers: { get: () => null },
    }) as unknown as Response;
}

function makeChecksFetch(): FetchFn {
  return async (_input) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        check_runs: [{ conclusion: "success", status: "completed" }],
        total_count: 1,
      }),
      text: async () => "",
      headers: { get: () => null },
    }) as unknown as Response;
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  // Add repo_owner/repo_name to ws-alpha
  db.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
});

afterEach(() => {
  db.close();
});

describe("syncWorkItems", () => {
  it("disabled client → 0 work_items rows inserted", async () => {
    const client = new GithubSyncClient({ ok: false, reason: "no-token" });
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("enabled client → upserts work_items idempotently", async () => {
    const prs = [fakePR(42, "merged"), fakePR(43, "open")];
    // Combined fetch that handles both PRs and checks
    let callCount = 0;
    const fetchFn: FetchFn = async (input) => {
      callCount++;
      const url = typeof input === "string" ? input : "";
      if (url.includes("check-runs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            check_runs: [{ conclusion: "success", status: "completed" }],
            total_count: 1,
          }),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => prs,
        text: async () => JSON.stringify(prs),
        headers: { get: () => null },
      } as unknown as Response;
    };

    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });

    const rows = db.prepare("SELECT * FROM work_items ORDER BY number").all() as Array<{
      number: number;
      state: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.number).toBe(42);
    expect(rows[0]?.state).toBe("MERGED");
    expect(rows[1]?.number).toBe(43);
    expect(rows[1]?.state).toBe("OPEN");

    // Second call should be idempotent
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });
    const rows2 = db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number };
    expect(rows2.n).toBe(2);
  });

  it("atomically inserts, changes, and removes a branch key as eligibility changes", async () => {
    let listing = [fakePR(42, "open")];
    const fetchFn: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : "";
      return url.includes("check-runs") ? makeCheckResponse("success") : makeListResponse(listing);
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
    const ws = { workspace_id: "ws-alpha", repo_owner: "acme", repo_name: "repo-alpha" };

    await syncWorkItems(db, client, ws);
    expect(db.prepare("SELECT head_ref_key FROM work_item_branch_keys").get()).toEqual({
      head_ref_key: fingerprintBranchRef("feature/pr-42"),
    });

    listing = [{ ...fakePR(42, "open"), head: { sha: "changed-sha", ref: "feature/renamed" } }];
    await syncWorkItems(db, client, ws);
    expect(db.prepare("SELECT head_ref_key FROM work_item_branch_keys").get()).toEqual({
      head_ref_key: fingerprintBranchRef("feature/renamed"),
    });

    listing = [{ ...fakePR(42, "open"), head: { sha: "detached-sha", ref: "HEAD" } }];
    await syncWorkItems(db, client, ws);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_item_branch_keys").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT final_commit FROM work_items").get()).toEqual({
      final_commit: "detached-sha",
    });
  });

  it("a malformed page changes neither work items nor watermark", async () => {
    const malformed = [{ ...fakePR(42), head: { sha: "new-sha" } }];
    const client = new GithubSyncClient({ ok: true, data: "tok" }, makeFetch(malformed));
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = 'gh_watermark:acme/repo-alpha'").get(),
    ).toBeUndefined();
  });

  it("rolls back the work-item update when the paired branch-key write fails", async () => {
    let listing = [fakePR(42, "open")];
    const fetchFn: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : "";
      return url.includes("check-runs") ? makeCheckResponse("success") : makeListResponse(listing);
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
    const ws = { workspace_id: "ws-alpha", repo_owner: "acme", repo_name: "repo-alpha" };
    await syncWorkItems(db, client, ws);
    const before = db
      .prepare(
        `SELECT wi.final_commit, bk.head_ref_key
           FROM work_items wi JOIN work_item_branch_keys bk USING (work_item_id)`,
      )
      .get();

    db.exec(`CREATE TRIGGER reject_branch_key_update
      BEFORE UPDATE ON work_item_branch_keys BEGIN SELECT RAISE(ABORT, 'reject-key'); END`);
    listing = [{ ...fakePR(42, "open"), head: { sha: "new-sha", ref: "feature/new" } }];
    await expect(syncWorkItems(db, client, ws)).rejects.toThrow("reject-key");
    expect(
      db
        .prepare(
          `SELECT wi.final_commit, bk.head_ref_key
           FROM work_items wi JOIN work_item_branch_keys bk USING (work_item_id)`,
        )
        .get(),
    ).toEqual(before);
  });
});

function makeBackfillClient(
  getPRHeadKey: GithubClient["getPRHeadKey"],
  enabled = true,
): GithubClient {
  return {
    enabled,
    listPRs: async () => ({ ok: true, data: [] }),
    getPRHeadKey,
    getCheckConclusion: async () => ({ ok: true, data: "NONE" }),
    listPRCommits: async () => ({ ok: true, data: [] }),
    listPullsForCommit: async () => ({ ok: true, data: [] }),
    getPRBody: async () => ({ ok: true, data: "" }),
    getPRDiff: async () => ({ ok: true, data: "" }),
    getReviewThreads: async () => ({ ok: true, data: [] }),
  };
}

function insertHistoricalWorkItems(count: number): void {
  const insert = db.prepare(
    `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
     VALUES (?, 'ws-alpha', ?, 'CLOSED', '2026-08-01T00:00:00Z')`,
  );
  for (let number = 1; number <= count; number++) {
    insert.run(`gh:acme/repo-alpha#${number}`, number);
  }
}

describe("backfillMissingWorkItemBranchKeys", () => {
  it("reaches PRs older than the 100-row listing through resumable per-PR pages", async () => {
    insertHistoricalWorkItems(125);
    const calls: number[] = [];
    const client = makeBackfillClient(async (_owner, _repo, number) => {
      calls.push(number);
      return { ok: true, data: fingerprintBranchRef(`feature/historical-${number}`) };
    });

    const first = await backfillMissingWorkItemBranchKeys(db, client, { limit: 50 });
    expect(first).toMatchObject({ selected: 50, keyed: 50, missing: 0 });
    expect(first.nextCursor).not.toBeNull();
    const second = await backfillMissingWorkItemBranchKeys(db, client, {
      cursor: first.nextCursor,
      limit: 50,
    });
    const third = await backfillMissingWorkItemBranchKeys(db, client, {
      cursor: second.nextCursor,
      limit: 50,
    });
    expect(third).toMatchObject({ selected: 25, keyed: 25, nextCursor: null });
    expect(calls).toHaveLength(125);
    expect(calls).toContain(125);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_item_branch_keys").get()).toEqual({ n: 125 });
  });

  it("leaves failure/ineligible rows missing, retries them, and never touches existing keys", async () => {
    insertHistoricalWorkItems(4);
    const existingId = "gh:acme/repo-alpha#1";
    const existingKey = fingerprintBranchRef("feature/existing");
    db.prepare(
      `INSERT INTO work_item_branch_keys
       (work_item_id, head_ref_key, normalization_version, synced_at)
       VALUES (?, ?, 'branch-v1', '2026-08-01T00:00:00Z')`,
    ).run(existingId, existingKey);

    let retry = false;
    const calls: number[] = [];
    const client = makeBackfillClient(async (_owner, _repo, number) => {
      calls.push(number);
      if (!retry && number === 2) return { ok: false, reason: "transient" };
      if (!retry && number === 3) return { ok: true, data: null };
      return { ok: true, data: fingerprintBranchRef(`feature/retry-${number}`) };
    });

    const first = await backfillMissingWorkItemBranchKeys(db, client);
    expect(first).toMatchObject({ selected: 3, keyed: 1, failed: 1, ineligible: 1, missing: 2 });
    expect(calls).not.toContain(1);
    retry = true;
    const second = await backfillMissingWorkItemBranchKeys(db, client);
    expect(second).toMatchObject({ selected: 2, keyed: 2, missing: 0 });
    const callsBeforeNoop = calls.length;
    expect(await backfillMissingWorkItemBranchKeys(db, client)).toMatchObject({ selected: 0 });
    expect(calls).toHaveLength(callsBeforeNoop);
    expect(
      db
        .prepare("SELECT head_ref_key FROM work_item_branch_keys WHERE work_item_id = ?")
        .get(existingId),
    ).toEqual({ head_ref_key: existingKey });
  });

  it("bounds concurrency while preserving deterministic cursor traversal", async () => {
    insertHistoricalWorkItems(12);
    let inflight = 0;
    let maxInflight = 0;
    const client = makeBackfillClient(async (_owner, _repo, number) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight--;
      return { ok: true, data: fingerprintBranchRef(`feature/concurrent-${number}`) };
    });
    const first = await backfillMissingWorkItemBranchKeys(db, client, {
      limit: 7,
      concurrency: 3,
    });
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(first.nextCursor).toBe("gh:acme/repo-alpha#4");
    const second = await backfillMissingWorkItemBranchKeys(db, client, {
      cursor: first.nextCursor,
      limit: 7,
      concurrency: 3,
    });
    expect(second).toMatchObject({ selected: 5, keyed: 5, nextCursor: null });
  });

  it("excludes rows from a stale repository mapping while backfilling current canonical rows", async () => {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:old/repo#42', 'ws-alpha', 42, 'CLOSED', '2026-08-01T00:00:00Z')`,
    ).run();
    db.prepare(
      "UPDATE workspaces SET repo_owner = 'new', repo_name = 'repo' WHERE workspace_id = 'ws-alpha'",
    ).run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:new/repo#43', 'ws-alpha', 43, 'CLOSED', '2026-08-01T00:00:00Z')`,
    ).run();

    const calls: Array<{ owner: string; repo: string; number: number }> = [];
    const currentKey = fingerprintBranchRef("feature/current");
    const client = makeBackfillClient(async (owner, repo, number) => {
      calls.push({ owner, repo, number });
      return { ok: true, data: currentKey };
    });

    expect(await backfillMissingWorkItemBranchKeys(db, client)).toMatchObject({
      selected: 1,
      keyed: 1,
    });
    expect(calls).toEqual([{ owner: "new", repo: "repo", number: 43 }]);
    expect(
      db.prepare("SELECT head_ref_key FROM work_item_branch_keys ORDER BY work_item_id").all(),
    ).toEqual([{ head_ref_key: currentKey }]);
    expect(
      db
        .prepare(
          "SELECT head_ref_key FROM work_item_branch_keys WHERE work_item_id = 'gh:old/repo#42'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("bounds evidence reads to the exact allowlist and fixed as-of/synced-at clock", async () => {
    insertHistoricalWorkItems(2);
    db.prepare("UPDATE work_items SET synced_at = '2026-09-01T00:00:00Z' WHERE number = 2").run();
    db.prepare(
      "UPDATE workspaces SET repo_owner='other', repo_name='repo-beta' WHERE workspace_id='ws-beta'",
    ).run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:other/repo-beta#9', 'ws-beta', 9, 'CLOSED', '2026-08-01T00:00:00Z')`,
    ).run();
    const calls: string[] = [];
    const client = makeBackfillClient(async (owner, repo, number) => {
      calls.push(`${owner}/${repo}#${number}`);
      return { ok: true, data: fingerprintBranchRef(`feature/${number}`) };
    });
    const checkpoints: unknown[] = [];

    const result = await backfillMissingWorkItemBranchKeys(db, client, {
      evidence: {
        repositories: [{ workspaceId: "ws-alpha", owner: "acme", repo: "repo-alpha" }],
        asOf: "2026-08-15T00:00:00Z",
        syncedAt: "2026-08-26T12:00:00Z",
        onPageCheckpoint: (checkpoint) => {
          checkpoints.push({
            checkpoint,
            rows: db.prepare("SELECT work_item_id, synced_at FROM work_item_branch_keys").all(),
          });
        },
      },
    });

    expect(calls).toEqual(["acme/repo-alpha#1"]);
    expect(result).toMatchObject({
      selected: 1,
      keyed: 1,
      classifications: { KEYED: 1, INELIGIBLE: 0, FETCH_FAILED: 0 },
      failureReasonCounts: { GITHUB_READ_FAILED: 0, GITHUB_READ_THREW: 0 },
    });
    expect(checkpoints).toEqual([
      {
        checkpoint: {
          afterWorkItemId: "gh:acme/repo-alpha#2",
          scanned: 2,
          selected: 1,
          keyed: 1,
          ineligible: 0,
          failed: 0,
        },
        rows: [{ work_item_id: "gh:acme/repo-alpha#1", synced_at: "2026-08-26T12:00:00Z" }],
      },
    ]);
  });

  it("refuses an allowlist mismatch before any GitHub read", async () => {
    insertHistoricalWorkItems(1);
    let calls = 0;
    const client = makeBackfillClient(async () => {
      calls += 1;
      return { ok: true, data: fingerprintBranchRef("feature/never") };
    });

    await expect(
      backfillMissingWorkItemBranchKeys(db, client, {
        evidence: {
          repositories: [{ workspaceId: "ws-alpha", owner: "wrong", repo: "repo-alpha" }],
          asOf: "2026-08-26T00:00:00Z",
          syncedAt: "2026-08-26T00:00:00Z",
        },
      }),
    ).rejects.toThrow("branch_backfill_allowlist_mismatch");
    expect(calls).toBe(0);
  });

  it("classifies ineligible and failed reads, then resume-from-start retries missing keys", async () => {
    insertHistoricalWorkItems(3);
    let retry = false;
    const calls: number[] = [];
    const client = makeBackfillClient(async (_owner, _repo, number) => {
      calls.push(number);
      if (!retry && number === 1) {
        return {
          ok: false,
          reason: "failed at C:/private/transcript.jsonl https://example.invalid secret detail",
        };
      }
      if (number === 2) return { ok: true, data: null };
      return { ok: true, data: fingerprintBranchRef(`feature/${number}`) };
    });
    const evidence = {
      repositories: [{ workspaceId: "ws-alpha", owner: "acme", repo: "repo-alpha" }],
      asOf: "2026-08-26T23:59:59Z",
      syncedAt: "2026-08-26T12:00:00Z",
    } as const;

    const first = await backfillMissingWorkItemBranchKeys(db, client, {
      limit: 2,
      evidence,
    });
    expect(first).toMatchObject({
      selected: 2,
      keyed: 0,
      ineligible: 1,
      failed: 1,
      classifications: { KEYED: 0, INELIGIBLE: 1, FETCH_FAILED: 1 },
      failureReasonCounts: { GITHUB_READ_FAILED: 1, GITHUB_READ_THREW: 0 },
    });
    expect(JSON.stringify(first)).not.toContain("C:/private");
    expect(JSON.stringify(first)).not.toContain("example.invalid");
    expect(JSON.stringify(first)).not.toContain("secret detail");
    retry = true;
    const resumed = await backfillMissingWorkItemBranchKeys(db, client, {
      limit: 3,
      cursor: first.nextCursor,
      evidence: { ...evidence, resumeFromStart: true },
    });
    expect(resumed).toMatchObject({
      selected: 3,
      keyed: 2,
      ineligible: 1,
      failed: 0,
      classifications: { KEYED: 2, INELIGIBLE: 1, FETCH_FAILED: 0 },
    });
    expect(calls.filter((number) => number === 1)).toHaveLength(2);
    expect(
      db.prepare("SELECT work_item_id FROM work_item_branch_keys ORDER BY work_item_id").all(),
    ).toEqual([{ work_item_id: "gh:acme/repo-alpha#1" }, { work_item_id: "gh:acme/repo-alpha#3" }]);
  });

  it("compares strict UTC evidence timestamps without losing millisecond precision", async () => {
    insertHistoricalWorkItems(2);
    db.prepare(
      `UPDATE work_items
          SET synced_at = CASE number
            WHEN 1 THEN '2026-08-26T12:00:00.100Z'
            ELSE '2026-08-26T12:00:00.999Z'
          END`,
    ).run();
    const calls: number[] = [];
    const client = makeBackfillClient(async (_owner, _repo, number) => {
      calls.push(number);
      return { ok: true, data: fingerprintBranchRef(`feature/${number}`) };
    });

    const result = await backfillMissingWorkItemBranchKeys(db, client, {
      evidence: {
        repositories: [{ workspaceId: "ws-alpha", owner: "acme", repo: "repo-alpha" }],
        asOf: "2026-08-26T12:00:00.500Z",
        syncedAt: "2026-08-26T12:00:00.500Z",
      },
    });

    expect(calls).toEqual([1]);
    expect(result).toMatchObject({ selected: 1, keyed: 1 });
  });

  it("rejects non-UTC or invalid evidence timestamps before any GitHub read", async () => {
    insertHistoricalWorkItems(1);
    let calls = 0;
    const client = makeBackfillClient(async () => {
      calls += 1;
      return { ok: true, data: fingerprintBranchRef("feature/never") };
    });
    const repository = { workspaceId: "ws-alpha", owner: "acme", repo: "repo-alpha" };

    for (const evidence of [
      {
        repositories: [repository],
        asOf: "2026-08-26T12:00:00-07:00",
        syncedAt: "2026-08-26T12:00:00Z",
      },
      {
        repositories: [repository],
        asOf: "2026-02-30T12:00:00Z",
        syncedAt: "2026-08-26T12:00:00Z",
      },
      {
        repositories: [repository],
        asOf: "2026-08-26T12:00:00Z",
        syncedAt: "2026-08-26 12:00:00Z",
      },
    ]) {
      await expect(backfillMissingWorkItemBranchKeys(db, client, { evidence })).rejects.toThrow(
        /branch_backfill_(as_of|synced_at)_invalid/u,
      );
    }
    expect(calls).toBe(0);
  });

  it("bounds keyset rows scanned per evidence page across future rows and resume", async () => {
    insertHistoricalWorkItems(1200);
    db.prepare("UPDATE work_items SET synced_at = '2026-09-01T00:00:00.999Z'").run();
    let githubCalls = 0;
    const client = makeBackfillClient(async () => {
      githubCalls += 1;
      return { ok: true, data: fingerprintBranchRef("feature/never") };
    });
    const checkpoints: Array<{ afterWorkItemId: string | null; scanned: number }> = [];
    const evidence = {
      repositories: [{ workspaceId: "ws-alpha", owner: "acme", repo: "repo-alpha" }],
      asOf: "2026-08-26T23:59:59.999Z",
      syncedAt: "2026-08-26T23:59:59.999Z",
      onPageCheckpoint: (checkpoint: { afterWorkItemId: string | null; scanned: number }) => {
        checkpoints.push({
          afterWorkItemId: checkpoint.afterWorkItemId,
          scanned: checkpoint.scanned,
        });
      },
    };

    const first = await backfillMissingWorkItemBranchKeys(db, client, {
      limit: 50,
      evidence,
    });
    expect(first).toMatchObject({ selected: 0, scanned: 256 });
    expect(first.nextCursor).not.toBeNull();
    const resumed = await backfillMissingWorkItemBranchKeys(db, client, {
      cursor: first.nextCursor,
      limit: 50,
      evidence: { ...evidence, resumeFromStart: true },
    });
    expect(resumed).toMatchObject({
      selected: 0,
      scanned: 256,
      nextCursor: first.nextCursor,
    });
    const continued = await backfillMissingWorkItemBranchKeys(db, client, {
      cursor: first.nextCursor,
      limit: 50,
      evidence,
    });
    expect(continued).toMatchObject({ selected: 0, scanned: 256 });
    expect(continued.nextCursor).not.toBe(first.nextCursor);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.every(({ scanned }) => scanned <= 256)).toBe(true);
    expect(githubCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded concurrency (perf: pooled getCheckConclusion across the PR page)
// ---------------------------------------------------------------------------

function makeCheckResponse(conclusion: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      check_runs: [{ conclusion, status: "completed" }],
      total_count: 1,
    }),
    text: async () => "",
    headers: { get: () => null },
  } as unknown as Response;
}

function makeListResponse(prs: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => prs,
    text: async () => JSON.stringify(prs),
    headers: { get: () => null },
  } as unknown as Response;
}

describe("syncWorkItems — bounded concurrency", () => {
  it("pools check-conclusion calls (overlapping, in-flight ≤ 4) with serial-identical rows", async () => {
    const prs = Array.from({ length: 8 }, (_, i) => fakePR(100 + i));
    let inflight = 0;
    let maxInflight = 0;
    const fetchFn: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("check-runs")) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        // Simulate per-call latency so the pool has room to overlap.
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
        return makeCheckResponse("success");
      }
      return makeListResponse(prs);
    };

    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });

    // Calls actually overlapped, but never more than DEFAULT_CONCURRENCY=4.
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(4);

    // Rows identical to what a serial loop would produce.
    const rows = db
      .prepare("SELECT number, state, checks_conclusion FROM work_items ORDER BY number")
      .all() as Array<{ number: number; state: string; checks_conclusion: string | null }>;
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.state).toBe("MERGED");
      expect(row.checks_conclusion).toBe("SUCCESS");
    }
  });

  it("failed check-conclusion preserves prior value; watermark advances", async () => {
    const t1 = "2026-08-01T00:00:00Z";
    const t2 = "2026-08-05T00:00:00Z";
    const pr41 = {
      number: 41,
      state: "closed",
      merged_at: t1,
      closed_at: null,
      created_at: "2026-07-28T00:00:00Z",
      merge_commit_sha: "sha-41",
      head: { sha: "head-41", ref: "feature/pr-41" },
    };
    const pr42 = {
      number: 42,
      state: "closed",
      merged_at: t2,
      closed_at: null,
      created_at: "2026-08-02T00:00:00Z",
      merge_commit_sha: "sha-42",
      head: { sha: "head-42", ref: "feature/pr-42" },
    };

    let listing: unknown[] = [pr41];
    let checksFail = false;
    const fetchFn: FetchFn = async (input) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("check-runs")) {
        if (checksFail) {
          return {
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => "",
            headers: { get: () => null },
          } as unknown as Response;
        }
        return makeCheckResponse("success");
      }
      return makeListResponse(listing);
    };

    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
    const ws = {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    };

    // Pass 1: checks succeed for PR 41.
    await syncWorkItems(db, client, ws);
    const wmKey = "gh_watermark:acme/repo-alpha";
    const wm1 = db.prepare("SELECT value FROM user_config WHERE key = ?").get(wmKey) as {
      value: string;
    };
    expect(wm1.value).toBe(t1);

    // Pass 2: every check call fails; COALESCE must preserve PR 41's value.
    listing = [pr41, pr42];
    checksFail = true;
    await syncWorkItems(db, client, ws);

    const rows = db
      .prepare("SELECT number, checks_conclusion FROM work_items ORDER BY number")
      .all() as Array<{ number: number; checks_conclusion: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.number).toBe(41);
    expect(rows[0]?.checks_conclusion).toBe("SUCCESS"); // preserved, not nulled
    expect(rows[1]?.checks_conclusion).toBeNull();

    const wm2 = db.prepare("SELECT value FROM user_config WHERE key = ?").get(wmKey) as {
      value: string;
    };
    expect(wm2.value).toBe(t2); // advanced despite failed check fetches
  });

  it("disabled client makes zero fetch calls", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async (input) => {
      calls++;
      void input;
      return makeListResponse([]);
    };
    const client = new GithubSyncClient({ ok: false, reason: "no-token" }, fetchFn);
    await syncWorkItems(db, client, {
      workspace_id: "ws-alpha",
      repo_owner: "acme",
      repo_name: "repo-alpha",
    });
    expect(calls).toBe(0);
  });
});
