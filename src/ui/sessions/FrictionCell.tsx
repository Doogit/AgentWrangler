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
import { type SignalRow, SignalRows } from "./SignalRows";

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
  /** Missing on legacy payloads; stored zero is unsupported in either case. */
  interrupts_supported?: false | undefined;
  api_error_eligible_request_count?: null | undefined;
  api_error_rate?: null | undefined;
  tool_completed_count?: number | undefined;
  tool_completed_error_count?: number | undefined;
  tool_error_rate?: number | null | undefined;
  test_completed_count?: number | undefined;
  test_pass_count?: number | undefined;
  test_outcome?:
    | "NO_TEST_OUTCOMES"
    | "NO_FAILURES_OBSERVED"
    | "FAILURES_OBSERVED"
    | "FAILED_THEN_PASSED"
    | undefined;
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
    density >= THRESHOLDS.reprompt.high;
  if (isHigh) return "HIGH";

  const isElevated =
    c.api_error_count >= THRESHOLDS.api_errors.elevated ||
    c.tool_error_count >= THRESHOLDS.tool_errors.elevated ||
    c.test_fail_count >= THRESHOLDS.test_fails.elevated ||
    c.compaction_count >= THRESHOLDS.compactions.elevated ||
    density >= THRESHOLDS.reprompt.elevated;
  if (isElevated) return "ELEVATED";

  return "LOW";
}

// ---------------------------------------------------------------------------
// Tooltip (names every threshold — required by spec)
// ---------------------------------------------------------------------------

