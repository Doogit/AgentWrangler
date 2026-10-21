/**
 * test/detector/tier-price.test.ts — PRICE-O55-F1: rec-lane savings are priced at each turn's own
 * tier. Covers the tier-price helper and D4 (target = sonnet-5; source = each lookup turn's own
 * Opus tier). B2/C5/D7 own-tier pricing is asserted in their own detector tests (sonnet-4 turns).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d4Analysis } from "../../src/detector/detectors/d4_model_mismatch.js";
import { buildContext } from "../../src/detector/engine.js";
import { blendedTierPrice, tierPriceVector } from "../../src/detector/tier-price.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});
afterEach(() => db.close());

describe("tierPriceVector / blendedTierPrice", () => {
  it("prefers the freshest snapshot, falls back to LIST_PRICES, zeros for unknown tiers", () => {
    // Fixture seeds a sonnet-4 snapshot [3,15,0.3,3.75,4.5]; it has no opus-5-5 snapshot.
    expect(tierPriceVector(db, "sonnet-4")).toEqual([3, 15, 0.3, 3.75, 4.5]);
    expect(tierPriceVector(db, "opus-5-5")).toEqual([4, 20, 0.2, 5, 8]);
    expect(tierPriceVector(db, null)).toEqual([0, 0, 0, 0, 0]);
    expect(tierPriceVector(db, "no-such-tier")).toEqual([0, 0, 0, 0, 0]);
  });

  it("weights each model's own-tier price by its tokens (sum per tier)", () => {
    // 100 tokens sonnet-4 read 0.3 + 300 tokens opus-5-5 read 0.2 → (30 + 60) / 400.
    const price = blendedTierPrice(
      db,
      [
        { model: "claude-sonnet-4-6", weight: 100 },
        { model: "claude-opus-5-5", weight: 300 },
      ],
      2,
    );
    expect(price).toBeCloseTo(0.225, 10);
  });

  it("uses the unweighted mean at zero total weight and 0 for no items", () => {
    const price = blendedTierPrice(
      db,
      [
        { model: "claude-sonnet-4-6", weight: 0 },
        { model: "claude-opus-5-5", weight: 0 },
      ],
      2,
    );
    expect(price).toBeCloseTo(0.25, 10);
    expect(blendedTierPrice(db, [], 2)).toBe(0);
  });
});

function insLookupTurns(model: string, agentId: string, n: number, cr: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-tier', 'ws-tier', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-tier', 'ws-tier', '/fake/sess-tier.jsonl', '2026-01-02T00:00:00.000Z',
             '2026-01-02T00:00:00.000Z', 'RECONCILED', 1, 0, '[]')`,
  ).run();
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_equiv_u, cost_claim, provisional, parser_version, agent_id)
       VALUES (?, 'sess-tier', 'ws-tier', '2026-01-02T00:00:00.000Z', ?, 1, 60000, 250,
               ?, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1', ?)`,
    ).run(`msg-${agentId}-${i}`, model, cr, agentId);
  }
}

describe("D4 prices each lookup turn at its own Opus tier against sonnet-5", () => {
  it("Opus 5.5 only: cache read $0.20 vs sonnet-5 $0.20 (not $0.50)", () => {
    insLookupTurns("claude-opus-5-5", "lookup-a", 5, 100_000);
    const analysis = d4Analysis(db, buildContext(NOW));
    const ws = analysis.workspaces[0];
    if (!ws) throw new Error("expected D4 to fire");
    // Per turn: 60,000 x (4 - 2) + 250 x (20 - 10) + 100,000 x (0.2 - 0.2) = 122,500; x5 x AV 0.5.
    expect(ws.estimate.rank_value_u_per_wk).toBe(306_250);
    expect(analysis.sonnetFull).toEqual([2, 10, 0.2, 2.5, 4]);
  });

  it("mixed opus + opus-5-5 are grouped and priced per tier", () => {
    insLookupTurns("claude-opus-5-5", "lookup-a", 5, 100_000);
    insLookupTurns("claude-opus-4", "lookup-b", 5, 100_000);
    const ws = d4Analysis(db, buildContext(NOW)).workspaces[0];
    if (!ws) throw new Error("expected D4 to fire");
    // opus-5-5: 122,500/turn. opus [5,25,0.5]: 60,000x3 + 250x15 + 100,000x0.3 = 213,750/turn.
    // (5 x 122,500 + 5 x 213,750) x 0.5 = 840,625.
    expect(ws.estimate.rank_value_u_per_wk).toBe(840_625);
  });
});
