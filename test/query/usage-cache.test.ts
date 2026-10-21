/**
 * Tests for the shared oauth/usage upstream cache.
 *
 * Red-first: this file is written BEFORE the implementation exists.
 * These tests verify:
 *   1. N=100 rapid calls produce exactly 1 upstream call (in-flight coalescing).
 *   2. Within TTL: subsequent calls do not hit upstream.
 *   3. After TTL expires: hits upstream again.
 *   4. After 429+Retry-After=X: no upstream call before X seconds elapse.
 *   5. Default Retry-After (240 s) and min TTL (180 s) are honoured.
 *   6. getBurnStatus returns last-good data marked stale on 429/error.
 *   7. getLimitsModel continues to serve last-good rows on 429 (existing).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSharedUsageCache, cachedFetchOAuthUsage } from "../../src/oauth/usage-cache.js";
import type { OAuthUsageResult } from "../../src/oauth/usage.js";
import type { UsageReader } from "../../src/oauth/usage.js";
import type { BurnStatus } from "../../src/query/api/burn-status.js";
import { _resetBurnStatusLastGood, getBurnStatus } from "../../src/query/api/burn-status.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const okResult: OAuthUsageResult = {
  ok: true,
  data: {
    five_hour: { utilization: 0.3, resets_at: "2026-09-03T00:00:00Z" },
    seven_day: { utilization: 0.4, resets_at: "2026-09-09T00:00:00Z" },
  },
};

const rateLimitedResult = (retryAfterSec?: number): OAuthUsageResult => ({
  ok: false,
  status: 429,
  reason: "rate limited",
  ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
});

// ---------------------------------------------------------------------------
// Shared cache unit tests (cachedFetchOAuthUsage)
// ---------------------------------------------------------------------------

describe("cachedFetchOAuthUsage — in-flight coalescing", () => {
  beforeEach(() => _resetSharedUsageCache());
  afterEach(() => _resetSharedUsageCache());

  it("N=100 simultaneous calls produce exactly 1 upstream call", async () => {
    const upstream = vi.fn().mockResolvedValue(okResult);
    const calls = Array.from({ length: 100 }, () => cachedFetchOAuthUsage(upstream));
    const results = await Promise.all(calls);
    expect(upstream).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  it("second call within TTL does not hit upstream", async () => {
    const upstream = vi.fn().mockResolvedValue(okResult);
    await cachedFetchOAuthUsage(upstream);
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("cachedFetchOAuthUsage — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSharedUsageCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSharedUsageCache();
  });

  it("hits upstream again after MIN_TTL_MS (180 s) elapses", async () => {
    const upstream = vi.fn().mockResolvedValue(okResult);
    await cachedFetchOAuthUsage(upstream);
    vi.advanceTimersByTime(180_001);
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does NOT hit upstream again before MIN_TTL_MS elapses", async () => {
    const upstream = vi.fn().mockResolvedValue(okResult);
    await cachedFetchOAuthUsage(upstream);
    vi.advanceTimersByTime(179_999);
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("cachedFetchOAuthUsage — 429 Retry-After backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSharedUsageCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSharedUsageCache();
  });

  it("no upstream call within Retry-After=300 s window", async () => {
    const upstream = vi.fn().mockResolvedValue(rateLimitedResult(300));
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(299_000); // 1 s before window closes
    const calls = Array.from({ length: 50 }, () => cachedFetchOAuthUsage(upstream));
    await Promise.all(calls);
    expect(upstream).toHaveBeenCalledTimes(1); // still no new upstream call
  });

  it("hits upstream again after Retry-After=300 s elapses", async () => {
    const upstream = vi.fn().mockResolvedValue(rateLimitedResult(300));
    await cachedFetchOAuthUsage(upstream);
    vi.advanceTimersByTime(300_001);
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("uses MIN_TTL_MS (180 s) when Retry-After < 180 s", async () => {
    // Retry-After=60 < MIN_TTL_MS=180 → backs off for 180 s
    const upstream = vi.fn().mockResolvedValue(rateLimitedResult(60));
    await cachedFetchOAuthUsage(upstream);
    vi.advanceTimersByTime(179_999); // still inside min-TTL window
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("default backoff (240 s) when 429 omits Retry-After", async () => {
    const upstream = vi.fn().mockResolvedValue(rateLimitedResult()); // no retryAfterSec
    await cachedFetchOAuthUsage(upstream);
    vi.advanceTimersByTime(239_999);
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(1); // still within 240 s
    vi.advanceTimersByTime(2); // past 240 s
    await cachedFetchOAuthUsage(upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getBurnStatus — stale / asOf on 429 and network errors
// ---------------------------------------------------------------------------

describe("getBurnStatus — stale last-good on 429", () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetBurnStatusLastGood();
    _resetSharedUsageCache();
    db = createInMemoryFixtureDb();
    setQueryDb(db);
  });
  afterEach(() => {
    _resetBurnStatusLastGood();
    _resetSharedUsageCache();
    resetQueryDb();
    db.close();
  });

  it("returns stale last-good data on 429 when a previous ok call succeeded", async () => {
    const okReader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: 0.25, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: 0.4, resets_at: "2026-09-09T00:00:00Z" },
        },
      });
    await getBurnStatus(okReader); // populates lastGood

    const rlReader: UsageReader = () =>
      Promise.resolve({ ok: false, status: 429, reason: "rate limited", retryAfterSec: 60 });
    const envelope = await getBurnStatus(rlReader);

    const data = envelope.data as BurnStatus;
    expect(data.available).toBe(true); // serving last-good
    expect(data.stale).toBe(true);
    expect(typeof data.asOf).toBe("string");
    expect(data.asOf?.length).toBeGreaterThan(0);
    expect(data.five_hour?.utilization).toBe(0.25);
    expect(data.seven_day?.utilization).toBe(0.4);
  });

  it("returns stale last-good data on generic error", async () => {
    const okReader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: 0.1, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: 0.2, resets_at: "2026-09-09T00:00:00Z" },
        },
      });
    await getBurnStatus(okReader);

    const errReader: UsageReader = () => Promise.resolve({ ok: false, reason: "network error" });
    const envelope = await getBurnStatus(errReader);

    const data = envelope.data as BurnStatus;
    expect(data.available).toBe(true);
    expect(data.stale).toBe(true);
  });

  it("returns available:false when no last-good exists and reader fails", async () => {
    const rlReader: UsageReader = () =>
      Promise.resolve({ ok: false, status: 429, reason: "rate limited", retryAfterSec: 60 });
    const envelope = await getBurnStatus(rlReader);

    const data = envelope.data as BurnStatus;
    expect(data.available).toBe(false);
    expect(data.stale).toBe(false);
  });

  it("ok response carries stale:false and an asOf timestamp", async () => {
    const okReader: UsageReader = () =>
      Promise.resolve({
        ok: true,
        data: {
          five_hour: { utilization: 0.1, resets_at: "2026-09-03T00:00:00Z" },
          seven_day: { utilization: 0.2, resets_at: "2026-09-09T00:00:00Z" },
        },
      });
    const envelope = await getBurnStatus(okReader);
    const data = envelope.data as BurnStatus;
    expect(data.available).toBe(true);
    expect(data.stale).toBe(false);
    expect(typeof data.asOf).toBe("string");
  });
});
