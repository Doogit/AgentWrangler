/**
 * test/detector/b1-claim-producer.test.ts — b1ClaimProducer ledger claims (P3.L L4).
 *
 * B1 claims every pair's CURRENT-turn cw cells whole (no netting — B1 is an in-TTL prefix
 * collapse, not a fresh-start question), priced by the ledger as a repricing (counterfactual
 * = that turn's own cacheRead price). The card (evaluate()) prices the full write price;
 * the ledger prices (write − read) per spec F2 v2 item 1, so the two numbers differ by design.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import {
  b1ClaimProducer,
  b1Detector,
} from "../../src/detector/detectors/b1_cache_read_collapse.js";
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
     VALUES ('snap-b1c-sonnet', 'sonnet-4', ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
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
  const messageId = `msg-b1c-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             0, 0, ?, ?, 0, 0, 0, 'snap-b1c-sonnet',
             0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, workspaceId, ts, opts.cacheReadTokens ?? 0, opts.cacheWrite5m ?? 0);
  return messageId;
}

describe("b1ClaimProducer", () => {
  it("claims the current turn's cw5m cell whole, priced (write − read); recId matches the card", () => {
    const WS = "ws-b1c";
    const SESS = "b1c-sess";
    insWorkspaceSession(WS, SESS);
    insTurn(WS, SESS, "2027-01-02T10:00:00.000Z", {
      cacheReadTokens: 150_000,
      cacheWrite5m: 1_000,
    });
    const currentId = insTurn(WS, SESS, "2027-01-02T10:03:00.000Z", {
      cacheReadTokens: 2_000,
      cacheWrite5m: 150_000,
    });

    const outcome = b1Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WS);
    expect(fired).toBeDefined();
    // U7: the card prices the same way as the ledger: 150,000 × 0.5 × (3.75 − 0.3) = 258,750.
    expect(fired?.modeled_savings_u_per_wk).toBe(258_750);

    const ledger = buildClaimLedger(db, CTX, [b1ClaimProducer]);
    const b1Claims = ledger.claims.filter((claim) => claim.detectorId === "B1");
    expect(b1Claims).toHaveLength(1);
    const claim = b1Claims[0];
    if (!claim) throw new Error("expected one B1 claim");
    expect(claim.component).toBe("cw5m");
    expect(claim.turnKey).toBe(turnKey(SESS, currentId));
    expect(claim.raw_tokens).toBe(150_000);
    expect(claim.counterfactualPriceU).toBe(0.3);
    // Ledger prices (write − read): 150,000 × 0.5 × (3.75 − 0.3) = 258,750 = the card's figure.
    expect(claim.value_u).toBe(258_750);
    expect(claim.value_u).toBe(fired?.modeled_savings_u_per_wk);
    expect(claim.recId).toBe(recId("B1", WS, `B1|${WS}`));

    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("yields nothing when B1 doesn't fire (no collapse pair)", () => {
    const WS = "ws-b1c-nofire";
    const SESS = "b1c-nofire-sess";
    insWorkspaceSession(WS, SESS);
    insTurn(WS, SESS, "2027-01-02T10:00:00.000Z", {
      cacheReadTokens: 200_000,
      cacheWrite5m: 10_000,
    });

    expect(
      b1Detector.evaluate(db, CTX).fired.filter((f) => f.scope_workspace_id === WS),
    ).toHaveLength(0);
    const ledger = buildClaimLedger(db, CTX, [b1ClaimProducer]);
    expect(ledger.claims.filter((claim) => claim.detectorId === "B1")).toHaveLength(0);
  });
});
