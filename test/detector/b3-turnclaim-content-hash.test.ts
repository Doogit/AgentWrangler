/**
 * test/detector/b3-turnclaim-content-hash.test.ts — regression for the money
 * double-count the independent review of merge f989152 surfaced.
 *
 * turn-claim pre-excludes exactly the loop turns D7 monetizes by running D7's OWN
 * matcher (`analyzeD7LoopEvents`). D7 keys its identical-call loop signal on a
 * CONTENT-superseded hash (`normalizedClusterText($.command | $.error)`), NOT the
 * raw `input_hash`. If turn-claim feeds RAW `input_hash` to the same matcher, then
 * for migration-028 content-backed events (raw hash null/varying, captured command
 * identical) the two runs diverge: D7 prices the loop's repeat turns while
 * turn-claim excludes nothing, and a C-family (here C7) claims the same turns →
 * counted twice in the efficiency-headroom SUM.
 *
 * The events are spaced > D7's MAX_RUN_GAP_SEC (120s) so `markErrorRuns` (the
 * time-gapped friction signal) does NOT fire on either side — isolating the
 * identical-call CONTENT-hash path as the sole differentiator.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};

const WS = "ws-content-hash";
const TURN_COST_U = 100_000;
const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();
// > 120s (D7's MAX_RUN_GAP_SEC) so markErrorRuns cannot form a run; only the
// gap-free identical-call (content-hash) signal can flag this cluster.
const SPREAD_MS = 200_000;

let db: Database.Database;
let seq = 0;

function insSession(sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-03T10:00:00.000Z', '2027-01-03T14:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, `/fixture/${sessionId}.jsonl`);
}

function insTurn(sessionId: string, costU: number): string {
  const messageId = `msg-ch-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             0, 0, 0, 0, 0, 0, 0, NULL,
             ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, new Date(TS_BASE + seq * 1000).toISOString(), costU);
  return messageId;
}

/** Insert a Bash ERROR event with a captured command, at an absolute ts. */
function insBashError(
  sessionId: string,
  ownerMessageId: string,
  command: string,
  tsMs: number,
): void {
  const eventId = `evt-ch-${seq++}`;
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
        exit_class, commit_sha, tool_error_class, tool_error_classifier_version,
        bash_command_family)
     VALUES (?, ?, ?, 'Bash', 1, NULL, NULL, 'ERROR', NULL, NULL, NULL, 'BASH_GIT')`,
  ).run(eventId, sessionId, new Date(tsMs).toISOString());
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, NULL, ?, ?, 0)`,
  ).run(eventId, ownerMessageId, seq);
  db.prepare(
    `INSERT INTO tool_event_content (event_id, content_json, content_included)
     VALUES (?, ?, 1)`,
  ).run(eventId, JSON.stringify({ command, error: "Exit code 1\nfatal: unable to push" }));
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(WS, WS);
});
afterEach(() => db.close());

describe("turn-claim D7 pre-exclusion uses the CONTENT-superseded hash (parity with D7)", () => {
  it("excludes a content-identical Bash retry loop from C7 (raw input_hash null)", () => {
    insSession("s-loop");
    // 3 identical `git push` failures on distinct priced turns, raw input_hash NULL,
    // captured command identical, spaced 200s apart. D7's identical-call signal keys
    // on the content hash → run of 3 → repeat turns 2 & 3 are D7 loop economics.
    for (let i = 0; i < 3; i++) {
      insBashError(
        "s-loop",
        insTurn("s-loop", TURN_COST_U),
        "git push origin main",
        TS_BASE + i * SPREAD_MS,
      );
    }

    const claims = wastedTurnClaims(db, CTX);
    // D7 prices the all-but-first loop members, so only the FIRST failure stays
    // claimable by C7. A raw-hash turn-claim would form no run (null key) and let
    // C7 claim all 3 — the same turns D7 also prices (double-count).
    expect(claims.get("C7")?.size).toBe(1);
  });
});
