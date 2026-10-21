/**
 * test/detector/cache-claim-disjoint.test.ts — B1/D8/B3 ledger claims never share a turn
 * (P3.L L4). B1 owns gap ≤ thread TTL, D8 owns gap > thread TTL (cache-ttl.ts); the claim
 * producers must preserve that partition, and buildClaimLedger over all three producers on
 * the same fixture must report zero doubleOwned/overbilled/overvalued.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import {
  b1ClaimProducer,
  b1Detector,
} from "../../src/detector/detectors/b1_cache_read_collapse.js";
import { b3ClaimProducer } from "../../src/detector/detectors/b3_resume_cache_miss.js";
import { d8ClaimProducer, d8Detector } from "../../src/detector/detectors/d8_cache_write_churn.js";
import { turnKey } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const BASE = Date.parse("2027-01-02T00:00:00.000Z");

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-mix', 'ws-mix', '2027-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
       state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-mix', 'ws-mix', '/fixture/sess-mix.jsonl', '2027-01-02T00:00:00.000Z',
             '2027-01-02T03:00:00.000Z', 'RECONCILED', 0, 0, '[]')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-mix', 'sonnet-4', '[3,15,0.3,3.75,6]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function insTurn(offsetMin: number, f: { input?: number; cr?: number; cw5m?: number }): string {
  const { input = 0, cr = 0, cw5m = 0 } = f;
  const ts = new Date(BASE + offsetMin * 60_000).toISOString();
  const messageId = `msg-mix-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, 'sess-mix', 'ws-mix', ?, 'claude-sonnet-4-6',
             0, ?, 0, ?, ?, 0, 0, NULL, 'snap-mix', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, ts, input, cr, cw5m);
  return messageId;
}

describe("B1 ∩ D8 claim producers — no turn claimed by both", () => {
  it("partitions one session's in-TTL collapse (B1) from its idle-gap spikes (D8)", () => {
    // Anchor: small first turn → D8's fresh-start base = 7,000.
    insTurn(0, { input: 2000, cr: 5000 });
    // B1 pair: prior turn (large read, sets 5m thread tier), then a collapse 3 min later
    // (within the 5m TTL) that re-writes 150,000 with a low read — also D8-shaped, but the
    // gap keeps it out of D8's side of the partition.
    insTurn(60, { cr: 150_000, cw5m: 1_000 });
    const collapseId = insTurn(63, { cr: 2_000, cw5m: 150_000 });
    // Three idle-gap spikes (> 5 min TTL) → D8 churn events.
    const spike1 = insTurn(113, { cw5m: 60_000, cr: 0 });
    const spike2 = insTurn(123, { cw5m: 60_000, cr: 0 });
    const spike3 = insTurn(133, { cw5m: 60_000, cr: 0 });

    // Sanity: both detectors actually fire for ws-mix on this fixture.
    expect(b1Detector.evaluate(db, CTX).fired.some((f) => f.scope_workspace_id === "ws-mix")).toBe(
      true,
    );
    expect(d8Detector.evaluate(db, CTX).fired.some((f) => f.scope_workspace_id === "ws-mix")).toBe(
      true,
    );

    const ledger = buildClaimLedger(db, CTX, [d8ClaimProducer, b1ClaimProducer, b3ClaimProducer]);
    const d8TurnKeys = new Set(
      ledger.claims.filter((c) => c.detectorId === "D8").map((c) => c.turnKey),
    );
    const b1TurnKeys = new Set(
      ledger.claims.filter((c) => c.detectorId === "B1").map((c) => c.turnKey),
    );
    expect(d8TurnKeys.size).toBeGreaterThan(0);
    expect(b1TurnKeys.size).toBeGreaterThan(0);
    // No turnKey is claimed by both detectors.
    for (const key of d8TurnKeys) expect(b1TurnKeys.has(key)).toBe(false);

    // The collapse turn belongs to B1 only; the idle-gap spikes to D8 only.
    const collapseKey = turnKey("sess-mix", collapseId);
    expect(b1TurnKeys.has(collapseKey)).toBe(true);
    expect(d8TurnKeys.has(collapseKey)).toBe(false);
    for (const spikeId of [spike1, spike2, spike3]) {
      const key = turnKey("sess-mix", spikeId);
      expect(d8TurnKeys.has(key)).toBe(true);
      expect(b1TurnKeys.has(key)).toBe(false);
    }

    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });
});
