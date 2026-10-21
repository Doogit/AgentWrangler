/**
 * test/detector/cache-b1-d8-disjoint.test.ts — B1 and D8 never price the same turn.
 *
 * P3.2 (2026-09-25): B1 is the in-TTL collapse (gap ≤ thread TTL), D8 the idle
 * re-write (gap > thread TTL). A turn that is both a B1 collapse and a D8 spike must
 * land in exactly one of them. Sweeps gaps across both TTL boundaries and every
 * prior/current write-tier combination; the expected owner is derived here from the
 * RQ4 rule (1h tier → 60 min, 5m tier → 5 min, no tier → main default 60 min).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b1Detector } from "../../src/detector/detectors/b1_cache_read_collapse.js";
import { d8Detector } from "../../src/detector/detectors/d8_cache_write_churn.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const BASE = Date.parse("2027-01-02T00:00:00.000Z");

type Tier = "5m" | "1h" | null;
const TIER_TTL_MIN = { "5m": 5, "1h": 60 } as const;
const GAPS_MIN = [1, 4, 5, 6, 30, 59, 60, 61, 120, 600];
const PRIOR: Tier[] = [null, "5m", "1h"];
const CURRENT: Exclude<Tier, null>[] = ["5m", "1h"];

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-disjoint', 'sonnet-4', '[3,15,0.3,3.75,6]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
});
afterEach(() => db.close());

function insTurn(ws: string, sess: string, ts: string, cr: number, tier: Tier, tokens: number) {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, 0, 0, ?, ?, ?, 0, 0, 'snap-disjoint', 0,
             'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    `msg-dj-${seq++}`,
    sess,
    ws,
    ts,
    cr,
    tier === "5m" ? tokens : 0,
    tier === "1h" ? tokens : 0,
  );
}

describe("B1 ∩ D8 — no turn priced by both", () => {
  it("partitions every collapse-with-spike turn between B1 (in-TTL) and D8 (idle)", () => {
    const expected = new Map<string, "B1" | "D8">();
    for (const prior of PRIOR)
      for (const current of CURRENT)
        for (const gap of GAPS_MIN) {
          const ws = `ws-dj-${prior ?? "none"}-${current}-${gap}`;
          const sess = `${ws}-sess`;
          db.prepare(
            `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
             VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
          ).run(ws, ws);
          db.prepare(
            `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
               state, turn_count, cost_equiv_u, hygiene_flags)
             VALUES (?, ?, ?, '2027-01-02T00:00:00.000Z', '2027-01-02T12:00:00.000Z',
               'RECONCILED', 0, 0, '[]')`,
          ).run(sess, ws, `/fixture/${sess}.jsonl`);
          // An empty opening turn keeps D8's fresh-start base at 0 (P3.1-T9 netting), so D8's
          // side of the partition still has something avoidable.
          insTurn(ws, sess, new Date(BASE - 60_000).toISOString(), 0, null, 0);
          // Warm prior turn (61k context), then a collapse (reads 60k → 1k) that re-writes 60k.
          insTurn(ws, sess, new Date(BASE).toISOString(), 60_000, prior, 1_000);
          insTurn(ws, sess, new Date(BASE + gap * 60_000).toISOString(), 1_000, current, 60_000);
          const ttl = TIER_TTL_MIN[prior ?? current];
          expected.set(ws, gap <= ttl ? "B1" : "D8");
        }

    const b1 = new Set(b1Detector.evaluate(db, CTX).fired.map((f) => f.scope_workspace_id));
    const d8 = new Set(d8Detector.evaluate(db, CTX).fired.map((f) => f.scope_workspace_id));

    for (const [ws, owner] of expected) {
      expect({ ws, b1: b1.has(ws), d8: d8.has(ws) }).toEqual({
        ws,
        b1: owner === "B1",
        d8: owner === "D8",
      });
    }
    // Both sides of the partition are exercised.
    expect([...expected.values()].filter((o) => o === "B1").length).toBeGreaterThan(0);
    expect([...expected.values()].filter((o) => o === "D8").length).toBeGreaterThan(0);
  });
});