export const FRICTION_TOOLTIP = [
  "Legacy friction heuristic: an observation aid, not a health or quality rating.",
  "",
  "Thresholds (any component triggers the band):",
  `  API errors: ELEVATED ≥ ${THRESHOLDS.api_errors.elevated}, HIGH ≥ ${THRESHOLDS.api_errors.high}`,
  `  Tool errors: ELEVATED ≥ ${THRESHOLDS.tool_errors.elevated}, HIGH ≥ ${THRESHOLDS.tool_errors.high}`,
  `  Test failures: ELEVATED ≥ ${THRESHOLDS.test_fails.elevated}, HIGH ≥ ${THRESHOLDS.test_fails.high}`,
  `  Compactions: ELEVATED ≥ ${THRESHOLDS.compactions.elevated}, HIGH ≥ ${THRESHOLDS.compactions.high}`,
  "  Interrupts: unavailable. The stored legacy zero is unsupported telemetry, not an observed zero.",
  `  User-message share (user turns / total turns): ELEVATED ≥ ${THRESHOLDS.reprompt.elevated * 100}%, HIGH ≥ ${THRESHOLDS.reprompt.high * 100}%`,
  "",
  `Time between user messages: middle value and 90th-percentile value in seconds; a long gap is over ${LONG_GAP_THRESHOLD_S}s. Shown after at least two gaps.`,
  "",
  "Operational observations: API-request exposure is unavailable, so API-error rate is unavailable. Tool-error rate uses completed tool results when available.",
  "Test outcomes are separate from task success or failure. 'Failed then passed' only means a later test pass was observed; it does not link the tests.",
  "Interaction/context signals (compactions, user-message share, gaps) describe flow, not corrections or human wait time.",
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
  const toolRateFmt =
    counts.tool_error_rate !== undefined && counts.tool_error_rate !== null
      ? `${Math.round(counts.tool_error_rate * 100)}% (${counts.tool_completed_error_count ?? 0}/${counts.tool_completed_count ?? 0} completed)`
      : "unavailable";
  const testOutcomeLabel =
    counts.test_outcome === "FAILED_THEN_PASSED"
      ? "Failed then passed observed"
      : counts.test_outcome === "FAILURES_OBSERVED"
        ? "Failures observed"
        : counts.test_outcome === "NO_FAILURES_OBSERVED"
          ? "No failures observed"
          : "No completed test outcomes";
  const completedTestOutcomeFmt =
    counts.test_pass_count !== undefined && counts.test_outcome !== undefined
      ? `${counts.test_pass_count} completed passes · ${testOutcomeLabel}`
      : "Unavailable (completed-test outcome metadata not recorded)";

  if (variant === "compact") {
    // Compact: band dot + chip + non-zero counts on one line
    const parts: string[] = [];
    if (counts.api_error_count > 0) parts.push(`api-err ${counts.api_error_count}`);
    if (counts.tool_error_count > 0) parts.push(`tool-err ${counts.tool_error_count}`);
    if (counts.test_fail_count > 0) parts.push(`fail ${counts.test_fail_count}`);
    if (counts.compaction_count > 0) parts.push(`compact ${counts.compaction_count}`);
    if (counts.test_outcome === "FAILED_THEN_PASSED") parts.push("test fail then pass");
    if (Math.round(density * 100) > 0) parts.push(`user messages ${Math.round(density * 100)}%`);
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

  // Strip variant: one expandable row per signal, worst level first. Signals with no data are
  // hidden. The band dot + chip live in the caller's .sec-h (OV-11 item 28).
  const rows: SignalRow[] = [
    {
      label: "Operational: API errors",
      value: String(counts.api_error_count),
      ...levelOf(counts.api_error_count, THRESHOLDS.api_errors),
      found: `${plural(counts.api_error_count, "API error")} recorded. ${thresholdText(THRESHOLDS.api_errors)}`,
      why: "An API error means a request to the model failed, for example from overload or a rate limit. Claude Code retries some of these automatically; each one costs waiting time and may send the input again.",
    },
    {
      label: "Operational: tool errors",
      value: String(counts.tool_error_count),
      ...levelOf(counts.tool_error_count, THRESHOLDS.tool_errors),
      found: `${plural(counts.tool_error_count, "tool call")} returned an error.${
        counts.tool_error_rate == null ? "" : ` Tool error rate: ${toolRateFmt}.`
      } ${thresholdText(THRESHOLDS.tool_errors)}`,
      why: "Each failed tool call costs a turn, and the agent often retries the same thing. Repeated messages usually share one cause you can fix once, such as a wrong path or an edit to a stale file.",
    },
    {
      label: "Recorded test failure signals",
      value: String(counts.test_fail_count),
      ...levelOf(counts.test_fail_count, THRESHOLDS.test_fails),
      found: `${plural(counts.test_fail_count, "test failure signal")} recorded.${
        /^unavailable/i.test(completedTestOutcomeFmt)
          ? ""
          : ` Completed-test outcome: ${completedTestOutcomeFmt}.`
      } ${thresholdText(THRESHOLDS.test_fails)}`,
      why: "A failure followed by a later pass is normal while building. Failures with no later pass can mean the work was left broken. A signal does not say which test failed or whether that same test passed later.",
    },
    {
      label: "Context: compactions",
      value: String(counts.compaction_count),
      ...levelOf(counts.compaction_count, THRESHOLDS.compactions),
      found: `${
        counts.compaction_count === 0
          ? "No compactions recorded."
          : `${plural(counts.compaction_count, "compaction")} recorded: the conversation was summarized, automatically when the context window filled or by a manual /compact.`
      } ${thresholdText(THRESHOLDS.compactions)}`,
      why: "After a compaction the agent works from a summary, so it loses detail and often re-reads files, which costs tokens. Splitting long work into smaller sessions can avoid it.",
    },
    {
      label: "Interaction: user-message share",
      // Floor, not round: 39.6% must not read "40%" while its level is Normal.
      value: `${Math.floor(density * 100)}%`,
      ...levelOf(density, THRESHOLDS.reprompt),
      found: `${counts.user_turn_count.toLocaleString("en-US")} of ${counts.turn_count.toLocaleString("en-US")} turns were your messages. Elevated at ${THRESHOLDS.reprompt.elevated * 100}% or more, high at ${THRESHOLDS.reprompt.high * 100}% or more.`,
      why: "A high share means a lot of back-and-forth. That can be normal pairing or repeated corrections; clear instructions or a written plan up front can cut turns. It does not measure corrections directly.",
    },
  ];
  if (hasGaps && counts.gap_median_s != null) {
    rows.push({
      label: "Time between your messages",
      value: `median ${gapMedianFmt}`,
      rank: 3,
      found: (
        <>
          Median gap <span data-testid="gap-median">{gapMedianFmt}</span>, 90th percentile{" "}
          <span data-testid="gap-p90">{gapP90Fmt}</span>,{" "}
          <span data-testid="long-gap-count">{longGapFmt}</span>{" "}
          {counts.long_gap_count === 1 ? "gap" : "gaps"} longer than {LONG_GAP_THRESHOLD_S}s.
        </>
      ),
      why: "Context only, not part of the band. A gap includes time the agent spent working, so a long gap is not always time you were away. When no request runs for longer than the prompt cache lifetime (5 minutes by default), the next message writes the whole context to the cache again.",
    });
  }
  return (
    <div data-testid="friction-cell" data-band={band} title={FRICTION_TOOLTIP}>
      <SignalRows rows={rows} />
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function thresholdText(t: { elevated: number; high: number }): string {
  return `Elevated at ${t.elevated} or more, high at ${t.high} or more.`;
}

function levelOf(
  value: number,
  t: { elevated: number; high: number },
): Pick<SignalRow, "level" | "tone" | "rank"> {
  if (value >= t.high) return { level: "High", tone: "red", rank: 0 };
  if (value >= t.elevated) return { level: "Elevated", tone: "amber", rank: 1 };
  return { level: "Normal", rank: 2 };
}

export default FrictionCell;
