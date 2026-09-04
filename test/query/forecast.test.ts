/**
 * test/query/forecast.test.ts — BurnForecaster (ADR-107 §D-5, 5-state + OFF).
 *
 * Exercises every state deterministically via the pure computeForecast(), the
 * COLD_START-before-EXCEEDED eval order, the 0.25-day rate floor, the Julian-day
 * conversion, and the DB wiring (forecastFromDb + user_config limit).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeForecast,
  forecastFromDb,
  readLimitTokens,
  toJulianDay,
} from "../../src/query/forecast.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW_JD = 2_460_000; // arbitrary reference Julian day

describe("computeForecast state machine", () => {
  it("OFF when no limit is configured", () => {
    const f = computeForecast({
      limitTokens: null,
      tokensUsed: 12345,
      elapsedDays: 1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("OFF");
    expect(f.limit_tokens).toBeNull();
    expect(f.tokens_used).toBe(12345);
    expect(f.tokens_per_day).toBeNull();
    expect(f.projected_exhaustion_jd).toBeNull();
  });

  it("COLD_START when elapsed < 0.25d", () => {
    const f = computeForecast({
      limitTokens: 1000,
      tokensUsed: 100,
      elapsedDays: 0.1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("COLD_START");
    expect(f.tokens_per_day).toBeNull();
    expect(f.projected_exhaustion_jd).toBeNull();
  });

  it("COLD_START is evaluated BEFORE EXCEEDED", () => {
    // Over the limit AND cold — must resolve to COLD_START, not EXCEEDED.
    const f = computeForecast({
      limitTokens: 1000,
      tokensUsed: 5000,
      elapsedDays: 0.1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("COLD_START");
  });

  it("EXCEEDED when tokens >= limit (past-date ETA clamped to null)", () => {
    const f = computeForecast({
      limitTokens: 1000,
      tokensUsed: 2000,
      elapsedDays: 1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("EXCEEDED");
    expect(f.projected_exhaustion_jd).toBeNull();
    expect(f.tokens_per_day).toBe(2000);
  });

  it("NO_BURN when no tokens in the window", () => {
    const f = computeForecast({
      limitTokens: 1000,
      tokensUsed: 0,
      elapsedDays: 1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("NO_BURN");
    expect(f.tokens_per_day).toBeNull();
    expect(f.projected_exhaustion_jd).toBeNull();
  });

  it("WARNING when ETA <= threshold", () => {
    const f = computeForecast({
      limitTokens: 1000,
      tokensUsed: 900,
      elapsedDays: 1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("WARNING");
    expect(f.tokens_per_day).toBe(900);
    // remaining 100 / rate 900 = 0.111d
    expect(f.projected_exhaustion_jd).toBeCloseTo(NOW_JD + 100 / 900, 9);
  });

  it("OK when ETA > threshold", () => {
    const f = computeForecast({
      limitTokens: 10_000,
      tokensUsed: 1000,
      elapsedDays: 1,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    expect(f.state).toBe("OK");
    expect(f.projected_exhaustion_jd).toBeCloseTo(NOW_JD + 9000 / 1000, 9);
  });

  it("applies the 0.25-day rate floor at the boundary (not COLD_START at exactly 0.25)", () => {
    const f = computeForecast({
      limitTokens: 10_000,
      tokensUsed: 250,
      elapsedDays: 0.25,
      nowJd: NOW_JD,
      warnThresholdDays: 2,
    });
    // elapsed 0.25 is NOT < 0.25 => not cold; rate = 250 / 0.25 = 1000/day.
    expect(f.state).toBe("OK");
    expect(f.tokens_per_day).toBe(1000);
  });
});

describe("toJulianDay", () => {
  it("matches known Julian day references", () => {
    expect(toJulianDay(new Date("1970-01-01T00:00:00.000Z"))).toBeCloseTo(2440587.5, 6);
    expect(toJulianDay(new Date("2000-01-01T12:00:00.000Z"))).toBeCloseTo(2451545.0, 6);
  });
});

describe("forecastFromDb", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInMemoryFixtureDb();
  });
  afterEach(() => {
    db.close();
  });

  it("reads limit_tokens from user_config (null => OFF)", () => {
    expect(readLimitTokens(db)).toBeNull();
    const f = forecastFromDb(db, { now: new Date("2026-01-01T06:00:00.000Z") });
    expect(f.state).toBe("OFF");
  });

  it("EXCEEDED with a tiny limit; OK with a huge limit (DB wiring)", () => {
    const now = new Date("2026-01-01T06:00:00.000Z"); // after all fixture turns
    const exceeded = forecastFromDb(db, { now, limitTokens: 1 });
    expect(exceeded.state).toBe("EXCEEDED");
    expect(exceeded.tokens_used).toBeGreaterThan(0);

    const ok = forecastFromDb(db, { now, limitTokens: 1e12 });
    expect(ok.state).toBe("OK");
    expect(ok.projected_exhaustion_jd).not.toBeNull();
    expect(ok.tokens_used).toBe(exceeded.tokens_used);
  });
});

// ── Cap-weighted token metric (Data Model §2A) ───────────────────────────────

describe("forecastFromDb — cap-weighted token metric", () => {
  let db: Database.Database;

  // Window [2027-01-07T00:00Z, 2027-01-08T00:00Z); fixture turns sit mid-window.
  const NOW = new Date("2027-01-08T00:00:00.000Z");
  const TS = "2027-01-07T12:00:00.000Z";

  beforeEach(() => {
    db = createInMemoryFixtureDb();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-fc', 'ws-fc', '2027-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-fc', 'ws-fc', '/fake/fc.jsonl', ?, ?, 'RECONCILED', 1, 0, '[]')`,
    ).run(TS, TS);
  });

  afterEach(() => db.close());

  function insTurn(
    msgId: string,
    f: {
      input?: number;
      output?: number;
      cr?: number;
      cw5m?: number;
      provisional?: number;
      ts?: string;
    },
  ): void {
    const { input = 0, output = 0, cr = 0, cw5m = 0, provisional = 0, ts = TS } = f;
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model,
          is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
          provisional, parser_version)
       VALUES (?, 'sess-fc', 'ws-fc', ?, 'claude-sonnet',
               0, ?, ?, ?, ?, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
    ).run(msgId, ts, input, output, cr, cw5m, provisional);
  }

  it("weights cache reads at COEFF: a cache-heavy window yields LOWER burn than full weight", () => {
    // Single turn: in=1000 out=500 cr=90_000.
    // Full weight (old §D-2): 91_500. Cap-weighted (COEFF 0.1): 1500 + 9000 = 10_500.
    insTurn("msg-fc-1", { input: 1000, output: 500, cr: 90_000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: null }); // OFF still reports tokens_used
    expect(f.tokens_used).toBe(10_500);
    expect(f.tokens_used).toBeLessThan(91_500); // strictly lower than full weight
    expect(f.cap_weighted).toBe(true);
    expect(f.cap_read_coeff).toBe(0.1);
    expect(f.token_metric).toMatch(/cap-weighted/i);
    expect(f.token_metric).toMatch(/unverified/i);
  });

  it("respects a configured COEFF (1.0× upper-bound regime reproduces full weight)", () => {
    insTurn("msg-fc-2", { input: 1000, output: 500, cr: 90_000 });
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('cap_read_coeff', '1.0', ?)`,
    ).run(NOW.toISOString());

    const f = forecastFromDb(db, { now: NOW, limitTokens: null });
    expect(f.cap_read_coeff).toBe(1.0);
    expect(f.tokens_used).toBe(91_500);
  });

  it("deliberately includes provisional turns (burn = all compute engaged)", () => {
    insTurn("msg-fc-3", { input: 1000, output: 0, cr: 0 });
    insTurn("msg-fc-4", { input: 7000, output: 0, cr: 0, provisional: 1 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: null });
    expect(f.tokens_used).toBe(8000); // provisional 7000 NOT filtered
  });

  it("excludes future turns at and after the injected now bound", () => {
    insTurn("msg-fc-window-1", { input: 1000, ts: "2027-01-07T23:59:59.999Z" });
    insTurn("msg-fc-window-at-now", { input: 7000, ts: NOW.toISOString() });
    insTurn("msg-fc-window-future", { input: 9000, ts: "2027-01-08T00:00:00.001Z" });

    const f = forecastFromDb(db, { now: NOW, limitTokens: null });
    expect(f.tokens_used).toBe(1000);
  });

  it("a cache-heavy window projects a LATER exhaustion than its full-weight equivalent", () => {
    // Same turn as above; limit chosen so cap-weighted is OK (eta > 2d) but
    // full-weight would be EXCEEDED.
    insTurn("msg-fc-5", { input: 1000, output: 500, cr: 90_000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 80_000 });
    expect(f.tokens_used).toBe(10_500);
    expect(f.state).toBe("OK"); // full weight (91_500) would be EXCEEDED at this limit
    expect(f.projected_exhaustion_jd).not.toBeNull();

    const elapsedDays = 0.5; // turn anchored at 12:00 → 0.5d to NOW
    const expectedRate = 10_500 / elapsedDays;
    expect(f.tokens_per_day).toBeCloseTo(expectedRate, 6);
  });

  // ---------------------------------------------------------------------------
  // Legacy limit-scale detection (review P1): a limit_tokens value calibrated
  // under the OLD full-weight meter must be surfaced, never silently trusted.
  // Nested here for the shared ws-fc/sess-fc turn-insertion fixture.
  // ---------------------------------------------------------------------------

  function setProvenance(value: string | null): void {
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('limit_provenance', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(value, NOW.toISOString());
  }

  it("flags a limit whose provenance predates cap-weighting (legacy full-weight meter)", () => {
    // Pre-beea3d2 calibration provenance: no "cap-weighted" marker.
    setProvenance("calibrated 2026-01-01 @ 25.0%");
    insTurn("msg-fc-legacy-1", { input: 1000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(f.limit_scale_legacy).toBe(true);
    expect(f.limit_scale_note).toMatch(/full-weight/);
    expect(f.limit_scale_note).toMatch(/re-run Calibrate/i);
  });

  it("does NOT flag a fresh cap-weighted-calibrated limit", () => {
    setProvenance(
      "calibrated 2026-01-08 @ 25.0%; cap-weighted (cache reads ×0.1 COEFF, unverified)",
    );
    insTurn("msg-fc-legacy-2", { input: 1000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(f.limit_scale_legacy).toBe(false);
    expect(f.limit_scale_note).toBeNull();
  });

  it("treats an absent provenance row as legacy (safe default)", () => {
    // A manually typed limit that predates the meter change is indistinguishable
    // from a fresh one — conservative choice documented in src/query/forecast.ts.
    insTurn("msg-fc-legacy-3", { input: 1000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(f.limit_scale_legacy).toBe(true);
    expect(f.limit_scale_note).toMatch(/re-run Calibrate/i);
  });

  it("OFF (no limit) never carries the legacy flag", () => {
    // No limit_tokens, no provenance — nothing to flag.
    const f = forecastFromDb(db, { now: NOW, limitTokens: null });
    expect(f.state).toBe("OFF");
    expect(f.limit_scale_legacy).toBe(false);
    expect(f.limit_scale_note).toBeNull();
  });

  it("flags limit_confidence 'low' when provenance carries the LOW CONFIDENCE marker", () => {
    setProvenance(
      "calibrated 2026-01-08 @ 5.0%; cap-weighted (cache reads ×0.1 COEFF, unverified) — LOW CONFIDENCE (<10% utilization; re-calibrate after ~10% for a stable number)",
    );
    insTurn("msg-fc-lowconf-1", { input: 1000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(f.limit_confidence).toBe("low");
  });

  it("limit_confidence is null for a normal cap-weighted provenance", () => {
    setProvenance(
      "calibrated 2026-01-08 @ 25.0%; cap-weighted (cache reads ×0.1 COEFF, unverified)",
    );
    insTurn("msg-fc-lowconf-2", { input: 1000 });

    const f = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(f.limit_confidence).toBeNull();
  });

  it("surfaces limit_resets_at from user_config (null when unset)", () => {
    const before = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(before.limit_resets_at).toBeNull();

    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES ('limit_resets_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run("2026-01-10T00:00:00.000Z", NOW.toISOString());

    const after = forecastFromDb(db, { now: NOW, limitTokens: 100_000 });
    expect(after.limit_resets_at).toBe("2026-01-10T00:00:00.000Z");
  });
});
