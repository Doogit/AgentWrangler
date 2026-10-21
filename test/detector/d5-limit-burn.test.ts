/**
 * test/detector/d5-limit-burn.test.ts — D5 LIMIT_BURN_FORECAST detector tests.
 *
 * Covers:
 *   - BLOCKED only when limit_tokens is null and there is no burn history
 *   - ACTIVE degraded burn trend when limit_tokens is null and burn history exists
 *   - ACTIVE when forecast is WARNING (non-null limit, burn rate → ETA < 2 days)
 *   - ACTIVE when forecast is EXCEEDED (tokens_used >= limit_tokens)
 *   - INACTIVE when forecast is OK (ETA > 2 days)
 *   - INACTIVE when forecast is NO_BURN (limit set, no turns in 1d window)
 *   - INACTIVE when forecast is COLD_START (elapsed < 0.25 days)
 *   - category = 'LIMIT', target_metric = 'forecast_margin'
 *   - scope_workspace_id = null (global rec)
 *   - modeled_savings_u_per_wk = null (warning-class)
 *   - formula model = 'none', kind = 'WARNING'
 *   - evidence carries state, tokens_used, limit_tokens, projected_exhaustion_jd
 *   - determinism: two passes yield byte-identical rows; rec_id stable across drop+re-run
 *   - created_at uses injected ctx.now (never new Date())
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Frozen now: fixture data is in [2026-01-01, ...). The 1d forecast window = [2026-01-07, 2026-01-08).
const NOW = new Date("2026-01-08T00:00:00.000Z");
// A timestamp inside the 1d forecast window (midday, safe elapsed ≈ 0.5d > 0.25).
const IN_WINDOW_TS = "2026-01-07T12:00:00.000Z";
// A timestamp 5h before NOW — elapsed ≈ 0.208 days < 0.25 → COLD_START.
const COLD_START_TS = "2026-01-07T19:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Set the limit_tokens value in user_config (fixture seeds it as null). */
function setLimit(limitTokens: number): void {
  db.prepare("UPDATE user_config SET value = ?, updated_at = ? WHERE key = 'limit_tokens'").run(
    String(limitTokens),
    NOW.toISOString(),
  );
}

/** Set (or clear) the limit_provenance value in user_config (review P1 tests). */
function setProvenance(value: string): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES ('limit_provenance', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(value, NOW.toISOString());
}

/**
 * Insert a turn inside the 1d forecast window so forecastFromDb sees it.
 * Creates a throwaway workspace + session on first call per DB (INSERT OR IGNORE).
 */
function insTurnInWindow(
  msgId: string,
  inputTokens: number,
  outputTokens = 0,
  ts = IN_WINDOW_TS,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d5', 'project-d5', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-d5', 'ws-d5', '/fake/d5.jsonl', ?, ?, 'RECONCILED', 1, 0, '[]')`,
  ).run(ts, ts);
  db.prepare(
    `INSERT OR IGNORE INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, 'sess-d5', 'ws-d5', ?, 'claude-sonnet-4', 0, ?, ?, 0, 0, 0, 0,
             NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(msgId, ts, inputTokens, outputTokens);
}

function d5Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = 'D5' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

// ── Degraded / blocked: null limit ───────────────────────────────────────────

describe("D5 — degraded when limit_tokens is null", () => {
  it("stays BLOCKED when there is no burn history", () => {
    db.prepare("DELETE FROM turns").run();

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("BLOCKED");
    expect(d5Recs().length).toBe(0);
  });

  it("returns a directional degraded forecast with the calibration nudge", () => {
    insTurnInWindow("msg-d5-null-1", 1_000_000);

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("ACTIVE");

    const r = d5Recs()[0];
    if (!r) throw new Error("expected degraded D5 rec");
    expect(r.category).toBe("LIMIT");
    expect(r.target_metric).toBe("burn_trend");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("OFF");
    expect(ev.burn_trend).toBe("RISING");
    expect(ev.recent_cap_weighted_tokens).toBe(1_000_000);
    expect(ev.baseline_cap_weighted_tokens_per_day).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toMatch(/%/);
  });

  it("keeps the calibrated WARNING output unchanged", () => {
    setLimit(10_000);
    // U7: the stored-limit path reads a 7-day burn, so drop the seeded week of turns.
    db.prepare("DELETE FROM turns").run();
    insTurnInWindow("msg-d5-calibrated-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected calibrated D5 rec");
    expect(r.target_metric).toBe("forecast_margin");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("WARNING");
    expect(ev.tokens_used).toBe(9_000);
    expect(ev.limit_tokens).toBe(10_000);
    expect(ev.projected_exhaustion_jd).toEqual(expect.any(Number));
  });
});

