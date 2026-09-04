/**
 * src/ui/overview/BurnForecastCard.tsx — Burn forecast KPI card (FB4).
 *
 * Renders all 6 states of the BurnForecast state machine:
 *   OFF | COLD_START | NO_BURN | EXCEEDED | WARNING | OK
 *
 * Claim kind: PROXY (derived from stored token counts + configured limit).
 * When state = "OFF", :limit_tokens is not configured → show configure prompt.
 *
 * Fraction source preference (spec FB4 §2):
 *   1. Live:       burnStatus?.available && burnStatus.seven_day → utilization
 *   2. Calibrated: forecast.limit_tokens → tokens_used / limit_tokens
 *   3. Neither:    state = OFF → configure CTA only.
 *
 * WCAG: every color accent is paired with a text label (never color-only).
 */

import type { BurnStatus } from "../../query/api/burn-status";
import type { ForecastFromDbResult } from "../../query/forecast";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import { computeBudgetPace } from "./budget-pace";

interface BurnForecastCardProps {
  forecast: ForecastFromDbResult;
  burnStatus: BurnStatus | null;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

/** ISO-8601 timestamp → short weekday+date string, e.g. "Wed, Sep 9". */
function isoToShortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function BurnForecastCard({ forecast, burnStatus }: BurnForecastCardProps) {
  const { state, tokens_used, tokens_per_day, limit_tokens, limit_confidence, limit_resets_at } =
    forecast;

  // ── Fraction + reset anchor ──────────────────────────────────────────────
  const liveUtil = burnStatus?.available ? burnStatus.seven_day : undefined;

  // Prefer live; fall back to calibrated.
  const fraction: number | null = liveUtil
    ? liveUtil.utilization
    : limit_tokens !== null
      ? tokens_used / limit_tokens
      : null;

  const resetsAt: string | null = liveUtil?.resets_at ?? limit_resets_at ?? null;

  // ── Budget-pace (tick + delta chip + caption) ────────────────────────────
  const pace = fraction !== null ? computeBudgetPace(resetsAt, new Date(), fraction) : null;

  // Meter is clamped at 100%; headline pct is not clamped (shows >100% for EXCEEDED).
  const meterPct = fraction !== null ? Math.min(fraction, 1) * 100 : 0;
  const pctDisplay = fraction !== null ? Math.round(fraction * 100) : null;

  // ── Pace line projection ─────────────────────────────────────────────────
  const daysRemaining = pace !== null && pace.B !== null ? 7 * (1 - pace.B) : null;
  const projEnd =
    tokens_per_day !== null && limit_tokens !== null && daysRemaining !== null
      ? Math.round(((tokens_used + tokens_per_day * daysRemaining) / limit_tokens) * 100)
      : null;

  // ── State chip ───────────────────────────────────────────────────────────
  const stateClass = state === "EXCEEDED" ? "red" : state === "WARNING" ? "amber" : "green";
  const stateLabel = state === "EXCEEDED" ? "EXCEEDED" : state === "WARNING" ? "WARN" : "ON TRACK";

  // ── Delta chip ───────────────────────────────────────────────────────────
  const deltaPts = pace?.deltaPts ?? null;
  const deltaClass =
    deltaPts !== null && deltaPts > 2
      ? "amber"
      : deltaPts !== null && deltaPts < -2
        ? "green"
        : "neutral";
  const deltaLabel =
    deltaPts !== null && deltaPts > 2
      ? `${deltaPts} pts over weekly pace`
      : deltaPts !== null && deltaPts < -2
        ? `${Math.abs(deltaPts)} pts under pace`
        : "on pace";

  return (
    <div className="kpi card">
      <div className="kpi-label">
        BURN FORECAST{" "}
        <InfoTip
          label="What the burn forecast shows"
          content="Projects when you'll hit a usage limit at your current pace. If the date lands before the reset, slow down or switch to a cheaper model."
        />
      </div>

      {/* ── OFF: no limit configured ─────────────────────────────────────── */}
      {state === "OFF" && (
        <>
          <div className="kpi-off" aria-label="Forecast off">
            ● OFF
          </div>
          <div className="kpi-off-hint">
            Configure <span title=":limit_tokens">Weekly token limit</span> in Settings to enable
            burn alerting.
          </div>
        </>
      )}

      {/* ── Non-OFF: pct / meter / sub-lines ─────────────────────────────── */}
      {state !== "OFF" && fraction !== null && (
        <>
          {/* Headline */}
          <div className="bfc-headline">{pctDisplay}% of weekly limit</div>

          {/* Meter with optional budget-pace tick */}
          <div
            className="bfc-meter"
            role="progressbar"
            tabIndex={0}
            aria-valuenow={Math.min(pctDisplay ?? 0, 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${pctDisplay}% of weekly limit used`}
          >
            <div
              className={`bfc-meter-fill bfc-fill-${stateClass}`}
              style={{ width: `${meterPct}%` }}
            />
            {pace !== null && pace.B !== null && (
              <div className="bfc-tick" style={{ left: `${pace.B * 100}%` }} aria-hidden="true" />
            )}
          </div>

          {/* Delta chip + caption (only when budget tick is available) */}
          {pace !== null && pace.B !== null && (
            <>
              {/* biome-ignore lint/a11y/useSemanticElements: chip badge uses role="status"; <output> semantics differ */}
              <span className={`chip bfc-delta-chip bfc-delta-${deltaClass}`} role="status">
                {deltaLabel}
              </span>
              <div className="bfc-caption">
                {pace.daysElapsed} of 7 days elapsed → {pace.budgetPct}% budgeted vs{" "}
                {pace.actualPct}% used
              </div>
            </>
          )}

          {/* Sub-line: tokens used / limit + reset day */}
          <div className="kpi-subval">
            {fmtTokens(tokens_used)}
            {limit_tokens !== null && <> / {fmtTokens(limit_tokens)} cap-weighted</>}
            {resetsAt !== null && <> · resets {isoToShortDay(resetsAt)}</>}
          </div>

          {/* Pace line */}
          {tokens_per_day !== null && (
            <div className="kpi-subval">
              {fmtTokens(tokens_per_day)}/day
              {projEnd !== null && <> · at this pace you&apos;d end the week at ~{projEnd}%</>}
            </div>
          )}

          {/* COLD_START hint */}
          {state === "COLD_START" && (
            <div className="kpi-subval">Building baseline — need ≥7 days of data</div>
          )}
        </>
      )}

      {/* ── Chips row ────────────────────────────────────────────────────── */}
      <div className="chips">
        {state !== "OFF" && fraction !== null && (
          // biome-ignore lint/a11y/useSemanticElements: chip badge uses role="status"; <output> semantics differ
          <span className={`chip bfc-state-chip bfc-chip-${stateClass}`} role="status">
            {stateLabel}
          </span>
        )}
        {(limit_confidence ?? null) === "low" && (
          // biome-ignore lint/a11y/useSemanticElements: chip badge uses role="status"; <output> semantics differ
          <span className="chip bfc-chip-low-confidence" role="status">
            LOW CONFIDENCE
          </span>
        )}
        <Chip kind="PROXY" />
      </div>
    </div>
  );
}
