/**
 * test/detector/result-claims-ledger.test.ts — ledger-level conservation across the A1, A2 and
 * D7x result claim producers together (P3.L L3). Runs `buildClaimLedger` with its full default
 * `CLAIM_PRODUCERS` list (so D1/D2/D10/C-family producers are exercised too, even though this
 * fixture gives them nothing to fire on) and checks the ledger stays conserved and that no
 * `result:<event_id>` slice is ever owned by two detectors.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { buildContext } from "../../src/detector/engine.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
const WS = "ws-rcl";
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, CTX.fromIso);
});

afterEach(() => db.close());

function ts(offsetMinutes: number): string {
  return new Date(BASE + offsetMinutes * 60_000).toISOString();
}

function insertSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, `/fake/${sessionId}.jsonl`, CTX.fromIso, CTX.toIso);
}

function insertTurn(
  messageId: string,
  sessionId: string,
  turnTs: string,
  opts: { cacheRead?: number; cw5m?: number; cw1h?: number } = {},
): void {
  const { cacheRead = 0, cw5m = 0, cw1h = 0 } = opts;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
        cache_write_other, pricing_snapshot_id, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, NULL, 0, 0, ?, ?, ?, 0, 'snap-sonnet',
             'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, turnTs, cacheRead, cw5m, cw1h);
}

describe("A1/A2/D7x claims share one ledger without conflict", () => {
  it("stays conserved and never double-owns a result event slice", () => {
    // A1: one oversized Bash result.
    insertSession("la1");
    insertTurn("own-a1", "la1", ts(0));
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
         input_hash, exit_class, commit_sha)
       VALUES ('ev-a1', 'la1', ?, 'Bash', 0, ?, NULL, 'OK', NULL)`,
    ).run(ts(0), 25 * 1024 + 2_700);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES ('ev-a1', 'own-a1', 0, 0)`,
    ).run();
    insertTurn("later-a1", "la1", ts(10), { cw5m: 1_000 });

    // A2: one oversized (but <= 25.6 KiB) TaskOutput result.
    insertSession("la2");
    insertTurn("own-a2", "la2", ts(0));
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
         input_hash, exit_class, commit_sha)
       VALUES ('ev-a2', 'la2', ?, 'TaskOutput', 0, ?, NULL, 'OK', NULL)`,
    ).run(ts(0), 10 * 1024 + 2_700);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES ('ev-a2', 'own-a2', 0, 0)`,
    ).run();
    insertTurn("later-a2", "la2", ts(10), { cw5m: 1_000 });

    // D7x: a qualifying cross-session path (2 sessions, 10 reads total).
    insertSession("ld7-o");
    insertSession("ld7-r");
    insertTurn("own-d7-o", "ld7-o", ts(0));
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
           input_hash, exit_class, commit_sha)
         VALUES (?, 'ld7-o', ?, 'Read', 7, 3000, NULL, 'OK', NULL)`,
      ).run(`d7-o-r${i}`, ts(i));
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, 'shared-path', ?, 0, 0)`,
      ).run(`d7-o-r${i}`, i === 0 ? "own-d7-o" : null);
    }
    insertTurn("own-d7-r", "ld7-r", ts(20));
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
           input_hash, exit_class, commit_sha)
         VALUES (?, 'ld7-r', ?, 'Read', 7, 3000, NULL, 'OK', NULL)`,
      ).run(`d7-r-r${i}`, ts(20 + i));
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, 'shared-path', ?, 0, 0)`,
      ).run(`d7-r-r${i}`, i === 0 ? "own-d7-r" : null);
    }
    insertTurn("later-d7-r", "ld7-r", ts(30), { cw5m: 1_000 });

    const ledger = buildClaimLedger(db, CTX);
    const resultClaims = ledger.claims.filter((c) => c.slice.startsWith("result:"));
    expect(resultClaims.length).toBeGreaterThan(0);

    const detectorsBySlice = new Map<string, Set<string>>();
    for (const claim of resultClaims) {
      const set = detectorsBySlice.get(claim.slice) ?? new Set<string>();
      set.add(claim.detectorId);
      detectorsBySlice.set(claim.slice, set);
    }
    for (const [slice, detectors] of detectorsBySlice) {
      expect(detectors.size, `slice ${slice} owned by ${[...detectors].join(",")}`).toBe(1);
    }
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("a rebuild over the same window sees turns written since the last build", () => {
    insertSession("lr1");
    insertTurn("own-r1", "lr1", ts(0));
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
         input_hash, exit_class, commit_sha)
       VALUES ('ev-r1', 'lr1', ?, 'Bash', 0, ?, NULL, 'OK', NULL)`,
    ).run(ts(0), 25 * 1024 + 2_700);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES ('ev-r1', 'own-r1', 0, 0)`,
    ).run();
    const a1 = (l: ReturnType<typeof buildClaimLedger>) =>
      l.claims.filter((c) => c.detectorId === "A1");
    expect(a1(buildClaimLedger(db, CTX))).toHaveLength(0);

    insertTurn("later-r1", "lr1", ts(10), { cw5m: 1_000 });
    expect(a1(buildClaimLedger(db, CTX)).map((c) => c.turnKey)).toHaveLength(1);
  });
});
