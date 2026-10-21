import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c11ClaimProducer, c11Detector } from "../../src/detector/detectors/c11_mcp_output_cap.js";
import { buildContext } from "../../src/detector/engine.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;

function addTurn(messageId: string, ts: string, costU: number | null, sidechain = 0): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, 'session-w', 'ws-w', ?, 'claude-sonnet', ?, 10, 20, 300, 40, 0, 0, ?,
             'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, ts, sidechain, costU);
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-w', 'ws-w', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-w', 'ws-w', '/fixture/w.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
  // t1 issues the failed capped Read; t2 is a subagent turn (never the retry); t3 is the retry.
  addTurn("t1", "2027-01-02T00:00:01.000Z", 1000);
  addTurn("t2", "2027-01-02T00:00:02.000Z", 7777, 1);
  addTurn("t3", "2027-01-02T00:00:03.000Z", 3000);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES ('ev1', 'session-w', '2027-01-02T00:00:01.000Z', 'Read', 'ERROR', 'READ_OUTPUT_TOO_LARGE', 'tool-error-1')`,
  ).run();
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES ('ev1', NULL, 't1', 0, 0)",
  ).run();
});

afterEach(() => db.close());

describe("C11 prices the failed capped call and its retry turn (RR U13)", () => {
  it("estimates half of the issuing + first main-chain retry turn cost", () => {
    const fired = c11Detector.evaluate(db, CTX).fired[0];
    expect(fired?.modeled_savings_u_per_wk).toBe(2000); // 0.5 × (1000 + 3000); the sidechain turn is skipped
    expect(fired?.payload.estimate).toMatchObject({ basis: "E", rank_value_u_per_wk: 2000 });
  });

  it("claims both turns whole, in the reliability lane, to the session card", () => {
    const claims = [...c11ClaimProducer.produce(db, CTX)];
    expect(new Set(claims.map((c) => c.lane))).toEqual(new Set(["reliability"]));
    expect(new Set(claims.map((c) => c.turnKey))).toEqual(
      new Set(["session-w|t1", "session-w|t3"]),
    );
    expect(claims.filter((c) => c.turnKey === "session-w|t3").map((c) => c.tokens)).toEqual([
      10, 20, 300, 40,
    ]);
    expect(new Set(claims.map((c) => c.recId)).size).toBe(1);
  });

  it("stays unranked when no turn is priced", () => {
    db.prepare("UPDATE turns SET cost_equiv_u = NULL").run();
    const fired = c11Detector.evaluate(db, CTX).fired[0];
    expect(fired?.modeled_savings_u_per_wk).toBeNull();
    expect(fired?.payload.estimate).toMatchObject({ basis: "X", rank_value_u_per_wk: null });
  });
});