// ── ACTIVE: WARNING state ────────────────────────────────────────────────────

describe("D5 — ACTIVE when forecast is WARNING", () => {
  it("fires when burn rate yields ETA < 2 days", () => {
    // 9_000 tokens used in ~0.5 day → rate ≈ 18_000/day; limit 10_000 → ETA ≈ 0.06d < 2 → WARNING.
    setLimit(10_000);
    insTurnInWindow("msg-d5-warn-1", 9_000);

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("ACTIVE");

    const recs = d5Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D5 rec");
    expect(r.state).toBe("PROPOSED");
    expect(r.provenance).toBe("RULE");
  });

  it("category = LIMIT, target_metric = forecast_margin", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-cat-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    expect(r.category).toBe("LIMIT");
    expect(r.target_metric).toBe("forecast_margin");
  });

  it("scope_workspace_id is null (global rec)", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-scope-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    expect(r.scope_workspace_id).toBeNull();
  });

  it("modeled_savings_u_per_wk is null (warning-class detector)", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-savings-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    expect(r.modeled_savings_u_per_wk).toBeNull();
  });

  it("uses the registered warning formula", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-formula-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.formula_id).toBe("D5_LIMIT_BURN_FORECAST_V1");
    expect(formula.estimate).toMatchObject({ basis: "X", rank_value_u_per_wk: null });
    const evidence = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(evidence.session_ids).toEqual(["sess-d5"]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?")
        .get((evidence.session_ids as string[])[0]),
    ).toEqual({ n: 1 });
  });

  it("evidence carries state, tokens_used, limit_tokens, projected_exhaustion_jd", () => {
    setLimit(10_000);
    // U7: the stored-limit path reads a 7-day burn, so drop the seeded week of turns.
    db.prepare("DELETE FROM turns").run();
    insTurnInWindow("msg-d5-ev-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("WARNING");
    expect(typeof ev.tokens_used).toBe("number");
    expect(ev.limit_tokens).toBe(10_000);
    expect(typeof ev.projected_exhaustion_jd).toBe("number");
  });
});

// ── Legacy limit-scale surfacing (review P1) ─────────────────────────────────

