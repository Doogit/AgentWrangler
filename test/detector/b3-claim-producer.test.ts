/**
 * test/detector/b3-claim-producer.test.ts — b3ClaimProducer ledger claims (P3.L L4).
 *
 * B3 fires one rec per event (its scopeKey is per-event, not per-workspace). The producer
 * splits the event's avoidable-of-base creation to the cw5m/cw1h cells exactly as D8 and
 * reprices at (cell price − the turn's own cacheRead price).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import { b3ClaimProducer, b3Detector } from "../../src/detector/detectors/b3_resume_cache_miss.js";
import { recId } from "../../src/detector/rec-id.js";
import { turnKey } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const SONNET4_PRICES = "[3,15,0.3,3.75,6]";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-b3c-sonnet', 'sonnet-4', ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run(SONNET4_PRICES);
});

afterEach(() => db.close());

function insWorkspaceSession(workspaceId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-02T10:00:00.000Z', '2027-01-02T12:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`);
}

function insTurn(
  workspaceId: string,
  sessionId: string,
  ts: string,
  opts: { cacheReadTokens?: number; cacheWrite5m?: number },
): string {
  const messageId = `msg-b3c-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             0, 0, ?, ?, 0, 0, 0, 'snap-b3c-sonnet',
             0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, workspaceId, ts, opts.cacheReadTokens ?? 0, opts.cacheWrite5m ?? 0);
  return messageId;
}

describe("b3ClaimProducer", () => {
  it("claims the net-of-base creation on the resume turn; recId is the per-event scopeKey", () => {
    const WS = "ws-b3c";
    const SESS1 = "b3c-sess1";
    const SESS2 = "b3c-sess2";
    const WI = "gh:test/repo#401";

    insWorkspaceSession(WS, SESS1);
    insWorkspaceSession(WS, SESS2);
    // Three unrelated fresh sessions set the workspace's base prefix at 30,000.
    for (const fresh of ["b3c-fresh-a", "b3c-fresh-b", "b3c-fresh-c"]) {
      insWorkspaceSession(WS, fresh);
      insTurn(WS, fresh, "2027-01-02T08:00:00.000Z", { cacheWrite5m: 30_000 });
    }
    insTurn(WS, SESS1, "2027-01-02T10:00:00.000Z", { cacheReadTokens: 100_000 });
    const currentId = insTurn(WS, SESS2, "2027-01-02T10:03:00.000Z", {
      cacheReadTokens: 2_000,
      cacheWrite5m: 100_000,
    });

    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, ?, 401, 'OPEN', '2027-01-01T00:00:00.000Z')`,
    ).run(WI, WS);
    for (const sess of [SESS1, SESS2]) {
      db.prepare(
        `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
         VALUES (?, ?, 1.0, 'BRANCH')`,
      ).run(sess, WI);
    }

    const outcome = b3Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    const fired = outcome.fired[0];
    if (!fired) throw new Error("expected one B3 finding");
    // Card and ledger price alike: (100,000 − 30,000) × 0.5 × (3.75 − 0.3) = 120,750.
    expect(fired.modeled_savings_u_per_wk).toBe(120_750);
    const expectedRecId = recId("B3", WS, fired.scopeKey);

    const ledger = buildClaimLedger(db, CTX, [b3ClaimProducer]);
    const b3Claims = ledger.claims.filter((claim) => claim.detectorId === "B3");
    expect(b3Claims).toHaveLength(1);
    const claim = b3Claims[0];
    if (!claim) throw new Error("expected one B3 claim");
    expect(claim.component).toBe("cw5m");
    expect(claim.turnKey).toBe(turnKey(SESS2, currentId));
    // avoidable = 100,000 − 30,000 = 70,000, entirely on cw5m (net = raw since creation is
    // all cw5m); ledger prices (write − read): 70,000 × 0.5 × (3.75 − 0.3) = 120,750.
    expect(claim.raw_tokens).toBe(70_000);
    expect(claim.counterfactualPriceU).toBe(0.3);
    expect(claim.value_u).toBe(120_750);
    expect(claim.recId).toBe(expectedRecId);

    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("emits nothing when the resume only re-creates the base prefix (avoidable == 0)", () => {
    const WS = "ws-b3c-noavoid";
    const SESS1 = "b3c-noavoid-sess1";
    const SESS2 = "b3c-noavoid-sess2";
    const WI = "gh:test/repo#402";
    insWorkspaceSession(WS, SESS1);
    insWorkspaceSession(WS, SESS2);
    // Only two sessions: median first-turn context (20,000 and 20,001+2,000) ≥ 20,001 re-created.
    insTurn(WS, SESS1, "2027-01-02T10:00:00.000Z", { cacheReadTokens: 20_000 });
    insTurn(WS, SESS2, "2027-01-02T10:03:00.000Z", {
      cacheReadTokens: 2_000,
      cacheWrite5m: 20_001,
    });
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, ?, 402, 'OPEN', '2027-01-01T00:00:00.000Z')`,
    ).run(WI, WS);
    for (const sess of [SESS1, SESS2]) {
      db.prepare(
        `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
         VALUES (?, ?, 1.0, 'BRANCH')`,
      ).run(sess, WI);
    }

    const outcome = b3Detector.evaluate(db, CTX);
    // A resume that only re-creates the base prefix is no resume miss: no finding, no claim.
    expect(outcome.fired).toHaveLength(0);

    const ledger = buildClaimLedger(db, CTX, [b3ClaimProducer]);
    expect(ledger.claims.filter((claim) => claim.detectorId === "B3")).toHaveLength(0);
  });
});
