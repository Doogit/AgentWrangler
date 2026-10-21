import type { ReactNode } from "react";
import type { RecommendationCard } from "../../query/api/recommendations";
import InfoTip from "../shell/InfoTip";

export const CATEGORY_LABEL: Record<string, string> = {
  CONTEXT: "Context",
  MODEL: "Model",
  TOOLING: "Tooling",
  CACHE: "Cache",
  LIMIT: "Limits",
  SESSION_HYGIENE: "Session hygiene",
};
export const KIND_LABEL: Record<string, string> = {
  HABIT: "Habit",
  CONFIG: "Config",
  EDIT: "Edit",
  INVESTIGATE: "Investigate",
};
export const COPY_LABEL: Record<string, string> = {
  HABIT: "Copy instruction",
  INVESTIGATE: "Copy prompt",
};
export const REVIEW_LABEL: Record<string, string> = {
  CONFIG: "Review config",
  EDIT: "Review edit",
};
export const TRACK_UNAVAILABLE: Record<string, string> = {
  HANDLER_UNAVAILABLE:
    "Track is unavailable: no effect handler measures this recommendation's metric yet, so its before/after spend can't be compared.",
};
export const EFFECT_NOT_MEASURED_HELP =
  "Adopting records this change, but nothing tracks this recommendation's metric yet, so there will be no before/after verdict.";
/** Evidence windows are half-open UTC intervals; show their included calendar dates. */
export function evidenceWindowLabel(
  count: number | null | undefined,
  window: { from: string; to: string } | null,
  subjectSuffix?: string,
): string {
  // R6-14: an unknown count means the full cohort was not established, not a data failure —
  // omit the count instead of claiming it is "unavailable" next to real dates.
  const sessions =
    count == null
      ? null
      : `${count.toLocaleString()} session${count === 1 ? "" : "s"}${subjectSuffix ?? ""}`;
  if (!window) return sessions === null ? "dates unavailable" : `${sessions}, dates unavailable`;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    return sessions === null ? "dates unavailable" : `${sessions}, dates unavailable`;
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const dates = `${format.format(from)} – ${format.format(to - 1)}`;
  return sessions === null ? dates : `${sessions}, ${dates}`;
}

export function isUnmeasured(rec: {
  action_validation?: RecommendationCard["action_validation"] | undefined;
}): boolean {
  const primary = rec.action_validation?.primary;
  return primary?.ok === true && primary.measured === false;
}
export function trackUnavailableReason(rec: RecommendationCard): string {
  return (
    TRACK_UNAVAILABLE[rec.effect_capability?.reason ?? ""] ??
    "Track is unavailable for this recommendation: its effect can't be measured automatically."
  );
}
export const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
/**
 * Folded detectors whose $ is priced on the owner's card (B4 events are all B1 collapses; B2's
 * expired-cache resumes are the idle breaks D8 prices, MED-1).
 */
export const FOLDED_HEADLINE_OWNER: Readonly<Record<string, string>> = { B4: "B1", B2: "D8" };
const FOLDED_HEADLINE_WHY: Readonly<Record<string, string>> = {
  B2: "D8 prices the cache rewrites after a break. This card shows its own count of those resumes, in tokens only, so the same spend is not counted twice. Where D8 has no card, these resumes have no $ figure.",
};
export function isD1Heuristic(rec: RecommendationCard): boolean {
  return rec.detector_id === "D1" && rec.evidence.attribution_method !== "MEASURED_CONTENT";
}
export function savingsRange(rec: RecommendationCard): [number, number] | null {
  return (
    rec.range_u_per_wk ??
    (rec.modeled_savings_u_per_wk === null
      ? null
      : [rec.modeled_savings_u_per_wk, rec.modeled_savings_u_per_wk])
  );
}
/**
 * The card headline (P3.L L6): `allocated_u_per_wk` when the API set it (a number, or `null` =
 * "not estimated"); `modeled_savings_u_per_wk` only for legacy fixtures that omit it.
 * Same semantics as `headlineSavings` in the recs API.
 */
