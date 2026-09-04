/**
 * src/detector/detectors/d5_limit_burn_forecast.ts — D5 LIMIT_BURN_FORECAST.
 *
 * Warning-class detector (no savings model). Uses the existing forecastFromDb
 * (ADR-107 §D-5) under the injected clock. Burn figures are CAP-WEIGHTED
 * (cache reads × COEFF, unverified — see src/query/cap-weighted.ts); the
 * caveat travels in the fired evidence via `token_metric`. Fires (global scope,
 * LIMIT category) when the forecast state is WARNING or EXCEEDED. state OFF
 * (no :limit_tokens) → degraded burn-trend row when history exists, otherwise
 * BLOCKED; OK / NO_BURN / COLD_START → INACTIVE.
 */

import type { Db } from "../../db/open.js";
import { capWeightExprSql } from "../../query/cap-weighted.js";
import { forecastFromDb } from "../../query/forecast.js";
import { d5Formula } from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_BURN_WINDOW_DAYS = 1;
const BASELINE_BURN_WINDOW_DAYS = 7;
const CALIBRATION_NUDGE = "Calibrate to get a real limit";

interface BurnAggregate {
  tokens: number;
  turns: number;
}

interface DegradedBurnTrend {
  direction: "RISING" | "FALLING" | "FLAT";
  recentTokens: number;
  recentTokensPerDay: number;
  baselineTokens: number;
  baselineTokensPerDay: number;
  deltaTokensPerDay: number;
}

function aggregateCapWeightedBurn(
  db: Db,
  fromMs: number,
  toMs: number,
  coeff: number,
): BurnAggregate {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${capWeightExprSql("turns", coeff)}), 0) AS tokens,
              COUNT(*) AS turns
         FROM turns
        WHERE ts >= ? AND ts < ?`,
    )
    .get(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
    tokens: number;
    turns: number;
  };
  return { tokens: row.tokens, turns: row.turns };
}

/** Compare the latest calendar day with the user's own preceding seven-day baseline. */
function degradedBurnTrend(db: Db, now: Date, coeff: number): DegradedBurnTrend | null {
  const recentToMs = now.getTime();
  const recentFromMs = recentToMs - RECENT_BURN_WINDOW_DAYS * MS_PER_DAY;
  const baselineFromMs = recentFromMs - BASELINE_BURN_WINDOW_DAYS * MS_PER_DAY;
  const recent = aggregateCapWeightedBurn(db, recentFromMs, recentToMs, coeff);
  const baseline = aggregateCapWeightedBurn(db, baselineFromMs, recentFromMs, coeff);

  if (recent.turns === 0 && baseline.turns === 0) return null;

  const recentTokensPerDay = recent.tokens / RECENT_BURN_WINDOW_DAYS;
  const baselineTokensPerDay = baseline.tokens / BASELINE_BURN_WINDOW_DAYS;
  const deltaTokensPerDay = recentTokensPerDay - baselineTokensPerDay;
  const direction = deltaTokensPerDay > 0 ? "RISING" : deltaTokensPerDay < 0 ? "FALLING" : "FLAT";

  return {
    direction,
    recentTokens: recent.tokens,
    recentTokensPerDay,
    baselineTokens: baseline.tokens,
    baselineTokensPerDay,
    deltaTokensPerDay,
  };
}

function directionLabel(direction: DegradedBurnTrend["direction"]): string {
  switch (direction) {
    case "RISING":
      return "rising";
    case "FALLING":
      return "falling";
    case "FLAT":
      return "flat";
  }
}

export const d5Detector: Detector = {
  id: "D5",
  name: "LIMIT_BURN_FORECAST",
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const forecast = forecastFromDb(db, { now: ctx.now });

    if (forecast.state === "OFF") {
      const trend = degradedBurnTrend(db, ctx.now, forecast.cap_read_coeff);
      if (trend === null) {
        return { fired: [], status: "BLOCKED", note: "Weekly token limit is not configured" };
      }

      const fired: Fired = {
        scopeKey: "D5|global|LIMIT_BURN_FORECAST",
        category: "LIMIT",
        scope_workspace_id: null,
        lever: `${CALIBRATION_NUDGE}, then use this burn trend to guide workload.`,
        target_metric: "burn_trend",
        modeled_savings_u_per_wk: null,
        modeled_formula: d5Formula(),
        evidence: {
          title: `Burn trend ${directionLabel(trend.direction)}: ${CALIBRATION_NUDGE}`,
          state: "DEGRADED",
          forecast_state: forecast.state,
          tokens_used: forecast.tokens_used,
          limit_tokens: null,
          projected_exhaustion_jd: null,
          token_metric: forecast.token_metric,
          cap_weighted: forecast.cap_weighted,
          burn_trend: trend.direction,
          recent_cap_weighted_tokens: trend.recentTokens,
          recent_cap_weighted_tokens_per_day: trend.recentTokensPerDay,
          baseline_cap_weighted_tokens: trend.baselineTokens,
          baseline_cap_weighted_tokens_per_day: trend.baselineTokensPerDay,
          baseline_window_days: BASELINE_BURN_WINDOW_DAYS,
          trend_delta_cap_weighted_tokens_per_day: trend.deltaTokensPerDay,
          calibration_nudge: CALIBRATION_NUDGE,
        },
      };
      return {
        fired: [fired],
        status: "ACTIVE",
        note: `degraded burn trend ${directionLabel(trend.direction)}; calibrate to get a real limit`,
      };
    }

    if (forecast.state === "WARNING" || forecast.state === "EXCEEDED") {
      const stateLabel = forecast.state === "EXCEEDED" ? "EXCEEDED" : "warning";
      const fired: Fired = {
        scopeKey: "D5|global|LIMIT_BURN_FORECAST",
        category: "LIMIT",
        scope_workspace_id: null,
        lever:
          "Scope work to the top-burn workspace/sessions before the weekly reset; reduce burn rate.",
        target_metric: "forecast_margin",
        modeled_savings_u_per_wk: null,
        modeled_formula: d5Formula(),
        evidence: {
          title: `Rate-limit ${stateLabel}: reduce burn before weekly reset`,
          state: forecast.state,
          tokens_used: forecast.tokens_used,
          limit_tokens: forecast.limit_tokens,
          projected_exhaustion_jd: forecast.projected_exhaustion_jd,
          token_metric: forecast.token_metric,
          cap_weighted: true,
          // Legacy limit-scale honesty flag (review P1): true when the stored
          // limit was calibrated under the old full-weight meter, so the fired
          // evidence carries the caveat instead of silently trusting the number.
          limit_scale_legacy: forecast.limit_scale_legacy,
          ...(forecast.limit_scale_note !== null
            ? { limit_scale_note: forecast.limit_scale_note }
            : {}),
        },
      };
      return { fired: [fired], status: "ACTIVE", note: `burn forecast ${forecast.state}` };
    }

    return {
      fired: [],
      status: "INACTIVE",
      note: `burn forecast ${forecast.state} (no exhaustion projected within the warn window)`,
    };
  },
};
