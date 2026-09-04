/**
 * src/ui/sessions/FrictionCell.tsx — RV2b L1 friction surface.
 *
 * Surfaces per-session friction component counts and a coarse directional band.
 * Exported for reuse on workspace drill-down (deferred — see RV2b scope note).
 *
 * Claim kind: DIRECTIONAL.
 * No composite score (METR cautionary). No dollar claims. No generic advice copy.
 * SEC-101: counts/bands/ids only — never message content.
 */

import { LONG_GAP_THRESHOLD_S } from "../../ingest/types.js";
import Chip from "../shell/Chip";

// ---------------------------------------------------------------------------
// Thresholds (named in every tooltip — required by spec)
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  api_errors: { elevated: 1, high: 3 },
  tool_errors: { elevated: 1, high: 3 },
  test_fails: { elevated: 1, high: 3 },
  compactions: { elevated: 1, high: 2 },
  interrupts: { elevated: 1, high: 2 },
  /** Re-prompt density = user_turn_count / turn_count */
  reprompt: { elevated: 0.4, high: 0.6 },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrictionCounts {
  api_error_count: number;
  tool_error_count: number;
  test_fail_count: number;
  compaction_count: number;
  interrupt_count: number;
  user_turn_count: number;
  turn_count: number;
  /** EF3 gap aggregates — null when gap_n < 2 (not enough user turns). */
  gap_median_s?: number | null;
  gap_p90_s?: number | null;
  long_gap_count?: number;
  gap_n?: number;
}

export type FrictionBand = "LOW" | "ELEVATED" | "HIGH";

// ---------------------------------------------------------------------------
// Band computation
// ---------------------------------------------------------------------------

export function frictionBand(c: FrictionCounts): FrictionBand {
  const density = c.turn_count > 0 ? c.user_turn_count / c.turn_count : 0;
  const isHigh =
    c.api_error_count >= THRESHOLDS.api_errors.high ||
    c.tool_error_count >= THRESHOLDS.tool_errors.high ||
    c.test_fail_count >= THRESHOLDS.test_fails.high ||
    c.compaction_count >= THRESHOLDS.compactions.high ||
    c.interrupt_count >= THRESHOLDS.interrupts.high ||
    density >= THRESHOLDS.reprompt.high;
  if (isHigh) return "HIGH";

  const isElevated =
    c.api_error_count >= THRESHOLDS.api_errors.elevated ||
    c.tool_error_count >= THRESHOLDS.tool_errors.elevated ||
    c.test_fail_count >= THRESHOLDS.test_fails.elevated ||
    c.compaction_count >= THRESHOLDS.compactions.elevated ||
    c.interrupt_count >= THRESHOLDS.interrupts.elevated ||
    density >= THRESHOLDS.reprompt.elevated;
  if (isElevated) return "ELEVATED";

  return "LOW";
}

// ---------------------------------------------------------------------------
// Tooltip (names every threshold — required by spec)
// ---------------------------------------------------------------------------

export const FRICTION_TOOLTIP = [
  "Friction signals — directional band, not a precision score.",
  "",
  "Thresholds (any component triggers the band):",
  `  API errors: ELEVATED ≥ ${THRESHOLDS.api_errors.elevated}, HIGH ≥ ${THRESHOLDS.api_errors.high}`,
  `  Tool errors (exit_class=ERROR): ELEVATED ≥ ${THRESHOLDS.tool_errors.elevated}, HIGH ≥ ${THRESHOLDS.tool_errors.high}`,
  `  Test fails (exit_class=TEST_FAIL): ELEVATED ≥ ${THRESHOLDS.test_fails.elevated}, HIGH ≥ ${THRESHOLDS.test_fails.high}`,
  `  Compactions: ELEVATED ≥ ${THRESHOLDS.compactions.elevated}, HIGH ≥ ${THRESHOLDS.compactions.high}`,
  `  Interrupts: ELEVATED ≥ ${THRESHOLDS.interrupts.elevated}, HIGH ≥ ${THRESHOLDS.interrupts.high} (no reliable corpus marker — always 0)`,
  `  Re-prompt density (user turns / total turns): ELEVATED ≥ ${THRESHOLDS.reprompt.elevated * 100}%, HIGH ≥ ${THRESHOLDS.reprompt.high * 100}%`,
  "",
  `EF3 gap aggregates: median/p90 inter-user-turn gap (s); long gap = gap > ${LONG_GAP_THRESHOLD_S}s. Shown when gap_n ≥ 2; "—" otherwise.`,
  "",
  "Loop events (D7 signal): not shown here — visible in Cost Drivers panel when D7 fires.",
].join("\n");

