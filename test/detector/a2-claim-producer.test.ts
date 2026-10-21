/**
 * test/detector/a2-claim-producer.test.ts — a2ClaimProducer ledger claims (P3.L L3).
 *
 * A2 writes on the first later turn and carries on the rest (U7; it used to write only). It is
 * main-thread only, so the chain walk's same-agent narrowing doesn't matter as much as for A1,
 * but the write-turn split, the clamp, the unbilled-turn skip and the >25.6 KiB A1 exclusion
 * all still apply.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { A1_RESULT_BYTES_THRESHOLD } from "../../src/detector/detectors/a1_tool_result_bloat.js";
import {
  A2_TASK_OUTPUT_BYTES_THRESHOLD,
  a2ClaimProducer,
} from "../../src/detector/detectors/a2_task_output_bloat.js";
import { buildContext } from "../../src/detector/engine.js";
import { recId } from "../../src/detector/rec-id.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
const WS = "ws-a2c";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, CTX.fromIso);
});

afterEach(() => db.close());

function insertSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, `/fake/${sessionId}.jsonl`, CTX.fromIso, CTX.toIso);
}

interface TurnOpts {
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
  provisional?: number;
}

function insertTurn(messageId: string, sessionId: string, ts: string, opts: TurnOpts = {}): void {
  const { cacheRead = 0, cw5m = 0, cw1h = 0, provisional = 0 } = opts;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
        cache_write_other, pricing_snapshot_id, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, NULL, 0, 0, ?, ?, ?, 0, 'snap-sonnet',
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(messageId, sessionId, WS, ts, cacheRead, cw5m, cw1h, provisional);
}

function addTaskOutput(
  eventId: string,
  sessionId: string,
  ts: string,
  resultBytes: number,
  ownerMessageId: string,
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
       input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, 'TaskOutput', 0, ?, NULL, 'OK', NULL)`,
  ).run(eventId, sessionId, ts, resultBytes);
  db.prepare(
    `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, 0, 0)`,
  ).run(eventId, ownerMessageId);
}

function claimsFor(sessionId: string) {
  const ledger = buildClaimLedger(db, CTX, [a2ClaimProducer]);
  return ledger.claims.filter((claim) => claim.sessionId === sessionId);
}

describe("a2ClaimProducer", () => {
  it("writes to the first later turn and carries on the later ones (U7)", () => {
    insertSession("s1");
    insertTurn("own-1", "s1", "2027-01-02T00:00:00.000Z");
    addTaskOutput(
      "ev-1",
      "s1",
      "2027-01-02T00:00:00.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700,
      "own-1",
    );
    insertTurn("later-1", "s1", "2027-01-02T00:10:00.000Z", { cw5m: 1_000, cacheRead: 100_000 });
    insertTurn("later-2", "s1", "2027-01-02T00:20:00.000Z", { cacheRead: 100_000 });

    const claims = claimsFor("s1");
    expect(claims.length).toBeGreaterThan(0);
    const writes = claims.filter((c) => c.component !== "cacheRead");
    const reads = claims.filter((c) => c.component === "cacheRead");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.turnKey === "s1|later-1")).toBe(true);
    expect(reads.map((c) => c.turnKey)).toEqual(["s1|later-2"]);
  });

  it("splits the write claim across cw5m/cw1h by the write turn's own mix", () => {
    insertSession("s2");
    insertTurn("own-2", "s2", "2027-01-02T00:00:00.000Z");
    addTaskOutput(
      "ev-2",
      "s2",
      "2027-01-02T00:00:00.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700,
      "own-2",
    );
    insertTurn("later-2", "s2", "2027-01-02T00:10:00.000Z", { cw5m: 300, cw1h: 700 });

    const claims = claimsFor("s2");
    const byComponent = new Map(claims.map((c) => [c.component, c.raw_tokens]));
    expect(byComponent.get("cw5m")).toBe(300);
    expect(byComponent.get("cw1h")).toBe(700);
  });

  it("skips events over 25.6 KiB — A1 owns those", () => {
    insertSession("s3");
    insertTurn("own-3", "s3", "2027-01-02T00:00:00.000Z");
    addTaskOutput("ev-3", "s3", "2027-01-02T00:00:00.000Z", A1_RESULT_BYTES_THRESHOLD + 1, "own-3");
    insertTurn("later-3", "s3", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    expect(claimsFor("s3")).toHaveLength(0);
  });

  it("still claims events at or under 25.6 KiB", () => {
    insertSession("s4");
    insertTurn("own-4", "s4", "2027-01-02T00:00:00.000Z");
    addTaskOutput("ev-4", "s4", "2027-01-02T00:00:00.000Z", A1_RESULT_BYTES_THRESHOLD, "own-4");
    insertTurn("later-4", "s4", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    expect(claimsFor("s4").length).toBeGreaterThan(0);
  });

  it("clamps a producer's own claims at the cell's raw token budget", () => {
    insertSession("s5");
    insertTurn("own-5", "s5", "2027-01-02T00:00:00.000Z");
    addTaskOutput(
      "ev-5a",
      "s5",
      "2027-01-02T00:00:00.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_430,
      "own-5",
    );
    addTaskOutput(
      "ev-5b",
      "s5",
      "2027-01-02T00:00:30.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_430,
      "own-5",
    );
    insertTurn("later-5", "s5", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    const claims = claimsFor("s5");
    const byEvent = new Map(claims.map((c) => [c.slice, c.raw_tokens]));
    expect(byEvent.get("result:ev-5a")).toBe(900);
    expect(byEvent.get("result:ev-5b")).toBe(100);
    expect(conservationReport(buildClaimLedger(db, CTX, [a2ClaimProducer])).overbilled).toEqual([]);
  });

  it("skips claims on unbilled (provisional) write turns", () => {
    insertSession("s6");
    insertTurn("own-6", "s6", "2027-01-02T00:00:00.000Z");
    addTaskOutput(
      "ev-6",
      "s6",
      "2027-01-02T00:00:00.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700,
      "own-6",
    );
    insertTurn("later-6", "s6", "2027-01-02T00:10:00.000Z", { cw5m: 1_000, provisional: 1 });

    expect(claimsFor("s6")).toHaveLength(0);
  });

  it("stamps slice, fraction, fractionRange, assumed and the detector's own recId", () => {
    insertSession("s7");
    insertTurn("own-7", "s7", "2027-01-02T00:00:00.000Z");
    addTaskOutput(
      "ev-7",
      "s7",
      "2027-01-02T00:00:00.000Z",
      A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700,
      "own-7",
    );
    insertTurn("later-7", "s7", "2027-01-02T00:10:00.000Z", { cw5m: 1_000 });

    const claims = claimsFor("s7");
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.slice).toBe("result:ev-7");
      expect(claim.fraction).toBe(0.5);
      expect(claim.fractionRange).toEqual([0.33, 0.7]);
      expect(claim.assumed).toBe(true);
      expect(claim.recId).toBe(recId("A2", WS, `A2|${WS}`));
      expect(claim.detectorId).toBe("A2");
    }
  });
});
