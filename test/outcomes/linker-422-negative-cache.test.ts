/**
 * test/outcomes/linker-422-negative-cache.test.ts — P0-U13 S4: a reverse
 * commit→PR lookup that GitHub answers with HTTP 422 (commit unknown) is recorded
 * per repo and not repeated while the repo sync watermark is unchanged.
 *
 * Independent oracle: a stub GithubClient counting listPullsForCommit per SHA;
 * expected counts and links are hand-written. Synthetic owner/repo only.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GhPR, GhResult, GithubClient } from "../../src/outcomes/github/client.js";
import { linkSessions } from "../../src/outcomes/linker.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const BAD_SHA = "bad0000000000000000000000000000000000001";
const GOOD_SHA = "good000000000000000000000000000000000002";

class LookupClient implements GithubClient {
  readonly enabled = true;
  calls: string[] = [];
  /** SHA → failure reason (absent = success). */
  failures = new Map<string, string>();
  /** SHA → PR numbers on success. */
  pulls = new Map<string, number[]>();

  async listPullsForCommit(_o: string, _r: string, sha: string): Promise<GhResult<number[]>> {
    this.calls.push(sha);
    const reason = this.failures.get(sha);
    if (reason !== undefined) return { ok: false, reason };
    return { ok: true, data: this.pulls.get(sha) ?? [] };
  }
  async listPRCommits(): Promise<GhResult<{ sha: string; message: string }[]>> {
    return { ok: true, data: [] };
  }
  async getPRBody(): Promise<GhResult<string>> {
    return { ok: true, data: "" };
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
let client: LookupClient;

function setWatermark(value: string): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES ('gh_watermark:acme/repo-alpha', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(value, "2026-09-01T00:00:00.000Z");
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
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
  db.prepare(
    `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
     VALUES ('gh:acme/repo-alpha#701', 'ws-alpha', 701, 'MERGED', '2026-09-01T00:00:00.000Z')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?, 'sess-a1', '2026-01-01T00:00:00Z', 'Bash', ?)`,
  );
  ins.run("te-bad", BAD_SHA);
  ins.run("te-good", GOOD_SHA);
  client = new LookupClient();
  client.pulls.set(GOOD_SHA, [701]);
  setWatermark("2026-09-01T00:00:00Z");
});

afterEach(() => {
  db.close();
});

const EXPECTED_LINKS = [
  { session_id: "sess-a1", work_item_id: "gh:acme/repo-alpha#701", method: "SHA_OVERLAP" },
];

describe("linkSessions — 422 reverse-lookup negative cache (P0-U13 S4)", () => {
  it("looks a 422 SHA up once, then makes 0 calls for it while the watermark is unchanged", async () => {
    client.failures.set(BAD_SHA, "github-commit-pulls-error:422");
    await linkSessions(db, client);
    expect(client.calls.filter((s) => s === BAD_SHA)).toHaveLength(1);
    expect(links()).toEqual(EXPECTED_LINKS);

    client.calls = [];
    await linkSessions(db, client);
    expect(client.calls).toEqual([]);
    expect(links()).toEqual(EXPECTED_LINKS);
  });

  it("retries a 422 SHA exactly once after the watermark moves", async () => {
    client.failures.set(BAD_SHA, "github-commit-pulls-error:422");
    await linkSessions(db, client);
    setWatermark("2026-09-02T00:00:00Z");
    client.calls = [];
    await linkSessions(db, client);
    expect([...client.calls].sort()).toEqual([BAD_SHA, GOOD_SHA].sort());
    expect(client.calls.filter((s) => s === BAD_SHA)).toHaveLength(1);

    client.calls = [];
    await linkSessions(db, client);
    expect(client.calls).toEqual([]);
  });

  it.each([
    ["5xx", "github-commit-pulls-error:503"],
    ["timeout", "github-commit-pulls-error:timeout"],
    ["rate limit", "github-commit-pulls-error:403"],
  ])("does not cache a %s failure — it is retried next pass", async (_name, reason) => {
    client.failures.set(BAD_SHA, reason);
    await linkSessions(db, client);
    client.calls = [];
    await linkSessions(db, client);
    expect(client.calls.filter((s) => s === BAD_SHA)).toHaveLength(1);
    expect(links()).toEqual(EXPECTED_LINKS);
  });
});
