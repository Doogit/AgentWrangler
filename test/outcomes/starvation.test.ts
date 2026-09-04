/**
 * test/outcomes/starvation.test.ts — event-loop-starvation fix regression tests.
 *
 * Guards the mechanisms that keep the outcomes pass from stalling on a busy
 * event loop:
 *   1. GithubSyncClient.fetchWithRetry — a fetch aborted because the loop was
 *      momentarily starved is retried with backoff and bounded (never hangs); a
 *      genuinely failing fetch degrades to {ok:false} after maxAttempts.
 *   2. linkSessions — cedes the event loop across a large session batch so
 *      undici's socket/timer callbacks run instead of being monopolised.
 *   3. GhCliClient subprocess transport — SHA_OVERLAP reads route through a child
 *      process (own event loop), so they resolve while the parent loop is busy.
 *      This is the primary anti-starvation mechanism in production (daemon/index.ts
 *      constructs GhCliClient, not GithubSyncClient).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import type { FetchFn } from "../../src/outcomes/github/client.js";
import { GhCliClient } from "../../src/outcomes/github/gh-cli-client.js";
import type { GhRunner } from "../../src/outcomes/github/gh-cli-client.js";
import { evaluateBranchLinksShadow, linkSessions } from "../../src/outcomes/linker.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// A fetch response that satisfies the shapes listPRs reads.
const okPrResponse = {
  ok: true,
  status: 200,
  json: async () => [],
  text: async () => "[]",
  headers: { get: () => null },
} as unknown as Response;

describe("evaluateBranchLinksShadow - cedes the event loop", () => {
  const scratch = path.join(os.tmpdir(), "aw-branch-shadow-starvation");
  let db: Database.Database;

  afterEach(() => {
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("does not monopolise the loop across more than twice the linker cadence", async () => {
    db = createInMemoryFixtureDb();
    db.prepare("UPDATE sessions SET state='LIVE' WHERE session_id='sess-a1'").run();
    db.prepare(
      "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
    ).run();
    fs.mkdirSync(scratch, { recursive: true });
    const insertSession = db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    );
    const insertToolEvent = db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'Bash')`,
    );
    const insertWorkItem = db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, 'ws-alpha', ?, 'MERGED', '2026-01-01T00:00:00Z')`,
    );
    const insertBranchKey = db.prepare(
      `INSERT INTO work_item_branch_keys
         (work_item_id, head_ref_key, normalization_version, synced_at)
       VALUES (?, ?, 'branch-v1', '2026-01-01T00:00:00Z')`,
    );
    for (let i = 0; i < 40; i++) {
      const sessionId = `sess-shadow-y${i}`;
      const workItemId = `gh:acme/repo-alpha#${1000 + i}`;
      const branchRef = `feature/shadow-y${i}`;
      const filePath = path.join(scratch, `${sessionId}.jsonl`);
      fs.writeFileSync(filePath, `${JSON.stringify({ gitBranch: branchRef })}\n`, "utf-8");
      insertSession.run(sessionId, filePath);
      insertToolEvent.run(`te-${sessionId}`, sessionId);
      insertWorkItem.run(workItemId, 1000 + i);
      insertBranchKey.run(workItemId, fingerprintBranchRef(branchRef));
    }

    let loopTurns = 0;
    let keepTicking = true;
    const tick = () => {
      if (!keepTicking) return;
      loopTurns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);

    const report = await evaluateBranchLinksShadow(db, "shadow");
    keepTicking = false;

    expect(report.sessionsEvaluated).toBe(40);
    expect(report.candidateReasonCounts.UNIQUE_CANDIDATE).toBe(40);
    expect(loopTurns).toBeGreaterThan(0);
  });
});

describe("GithubSyncClient — bounded retry (anti-starvation)", () => {
  it("retries an aborted fetch with backoff and eventually succeeds", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      if (calls < 3) throw new DOMException("The operation timed out.", "TimeoutError");
      return okPrResponse;
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn, {
      maxAttempts: 3,
      retryBackoffMs: 0,
      requestTimeoutMs: 50,
    });

    const result = await client.listPRs("owner", "repo");
    expect(result.ok).toBe(true);
    expect(calls).toBe(3); // two aborts, then success
  });

  // TEST 6: fetchWithRetry must NOT retry on an HTTP error response (ok:false, non-throwing).
  it("does not retry when fetch returns an HTTP error response (ok:false)", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      // Returns a non-throwing Response with ok:false status 500.
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn, {
      maxAttempts: 3,
      retryBackoffMs: 0,
      requestTimeoutMs: 50,
    });

    const result = await client.listPRs("owner", "repo");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(calls).toBe(1); // only 1 attempt — HTTP errors are not retried
    expect(result.reason.startsWith("github-api-error:")).toBe(true);
  });

  it("bounds retries and degrades to {ok:false} without hanging", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn, {
      maxAttempts: 2,
      retryBackoffMs: 0,
      requestTimeoutMs: 50,
    });

    const result = await client.listPRs("owner", "repo");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toContain("github-fetch-error");
    expect(calls).toBe(2); // bounded — exactly maxAttempts, no unbounded loop
  });
});

describe("linkSessions — cedes the event loop (anti-starvation)", () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  it("does not monopolise the loop across a large session batch", async () => {
    db = createInMemoryFixtureDb();
    db.prepare(
      "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
    ).run();

    // Seed 40 RECONCILED sessions (> 2×YIELD_EVERY), each with a Bash tool_event.
    // file_path points at a non-existent transcript so harvestPrLinks returns [].
    const insertSession = db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    );
    const insertToolEvent = db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'Bash')`,
    );
    for (let i = 0; i < 40; i++) {
      insertSession.run(`sess-y${i}`, `C:/nope/sess-y${i}.jsonl`);
      insertToolEvent.run(`te-y${i}`, `sess-y${i}`);
    }

    const disabledClient = new GithubSyncClient({ ok: false, reason: "no-token" });

    // A recurring macrotask: it can only tick if linkSessions cedes the loop.
    let loopTurns = 0;
    let keepTicking = true;
    const tick = () => {
      if (!keepTicking) return;
      loopTurns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);

    await linkSessions(db, disabledClient);
    keepTicking = false;

    expect(loopTurns).toBeGreaterThan(0);
  });
});

describe("linkSessions with GhCliClient — subprocess transport + SHA_OVERLAP + loop responsive", () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  /**
   * Regression guard for the original event-loop-starvation bug.
   *
   * In production, daemon/index.ts constructs a GhCliClient (subprocess transport)
   * for the outcomes pass. This test verifies that:
   *   1. SHA_OVERLAP linkage works end-to-end through the GhCliClient runner.
   *   2. The event loop stays responsive (setImmediate ticks) while the runner
   *      completes — simulating the subprocess-off-thread property.
   *   3. The correct work_item is linked with confidence > 0.5.
   *
   * When the fetch-based GithubSyncClient was used instead, undici's socket
   * callbacks were starved by the transcript-harvest loop, aborting every
   * listPRCommits call at the 15 s timeout and preventing writeObservedOutcomes
   * from ever running.
   */
  it("SHA_OVERLAP written and loop ticks proceed while gh runner resolves", async () => {
    db = createInMemoryFixtureDb();
    db.prepare(
      "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
    ).run();

    // One RECONCILED session with a Bash event carrying a commit SHA.
    // Non-existent file_path → harvestPrLinks returns [] (no PR_LINK hit).
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-ghcli', 'ws-alpha', 'C:/nope/sess-ghcli.jsonl',
         '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'RECONCILED', 1, 0, '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
       VALUES ('te-ghcli', 'sess-ghcli', '2026-01-01T00:00:00Z', 'Bash', 'cafebabe')`,
    ).run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#77', 'ws-alpha', 77, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();

    // Injected runner returns the matching SHA — simulates a gh subprocess completing.
    // The setImmediate yield inside the runner simulates the async subprocess read
    // completing off the main thread (parent only reads the pipe after the process exits).
    let runnerCalls = 0;
    const runner: GhRunner = async (_args, _opts) => {
      runnerCalls += 1;
      await new Promise<void>((r) => setImmediate(r));
      return { ok: true, stdout: JSON.stringify([{ sha: "cafebabe" }]), stderr: "", code: 0 };
    };
    const client = new GhCliClient({ ok: true, data: "tok" }, runner);

    // A recurring macrotask: can only tick if the event loop is not monopolised.
    let loopTurns = 0;
    let keepTicking = true;
    const tick = () => {
      if (!keepTicking) return;
      loopTurns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);

    await linkSessions(db, client);
    keepTicking = false;

    // The subprocess runner was invoked for the SHA_OVERLAP lookup.
    expect(runnerCalls).toBeGreaterThan(0);

    // SHA_OVERLAP link written with correct confidence.
    const row = db
      .prepare("SELECT method, confidence FROM session_work_links WHERE session_id='sess-ghcli'")
      .get() as { method: string; confidence: number } | undefined;
    expect(row?.method).toBe("SHA_OVERLAP");
    expect(row?.confidence).toBeGreaterThan(0.5);

    // Event loop was responsive — the ticker fired at least once.
    expect(loopTurns).toBeGreaterThan(0);
  });
});
