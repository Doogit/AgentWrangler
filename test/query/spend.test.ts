/**
 * test/query/spend.test.ts — spend-path SQL building blocks over the fixture DB.
 *
 * Asserts the documented aggregates from test/fixtures/seed.ts:
 *   global reconciled cost = 99_125 μUSD ($0.099125), 8 reconciled turns;
 *   ws-alpha = 49_775 μUSD / 6 turns, ws-beta = 49_350 μUSD / 2 turns.
 * Covers: cache read/write split, provisional exclusion (spend) vs inclusion
 * (context-per-turn / live), the claim-kind guard, and the live-strip on-demand
 * running-cost SUM.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contextPerTurnByModel,
  globalSpend,
  hasStaleClaim,
  liveSessionCount,
  liveSessions,
  spendByWorkspace,
} from "../../src/query/spend.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Window bounds that fully contain the fixture's 2026-01-01 timestamps.
const FROM = "2025-12-01T00:00:00.000Z";
const TO = "2026-02-01T00:00:00.000Z";
// Cutoffs relative to the fixture's LIVE session (last_turn_at = 2026-01-01T05:05Z).
const CUTOFF_BEFORE = "2026-01-01T00:00:00.000Z";
const CUTOFF_AFTER = "2026-01-02T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

describe("spendByWorkspace", () => {
  it("returns per-workspace reconciled spend ordered by cost desc", () => {
    const rows = spendByWorkspace(db, FROM, TO);
    expect(rows.map((r) => r.workspace_id)).toEqual(["ws-alpha", "ws-beta"]);

    const alpha = rows[0];
    const beta = rows[1];
    if (alpha === undefined || beta === undefined) throw new Error("missing rows");

    // Pricing-arithmetic regression: documented micro-USD totals.
    expect(alpha.cost_equiv_u).toBe(49_775);
    expect(alpha.turns).toBe(7); // sess-a1(3) + sess-a2(2) + sess-a3(2)
    expect(beta.cost_equiv_u).toBe(49_350);
    expect(beta.turns).toBe(2);

    // cache read vs write are kept SEPARATE.
    // alpha cache_read: only turn-a1-2 cr=1000; cache_write: turn-a1-2 cw5m=500.
    expect(alpha.cache_read_tok).toBe(1000);
    expect(alpha.cache_write_tok).toBe(500);
    // beta cache_read: turn-b1-1 cr=2000; cache_write: turn-b1-1 cw5m=1000.
    expect(beta.cache_read_tok).toBe(2000);
    expect(beta.cache_write_tok).toBe(1000);

    expect(alpha.unpriced_turns).toBe(0);
    expect(alpha.claim_kinds).toBe(1);
  });

  it("excludes provisional turns (ws-beta's LIVE haiku turn is not summed)", () => {
    const rows = spendByWorkspace(db, FROM, TO);
    const beta = rows.find((r) => r.workspace_id === "ws-beta");
    // 49_350 (reconciled) — NOT 50_950 (which would include the 1_600 provisional turn).
    expect(beta?.cost_equiv_u).toBe(49_350);
    expect(beta?.turns).toBe(2);
  });
});

describe("globalSpend", () => {
  it("sums reconciled cost and counts provisional separately", () => {
    const g = globalSpend(db, FROM, TO);
    expect(g.cost_equiv_u).toBe(99_125); // $0.099125
    expect(g.cost_equiv_u / 1e6).toBeCloseTo(0.099125, 9);
    expect(g.turns).toBe(9); // reconciled: alpha 7 + beta 2
    expect(g.turns_total).toBe(10); // includes the provisional LIVE turn
    expect(g.unpriced_turns).toBe(0);
    expect(g.claim_kinds).toBe(1);
  });
});

describe("contextPerTurnByModel", () => {
  it("groups by model and INCLUDES provisional turns (differs from spend)", () => {
    const rows = contextPerTurnByModel(db, FROM, TO);
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));

    // haiku turns: a2-2, a3-1, a3-2, and the provisional b2-1 => 4 (provisional included).
    expect(byModel["claude-haiku"]?.n).toBe(4);
    // sonnet turns: a1-1, a1-2, a1-3, a2-1, b1-1, b1-2 => 6.
    expect(byModel["claude-sonnet"]?.n).toBe(6);

    // avg_context_per_turn (context = input + cache_read + cache_write*).
    // sonnet contexts: 1000,3500,1500,3000,8000,2500 => mean 3250.
    expect(byModel["claude-sonnet"]?.avg_context_per_turn).toBeCloseTo(3250, 6);
    // usd_per_turn sonnet = 96_525 / 6 / 1e6.
    expect(byModel["claude-sonnet"]?.usd_per_turn).toBeCloseTo(96_525 / 6 / 1e6, 12);
  });
});

describe("claim-kind guard", () => {
  it("hasStaleClaim is false on the clean fixture", () => {
    expect(hasStaleClaim(db, FROM, TO)).toBe(false);
  });

  it("surfaces mixed cost_claim kinds instead of a silent single kind", () => {
    // Add one reconciled turn with a STALE claim in ws-alpha's window.
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model,
         is_sidechain, input_tokens, output_tokens, cache_read_tokens,
         cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes,
         pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES ('msg-stale','sess-a1','ws-alpha','2026-01-01T00:30:00.000Z','claude-sonnet',
         0, 100, 10, 0, 0, 0, 0, NULL, 'snap-sonnet', 450, 'LIST_EQUIV_STALE', 0, 'test-v1')`,
    ).run();

    const alpha = spendByWorkspace(db, FROM, TO).find((r) => r.workspace_id === "ws-alpha");
    expect(alpha?.claim_kinds).toBe(2);
    expect(hasStaleClaim(db, FROM, TO)).toBe(true);
    expect(globalSpend(db, FROM, TO).claim_kinds).toBe(2);
  });
});

describe("live strip building block", () => {
  it("liveSessionCount honors the activity cutoff", () => {
    expect(liveSessionCount(db, CUTOFF_BEFORE)).toBe(1);
    expect(liveSessionCount(db, CUTOFF_AFTER)).toBe(0);
  });

  it("returns the LIVE session with on-demand running cost and latest context", () => {
    const rows = liveSessions(db, CUTOFF_BEFORE);
    expect(rows.length).toBe(1);
    const r = rows[0];
    if (r === undefined) throw new Error("missing live row");
    expect(r.session_id).toBe("sess-b2");
    expect(r.workspace_id).toBe("ws-beta");
    expect(r.project_slug).toBe("project-beta");
    expect(r.running_usd_u).toBe(1_600); // SUM over the session's turns
    expect(r.current_context_tokens).toBe(1_000); // b2-1 context = input(1000)
    expect(r.model).toBe("claude-haiku");
    expect(r.started_at).toBe("2026-01-01T05:00:00.000Z");
  });

  it("running_usd_u uses an on-demand SUM, not the stale sessions.cost_equiv_u", () => {
    // Add a second provisional turn to sess-b2 WITHOUT touching sessions.cost_equiv_u.
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model,
         is_sidechain, input_tokens, output_tokens, cache_read_tokens,
         cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes,
         pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES ('msg-b2-2','sess-b2','ws-beta','2026-01-01T05:06:00.000Z','claude-haiku',
         0, 500, 0, 0, 0, 0, 0, NULL, 'snap-haiku', 400, 'LIST_EQUIV', 1, 'test-v1')`,
    ).run();

    const storedRollforward = (
      db.prepare("SELECT cost_equiv_u AS c FROM sessions WHERE session_id = 'sess-b2'").get() as {
        c: number;
      }
    ).c;
    expect(storedRollforward).toBe(1_600); // rollforward is stale

    const r = liveSessions(db, CUTOFF_BEFORE)[0];
    // On-demand SUM sees both turns: 1_600 + 400 = 2_000.
    expect(r?.running_usd_u).toBe(2_000);
  });
});
