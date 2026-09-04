/**
 * test/detector/calibration.test.ts — calibrateBytesPerToken unit tests.
 *
 * Uses an in-memory DB. Credentials, counter, and sampler are all injected —
 * no real network calls, no real file I/O.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BYTES_PER_TOKEN,
  calibrateBytesPerToken,
  configGet,
  configSet,
  resolveBytesPerToken,
} from "../../src/detector/calibration.js";
import type { ToolResultSampler } from "../../src/detector/calibration.js";
import type { TokenCounter } from "../../src/oauth/count-tokens.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
// resolveBytesPerToken
// ---------------------------------------------------------------------------

describe("resolveBytesPerToken", () => {
  it("returns the default ratio when no calibration row exists", () => {
    const result = resolveBytesPerToken(db);
    expect(result.ratio).toBe(DEFAULT_BYTES_PER_TOKEN);
    expect(result.calibrated).toBe(false);
    expect(result.measuredAt).toBeNull();
    expect(result.model).toBeNull();
    expect(result.provenance).toBeNull();
  });

  it("returns the calibrated ratio when user_config has bytes_per_token", () => {
    const ts = new Date().toISOString();
    configSet(db, "bytes_per_token", "3.65");
    configSet(db, "bytes_per_token_measured_at", ts);
    configSet(
      db,
      "bytes_per_token_provenance",
      "calibrated 2026-09-02 via count_tokens · model claude-sonnet-4-6 · N=150 · median 3.6500",
    );
    const result = resolveBytesPerToken(db);
    expect(result.ratio).toBeCloseTo(3.65);
    expect(result.calibrated).toBe(true);
    expect(result.measuredAt).toBe(ts);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.provenance).toContain("claude-sonnet-4-6");
  });

  it("falls back to default on an invalid stored value", () => {
    configSet(db, "bytes_per_token", "not-a-number");
    const result = resolveBytesPerToken(db);
    expect(result.ratio).toBe(DEFAULT_BYTES_PER_TOKEN);
    expect(result.calibrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calibrateBytesPerToken — disabled guard
// ---------------------------------------------------------------------------

describe("calibrateBytesPerToken — disabled guard", () => {
  it("returns ok:false when opt-in flag is not set", async () => {
    const result = await calibrateBytesPerToken(db, {
      counter: async () => ({ ok: true, input_tokens: 10 }),
      sampler: () => [{ text: "hi", bytes: 40 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("disabled");
    // Nothing persisted
    expect(configGet(db, "bytes_per_token")).toBeNull();
  });

  it("returns ok:false when flag is explicitly 'false'", async () => {
    configSet(db, "bytes_per_token_calibration_enabled", "false");
    const result = await calibrateBytesPerToken(db, {
      counter: async () => ({ ok: true, input_tokens: 10 }),
      sampler: () => [{ text: "hi", bytes: 40 }],
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers — deterministic fake counter + sampler
// ---------------------------------------------------------------------------

/** Builds a fake sampler returning N blocks, each with the given bytes and text. */
function makeSampler(n: number, bytesEach: number): ToolResultSampler {
  return () => Array.from({ length: n }, (_, i) => ({ text: `sample_${i}`, bytes: bytesEach }));
}

/**
 * Builds a fake counter that always returns the given token count.
 * bytes=40, tokens=10 → ratio 4.0.
 */
function makeCounter(tokensPerCall: number): TokenCounter {
  return async () => ({ ok: true, input_tokens: tokensPerCall });
}

function enableCalibration(): void {
  configSet(db, "bytes_per_token_calibration_enabled", "true");
}

// ---------------------------------------------------------------------------
// calibrateBytesPerToken — happy path (median, provenance, persistence)
// ---------------------------------------------------------------------------

