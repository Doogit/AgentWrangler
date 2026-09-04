/**
 * src/ui/sessions/SpendPercentileChip.tsx — BM3 self-percentile chip.
 *
 * Renders "top X% of your sessions by spend" against the session's OWN workspace
 * history (the only honest peer group). Plain observed numbers — no proxy claim,
 * no dollar headline. Returns null (nothing rendered) when the percentile is
 * withheld (peer set below n>=20), so a tiny-n session never shows a misleading
 * rank. The tooltip carries the n and the window, per spec.
 */

import Chip from "../shell/Chip";

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
  // percentile = share of your sessions costing at or below this one. Both the
  // label and the tooltip derive from ONE rounded value so they always read as
  // complementary shares, and the "top X%" headline is clamped to [1,99] so the
  // chip can never render the misleading extremes "top 0%" or "top 100%".
  const atOrAbovePct = Math.round(percentile * 100);
  const topPercent = Math.min(99, Math.max(1, 100 - atOrAbovePct));
  return (
    <Chip
      kind="EXACT"
      label={`top ${topPercent}% by spend`}
      title={`Ranks at or above ${atOrAbovePct}% of your ${n} sessions in this workspace (trailing ${windowDays} days).`}
    />
  );
}
