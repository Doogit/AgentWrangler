/**
 * test/query/calibration.test.ts — Limit calibration (FU-1 / ADR-111).
 *
 * Covers:
 *   - utilization=0.25, known T → limit_tokens ≈ T/0.25
 *   - Forecast state flips OFF → real state after calibration
 *   - 429 response → ok:false with reason, no hard-fail
 *   - utilization < 0.02 → ok:false with reason, no write; < 0.10 is low-confidence
 *   - Provenance stored on calibration ("calibrated … @ …%")
 *   - Manual saveSettings sets provenance="manual"
 *   - Clearing limit_tokens clears provenance
 *
 * All tests use injected usage readers — no real network calls.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthUsageResult } from "../../src/oauth/usage.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { forecastFromDb } from "../../src/query/forecast.js";
import {
  applySettingsUpdate,
  calibrateLimit,
  getSettingsData,
} from "../../src/query/settings-store.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Known fixture token totals (from seed.ts — all turns including provisional)
//
// Cap-weighted totals (COEFF = default 0.1 → cache reads count at 0.1×):
// turn-a1-1: 1000+200                          = 1200
// turn-a1-2: 2000+400+0.1×1000+500             = 3000   (full-weight was 3900)
// turn-a1-3: 1500+300                          = 1800
// turn-a2-1: 3000+600                          = 3600
// turn-a2-2: 500+100                           = 600
// turn-a3-1: 750+75                            = 825
// turn-a3-2: 750+75                            = 825
// turn-b1-1: 5000+1000+0.1×2000+1000           = 7200   (full-weight was 9000)
// turn-b1-2: 2500+500                          = 3000
// turn-b2-1 (provisional): 1000+200            = 1200
// Total: 23250  (full-weight total would be 25950)
// ---------------------------------------------------------------------------
const FIXTURE_TOTAL_TOKENS = 23250;
/** Full-weight (old §D-2) fixture total — used to prove weighting actually applies. */
const FIXTURE_FULL_WEIGHT_TOKENS = 25950;

// BASE_TS from seed.ts — all fixture turns are within 305 minutes of this.
const BASE_TS = "2026-01-01T00:00:00.000Z";

// resets_at exactly 7 days after BASE_TS so window_start = BASE_TS.
// window_start = MOCK_RESETS_AT - 7d = "2026-01-01T00:00:00.000Z" = BASE_TS.
// This ensures all fixture turns (ts[0]…ts[305]) fall within the calibration window.
const MOCK_RESETS_AT = "2026-01-08T00:00:00.000Z"; // BASE_TS + 7 days

function makeUsageReader(utilization: number, status?: number): () => Promise<OAuthUsageResult> {
  if (status !== undefined) {
    return async () => ({
      ok: false,
      reason: `HTTP ${status} from oauth/usage — enter the limit manually or try again later`,
      status,
    });
  }
  return async () => ({
    ok: true,
    data: {
      five_hour: { utilization: 0, resets_at: MOCK_RESETS_AT },
      seven_day: { utilization, resets_at: MOCK_RESETS_AT },
    },
  });
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("calibrateLimit — happy path (utilization=0.25)", () => {
  it("yields limit_tokens ≈ T/0.25 from the fixture DB", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.25));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // limit_tokens = round(23250 / 0.25) = 93000 (cap-weighted; NOT 103800 full-weight)
    expect(result.limit_tokens).toBe(Math.round(FIXTURE_TOTAL_TOKENS / 0.25));
    expect(result.limit_tokens).toBe(93000);
    expect(result.limit_tokens).toBeLessThan(Math.round(FIXTURE_FULL_WEIGHT_TOKENS / 0.25));
  });

  it("persists limit_tokens and limit_provenance to user_config", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.25));
    expect(result.ok).toBe(true);

    const settings = getSettingsData(db);
    expect(settings.limit_tokens).toBe(93000);
    expect(settings.limit_provenance).toMatch(/^calibrated \d{4}-\d{2}-\d{2} @ 25\.0%/);
    expect(settings.limit_provenance).toMatch(/cap-weighted/i);
    expect(settings.limit_resets_at).toBe(MOCK_RESETS_AT);
  });

  it("returns the provenance string in the result", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.25));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.provenance).toMatch(/^calibrated \d{4}-\d{2}-\d{2} @ 25\.0%/);
  });

  it("flips the burn-forecast state from OFF to a real state (≠ OFF)", async () => {
    // Before calibration: limit_tokens=null → forecast OFF
    const before = forecastFromDb(db, { now: new Date("2026-01-02T00:00:00.000Z") });
    expect(before.state).toBe("OFF");

    await calibrateLimit(db, makeUsageReader(0.25));

    // After: limit_tokens set → forecast is not OFF (will be OK or NO_BURN)
    const after = forecastFromDb(db, { now: new Date("2026-01-02T00:00:00.000Z") });
    expect(after.state).not.toBe("OFF");
    expect(after.limit_tokens).toBe(93000);
  });
});

// ---------------------------------------------------------------------------
// 429 / network error fallback
// ---------------------------------------------------------------------------

