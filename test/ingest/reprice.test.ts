/**
 * test/ingest/reprice.test.ts — PRICE-O55 boot re-price.
 *
 * Turns ingested before a tier existed keep the old tier's snapshot and cost.
 * The boot re-price moves them to the snapshot their model resolves to now and
 * moves the session roll-up by the same delta. Oracle: costs hand-computed from
 * Anthropic's list prices (opus-5-5 $4/$20/$0.20/$5/$8, opus $5/$25/$0.5/$6.25/$10).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { LIST_PRICES, LIST_PRICE_VERSIONS } from "../../src/ingest/pricing.js";
import { repriceTurns } from "../../src/ingest/reprice.js";
import { migratedMemDb } from "./dbutil.js";

const NOW = "2026-09-26T00:00:00.000Z";
let db: Db;

// Tokens: input 1000, output 200, cache read 10000, 5m write 1000, 1h write 1000.
// Old (opus tier):   5000 + 5000 + 5000 + 6250 + 10000 = 31250
// New (opus-5-5):    4000 + 4000 + 2000 + 5000 +  8000 = 23000
const OLD_COST = 31_250;
const NEW_COST = 23_000;

function insertTurn(id: string, session: string, model: string, cost: number): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, input_tokens,
       output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
       pricing_snapshot_id, cost_equiv_u, parser_version)
     VALUES (?, ?, 'ws', ?, ?, 1000, 200, 10000, 1000, 1000, 0, 'list-opus-v2', ?, 'test')`,
  ).run(id, session, NOW, model, cost);
}

function sessionCost(session: string): number {
  return (
    db.prepare("SELECT cost_equiv_u FROM sessions WHERE session_id = ?").get(session) as {
      cost_equiv_u: number;
    }
  ).cost_equiv_u;
}

beforeEach(() => {
  db = migratedMemDb();
  // Seeded as an older daemon would have: every tier except opus-5-5.
  db.prepare(
    `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('list-opus-v2', 'opus', '[5,25,0.5,6.25,10]', '2026-09-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z')`,
  ).run();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', ?)",
  ).run(NOW);
  for (const s of ["s1", "s2"]) {
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u)
       VALUES (?, 'ws', ?, 'RECONCILED', 0, 0)`,
    ).run(s, `${s}.jsonl`);
  }
  // s1: one Opus 5.5 turn (mispriced) + one Opus 5 turn (correct). s2: Opus 5 only.
  insertTurn("m1", "s1", "claude-opus-5-5", OLD_COST);
  insertTurn("m2", "s1", "claude-opus-5", OLD_COST);
  insertTurn("m3", "s2", "claude-opus-5", OLD_COST);
  db.prepare("UPDATE sessions SET cost_equiv_u = ? WHERE session_id = 's1'").run(2 * OLD_COST);
  db.prepare("UPDATE sessions SET cost_equiv_u = ? WHERE session_id = 's2'").run(OLD_COST);
});
afterEach(() => db.close());

describe("repriceTurns", () => {
  it("re-prices Opus 5.5 turns at the official rate and moves the session total by the delta", () => {
    const res = repriceTurns(db, NOW);
    expect(res.turns).toBe(1);
    expect(res.deltaU).toBe(NEW_COST - OLD_COST);

    const m1 = db
      .prepare("SELECT cost_equiv_u, pricing_snapshot_id FROM turns WHERE message_id = 'm1'")
      .get() as { cost_equiv_u: number; pricing_snapshot_id: string };
    expect(m1).toEqual({ cost_equiv_u: NEW_COST, pricing_snapshot_id: "list-opus-5-5-v2" });
    expect(sessionCost("s1")).toBe(NEW_COST + OLD_COST);
    // Opus 5 turns and their sessions are untouched.
    const m2 = db.prepare("SELECT cost_equiv_u FROM turns WHERE message_id = 'm2'").get() as {
      cost_equiv_u: number;
    };
    expect(m2.cost_equiv_u).toBe(OLD_COST);
    expect(sessionCost("s2")).toBe(OLD_COST);
  });

  it("leaves a turn on another snapshot of its own tier as priced", () => {
    db.prepare(
      `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
       VALUES ('fixture-opus', 'opus', '[1,1,1,1,1]', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      "UPDATE turns SET pricing_snapshot_id = 'fixture-opus' WHERE message_id = 'm3'",
    ).run();
    expect(repriceTurns(db, NOW).turns).toBe(1); // only m1 (opus-5-5 on the opus tier)
    const m3 = db
      .prepare("SELECT cost_equiv_u, pricing_snapshot_id FROM turns WHERE message_id = 'm3'")
      .get();
    expect(m3).toEqual({ cost_equiv_u: OLD_COST, pricing_snapshot_id: "fixture-opus" });
  });

  it("is idempotent: a second run changes nothing", () => {
    repriceTurns(db, NOW);
    expect(repriceTurns(db, NOW)).toEqual({ turns: 0, deltaU: 0 });
    expect(sessionCost("s1")).toBe(NEW_COST + OLD_COST);
  });

  // F24 oracle: platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-14 ($/MTok).
  // An older daemon filed Sonnet 5.5 under sonnet-5 (cache read $0.20, page $0.10) and Haiku 5.5
  // under haiku (Haiku 4.5 rates). The boot re-price moves them to their own tiers.
  describe("F24: Sonnet 5.5 and Haiku 5.5 tiers", () => {
    function insertF24(
      id: string,
      model: string,
      snapshot: string,
      cost: number,
      [input, output, read, w5m, w1h]: [number, number, number, number, number],
    ): void {
      db.prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, input_tokens,
           output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
           pricing_snapshot_id, cost_equiv_u, parser_version)
         VALUES (?, 's3', 'ws', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'test')`,
      ).run(id, NOW, model, input, output, read, w5m, w1h, snapshot, cost);
    }
    const TOKENS: [number, number, number, number, number] = [1000, 200, 10000, 1000, 1000];
    // sonnet-5 [2,10,0.2,2.5,4]: 2000+2000+2000+2500+4000 = 12500
    // sonnet-5-5 [2,10,0.1,2.5,4]: 2000+2000+1000+2500+4000 = 11500
    // haiku (4.5) [1,5,0.1,1.25,2]: 1000+1000+1000+1250+2000 = 6250
    // haiku-5-5 [0.1,0.5,0.01,0.125,0.2] (prompt 13,000): 100+100+100+125+200 = 625
    // long turn: in 1000, out 200, read 200000 (prompt 201,000 > 100k):
    //   haiku: 1000+1000+20000 = 22000; haiku-5-5-long [0.5,2.5,0.05,..]: 500+500+10000 = 11000
    const LONG: [number, number, number, number, number] = [1000, 200, 200_000, 0, 0];

    beforeEach(() => {
      repriceTurns(db, NOW); // settle the base fixture (m1) and seed every list snapshot
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u)
         VALUES ('s3', 'ws', 's3.jsonl', 'RECONCILED', 0, ?)`,
      ).run(12500 + 12500 + 6250 + 22000);
      insertF24("f1", "claude-sonnet-5-5", "list-sonnet-5-v2", 12500, TOKENS);
      insertF24("f2", "claude-sonnet-5", "list-sonnet-5-v2", 12500, TOKENS);
      insertF24("f3", "claude-haiku-5-5", "list-haiku-v2", 6250, TOKENS);
      insertF24("f4", "claude-haiku-5-5", "list-haiku-v2", 22000, LONG);
    });

    it("re-prices to the published rates; Sonnet 5 untouched; session moves by the delta", () => {
      const res = repriceTurns(db, NOW);
      expect(res).toEqual({ turns: 3, deltaU: 11500 - 12500 + (625 - 6250) + (11000 - 22000) });
      const rows = db
        .prepare(
          "SELECT message_id, cost_equiv_u, pricing_snapshot_id FROM turns WHERE session_id = 's3' ORDER BY 1",
        )
        .all();
      expect(rows).toEqual([
        { message_id: "f1", cost_equiv_u: 11500, pricing_snapshot_id: "list-sonnet-5-5-v2" },
        { message_id: "f2", cost_equiv_u: 12500, pricing_snapshot_id: "list-sonnet-5-v2" },
        { message_id: "f3", cost_equiv_u: 625, pricing_snapshot_id: "list-haiku-5-5-v2" },
        { message_id: "f4", cost_equiv_u: 11000, pricing_snapshot_id: "list-haiku-5-5-long-v2" },
      ]);
      expect(sessionCost("s3")).toBe(11500 + 12500 + 625 + 11000);
    });

    it("is idempotent: a second run moves nothing (long-prompt turn included)", () => {
      repriceTurns(db, NOW);
      expect(repriceTurns(db, NOW)).toEqual({ turns: 0, deltaU: 0 });
      expect(repriceTurns(db, "2026-09-27T00:00:00.000Z")).toEqual({ turns: 0, deltaU: 0 });
      expect(sessionCost("s3")).toBe(11500 + 12500 + 625 + 11000);
    });

    it("moves a ≤100k Haiku 5.5 turn wrongly filed on the long tier back", () => {
      repriceTurns(db, NOW);
      db.prepare(
        "UPDATE turns SET pricing_snapshot_id = 'list-haiku-5-5-long-v2', cost_equiv_u = 3125 WHERE message_id = 'f3'",
      ).run();
      expect(repriceTurns(db, NOW)).toEqual({ turns: 1, deltaU: 625 - 3125 });
    });
  });

  describe("changed price on an existing tier (version bump)", () => {
    const LATER = "2026-09-27T00:00:00.000Z";
    const savedPrices = LIST_PRICES.opus;
    const savedVersion = LIST_PRICE_VERSIONS.opus;
    // Bumped opus [6,30,0.6,7.5,12]: 6000 + 6000 + 6000 + 7500 + 12000 = 37500.
    const BUMPED_COST = 37_500;

    afterEach(() => {
      if (savedPrices !== undefined) LIST_PRICES.opus = savedPrices;
      if (savedVersion !== undefined) LIST_PRICE_VERSIONS.opus = savedVersion;
    });

    function bump(): void {
      LIST_PRICES.opus = [6, 30, 0.6, 7.5, 12];
      LIST_PRICE_VERSIONS.opus = 3;
    }

    it("with current versions nothing moves after the first settle", () => {
      repriceTurns(db, NOW);
      expect(repriceTurns(db, LATER)).toEqual({ turns: 0, deltaU: 0 });
    });

    it("re-prices exactly that tier's list-priced turns; session delta equals turn delta; second run moves 0", () => {
      repriceTurns(db, NOW); // settle m1 onto opus-5-5
      bump();
      const res = repriceTurns(db, LATER);
      const delta = BUMPED_COST - OLD_COST;
      expect(res).toEqual({ turns: 2, deltaU: 2 * delta }); // m2 + m3 (opus tier)
      const rows = db
        .prepare("SELECT message_id, cost_equiv_u, pricing_snapshot_id FROM turns ORDER BY 1")
        .all();
      expect(rows).toEqual([
        { message_id: "m1", cost_equiv_u: NEW_COST, pricing_snapshot_id: "list-opus-5-5-v2" },
        { message_id: "m2", cost_equiv_u: BUMPED_COST, pricing_snapshot_id: "list-opus-v3" },
        { message_id: "m3", cost_equiv_u: BUMPED_COST, pricing_snapshot_id: "list-opus-v3" },
      ]);
      expect(sessionCost("s1")).toBe(NEW_COST + BUMPED_COST);
      expect(sessionCost("s2")).toBe(BUMPED_COST);
      expect(repriceTurns(db, LATER)).toEqual({ turns: 0, deltaU: 0 });
    });

    it("leaves a fixture (non-list) snapshot turn untouched", () => {
      db.prepare(
        `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
         VALUES ('fixture-opus', 'opus', '[1,1,1,1,1]', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        "UPDATE turns SET pricing_snapshot_id = 'fixture-opus' WHERE message_id = 'm3'",
      ).run();
      repriceTurns(db, NOW);
      bump();
      expect(repriceTurns(db, LATER).turns).toBe(1); // m2 only
      const m3 = db
        .prepare("SELECT cost_equiv_u, pricing_snapshot_id FROM turns WHERE message_id = 'm3'")
        .get();
      expect(m3).toEqual({ cost_equiv_u: OLD_COST, pricing_snapshot_id: "fixture-opus" });
    });
  });
});
