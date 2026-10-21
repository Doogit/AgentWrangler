/**
 * test/detector/d2-claim-producer.test.ts — d2ClaimProducer ledger claims (P3.L L2).
 *
 * D2's producer must (a) match the detector's own modeled_savings_u_per_wk on a uniform-price
 * fixture (within rounding), (b) never attribute a sidechain turn (D2 is main-thread only),
 * and (c) yield nothing when the detector itself doesn't fire. Fixture helpers mirror
 * d2-session-long-full-context.test.ts.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { d2ClaimProducer } from "../../src/detector/detectors/d2_session_long_full_context.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();
const QUALIFYING_SESSIONS = 3;

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d2','ws-d2','2027-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function insertSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-d2', ?, '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, `/fake/${sessionId}.jsonl`);
}

let messageSequence = 0;

function insertTurn(
  sessionId: string,
  timestampIso: string,
  cacheRead: number,
  sidechain = 0,
): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-d2', ?, 'claude-sonnet',
             ?, 0, 0, ?, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(`msg-d2c-${messageSequence++}`, sessionId, timestampIso, sidechain, cacheRead);
}

function timestamp(offsetMinutes: number): string {
  return new Date(BASE + offsetMinutes * 60_000).toISOString();
}

/**
 * review 3 B5 growth fixture (same shape as d2-session-long-full-context.test.ts): 3 sessions
 * × 300 calls, call i reads 40,000 + 1,000·i. Every turn's usage is cache-read only, so
 * context_tokens == cache_read_tokens for every row — a clean k=1 basis for the
 * context-avoided → cache-read-tokens conversion the producer's fraction relies on.
 */
function addGrowthFixture(): void {
  for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
    insertSession(`sess-grow-${s}`);
    for (let i = 0; i < 300; i++) {
      insertTurn(`sess-grow-${s}`, timestamp(s * 400 + i), 40_000 + 1_000 * i);
    }
  }
}

describe("d2ClaimProducer", () => {
  it("sums to the detector's modeled_savings_u_per_wk within rounding (uniform price)", () => {
    addGrowthFixture();
    runDetectors(db, { now: NOW });
    const rec = db.prepare("SELECT * FROM recommendations WHERE detector_id = 'D2'").get() as
      | { modeled_savings_u_per_wk: number }
      | undefined;
    expect(rec).toBeDefined();
    const savingsU = (rec as { modeled_savings_u_per_wk: number }).modeled_savings_u_per_wk;
    expect(savingsU).toBeGreaterThan(0);

    const ledger = buildClaimLedger(db, buildContext(NOW), [d2ClaimProducer]);
    const d2Claims = ledger.claims.filter((claim) => claim.detectorId === "D2");
    expect(d2Claims.length).toBeGreaterThan(0);
    const totalValueU = d2Claims.reduce((sum, claim) => sum + claim.value_u, 0);

    expect(Math.abs(totalValueU - savingsU) / savingsU).toBeLessThan(0.01);
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("gives no claims to sidechain turns", () => {
    addGrowthFixture();
    // Sidechain turns interleaved in the same sessions/window — D2's own query excludes them
    // (is_sidechain = 0), so the producer must never claim one either.
    for (let s = 1; s <= QUALIFYING_SESSIONS; s++) {
      for (let i = 0; i < 10; i++) {
        insertTurn(`sess-grow-${s}`, timestamp(s * 400 + 300 + i), 500_000, 1);
      }
    }
    runDetectors(db, { now: NOW });
    const ledger = buildClaimLedger(db, buildContext(NOW), [d2ClaimProducer]);
    const sidechainKeys = new Set(
      (
        db
          .prepare("SELECT message_id, session_id FROM turns WHERE is_sidechain = 1")
          .all() as Array<{
          message_id: string;
          session_id: string;
        }>
      ).map((row) => `${row.session_id}|${row.message_id}`),
    );
    expect(sidechainKeys.size).toBeGreaterThan(0);
    for (const claim of ledger.claims.filter((claim) => claim.detectorId === "D2"))
      expect(sidechainKeys.has(claim.turnKey)).toBe(false);
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("yields nothing when D2 doesn't fire (below the qualifying-session minimum)", () => {
    insertSession("sess-lone");
    for (let i = 0; i < 300; i++) insertTurn("sess-lone", timestamp(i), 200_000);
    runDetectors(db, { now: NOW });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id = 'D2'").get(),
    ).toEqual({ n: 0 });
    const ledger = buildClaimLedger(db, buildContext(NOW), [d2ClaimProducer]);
    expect(ledger.claims.filter((claim) => claim.detectorId === "D2")).toHaveLength(0);
  });
});