// ---------------------------------------------------------------------------
// Band visual config
// ---------------------------------------------------------------------------

const BAND_COLOR: Record<FrictionBand, string> = {
  LOW: "var(--green)",
  ELEVATED: "var(--amber)",
  HIGH: "var(--red)",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Compact friction cell for table rows and a strip for detail pages.
 *
 * variant="compact" — minimal: band chip + summary counts (zeros omitted).
 * variant="strip"   — full: all components shown with labels.
 */
export function FrictionCell({
  counts,
  variant = "compact",
}: {
  counts: FrictionCounts;
  variant?: "compact" | "strip";
}) {
  const band = frictionBand(counts);
  const density = counts.turn_count > 0 ? counts.user_turn_count / counts.turn_count : 0;

  const bandDot = (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: BAND_COLOR[band],
        flexShrink: 0,
        verticalAlign: "middle",
        marginRight: 4,
      }}
      aria-hidden="true"
    />
  );

  const hasGaps = (counts.gap_n ?? 0) >= 2;
  const gapMedianFmt =
    hasGaps && counts.gap_median_s !== null && counts.gap_median_s !== undefined
      ? `${Math.round(counts.gap_median_s)}s`
      : "—";
  const gapP90Fmt =
    hasGaps && counts.gap_p90_s !== null && counts.gap_p90_s !== undefined
      ? `${Math.round(counts.gap_p90_s)}s`
      : "—";
  const longGapFmt = hasGaps ? String(counts.long_gap_count ?? 0) : "—";

  if (variant === "compact") {
    // Compact: band dot + chip + non-zero counts on one line
    const parts: string[] = [];
    if (counts.api_error_count > 0) parts.push(`api-err ${counts.api_error_count}`);
    if (counts.tool_error_count > 0) parts.push(`err ${counts.tool_error_count}`);
    if (counts.test_fail_count > 0) parts.push(`fail ${counts.test_fail_count}`);
    if (counts.compaction_count > 0) parts.push(`compact ${counts.compaction_count}`);
    if (counts.interrupt_count > 0) parts.push(`intr ${counts.interrupt_count}`);
    if (Math.round(density * 100) > 0) parts.push(`reprompt ${Math.round(density * 100)}%`);
    if (hasGaps && (counts.long_gap_count ?? 0) > 0)
      parts.push(`long-gap ${counts.long_gap_count ?? 0}`);

    return (
      <div
        data-testid="friction-cell"
        data-band={band}
        title={FRICTION_TOOLTIP}
        style={{ fontSize: 11, minWidth: 72 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 2 }}>
          {bandDot}
          <Chip kind="DIRECTIONAL" label={band} title={FRICTION_TOOLTIP} />
        </div>
        {parts.length > 0 && (
          <div style={{ color: "var(--text-muted)", lineHeight: 1.4 }}>{parts.join(" · ")}</div>
        )}
      </div>
    );
  }

  // Strip variant: show all components with labels
  return (
    <div
      data-testid="friction-cell"
      data-band={band}
      title={FRICTION_TOOLTIP}
      style={{ fontSize: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        {bandDot}
        <Chip kind="DIRECTIONAL" label={band} title={FRICTION_TOOLTIP} />
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: "3px 16px",
          margin: 0,
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <dt>API errors</dt>
        <dd style={{ margin: 0 }}>{counts.api_error_count}</dd>
        <dt>Tool errors</dt>
        <dd style={{ margin: 0 }}>{counts.tool_error_count}</dd>
        <dt>Test fails</dt>
        <dd style={{ margin: 0 }}>{counts.test_fail_count}</dd>
        <dt>Compactions</dt>
        <dd style={{ margin: 0 }}>{counts.compaction_count}</dd>
        <dt>Interrupts</dt>
        <dd style={{ margin: 0 }}>{counts.interrupt_count}</dd>
        <dt>Re-prompt density</dt>
        <dd style={{ margin: 0 }}>{Math.round(density * 100)}%</dd>
        <dt>Gap median</dt>
        <dd style={{ margin: 0 }} data-testid="gap-median">
          {gapMedianFmt}
        </dd>
        <dt>Gap p90</dt>
        <dd style={{ margin: 0 }} data-testid="gap-p90">
          {gapP90Fmt}
        </dd>
        <dt title={`Long gap = >${LONG_GAP_THRESHOLD_S}s`}>Long gaps</dt>
        <dd style={{ margin: 0 }} data-testid="long-gap-count">
          {longGapFmt}
        </dd>
      </dl>
    </div>
  );
}

export default FrictionCell;