describe("calibrateLimit — 429 fallback", () => {
  it("returns ok:false with a reason string on 429", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0, 429));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/429/);
  });

  it("does NOT write limit_tokens on 429", async () => {
    await calibrateLimit(db, makeUsageReader(0, 429));
    const settings = getSettingsData(db);
    expect(settings.limit_tokens).toBeNull();
  });

  it("does not throw — never hard-fails the daemon", async () => {
    await expect(calibrateLimit(db, makeUsageReader(0, 429))).resolves.not.toThrow();
  });

  it("returns ok:false for any non-200 status", async () => {
    for (const status of [401, 403, 500, 503]) {
      const result = await calibrateLimit(db, makeUsageReader(0, status));
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Low-confidence utilization thresholds
// ---------------------------------------------------------------------------

describe("calibrateLimit — low-confidence utilization thresholds", () => {
  it("refuses when utilization=0.01 (< 2%) without writing limit_tokens", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.01));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/noisy|utilization/i);
    expect(getSettingsData(db).limit_tokens).toBeNull();
  });

  it("calibrates utilization=0.05 with low confidence", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.05));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.confidence).toBe("low");
    expect(result.limit_tokens).toBe(Math.round(FIXTURE_TOTAL_TOKENS / 0.05));
    expect(result.provenance).toContain("cap-weighted");
    expect(result.provenance).toContain("LOW CONFIDENCE");
    const settings = getSettingsData(db);
    expect(settings.limit_tokens).toBe(Math.round(FIXTURE_TOTAL_TOKENS / 0.05));
  });

  it("calibrates utilization=0.09 with low confidence", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.09));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.confidence).toBe("low");
  });

  it("proceeds when utilization=0.10 (exactly at threshold)", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.1));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.confidence).toBeUndefined();
    expect(result.limit_tokens).toBe(Math.round(FIXTURE_TOTAL_TOKENS / 0.1));
  });

  it("calibrates utilization=0.50 without low confidence", async () => {
    const result = await calibrateLimit(db, makeUsageReader(0.5));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.confidence).toBeUndefined();
  });
});

describe("calibrateLimit — malformed reader defense", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.01])(
    "refuses invalid utilization %s without writing",
    async (utilization) => {
      const result = await calibrateLimit(db, makeUsageReader(utilization));
      expect(result.ok).toBe(false);
      expect(getSettingsData(db).limit_tokens).toBeNull();
    },
  );

  it("refuses a missing seven_day period without throwing", async () => {
    const reader = async () =>
      ({ ok: true, data: { five_hour: { utilization: 0.1, resets_at: MOCK_RESETS_AT } } }) as never;
    await expect(calibrateLimit(db, reader)).resolves.toMatchObject({ ok: false });
    expect(getSettingsData(db).limit_tokens).toBeNull();
  });

  it("converts reader exceptions into a failure result", async () => {
    const result = await calibrateLimit(db, async () => {
      throw new Error("provider unavailable");
    });
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/provider unavailable/),
    });
  });
});

// ---------------------------------------------------------------------------
// Provenance tracking
// ---------------------------------------------------------------------------

describe("calibrateLimit — provenance", () => {
  it("getSettingsData returns limit_provenance='manual' after a manual save", async () => {
    applySettingsUpdate(db, { limit_tokens: 5_000_000 });
    const settings = getSettingsData(db);
    expect(settings.limit_provenance).toBe("manual");
  });

  it("getSettingsData returns limit_provenance=null when limit_tokens is null", () => {
    const settings = getSettingsData(db);
    expect(settings.limit_tokens).toBeNull();
    expect(settings.limit_provenance).toBeNull();
  });

  it("clearing limit_tokens also clears limit_provenance", async () => {
    // Set a calibrated limit first
    await calibrateLimit(db, makeUsageReader(0.25));
    expect(getSettingsData(db).limit_provenance).not.toBeNull();

    // Clear it
    applySettingsUpdate(db, { limit_tokens: null });
    const settings = getSettingsData(db);
    expect(settings.limit_tokens).toBeNull();
    expect(settings.limit_provenance).toBeNull();
    expect(settings.limit_resets_at).toBeNull();
  });

  it("re-calibration overwrites the prior calibrated provenance", async () => {
    await calibrateLimit(db, makeUsageReader(0.25));
    const first = getSettingsData(db).limit_provenance;
    expect(first).toMatch(/25\.0%/);

    await calibrateLimit(db, makeUsageReader(0.5));
    const second = getSettingsData(db).limit_provenance;
    expect(second).toMatch(/50\.0%/);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Window upper bound — half-open interval [window_start, resets_at)
// ---------------------------------------------------------------------------

describe("calibrateLimit — window upper bound", () => {
  it("does NOT count turns timestamped after resets_at", async () => {
    // Insert a large turn timestamped 1 day AFTER MOCK_RESETS_AT.
    // Without the AND ts < ? upper bound, 50k+50k = 100k extra tokens would be
    // counted, producing Math.round((25950 + 100000) / 0.25) = 503800 instead
    // of the expected 103800.
    const AFTER_RESET_TS = "2026-01-09T00:00:00.000Z"; // MOCK_RESETS_AT + 1 day
    db.prepare(
      `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
       VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?)`,
    ).run(
      "msg-future-1",
      "sess-a1",
      "ws-alpha",
      AFTER_RESET_TS,
      "claude-sonnet",
      0,
      50000,
      50000,
      0,
      0,
      0,
      0,
      null,
      "snap-sonnet",
      0,
      "LIST_EQUIV",
      0,
      "test-v1",
    );

    const result = await calibrateLimit(db, makeUsageReader(0.25));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Only fixture tokens counted (cap-weighted 23250) — future turn excluded
    expect(result.limit_tokens).toBe(93000);
  });
});
