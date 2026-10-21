/**
 * test/detector/d7x-claim-producer.test.ts — d7xClaimProducer ledger claims (P3.L L3).
 *
 * D7x's write/carry mechanics (cw5m/cw1h split, compaction/collapse/75-cap stops, the
 * per-producer clamp) are the SAME shared `resultClaimsForEvent` logic A1's producer test
 * exercises directly; this file focuses on what is unique to D7x: which events even reach
 * the shared claim logic — the earliest (origin) session of a qualifying path is dropped, and
 * only each session's FIRST read of a path is a candidate (within-session repeats are not).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { d7xClaimProducer } from "../../src/detector/detectors/d7_loop_retry_waste.js";
import { buildContext } from "../../src/detector/engine.js";
import { recId } from "../../src/detector/rec-id.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
const WS = "ws-d7c";
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

interface TurnOpts {
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
  provisional?: number;
}

function insertTurn(
  messageId: string,
  sessionId: string,
  turnTs: string,
  opts: TurnOpts = {},
): void {
  const { cacheRead = 0, cw5m = 0, cw1h = 0, provisional = 0 } = opts;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
        cache_write_other, pricing_snapshot_id, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, NULL, 0, 0, ?, ?, ?, 0, 'snap-sonnet',
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(messageId, sessionId, WS, turnTs, cacheRead, cw5m, cw1h, provisional);
}

function addRead(
  eventId: string,
  sessionId: string,
  pathHash: string,
  resultBytes: number,
  readTs: string,
  ownerMessageId: string | null,
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
       input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, 'Read', 7, ?, NULL, 'OK', NULL)`,
  ).run(eventId, sessionId, readTs, resultBytes);
  db.prepare(
    `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, 0, 0)`,
  ).run(eventId, pathHash, ownerMessageId);
}

function claims() {
  return buildClaimLedger(db, CTX, [d7xClaimProducer]).claims;
}

describe("d7xClaimProducer", () => {
  it("drops the origin (earliest) session and each session's within-session repeat reads", () => {
    // Qualifying path: 5 sessions, 10 reads total, max share 3/10 = 0.3 (<= 0.8).
    insertSession("s1");
    insertSession("s2");
    insertSession("s3");
    insertSession("s4");
    insertSession("s5");

    // s1 is the earliest — the origin, never redundant.
    insertTurn("own-s1", "s1", ts(0));
    addRead("r-s1", "s1", "shared-path", 5_000, ts(0), "own-s1");

    // s2's first read is redundant; its two later reads are within-session repeats.
    insertTurn("own-s2", "s2", ts(10));
    // F7: one read identity has one size (the same content each time).
    addRead("r-s2-1", "s2", "shared-path", 5_000, ts(10), "own-s2");
    addRead("r-s2-2", "s2", "shared-path", 5_000, ts(11), null);
    addRead("r-s2-3", "s2", "shared-path", 5_000, ts(12), null);
    insertTurn("later-s2", "s2", ts(20), { cw5m: 1_000 });

    for (const [id, offset] of [
      ["s3", 30],
      ["s4", 50],
      ["s5", 70],
    ] as const) {
      insertTurn(`own-${id}`, id, ts(offset));
      addRead(`r-${id}-1`, id, "shared-path", 5_000, ts(offset), `own-${id}`);
      addRead(`r-${id}-2`, id, "shared-path", 5_000, ts(offset + 1), null);
      insertTurn(`later-${id}`, id, ts(offset + 10), { cw5m: 1_000 });
    }

    const ledger = claims();
    const slices = new Set(ledger.map((c) => c.slice));
    expect([...slices]).toEqual(
      expect.arrayContaining(["result:r-s2-1", "result:r-s3-1", "result:r-s4-1", "result:r-s5-1"]),
    );
    // The origin session never claims, and within-session repeats never claim on their own.
    expect(ledger.some((c) => c.sessionId === "s1")).toBe(false);
    expect(slices.has("result:r-s2-2")).toBe(false);
    expect(slices.has("result:r-s2-3")).toBe(false);
    expect(slices.has("result:r-s3-2")).toBe(false);
    expect(conservationReport(buildClaimLedger(db, CTX, [d7xClaimProducer]))).toEqual({
      doubleOwned: [],
      overbilled: [],
      overvalued: [],
    });
  });

  it("carries to later turns after the write turn", () => {
    insertSession("c1");
    insertSession("c2");
    // 2 sessions, 10 reads total (c1=5, c2=5), share 0.5 (<= 0.8).
    insertTurn("own-c1", "c1", ts(0));
    for (let i = 0; i < 5; i++)
      addRead(`c1-r${i}`, "c1", "carry-path", 3_000, ts(i), i === 0 ? "own-c1" : null);

    insertTurn("own-c2", "c2", ts(20));
    for (let i = 0; i < 5; i++) {
      addRead(`c2-r${i}`, "c2", "carry-path", 3_000, ts(20 + i), i === 0 ? "own-c2" : null);
    }
    insertTurn("later-c2-1", "c2", ts(30), { cw5m: 1_000 });
    insertTurn("later-c2-2", "c2", ts(40), { cacheRead: 100_000 });

    const ledger = claims().filter((c) => c.sessionId === "c2");
    expect(ledger.some((c) => c.turnKey === "c2|later-c2-1" && c.component === "cw5m")).toBe(true);
    expect(ledger.some((c) => c.turnKey === "c2|later-c2-2" && c.component === "cacheRead")).toBe(
      true,
    );
  });

  it("skips claims on unbilled (provisional) write turns", () => {
    insertSession("u1");
    insertSession("u2");
    insertTurn("own-u1", "u1", ts(0));
    for (let i = 0; i < 5; i++)
      addRead(`u1-r${i}`, "u1", "unbilled-path", 3_000, ts(i), i === 0 ? "own-u1" : null);
    insertTurn("own-u2", "u2", ts(20));
    for (let i = 0; i < 5; i++)
      addRead(`u2-r${i}`, "u2", "unbilled-path", 3_000, ts(20 + i), i === 0 ? "own-u2" : null);
    insertTurn("later-u2", "u2", ts(30), { cw5m: 1_000, provisional: 1 });

    expect(claims().some((c) => c.sessionId === "u2")).toBe(false);
  });

  it("stamps slice, fraction, fractionRange, assumed and the detector's own recId", () => {
    insertSession("f1");
    insertSession("f2");
    insertTurn("own-f1", "f1", ts(0));
    for (let i = 0; i < 5; i++)
      addRead(`f1-r${i}`, "f1", "field-path", 3_000, ts(i), i === 0 ? "own-f1" : null);
    insertTurn("own-f2", "f2", ts(20));
    for (let i = 0; i < 5; i++)
      addRead(`f2-r${i}`, "f2", "field-path", 3_000, ts(20 + i), i === 0 ? "own-f2" : null);
    insertTurn("later-f2", "f2", ts(30), { cw5m: 1_000 });

    const f2Claims = claims().filter((c) => c.sessionId === "f2");
    expect(f2Claims.length).toBeGreaterThan(0);
    for (const claim of f2Claims) {
      expect(claim.slice).toBe("result:f2-r0");
      expect(claim.fraction).toBe(0.5);
      expect(claim.fractionRange).toEqual([0.33, 0.7]);
      expect(claim.assumed).toBe(true);
      expect(claim.recId).toBe(recId("D7", WS, `D7-XREAD|${WS}`));
      expect(claim.detectorId).toBe("D7");
    }
  });
});
