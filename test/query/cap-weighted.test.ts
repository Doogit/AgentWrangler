/**
 * test/query/cap-weighted.test.ts — cap-weighted token meter (Data Model §2A).
 *
 * Core invariant: the four usage fields are NEVER summed at uniform weight —
 * cache_read is down-weighted by COEFF (~0.1×), cache creations + input + output
 * are full weight. This is the whole point of the meter vs the frozen
 * context_tokens column (which sums everything 1×).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CapWeightedRow,
  DEFAULT_CAP_READ_COEFF,
  capWeightExprSql,
  capWeightForTurn,
  capWeightedTokens,
  resolveCapReadCoeff,
} from "../../src/query/cap-weighted.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Isolated window in 2027 so fixture turns (2026) never leak into assertions.
const FROM = "2027-01-01T00:00:00.000Z";
const TO = "2027-01-02T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-cap', 'ws-cap', '2027-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-cap', 'ws-cap', '/fake/sess-cap.jsonl',
             '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'RECONCILED', 0, 0, '[]')`,
  ).run();
});

afterEach(() => db.close());

let seq = 0;
function insTurn(fields: {
  input?: number;
  output?: number;
  cr?: number;
  cw5m?: number;
  cw1h?: number;
  cwOther?: number;
  sidechain?: number;
  provisional?: number;
  sessionId?: string;
}): void {
  const {
    input = 0,
    output = 0,
    cr = 0,
    cw5m = 0,
    cw1h = 0,
    cwOther = 0,
    sidechain = 0,
    provisional = 0,
    sessionId = "sess-cap",
  } = fields;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-cap', '2027-01-01T00:00:00.000Z', 'claude-sonnet',
             ?, ?, ?, ?, ?, ?, ?, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    `msg-cap-${seq++}`,
    sessionId,
    sidechain,
    input,
    output,
    cr,
    cw5m,
    cw1h,
    cwOther,
    provisional,
  );
}

describe("capWeightExprSql — throw guard", () => {
  it("throws on NaN coeff", () => {
    expect(() => capWeightExprSql("t", Number.NaN)).toThrow();
  });

  it("throws on Infinity coeff", () => {
    expect(() => capWeightExprSql("t", Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("resolveCapReadCoeff", () => {
  it("defaults to 0.1 when the config row is absent", () => {
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
    expect(DEFAULT_CAP_READ_COEFF).toBe(0.1);
  });

  it("reads a configured value (1.0× upper-bound regime)", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','1.0','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(1.0);
  });

  it("reads a valid sub-default value (0.05)", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','0.05','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(0.05);
  });

  it("falls back to default on an unparseable value", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','banana','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
  });

  it("falls back to default on a NULL value", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff',NULL,'2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
  });

  it("falls back to default on an empty string value", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
  });

  it("falls back to default on a negative value (-1)", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','-1','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
  });

  it("falls back to default on a value > 1 (5)", () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff','5','2027-01-01T00:00:00.000Z')",
    ).run();
    expect(resolveCapReadCoeff(db)).toBe(DEFAULT_CAP_READ_COEFF);
  });
});

describe("capWeightForTurn — non-uniform weighting", () => {
  it("down-weights cache_read by COEFF, full-weights everything else", () => {
    const t = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 10_000,
      cache_write_5m: 2000,
      cache_write_1h: 0,
      cache_write_other: 0,
    };
    // full(2000) + 0.1*10000 + full(1000+500) = 2000 + 1000 + 1500 = 4500
    expect(capWeightForTurn(t, 0.1)).toBe(4500);
    // Uniform (context_tokens-style) sum would be 1000+500+10000+2000 = 13500 — deliberately different.
    const uniform = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_5m;
    expect(capWeightForTurn(t, 0.1)).not.toBe(uniform);
  });
});

describe("capWeightedTokens — SQL meter", () => {
  it("a cache-read-only turn draws only COEFF× (not full weight)", () => {
    insTurn({ cr: 10_000 });
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    if (!row) throw new Error("expected a row");
    expect(row.cap_weighted_tokens).toBe(1000); // 0.1 × 10_000
    expect(row.cache_read_tokens).toBe(10_000); // raw read preserved
    expect(row.cache_read_weighted).toBe(1000);
  });

  it("a cache-write-only turn draws full weight", () => {
    insTurn({ cw5m: 8000, cw1h: 1000, cwOther: 1000 });
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    if (!row) throw new Error("expected a row");
    expect(row.cap_weighted_tokens).toBe(10_000); // full weight
    expect(row.cache_creation_tokens).toBe(10_000);
  });

  it("input + output are full weight", () => {
    insTurn({ input: 3000, output: 700 });
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    if (!row) throw new Error("expected a row");
    expect(row.cap_weighted_tokens).toBe(3700);
    expect(row.input_output_tokens).toBe(3700);
  });

  it("the meter never equals the uniform (context_tokens) sum when reads are present", () => {
    insTurn({ input: 1000, output: 500, cr: 20_000, cw5m: 2000 });
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    if (!row) throw new Error("expected a row");
    // cap = 2000 + 0.1*20000 + 1500 = 5500 ; uniform = 1000+500+20000+2000 = 23500
    expect(row.cap_weighted_tokens).toBe(5500);
    expect(row.cap_weighted_tokens).not.toBe(23_500);
  });

  it("selects the 1.0× regime when coeff is overridden", () => {
    insTurn({ cr: 10_000 });
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO, coeff: 1.0 });
    if (!row) throw new Error("expected a row");
    expect(row.cap_weighted_tokens).toBe(10_000); // full weight under 1×
  });

  it("groups by session_id and reports the cache_read:creation ratio", () => {
    insTurn({ cr: 5000, cw5m: 10_000, sessionId: "sess-cap" });
    // second session
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-cap2','ws-cap','/fake/2.jsonl','2027-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','RECONCILED',0,0,'[]')`,
    ).run();
    insTurn({ cr: 20_000, sessionId: "sess-cap2" });

    const rows = capWeightedTokens(db, { fromIso: FROM, toIso: TO, groupBy: "session_id" });
    const byId = Object.fromEntries(rows.map((r) => [r.group, r]));
    expect(byId["sess-cap"]?.cache_read_to_creation_ratio).toBeCloseTo(0.5); // 5000/10000
    expect(byId["sess-cap2"]?.cache_read_to_creation_ratio).toBeNull(); // no creation
  });

  it("excludes provisional turns by default, includes them on request", () => {
    insTurn({ input: 1000, provisional: 1 });
    expect(capWeightedTokens(db, { fromIso: FROM, toIso: TO })).toEqual([]);
    const [row] = capWeightedTokens(db, { fromIso: FROM, toIso: TO, includeProvisional: true });
    expect(row?.cap_weighted_tokens).toBe(1000);
  });

  it("returns an empty array for an empty window", () => {
    expect(capWeightedTokens(db, { fromIso: FROM, toIso: TO })).toEqual([]);
  });
});

// ── groupBy='model' — hand-computed fixture math (M-batch edge case) ─────────

describe("capWeightedTokens groupBy='model' — hand-computed fixture math", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryFixtureDb();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-model', 'ws-model', '2027-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-model', 'ws-model', '/fake/sess-model.jsonl',
               '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'RECONCILED', 0, 0, '[]')`,
    ).run();
  });

  afterEach(() => db.close());

  /** Insert one reconciled turn for an explicit model with explicit usage fields. */
  function insModelTurn(
    msgId: string,
    model: string,
    f: { input?: number; output?: number; cr?: number; cw5m?: number; cw1h?: number },
  ): void {
    const { input = 0, output = 0, cr = 0, cw5m = 0, cw1h = 0 } = f;
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model,
          is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
          provisional, parser_version)
       VALUES (?, 'sess-model', 'ws-model', '2027-01-01T06:00:00.000Z', ?,
               0, ?, ?, ?, ?, ?, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(msgId, model, input, output, cr, cw5m, cw1h);
  }

  it("returns per-model rows matching hand-computed cap weights", () => {
    // Sonnet turn: in=1000 out=100 cr=10_000 cw5m=4_000
    //   weighted = (1000+100) + 4_000 + 0.1×10_000 = 1100 + 4000 + 1000 = 6100
    insModelTurn("msg-m-1", "claude-sonnet", {
      input: 1000,
      output: 100,
      cr: 10_000,
      cw5m: 4_000,
    });
    // Haiku turn: in=500 out=50 cr=20_000 cw1h=1_000
    //   weighted = (500+50) + 1_000 + 0.1×20_000 = 550 + 1000 + 2000 = 3550
    insModelTurn("msg-m-2", "claude-haiku", {
      input: 500,
      output: 50,
      cr: 20_000,
      cw1h: 1_000,
    });

    const rows = capWeightedTokens(db, { fromIso: FROM, toIso: TO, groupBy: "model" });

    // Ordered by cap_weighted_raw DESC → sonnet (6100) before haiku (3550).
    expect(rows.map((r) => r.group)).toEqual(["claude-sonnet", "claude-haiku"]);

    const [sonnet, haiku] = rows as [CapWeightedRow, CapWeightedRow];
    expect(sonnet.cap_weighted_tokens).toBe(6100);
    expect(sonnet.cache_creation_tokens).toBe(4_000); // cw5m only
    expect(sonnet.cache_read_tokens).toBe(10_000);
    expect(sonnet.cache_read_weighted).toBe(1_000); // round(0.1 × 10_000)
    expect(sonnet.input_output_tokens).toBe(1_100);
    expect(sonnet.cache_read_to_creation_ratio).toBeCloseTo(2.5); // 10_000/4_000
    expect(sonnet.turns).toBe(1);

    expect(haiku.cap_weighted_tokens).toBe(3550);
    expect(haiku.cache_creation_tokens).toBe(1_000); // cw1h only
    expect(haiku.cache_read_tokens).toBe(20_000);
    expect(haiku.cache_read_weighted).toBe(2_000);
    expect(haiku.input_output_tokens).toBe(550);
    expect(haiku.cache_read_to_creation_ratio).toBeCloseTo(20); // 20_000/1_000
    expect(haiku.turns).toBe(1);

    // Per-model rows sum to the global total (never mixed weights).
    const [global] = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    expect(global?.cap_weighted_tokens).toBe(6100 + 3550);
  });
});
