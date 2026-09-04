/**
 * src/ui/overview/budget-pace.ts — Budget-pace math for BurnForecastCard.
 *
 * Pure helper: no I/O, no React. Testable in isolation.
 * Spec: FB4 §3.
 */

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface BudgetPaceResult {
  /** Elapsed-week fraction [0,1]; null when no reset anchor is available. */
  B: number | null;
  /** B as integer percentage (0–100); null when B is null. */
  budgetPct: number | null;
  /** actualFraction as integer percentage. */
  actualPct: number;
  /** actualPct - budgetPct (before rounding each); null when B is null. */
  deltaPts: number | null;
  /** Days elapsed in the current window (1dp); null when B is null. */
  daysElapsed: number | null;
}

/**
 * Compute budget-pace metrics for the burn-forecast card tick mark.
 *
 * B = clamp((now - windowStart) / 7d, 0, 1)
 * where windowStart = resetsAt - 7d.
 *
 * Returns all-null tracking fields when `resetsAt` is null (no window anchor).
 */
export function computeBudgetPace(
  resetsAt: string | null,
  now: Date,
  actualFraction: number,
): BudgetPaceResult {
  const actualPct = Math.round(actualFraction * 100);

  if (resetsAt === null) {
    return { B: null, budgetPct: null, actualPct, deltaPts: null, daysElapsed: null };
  }

  const resetsAtMs = Date.parse(resetsAt);
  const windowStartMs = resetsAtMs - 7 * 86_400_000;
  const B = clamp((now.getTime() - windowStartMs) / (7 * 86_400_000), 0, 1);

  return {
    B,
    budgetPct: Math.round(B * 100),
    actualPct,
    deltaPts: Math.round(actualFraction * 100 - B * 100),
    daysElapsed: Math.round(B * 7 * 10) / 10,
  };
}
