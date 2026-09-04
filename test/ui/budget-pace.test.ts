/**
 * test/ui/budget-pace.test.ts — Unit tests for computeBudgetPace.
 * Spec: FB4 §3.
 */

import { describe, expect, it } from "vitest";
import { computeBudgetPace } from "../../src/ui/overview/budget-pace";

const WEEK_MS = 7 * 86_400_000;
const RESETS_AT = "2026-09-09T00:00:00Z";
const WINDOW_START_MS = Date.parse(RESETS_AT) - WEEK_MS; // 2026-09-02T00:00:00Z

describe("computeBudgetPace", () => {
  it("B≈0 at window start", () => {
    // 1 second past window start → B is essentially 0
    const now = new Date(WINDOW_START_MS + 1_000);
    const result = computeBudgetPace(RESETS_AT, now, 0.1);

    expect(result.B).toBeCloseTo(0, 3);
    expect(result.budgetPct).toBe(0);
    expect(result.actualPct).toBe(10);
    // deltaPts = round(10 - 0) = 10 (over pace)
    expect(result.deltaPts).toBe(10);
    expect(result.daysElapsed).toBeCloseTo(0, 1);
  });

  it("mid-week over-pace: 65% used at 50% elapsed", () => {
    // Exactly 3.5 days into the 7-day window
    const now = new Date(WINDOW_START_MS + 3.5 * 86_400_000);
    const result = computeBudgetPace(RESETS_AT, now, 0.65);

    expect(result.B).toBeCloseTo(0.5, 5);
    expect(result.budgetPct).toBe(50);
    expect(result.actualPct).toBe(65);
    // deltaPts = round(0.65*100 - 0.5*100) = round(15) = 15
    expect(result.deltaPts).toBe(15);
    expect(result.deltaPts).toBeGreaterThan(2); // triggers amber chip
    expect(result.daysElapsed).toBe(3.5);
  });

  it("mid-week under-pace: 20% used at 50% elapsed", () => {
    const now = new Date(WINDOW_START_MS + 3.5 * 86_400_000);
    const result = computeBudgetPace(RESETS_AT, now, 0.2);

    expect(result.budgetPct).toBe(50);
    expect(result.actualPct).toBe(20);
    // deltaPts = round(0.2*100 - 0.5*100) = round(-30) = -30
    expect(result.deltaPts).toBe(-30);
    expect(result.deltaPts).toBeLessThan(-2); // triggers green chip
  });

  it("B=1 at window end (clamped)", () => {
    // 1 second after reset → B clamped to 1
    const now = new Date(Date.parse(RESETS_AT) + 1_000);
    const result = computeBudgetPace(RESETS_AT, now, 1.0);

    expect(result.B).toBe(1);
    expect(result.budgetPct).toBe(100);
    expect(result.actualPct).toBe(100);
    expect(result.deltaPts).toBe(0);
    expect(result.daysElapsed).toBe(7);
  });

  it("null resetsAt → all tracking fields are null, actualPct still computed", () => {
    const result = computeBudgetPace(null, new Date(), 0.5);

    expect(result.B).toBeNull();
    expect(result.budgetPct).toBeNull();
    expect(result.deltaPts).toBeNull();
    expect(result.daysElapsed).toBeNull();
    expect(result.actualPct).toBe(50);
  });

  it("EXCEEDED fraction (>1): deltaPts positive, B clamped", () => {
    const now = new Date(WINDOW_START_MS + 3.5 * 86_400_000); // 50% elapsed
    const result = computeBudgetPace(RESETS_AT, now, 1.1); // 110% used

    expect(result.actualPct).toBe(110);
    // deltaPts = round(1.1*100 - 0.5*100) = round(60) = 60
    expect(result.deltaPts).toBe(60);
    expect(result.deltaPts).toBeGreaterThan(2);
  });

  it("on-pace zone: |deltaPts| <= 2 stays neutral", () => {
    // 50% elapsed, 51% used → delta = 1 → on pace
    const now = new Date(WINDOW_START_MS + 3.5 * 86_400_000);
    const result = computeBudgetPace(RESETS_AT, now, 0.51);

    expect(result.deltaPts).toBe(1);
    // between -2 and +2 exclusive → neutral
    expect(result.deltaPts).toBeLessThanOrEqual(2);
    expect(result.deltaPts).toBeGreaterThanOrEqual(-2);
  });
});
