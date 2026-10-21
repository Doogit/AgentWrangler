/**
 * src/ui/sessions/SpendPercentileChip.tsx — BM3 self-percentile text.
 *
 * Renders "top X% of your sessions by spend" against the session's OWN workspace
 * history (the only honest peer group). Plain observed numbers — no proxy claim,
 * no dollar headline. Returns null (nothing rendered) when the percentile is
 * withheld (peer set below n>=20), so a tiny-n session never shows a misleading
 * rank. The tooltip carries the n and the window, per spec.
 *
 * OV-11 item 20/24: rendered as muted text (no repeated pill) — a bold cost
 * figure and thin bar already carry the emphasis in both call sites.
 */

/**
 * percentile = share of your sessions costing at or below this one. Clamped to
 * [1,99] so the "top X%" headline can never read the misleading extremes
 * "top 0%" or "top 100%".
 */
export function topSpendPercent(percentile: number): number {
  const atOrAbovePct = Math.round(percentile * 100);
  return Math.min(99, Math.max(1, 100 - atOrAbovePct));
}

export function SpendPercentileChip({
  percentile,
  n,
  windowDays = 90,
}: {
  percentile: number | null | undefined;
  n: number;
  windowDays?: number;
}) {
  if (percentile === null || percentile === undefined) return null;
  // Label and tooltip derive from the same rounded value so they always read
  // as complementary shares.
  const atOrAbovePct = Math.round(percentile * 100);
  const topPercent = topSpendPercent(percentile);
  return (
    <span
      className="session-cost-percentile"
      title={`This session has estimated value at or above ${atOrAbovePct}% of your ${n} sessions in this workspace over the past ${windowDays} days.`}
    >
      {`top ${topPercent}% by estimated value`}
    </span>
  );
}
