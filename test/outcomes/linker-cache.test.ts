/**
 * test/outcomes/linker-cache.test.ts — P0-U13: the linker's per-PR commit/body
 * reads carry across passes while the work item's synced_at is unchanged.
 *
 * Independent oracle: a stub GithubClient that COUNTS listPRCommits/getPRBody
 * per PR number; expected link rows are hand-written. Synthetic owner/repo only.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GhPR, GhResult, GithubClient } from "../../src/outcomes/github/client.js";
import { linkSessions } from "../../src/outcomes/linker.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

class CountingClient implements GithubClient {
  readonly enabled = true;
  commitCalls: number[] = [];
  bodyCalls: number[] = [];
  failBody = new Set<number>();
  /** PR number → commit messages. */
  commits = new Map<number, string[]>();

  async listPRCommits(
    _o: string,
    _r: string,
    n: number,
  ): Promise<GhResult<{ sha: string; message: string }[]>> {
    this.commitCalls.push(n);
    return {
      ok: true,
      data: (this.commits.get(n) ?? []).map((message, i) => ({ sha: `sha-${n}-${i}`, message })),
    };
  }
  async getPRBody(_o: string, _r: string, n: number): Promise<GhResult<string>> {
    this.bodyCalls.push(n);
    if (this.failBody.has(n)) return { ok: false, reason: "github-pr-error:500" };
    return { ok: true, data: "" };
  }
  async listPullsForCommit(): Promise<GhResult<number[]>> {
    return { ok: true, data: [] };
  }
  reset(): void {
    this.commitCalls = [];
    this.bodyCalls = [];
  }
  async listPRs(): Promise<GhResult<GhPR[]>> {
    throw new Error("unexpected listPRs");
  }
  async getPRHeadKey(): Promise<GhResult<string | null>> {
    throw new Error("unexpected getPRHeadKey");
  }
  async getCheckConclusion(): Promise<GhResult<string>> {
    throw new Error("unexpected getCheckConclusion");
  }
  async getPRDiff(): Promise<GhResult<string>> {
    throw new Error("unexpected getPRDiff");
  }
  async getReviewThreads(): Promise<GhResult<{ id: string; isResolved: boolean }[]>> {
    throw new Error("unexpected getReviewThreads");
  }
}

let db: Database.Database;
let client: CountingClient;

function addWorkItem(n: number, syncedAt: string): void {
  db.prepare(
    `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
     VALUES (?, 'ws-alpha', ?, 'MERGED', ?)`,
  ).run(`gh:acme/repo-alpha#${n}`, n, syncedAt);
}

function links(): unknown[] {
  return db
    .prepare(
      "SELECT session_id, work_item_id, method FROM session_work_links ORDER BY session_id, work_item_id",
    )
    .all();
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name)
     VALUES ('te-a1', 'sess-a1', '2026-01-01T00:00:00Z', 'Bash')`,
  ).run();
  db.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
  client = new CountingClient();
  client.commits.set(501, ["Claude-Session: https://claude.ai/code/session_sess-a1"]);
  client.commits.set(502, ["plain commit"]);
  addWorkItem(501, "2026-09-01T00:00:00.000Z");
  addWorkItem(502, "2026-09-01T00:00:00.000Z");
});

afterEach(() => {
  db.close();
});

describe("linkSessions — cross-pass PR read cache (P0-U13)", () => {
  it("a second pass with unchanged work items makes zero commit/body reads and keeps links", async () => {
    await linkSessions(db, client);
    expect([...client.commitCalls].sort()).toEqual([501, 502]);
    expect([...client.bodyCalls].sort()).toEqual([501, 502]);
    const expected = [
      { session_id: "sess-a1", work_item_id: "gh:acme/repo-alpha#501", method: "TRAILER" },
    ];
    expect(links()).toEqual(expected);

    client.reset();
    await linkSessions(db, client);
    expect(client.commitCalls).toEqual([]);
    expect(client.bodyCalls).toEqual([]);
    expect(links()).toEqual(expected);
  });

  it("re-reads exactly the work item whose synced_at changed", async () => {
    await linkSessions(db, client);
    db.prepare("UPDATE work_items SET synced_at = ? WHERE number = 502").run(
      "2026-09-01T00:10:00.000Z",
    );
    client.commits.set(502, ["Claude-Session: https://claude.ai/code/session_sess-a1"]);
    client.reset();
    await linkSessions(db, client);
    expect(client.commitCalls).toEqual([502]);
    expect(client.bodyCalls).toEqual([502]);
    expect(links()).toEqual([
      { session_id: "sess-a1", work_item_id: "gh:acme/repo-alpha#501", method: "TRAILER" },
      { session_id: "sess-a1", work_item_id: "gh:acme/repo-alpha#502", method: "TRAILER" },
    ]);
  });

  it("does not carry a failed read across passes — it is retried next pass", async () => {
    client.failBody.add(502);
    await linkSessions(db, client);
    client.failBody.clear();
    client.reset();
    await linkSessions(db, client);
    expect(client.commitCalls).toEqual([502]);
    expect(client.bodyCalls).toEqual([502]);
  });

  it("does not trust the cache for an OPEN work item, even when synced_at is frozen (sync skips the row on repo-wide check-conclusion denial without bumping synced_at)", async () => {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#503', 'ws-alpha', 503, 'OPEN', '2026-09-01T00:00:00.000Z')`,
    ).run();
    client.commits.set(503, ["plain commit"]);

    await linkSessions(db, client);
    expect(client.commitCalls).toContain(503);
    expect(client.bodyCalls).toContain(503);

    // synced_at for #503 stays frozen across the next pass (as it would while
    // check-conclusion reads for its repo are denied) — the OPEN item must still
    // be re-read, not served from the cross-pass cache.
    client.reset();
    await linkSessions(db, client);
    expect(client.commitCalls).toContain(503);
    expect(client.bodyCalls).toContain(503);
  });
});
