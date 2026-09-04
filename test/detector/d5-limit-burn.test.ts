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
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.state).toBe("DEGRADED");
    expect(ev.forecast_state).toBe("OFF");
    expect(ev.burn_trend).toBe("RISING");
    expect(ev.recent_cap_weighted_tokens).toBe(1_000_000);
    expect(ev.baseline_cap_weighted_tokens_per_day).toBeGreaterThan(0);
    expect(ev.calibration_nudge).toBe("Calibrate to get a real limit");
    expect(ev.limit_tokens).toBeNull();
    expect(ev.projected_exhaustion_jd).toBeNull();
    expect(JSON.stringify(ev)).not.toMatch(/%/);
  });

  it("keeps the calibrated WARNING output unchanged", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-calibrated-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected calibrated D5 rec");
    expect(r.target_metric).toBe("forecast_margin");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.title).toBe("Rate-limit warning: reduce burn before weekly reset");
    expect(ev.state).toBe("WARNING");
    expect(ev.tokens_used).toBe(9_000);
    expect(ev.limit_tokens).toBe(10_000);
    expect(ev.projected_exhaustion_jd).toEqual(expect.any(Number));
    expect(ev.burn_trend).toBeUndefined();
    expect(ev.calibration_nudge).toBeUndefined();
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

  it("formula.model = 'none', formula.kind = 'WARNING'", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-formula-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.model).toBe("none");
    expect(formula.kind).toBe("WARNING");
  });

  it("evidence carries state, tokens_used, limit_tokens, projected_exhaustion_jd", () => {
    setLimit(10_000);
    insTurnInWindow("msg-d5-ev-1", 9_000);

    runDetectors(db, { now: NOW });
    const r = d5Recs()[0];
    if (!r) throw new Error("expected D5 rec");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.state).toBe("WARNING");
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
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.limit_scale_legacy).toBe(true);
    expect(ev.limit_scale_note).toMatch(/full-weight/);
    expect(ev.limit_scale_note).toMatch(/re-run Calibrate/i);
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
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
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
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.state).toBe("EXCEEDED");
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