describe("D5 — legacy limit-scale evidence", () => {
  it("carries limit_scale_legacy=true + reason when provenance predates cap-weighting", () => {
    // Pre-beea3d2 calibration provenance lacks the "cap-weighted" marker.
    setLimit(10_000);
    setProvenance("calibrated 2025-12-01 @ 25.0%");
    insTurnInWindow("msg-d5-legacy-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.limit_scale_legacy).toBe(true);
  });

  it("carries limit_scale_legacy=false for fresh cap-weighted provenance (no note)", () => {
    setLimit(10_000);
    setProvenance(
      "calibrated 2026-01-08 @ 25.0%; cap-weighted (cache reads ×0.1 COEFF, unverified)",
    );
    insTurnInWindow("msg-d5-legacy-2", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.limit_scale_legacy).toBe(false);
    expect(ev.limit_scale_note).toBeUndefined();
  });
});

// ── ACTIVE: EXCEEDED state ───────────────────────────────────────────────────

describe("D5 — ACTIVE when forecast is EXCEEDED", () => {
  it("fires when tokens_used >= limit_tokens", () => {
    setLimit(1); // tiny limit
    insTurnInWindow("msg-d5-exc-1", 100); // 100 tokens > 1 → EXCEEDED

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("ACTIVE");

    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("EXCEEDED");
    // Past-ETA is clamped to null (C-02).
    expect(ev.projected_exhaustion_jd).toBeNull();
  });
});

// ── INACTIVE: OK state ───────────────────────────────────────────────────────

describe("D5 — INACTIVE when forecast is OK", () => {
  it("does not fire when ETA > 2 days", () => {
    // Limit = 1B tokens; burn = 1_000 tokens → rate ≈ 2_000/day; ETA ≈ 500_000 days → OK.
    setLimit(1_000_000_000);
    insTurnInWindow("msg-d5-ok-1", 1_000);

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("INACTIVE");
    expect(d5Recs().length).toBe(0);
  });
});

// ── INACTIVE: NO_BURN state ──────────────────────────────────────────────────

describe("D5 — INACTIVE when forecast is NO_BURN", () => {
  it("does not fire when no turns exist in the 1d window", () => {
    // Limit is set but no turns in [2026-01-07, 2026-01-08) → tokensUsed = 0 → NO_BURN.
    setLimit(100_000);

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("INACTIVE");
    expect(d5Recs().length).toBe(0);
  });
});

// ── INACTIVE: COLD_START state ───────────────────────────────────────────────

describe("D5 — INACTIVE when forecast is COLD_START", () => {
  it("does not fire when elapsed < 0.25 days (too little history)", () => {
    // Turn at 2026-01-07T19:00Z → anchor = 19:00, elapsed = 5h/24 ≈ 0.208d < 0.25 → COLD_START.
    setLimit(10_000);
    // U7: the stored-limit path reads a 7-day burn, so drop the seeded week of turns.
    db.prepare("DELETE FROM turns").run();
    insTurnInWindow("msg-d5-cold-1", 5_000, 0, COLD_START_TS);

    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("INACTIVE");
    expect(d5Recs().length).toBe(0);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("D5 — determinism", () => {
  it("two passes over the same frozen DB yield byte-identical rows", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-det-1", 9_000);

    runDetectors(db, { now: NOW });
    const first = d5Recs();

    runDetectors(db, { now: NOW });
    const second = d5Recs();

    expect(second).toEqual(first);
  });

  it("rec_id is stable across drop + re-run", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-det-2", 9_000);

    runDetectors(db, { now: NOW });
    const firstId = d5Recs()[0]?.rec_id as string;

    db.prepare("DELETE FROM recommendations").run();

    runDetectors(db, { now: NOW });
    const secondId = d5Recs()[0]?.rec_id as string;

    expect(firstId).toBe(secondId);
  });

  it("uses injected ctx.now for created_at (never new Date())", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-det-3", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    expect(r.created_at).toBe(NOW.toISOString());
  });
});

// ── Snapshot forecast (U7): used_pct + pace to the reset ─────────────────────

/**
 * Replay shaped like the real 09-18..09-24 week: the weekly limit reset on 09-25 09:00Z and
 * was hit on 09-24 about 09:00Z, after use climbed ~18 points a day. The old 1-day-burn
 * check warned about 9h before the hit; the readings can warn two days before.
 */
const REPLAY_RESET = "2026-09-25T09:00:00.000Z";
const REPLAY_READINGS: Array<[string, number]> = [
  ["2026-09-18T12:00:00.000Z", 4],
  ["2026-09-19T12:00:00.000Z", 18],
  ["2026-09-20T12:00:00.000Z", 30],
  ["2026-09-21T12:00:00.000Z", 48],
  ["2026-09-22T12:00:00.000Z", 66],
  ["2026-09-23T12:00:00.000Z", 85],
];

function seedReadings(readings: Array<[string, number]>, resetsAt = REPLAY_RESET): void {
  for (const [ts, pct] of readings) {
    db.prepare(
      "INSERT INTO limit_snapshots (ts, resets_at, used_pct, source) VALUES (?, ?, ?, 'api')",
    ).run(ts, resetsAt, pct);
  }
}

describe("D5 — forecast from limit_snapshots", () => {
  it("warns on 09-22, about two days before the limit was hit (not 9h before)", () => {
    seedReadings(REPLAY_READINGS.filter(([ts]) => ts <= "2026-09-22T12:00:00.000Z"));
    const now = new Date("2026-09-22T13:00:00.000Z");

    const statuses = runDetectors(db, { now });
    expect(statuses.find((s) => s.detector_id === "D5")?.status).toBe("ACTIVE");
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("WARNING");
    expect(ev.severity).toBe("high");
    expect(ev.used_pct).toBe(66);
    expect(ev.projected_pct as number).toBeGreaterThan(100);
    expect(ev.resets_at).toBe(REPLAY_RESET);
    // The projected hit is readable ISO time, on 09-24, 40+ hours after this warning.
    const hit = Date.parse(ev.projected_limit_hit_at as string);
    expect(new Date(hit).toISOString().slice(0, 10)).toBe("2026-09-24");
    expect(hit - now.getTime()).toBeGreaterThan(40 * 3_600_000);
    expect(ev.required_cut_pct as number).toBeGreaterThan(0);
  });

  it("stays quiet for a steady week that ends well under the limit", () => {
    seedReadings([
      ["2026-09-19T12:00:00.000Z", 8],
      ["2026-09-20T12:00:00.000Z", 16],
      ["2026-09-21T12:00:00.000Z", 24],
    ]);
    const statuses = runDetectors(db, { now: new Date("2026-09-21T13:00:00.000Z") });
    expect(statuses.find((s) => s.detector_id === "D5")?.status).toBe("INACTIVE");
    expect(d5Recs()).toHaveLength(0);
  });

  it("is EXCEEDED once a reading is at 100%", () => {
    seedReadings([
      ["2026-09-23T12:00:00.000Z", 90],
      ["2026-09-24T12:00:00.000Z", 100],
    ]);
    runDetectors(db, { now: new Date("2026-09-24T13:00:00.000Z") });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.forecast_state).toBe("EXCEEDED");
    expect(ev.projected_exhaustion_jd).toBeNull();
  });

  it("falls back to the week-to-date average when there is only one reading", () => {
    seedReadings([["2026-09-22T12:00:00.000Z", 66]]);
    runDetectors(db, { now: new Date("2026-09-22T13:00:00.000Z") });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    // 66% in 4.1 days = about 16 points a day; 2.9 days left projects past 100%.
    expect(ev.pace_pct_per_day as number).toBeGreaterThan(14);
    expect(ev.pace_pct_per_day as number).toBeLessThan(18);
    expect(ev.forecast_state).toBe("WARNING");
  });

  // Live 10-19 shape: the week reset 10-16 06:00Z; readings 13% → 27% in the last 5h. The old
  // 3h-minimum gap read that 5h burst as "the pace of the last day" and projected 247%.
  const BURST_RESET = "2026-10-23T06:00:00.000Z";
  const BURST_READINGS: Array<[string, number]> = [
    ["2026-10-19T19:10:13.874Z", 13],
    ["2026-10-19T20:41:45.493Z", 16],
    ["2026-10-19T22:52:34.394Z", 24],
    ["2026-10-20T00:06:59.282Z", 27],
  ];
  const BURST_NOW = new Date("2026-10-20T00:23:00.000Z");

  it("reads pace over the last full day, not a 5-hour burst (no local burn: by time)", () => {
    seedReadings(BURST_READINGS, BURST_RESET);
    const statuses = runDetectors(db, { now: BURST_NOW });
    // Day-start used ≈ 13% × 66h/85h ≈ 10% → ~17 pts/day → ~82% by the reset: under the line.
    expect(statuses.find((s) => s.detector_id === "D5")?.status).toBe("INACTIVE");
    expect(d5Recs()).toHaveLength(0);
  });

  it("splits the reading gap by local burn: last day ~25 pts/day → ~108%, not 247%", () => {
    seedReadings(BURST_READINGS, BURST_RESET);
    insTurnInWindow("msg-d5-burst-1", 6_800, 0, "2026-10-17T02:00:00.000Z");
    insTurnInWindow("msg-d5-burst-2", 37_000, 0, "2026-10-19T12:00:00.000Z");
    runDetectors(db, { now: BURST_NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.pace_window_hours).toBe(24);
    expect(ev.pace_pct_per_day as number).toBeGreaterThan(24);
    expect(ev.pace_pct_per_day as number).toBeLessThan(26);
    expect(ev.projected_pct as number).toBeGreaterThan(105);
    expect(ev.projected_pct as number).toBeLessThan(111);
    expect((ev.projected_limit_hit_at as string).slice(0, 10)).toBe("2026-10-22");
  });

  it("with a stored token limit but no readings, compares a 7-day burn, not 1 day", () => {
    // 45,000 tokens over the week against a 100,000 weekly limit ends well under it; the old
    // 1-day window read the last day's 30,000 burst as the whole rate and warned.
    setLimit(100_000);
    for (let d = 2; d <= 6; d++)
      insTurnInWindow(`msg-d5-week-${d}`, 3_000, 0, `2026-01-0${d}T12:00:00.000Z`);
    insTurnInWindow("msg-d5-week-7", 30_000, 0, "2026-01-07T12:00:00.000Z");
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D5")?.status).toBe("INACTIVE");
  });
});