export function headlineSavings(rec: RecommendationCard): number | null {
  return rec.allocated_u_per_wk !== undefined
    ? rec.allocated_u_per_wk
    : rec.modeled_savings_u_per_wk;
}
/**
 * F1 (card review 2026-10-04): a net headline above the fix's own range covers more spend than
 * this fix removes, so the card shows the range only.
 */
export function netAboveRange(rec: RecommendationCard): boolean {
  return (
    typeof rec.allocated_u_per_wk === "number" &&
    rec.range_u_per_wk != null &&
    rec.allocated_u_per_wk > rec.range_u_per_wk[1]
  );
}
/**
 * Meter bounds: a numeric net headline draws its range band when it sits inside or above
 * `range_u_per_wk`; below the range (overlaps took part of it) or with no range it is a point.
 * `null` (not estimated) has no meter; legacy cards (`allocated_u_per_wk` undefined) keep the
 * standalone range / modeled point.
 */
export function meterBounds(rec: RecommendationCard): [number, number] | null {
  if (rec.allocated_u_per_wk === null) return null;
  if (typeof rec.allocated_u_per_wk !== "number") return savingsRange(rec);
  const range = rec.range_u_per_wk;
  return range != null && rec.allocated_u_per_wk >= range[0]
    ? range
    : [rec.allocated_u_per_wk, rec.allocated_u_per_wk];
}
export function isQuantified(rec: RecommendationCard): boolean {
  return rec.allocated_u_per_wk !== undefined
    ? rec.allocated_u_per_wk !== null
    : rec.modeled_savings_u_per_wk !== null || (rec.range_u_per_wk ?? null) !== null;
}
export function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
export function ReviewIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h10M4 17h7" />
    </svg>
  );
}
export function RecChips({
  rec,
  overview = false,
  afterCategory,
}: { rec: RecommendationCard; overview?: boolean; afterCategory?: ReactNode }) {
  const primary = rec.actions?.primary;
  return (
    <div className={overview ? "overview-top-rec-chips" : "rec-presentation-chips"}>
      <span className={`chip rec-cat-chip${overview ? " overview-top-rec-cat" : ""}`}>
        {CATEGORY_LABEL[rec.category] ?? rec.category}
      </span>
      {afterCategory}
      {primary && <span className="chip">{KIND_LABEL[primary.kind] ?? primary.kind}</span>}
      {isUnmeasured(rec) && (
        <span className="chip">
          Effect not tracked{" "}
          <InfoTip label="Effect not tracked" content={EFFECT_NOT_MEASURED_HELP} />
        </span>
      )}
    </div>
  );
}
/** A COUNT metric from the card's v2 evidence, or null. */
function metricCount(rec: RecommendationCard, code: string): number | null {
  const entry = (rec.evidence.metrics as Record<string, { value?: unknown }> | undefined)?.[code];
  return typeof entry?.value === "number" && Number.isFinite(entry.value) ? entry.value : null;
}
/** 0–100 share: "<0.1%" when tiny, one decimal under 10, whole numbers above. */
function fmtShare(pct: number): string {
  if (pct < 0.1) return "<0.1%";
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}
export function SavingsMeter({
  rec,
  scale,
  testIdSuffix,
  overview = false,
}: {
  rec: RecommendationCard;
  scale: number;
  testIdSuffix: string | number;
  overview?: boolean;
}) {
  // Safety lane (operator 2026-10-04): a count of what ran or was blocked, never a $.
  if (rec.safety_lane) {
    const guard = rec.detector_id === "C9";
    const n = metricCount(rec, guard ? "DENIAL_COUNT" : "OPERATION_COUNT");
    return (
      <div
        className="rec-savings-meter rec-savings-safety"
        data-testid={`savings-safety-${testIdSuffix}`}
      >
        {n !== null && (
          <strong className="rec-savings-estimate">
            {n.toLocaleString()}{" "}
            {guard ? `blocked call${n === 1 ? "" : "s"}` : `run${n === 1 ? "" : "s"}`}
          </strong>
        )}{" "}
        <small className="rec-savings-line">safety, not priced</small>{" "}
        <InfoTip
          label="About safety cards"
          content={
            guard
              ? "Calls your own PreToolUse guard stopped. The guard did its job; the fix is getting Claude to use an allowed shape the first time. No dollar figure: the point is safety, not spend."
              : "Times Claude ran a command that cannot be undone. No dollar figure: a wrong path or branch loses work for good, whatever the session cost."
          }
        />
      </div>
    );
  }
  // P3.L L6: the card headline is the allocated (net-of-overlaps) ledger figure when the API
  // sets it. `null` means this detector has no spend-ledger producer — never a $ figure, even
  // when the standalone formula (in the details) has one. `undefined` is a pre-L6 fixture;
  // fall back to the standalone modeled figure exactly as before.
  if (rec.allocated_u_per_wk === null) {
    // Reliability lane: the ledger's recovery-turn cost, an upper bound — never a saving.
    if (typeof rec.reliability_u_per_wk === "number") {
      return (
        <div
          className="rec-savings-meter rec-savings-reliability"
          data-testid={`savings-reliability-${testIdSuffix}`}
        >
          <strong className="rec-savings-estimate">
            {rec.reliability_u_per_wk > 0 && dollars(rec.reliability_u_per_wk) === "$0.00"
              ? "under $0.01"
              : dollars(rec.reliability_u_per_wk)}
            /wk
          </strong>{" "}
          <small className="rec-savings-line">upper bound</small>{" "}
          <InfoTip
            label="About this upper bound"
            content="Full cost of the turn after each failure (the model reading the error and re-planning). This is a ceiling, not an estimate: much of a turn's cost (re-reading the context) is paid by any turn, and some of the turn may be useful work."
          />
          {typeof rec.reliability_sidechain_u_per_wk === "number" &&
            rec.reliability_sidechain_u_per_wk > 0 && (
              <small
                className="rec-savings-line"
                data-testid={`savings-reliability-subagent-${testIdSuffix}`}
              >
                {" "}
                + {dollars(rec.reliability_sidechain_u_per_wk)}/wk in subagents{" "}
                <InfoTip
                  label="Subagent failures"
                  content="The same upper bound for these failures inside subagents. Kept out of the headline because this card's fix targets the main conversation."
                />
              </small>
            )}
        </div>
      );
    }
    // Standalone lane: a detector-only estimate that overlaps other cards, so it stays out of the
    // page total but is still a dollar figure (E1/E2).
    const modeled = rec.modeled_savings_u_per_wk;
    if (typeof modeled === "number" && modeled > 0 && rec.estimate?.summable === false) {
      return (
        <div className="rec-savings-meter" data-testid={`savings-standalone-${testIdSuffix}`}>
          <strong className="rec-savings-estimate">{dollars(modeled)}/wk</strong>{" "}
          <small className="rec-savings-line">estimate · not in page total</small>{" "}
          <InfoTip
            label="About this estimate"
            content="Standalone estimate from this card's own formula, with an assumed avoidable share (see the details). Some of this cost is also counted by other cards, so it is left out of the page total."
          />
        </div>
      );
    }
    // Folded lane (F5): every event is also priced by the owner card, so no second $ figure.
    const owner = FOLDED_HEADLINE_OWNER[rec.detector_id];
    if (owner !== undefined) {
      return (
        <div
          className="rec-savings-meter rec-savings-empty"
          data-testid={`savings-folded-${testIdSuffix}`}
        >
          $ counted in {owner}{" "}
          <InfoTip
            label="Why no figure here"
            content={
              FOLDED_HEADLINE_WHY[rec.detector_id] ??
              `Every event on this card is also an event on the ${owner} card, which already prices it. Showing it here too would count the same spend twice.`
            }
          />
        </div>
      );
    }
    return (
      <div
        className="rec-savings-meter rec-savings-empty"
        data-testid={`savings-not-estimated-${testIdSuffix}`}
      >
        Not estimated{" "}
        <InfoTip
          label="Why not estimated"
          content="This detector has no spend-ledger producer yet, so there is no dollar figure for it. This doesn't mean the fix is worthless — the standalone estimate, if any, is in the details."
        />
      </div>
    );
  }
  const netOfOverlaps = typeof rec.allocated_u_per_wk === "number";
  const rangeOnly = netAboveRange(rec);
  const estimate = rangeOnly ? null : headlineSavings(rec);
  const bounds = meterBounds(rec);
  // The heuristic range replaces the headline only for legacy cards; a net headline wins.
  const heuristic = isD1Heuristic(rec) && !netOfOverlaps;
  if (bounds === null)
    return (
      <div className="rec-savings-meter rec-savings-empty">
        No modeled savings{" "}
        <InfoTip
          label="Why no modeled savings"
          content="This finding has no dollar model yet. What's wrong and its facts show how large it is, in tokens, calls or bytes."
        />
      </div>
    );
  const low = Math.max(0, bounds[0]);
  const high = Math.max(low, bounds[1]);
  const pointWidth =
    scale > 0 && estimate !== null && !heuristic ? (Math.max(0, estimate) / scale) * 100 : 0;
  const rangeLeft =
    scale > 0 ? ((estimate === null || heuristic ? low : Math.max(0, estimate)) / scale) * 100 : 0;
  const rangeWidth = scale > 0 ? (high / scale) * 100 - rangeLeft : 0;
  return (
    <div className={`rec-savings-meter${overview ? " overview-top-rec-impact" : ""}`}>
      <span>
        {heuristic || estimate === null ? "Modeled range" : "Modeled savings"}{" "}
        <InfoTip
          label="About modeled savings"
          content={
            heuristic
              ? "Savings range varies the trim assumption only. Source token count uses a chars/4 heuristic and its uncertainty is not bounded by this range."
              : rangeOnly
                ? `This fix's own modeled range. The net-of-overlaps figure for this finding (${dollars(rec.allocated_u_per_wk as number)}/wk) covers more spend than this one fix removes, so it is not shown as the saving.`
                : netOfOverlaps
                  ? "Estimated weekly savings from recent usage, net of overlaps with other recommendations. Not a measured result. A larger number suggests more potential impact; review the recommendation before changing a habit or setting."
                  : "Estimated weekly savings from recent usage, not measured results. A larger number suggests more potential impact; review the recommendation before changing a habit or setting."
          }
        />
      </span>
      {estimate !== null && !heuristic ? (
        <strong className="rec-savings-estimate overview-top-rec-estimate">
          {dollars(estimate)}/wk
          {netOfOverlaps && (
            <small className="rec-savings-line rec-savings-net-of-overlaps">
              net of overlaps{" "}
              <InfoTip
                label="Net of overlaps"
                content="Spend in the last 7 days this fix would remove. When several recommendations target the same tokens, each token is counted once, for the most specific fix, so card figures add up without double counting. The standalone estimate is in the details."
              />
            </small>
          )}
          {typeof rec.pct_of_total_weekly_spend === "number" && (
            <small className="rec-savings-share">
              {fmtShare(rec.pct_of_total_weekly_spend)} of weekly spend{" "}
              <InfoTip
                label="Share of weekly spend"
                content="This saving as a share of your spend in the last 7 days, across all workspaces. Higher means a bigger part of your bill. It is an estimate, not a measured result."
              />
            </small>
          )}
        </strong>
      ) : (
        <strong>
          {dollars(low)}–{dollars(high)}
          <small>/wk</small>
        </strong>
      )}
      <div
        className="overview-top-rec-meter"
        role="img"
        aria-label={`Savings range ${dollars(low)} to ${dollars(high)} per week`}
      >
        {pointWidth > 0 && (
          <span
            className="overview-top-rec-point rec-savings-point"
            style={{ width: `${Math.min(100, pointWidth)}%` }}
            data-testid={`savings-point-${testIdSuffix}`}
          />
        )}
        {rangeWidth > 0 && (
          <span
            className="overview-top-rec-range rec-savings-range"
            style={{
              left: `${Math.min(100, rangeLeft)}%`,
              width: `${Math.min(100 - rangeLeft, rangeWidth)}%`,
            }}
            data-testid={`savings-range-${testIdSuffix}`}
          />
        )}
      </div>
      <span>
        {estimate === null || heuristic
          ? "range only · no point estimate"
          : // Review 6 R6-50: name the low end, so a top-of-range estimate doesn't hide it.
            [
              ...(low < estimate ? [`as low as ${dollars(low)}`] : []),
              ...(high > estimate ? [`up to ${dollars(high)}`] : []),
            ].join(", ") || "point estimate"}
      </span>
    </div>
  );
}
