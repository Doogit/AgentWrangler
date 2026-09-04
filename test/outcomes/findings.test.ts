/**
 * test/outcomes/findings.test.ts — FindingsExtractor E1/E2/E3.
 *
 * Verifies E1 unresolved-thread detection, E2 deferral-section parsing,
 * E3 TODO/FIXME detection, and exclusion of vendored files.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RECHECK_TTL_MS, extractFindings } from "../../src/outcomes/findings.js";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import type { FetchFn } from "../../src/outcomes/github/client.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedWorkItem(
  db: Database.Database,
  workItemId: string,
  number: number,
  state: "MERGED" | "OPEN" | "CLOSED",
  finalCommit: string | null = null,
) {
  db.prepare(
    `INSERT OR IGNORE INTO work_items
       (work_item_id, workspace_id, number, state, final_commit, synced_at)
     VALUES (?, 'ws-alpha', ?, ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(workItemId, number, state, finalCommit);
}

function makeClient(
  threads: Array<{ id: string; isResolved: boolean }> = [],
  body = "",
  diff = "",
  counts?: { graphql: number; body: number; diff: number },
): GithubSyncClient {
  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("graphql")) {
      if (counts) counts.graphql++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: threads },
              },
            },
          },
        }),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    }
    if (url.includes("pulls/")) {
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? "";
      if (accept === "application/vnd.github.diff") {
        if (counts) counts.diff++;
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => diff,
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (counts) counts.body++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ body }),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
      headers: { get: () => null },
    } as unknown as Response;
  };
  return new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// E1: Unresolved threads
// ---------------------------------------------------------------------------

describe("E1 — UNRESOLVED_THREAD", () => {
  it("writes DEFERRED finding for unresolved thread", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#10", 10, "MERGED", "sha-abc");
    const client = makeClient([{ id: "thread-1", isResolved: false }]);
    await extractFindings(db, client, "acme", "repo-alpha");

    const row = db
      .prepare(
        "SELECT source, status, evidence_ref FROM review_findings WHERE finding_id='e1:gh:acme/repo-alpha#10:thread-1'",
      )
      .get() as { source: string; status: string; evidence_ref: string } | undefined;
    expect(row?.source).toBe("UNRESOLVED_THREAD");
    expect(row?.status).toBe("DEFERRED");
    expect(row?.evidence_ref).toBe("thread-1");
  });

  it("writes ADDRESSED for resolved thread", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#11", 11, "MERGED", "sha-xyz");
    const client = makeClient([{ id: "thread-resolved", isResolved: true }]);
    await extractFindings(db, client, "acme", "repo-alpha");

    const row = db
      .prepare(
        "SELECT status FROM review_findings WHERE finding_id='e1:gh:acme/repo-alpha#11:thread-resolved'",
      )
      .get() as { status: string } | undefined;
    expect(row?.status).toBe("ADDRESSED");
  });

  it("is idempotent — running twice does not duplicate findings", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#12", 12, "MERGED", "sha-dup");
    const client = makeClient([{ id: "thread-dup", isResolved: false }]);
    await extractFindings(db, client, "acme", "repo-alpha");
    await extractFindings(db, client, "acme", "repo-alpha");

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM review_findings WHERE source='UNRESOLVED_THREAD'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E2: Deferral sections
// ---------------------------------------------------------------------------

describe("E2 — DEFERRAL_SECTION", () => {
  it("detects items under ## Deferred heading", async () => {
    const body = "## Deferred\n- item one\n- item two\n\n## Normal Section\n- not deferred";
    seedWorkItem(db, "gh:acme/repo-alpha#20", 20, "MERGED", "sha-body");
    const client = makeClient([], body);
    await extractFindings(db, client, "acme", "repo-alpha");

    const rows = db
      .prepare(
        "SELECT evidence_ref FROM review_findings WHERE source='DEFERRAL_SECTION' ORDER BY evidence_ref",
      )
      .all() as Array<{ evidence_ref: string }>;
    expect(rows).toHaveLength(2);
    // SEC-101: evidence_ref is keyword-class + index — a fixed enum + position,
    // never the raw heading text copied from the body.
    expect(rows.map((r) => r.evidence_ref)).toEqual([
      "gh:acme/repo-alpha#20:e2:deferred:0",
      "gh:acme/repo-alpha#20:e2:deferred:1",
    ]);
  });

  it("detects ## Follow-ups heading", async () => {
    const body = "## Follow-ups\n- todo thing\n";
    seedWorkItem(db, "gh:acme/repo-alpha#21", 21, "MERGED", "sha-fu");
    const client = makeClient([], body);
    await extractFindings(db, client, "acme", "repo-alpha");

    const rows = db
      .prepare("SELECT evidence_ref FROM review_findings WHERE source='DEFERRAL_SECTION'")
      .all() as Array<{ evidence_ref: string }>;
    expect(rows).toHaveLength(1);
    // "follow[- ]?ups?" normalizes to the fixed "follow-ups" class.
    expect(rows[0]?.evidence_ref).toBe("gh:acme/repo-alpha#21:e2:follow-ups:0");
  });
});

// ---------------------------------------------------------------------------
// E3: Diff markers
// ---------------------------------------------------------------------------

describe("E3 — DIFF_MARKER", () => {
  const fakeDiff = [
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " const x = 1;",
    "+// TODO: fix this",
    " const y = 2;",
    "+// FIXME: also this",
  ].join("\n");

  it("detects TODO and FIXME in added lines", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#30", 30, "MERGED", "abcdef1");
    const client = makeClient([], "", fakeDiff);
    await extractFindings(db, client, "acme", "repo-alpha");

    const rows = db
      .prepare(
        "SELECT evidence_ref FROM review_findings WHERE source='DIFF_MARKER' ORDER BY evidence_ref",
      )
      .all() as Array<{ evidence_ref: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.evidence_ref).toContain("src/foo.ts");
  });

  it("skips vendored/lockfile paths", async () => {
    const lockDiff = [
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,1 +1,2 @@",
      "+// TODO: would never be here but let's check exclusion",
    ].join("\n");
    seedWorkItem(db, "gh:acme/repo-alpha#31", 31, "MERGED", "abcdef2");
    const client = makeClient([], "", lockDiff);
    await extractFindings(db, client, "acme", "repo-alpha");

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE source='DIFF_MARKER'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disabled client
// ---------------------------------------------------------------------------

describe("extractFindings — disabled client", () => {
  it("writes 0 findings when client is disabled", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#50", 50, "MERGED", "sha-dis");
    const client = new GithubSyncClient({ ok: false, reason: "no-token" });
    await extractFindings(db, client, "acme", "repo-alpha");

    const count = (db.prepare("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number })
      .n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pass bounding (latency): immutable terminal bodies/diffs fetched once,
// terminal E1 re-checked on a staggered TTL, OPEN items every pass.
// ---------------------------------------------------------------------------

const BOUNDING_DIFF = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,1 +1,2 @@",
  " const x = 1;",
  "+// TODO: bounded",
].join("\n");

describe("findings pass bounding", () => {
  it("first pass fetches threads + body + diff for every work item", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#70", 70, "MERGED", "sha-p70");
    seedWorkItem(db, "gh:acme/repo-alpha#71", 71, "MERGED", "sha-p71");
    const counts = { graphql: 0, body: 0, diff: 0 };
    const client = makeClient(
      [{ id: "t1", isResolved: false }],
      "## Deferred\n- item\n",
      BOUNDING_DIFF,
      counts,
    );

    await extractFindings(db, client, "acme", "repo-alpha");

    expect(counts).toEqual({ graphql: 2, body: 2, diff: 2 });
  });

  it("immediate second pass does zero fetches for terminal items", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#72", 72, "MERGED", "sha-p72");
    const counts = { graphql: 0, body: 0, diff: 0 };
    const client = makeClient([], "", BOUNDING_DIFF, counts);

    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 1, body: 1, diff: 1 });

    // Terminal item: body/diff immutable → skipped; E1 just checked → inside TTL.
    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 1, body: 1, diff: 1 });

    // Findings unchanged by the second pass.
    const n = (db.prepare("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n;
    expect(n).toBe(1); // the E3 diff marker
  });

  it("retries terminal body/diff fetches after transient failures", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#73", 73, "MERGED", "sha-p73");
    seedWorkItem(db, "gh:acme/repo-alpha#74", 74, "MERGED", "sha-p74");
    const counts = { graphql: 0, body: 0, diff: 0 };
    let failBodyAndDiff = true;
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("graphql")) {
        counts.graphql++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
          }),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (url.includes("pulls/")) {
        const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? "";
        const isDiff = accept === "application/vnd.github.diff";
        if (isDiff) counts.diff++;
        else counts.body++;
        if (failBodyAndDiff) {
          return {
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => "",
            headers: { get: () => null },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ body: "## Deferred\n- retry me\n" }),
          text: async () => BOUNDING_DIFF,
          headers: { get: () => null },
        } as unknown as Response;
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);

    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 2, body: 2, diff: 2 });
    const wmAfterFailure = db
      .prepare("SELECT value FROM user_config WHERE key = 'gh_findings_seen:acme/repo-alpha'")
      .get() as { value: string };
    expect(wmAfterFailure.value).toBe("1970-01-01T00:00:00Z");

    failBodyAndDiff = false;
    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 4, body: 4, diff: 4 });
    const findings = db
      .prepare("SELECT source FROM review_findings ORDER BY work_item_id, source")
      .all() as Array<{ source: string }>;
    expect(findings.map((f) => f.source)).toEqual([
      "DEFERRAL_SECTION",
      "DIFF_MARKER",
      "DEFERRAL_SECTION",
      "DIFF_MARKER",
    ]);

    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 4, body: 4, diff: 4 });
  });

  it("resolved thread still clears a DEFERRED finding under the TTL policy", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#80", 80, "MERGED", "sha-c80");
    const t0 = new Date("2026-08-01T00:00:00Z");

    await extractFindings(db, makeClient([{ id: "t9", isResolved: false }]), "acme", "repo-alpha", {
      now: () => t0,
    });
    const findingId = "e1:gh:acme/repo-alpha#80:t9";
    const before = db
      .prepare("SELECT status, cleared_at FROM review_findings WHERE finding_id = ?")
      .get(findingId) as { status: string; cleared_at: string | null };
    expect(before.status).toBe("DEFERRED");
    expect(before.cleared_at).toBeNull();

    // Later pass, clock advanced past RECHECK_TTL (default 7d): the terminal
    // item is re-checked and the resolved thread clears the DEFERRED finding.
    const later = new Date(t0.getTime() + DEFAULT_RECHECK_TTL_MS * 2);
    await extractFindings(db, makeClient([{ id: "t9", isResolved: true }]), "acme", "repo-alpha", {
      now: () => later,
    });

    const after = db
      .prepare("SELECT status, cleared_at, cleared_by FROM review_findings WHERE finding_id = ?")
      .get(findingId) as { status: string; cleared_at: string | null; cleared_by: string | null };
    expect(after.status).toBe("ADDRESSED");
    expect(after.cleared_at).not.toBeNull();
    expect(after.cleared_by).toBe("sha-c80");
  });

  it("OPEN items are re-checked (threads + body) every pass", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#81", 81, "OPEN");
    const counts = { graphql: 0, body: 0, diff: 0 };
    const client = makeClient([{ id: "t2", isResolved: false }], "", "", counts);

    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 1, body: 1, diff: 0 });

    await extractFindings(db, client, "acme", "repo-alpha");
    expect(counts).toEqual({ graphql: 2, body: 2, diff: 0 });
  });

  it("disabled client makes zero network calls", async () => {
    seedWorkItem(db, "gh:acme/repo-alpha#82", 82, "MERGED", "sha-dis2");
    let calls = 0;
    const fetchFn: FetchFn = async (input) => {
      calls++;
      void input;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    };
    const client = new GithubSyncClient({ ok: false, reason: "no-token" }, fetchFn);
    await extractFindings(db, client, "acme", "repo-alpha");
    expect(calls).toBe(0);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