describe("calibrateBytesPerToken — happy path", () => {
  it("computes the median ratio and persists provenance", async () => {
    enableCalibration();

    // 50 samples, each 40 bytes → counter returns 10 tokens → ratio 4.0
    const result = await calibrateBytesPerToken(db, {
      counter: makeCounter(10),
      sampler: makeSampler(50, 40),
      scanRoots: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    // Median of 50 uniform ratios = 4.0
    expect(result.ratio).toBeCloseTo(4.0);
    expect(result.n).toBe(50);
    expect(typeof result.model).toBe("string");
    expect(result.provenance).toContain("count_tokens");
    expect(result.provenance).toContain("N=50");
    expect(result.provenance).toContain("median");

    // Persisted to user_config
    const stored = configGet(db, "bytes_per_token");
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeCloseTo(4.0);
    expect(configGet(db, "bytes_per_token_measured_at")).not.toBeNull();
    expect(configGet(db, "bytes_per_token_provenance")).toContain("N=50");
  });

  it("computes the correct median for an even-count array", async () => {
    enableCalibration();

    // 30 blocks: 15 with ratio 3.0 (bytes=30, tokens=10) and 15 with ratio 5.0 (bytes=50, tokens=10)
    // Sorted: [3.0×15, 5.0×15], median = (3.0 + 5.0) / 2 = 4.0
    let callCount = 0;
    const counter: TokenCounter = async (text) => {
      callCount++;
      return { ok: true, input_tokens: 10 };
    };
    const sampler: ToolResultSampler = () => [
      ...Array.from({ length: 15 }, () => ({ text: "aaa", bytes: 30 })),
      ...Array.from({ length: 15 }, () => ({ text: "bbbbb", bytes: 50 })),
    ];

    const result = await calibrateBytesPerToken(db, { counter, sampler, scanRoots: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.ratio).toBeCloseTo(4.0);
    expect(callCount).toBe(30);
  });

  it("skips failed counter calls and still succeeds when ≥30 pass", async () => {
    enableCalibration();

    let callCount = 0;
    // Every 3rd call fails; 60 total → 40 succeed (≥30)
    const counter: TokenCounter = async () => {
      callCount++;
      if (callCount % 3 === 0) return { ok: false, reason: "transient error" };
      return { ok: true, input_tokens: 10 };
    };
    const result = await calibrateBytesPerToken(db, {
      counter,
      sampler: makeSampler(60, 40),
      scanRoots: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.n).toBeGreaterThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// calibrateBytesPerToken — minimum sample floor
// ---------------------------------------------------------------------------

describe("calibrateBytesPerToken — minimum sample floor", () => {
  it("returns ok:false when fewer than 30 successful samples are collected", async () => {
    enableCalibration();

    // All counter calls fail
    const result = await calibrateBytesPerToken(db, {
      counter: async () => ({ ok: false, reason: "no cred" }),
      sampler: makeSampler(50, 40),
      scanRoots: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("30");
    // Nothing persisted
    expect(configGet(db, "bytes_per_token")).toBeNull();
  });

  it("returns ok:false when sampler returns fewer than 30 blocks", async () => {
    enableCalibration();

    const result = await calibrateBytesPerToken(db, {
      counter: makeCounter(10),
      sampler: makeSampler(10, 40), // only 10 blocks
      scanRoots: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// calibrateBytesPerToken — model fallback (404 → FALLBACK_MODEL)
// ---------------------------------------------------------------------------

describe("calibrateBytesPerToken — model fallback on 404", () => {
  it("falls back to claude-sonnet-4-6 when the primary model 404s", async () => {
    enableCalibration();

    const counter: TokenCounter = async (_text, model) => {
      if (model !== "claude-sonnet-4-6") {
        return { ok: false, reason: "not found", status: 404 };
      }
      return { ok: true, input_tokens: 10 };
    };

    const result = await calibrateBytesPerToken(db, {
      counter,
      sampler: makeSampler(50, 40),
      scanRoots: [],
      model: "claude-old-model-20241022",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.n).toBeGreaterThanOrEqual(30);
    }
  });
});

// ---------------------------------------------------------------------------
// configGet / configSet helpers
// ---------------------------------------------------------------------------

describe("configGet / configSet", () => {
  it("returns null for a missing key", () => {
    expect(configGet(db, "nonexistent_key")).toBeNull();
  });

  it("round-trips a string value", () => {
    configSet(db, "test_key", "hello");
    expect(configGet(db, "test_key")).toBe("hello");
  });

  it("handles null value (delete semantics)", () => {
    configSet(db, "del_key", "value");
    configSet(db, "del_key", null);
    expect(configGet(db, "del_key")).toBeNull();
  });

  it("upserts correctly on repeated writes", () => {
    configSet(db, "upsert_key", "first");
    configSet(db, "upsert_key", "second");
    expect(configGet(db, "upsert_key")).toBe("second");
  });
});
