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
import { capWeightExprSql, resolveCapReadCoeff } from "../../query/cap-weighted.js";
import { forecastFromDb, toJulianDay } from "../../query/forecast.js";
import { d5Estimate } from "../savings.js";
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

function sessionIdsForWindow(db: Db, fromMs: number, toMs: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT session_id FROM turns
          WHERE ts >= ? AND ts < ?
          ORDER BY session_id LIMIT 20`,
      )
      .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as Array<{
      session_id: string;
    }>
  ).map((row) => row.session_id);
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

const MS_PER_HOUR = 60 * 60 * 1000;
const WEEK_MS = 7 * MS_PER_DAY;
/** A reading older than this is not a basis for a forecast. */
const SNAPSHOT_MAX_AGE_MS = 48 * MS_PER_HOUR;
/**
 * Pace is the change over the last full day before the latest reading (or since the reset when
 * the week is younger). A shorter gap reads a burst as the day's pace: 13% → 27% in 5h was
 * projected over 78h to 247% while the day's real pace pointed to about 108%.
 */
const PACE_WINDOW_MS = 24 * MS_PER_HOUR;
/** Too little of the week has passed to read an average pace. */
const MIN_ELAPSED_FOR_AVERAGE_MS = 6 * MS_PER_HOUR;
/** Projected % of the weekly limit at the reset: a warning from here, high severity from 100. */
const WARN_PROJECTED_PCT = 85;
const EXCEED_PROJECTED_PCT = 100;
/** Without snapshots the stored token limit is compared with a 7-day burn, not a 1-day one. */
const LEGACY_WINDOW_DAYS = 7;

interface SnapshotRow {
  ts: string;
  resets_at: string | null;
  used_pct: number | null;
}

export interface SnapshotForecast {
  usedPct: number;
  projectedPct: number;
  pacePctPerDay: number;
  /** Hours the pace was read over: 24, or less when the week started under a day ago. */
  paceWindowHours: number;
  hoursToReset: number;
  resetsAtIso: string;
  weekStartMs: number;
  /** Null when the limit is already hit or no further use is projected. */
  hitAtMs: number | null;
  requiredCutPct: number;
  severity: "high" | "medium";
  exceeded: boolean;
}

/**
 * Project the weekly limit from the API's own used_pct readings: used now plus pace times the
 * hours left to the reset. Pace is the change over the 24h before the latest reading (see
 * PACE_WINDOW_MS), or since the reset when that is nearer. Returns null when there is no usable reading,
 * and a forecast with `severity` only when the projection reaches the warning line.
 */
export function forecastFromSnapshots(
  db: Db,
  now: Date,
): { forecast: SnapshotForecast | null; haveSnapshot: boolean } {
  const nowMs = now.getTime();
  const latest = db
    .prepare(
      `SELECT ts, resets_at, used_pct FROM limit_snapshots
        WHERE ts <= ? AND resets_at > ? AND used_pct IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(now.toISOString(), now.toISOString()) as SnapshotRow | undefined;
  if (latest === undefined || latest.resets_at === null || latest.used_pct === null) {
    return { forecast: null, haveSnapshot: false };
  }
  const latestMs = Date.parse(latest.ts);
  if (nowMs - latestMs > SNAPSHOT_MAX_AGE_MS) return { forecast: null, haveSnapshot: false };

  const resetMs = Date.parse(latest.resets_at);
  const weekStartMs = resetMs - WEEK_MS;
  const used = latest.used_pct;
  const hoursToReset = Math.max(0, (resetMs - latestMs) / MS_PER_HOUR);
  const weekRows = (
    db
      .prepare(
        `SELECT ts, resets_at, used_pct FROM limit_snapshots
          WHERE ts >= ? AND ts < ? AND used_pct IS NOT NULL AND resets_at IS NOT NULL
          ORDER BY ts`,
      )
      .all(new Date(weekStartMs).toISOString(), latest.ts) as SnapshotRow[]
  ).filter((r) => Math.abs(Date.parse(r.resets_at as string) - resetMs) < MS_PER_HOUR);

  if (latestMs - weekStartMs < MIN_ELAPSED_FOR_AVERAGE_MS) {
    return { forecast: null, haveSnapshot: true };
  }

  // Used % at the start of the pace window: between the readings around it (the reset counts as
  // 0%), split by the local cap-weighted burn on each side, or by time when there is none.
  const anchorMs = Math.max(weekStartMs, latestMs - PACE_WINDOW_MS);
  let prev = { ms: weekStartMs, pct: 0 };
  let next = { ms: latestMs, pct: used };
  for (const r of weekRows) {
    const ms = Date.parse(r.ts);
    if (ms <= anchorMs) prev = { ms, pct: r.used_pct as number };
    else {
      next = { ms, pct: r.used_pct as number };
      break;
    }
  }
  let share = 0;
  if (anchorMs > prev.ms) {
    const coeff = resolveCapReadCoeff(db);
    const span = aggregateCapWeightedBurn(db, prev.ms, next.ms, coeff).tokens;
    share =
      span > 0
        ? aggregateCapWeightedBurn(db, prev.ms, anchorMs, coeff).tokens / span
        : (anchorMs - prev.ms) / (next.ms - prev.ms);
  }
  const usedAtAnchor = prev.pct + (next.pct - prev.pct) * share;
  const paceWindowHours = (latestMs - anchorMs) / MS_PER_HOUR;
  const pacePerHour = Math.max(0, (used - usedAtAnchor) / paceWindowHours);

  const projectedPct = used + pacePerHour * hoursToReset;
  const exceeded = used >= EXCEED_PROJECTED_PCT;
  if (!exceeded && projectedPct < WARN_PROJECTED_PCT) return { forecast: null, haveSnapshot: true };

  const hitAtMs =
    exceeded || pacePerHour <= 0 || projectedPct < EXCEED_PROJECTED_PCT
      ? null
      : latestMs + ((EXCEED_PROJECTED_PCT - used) / pacePerHour) * MS_PER_HOUR;
  const requiredCutPct =
    projectedPct > EXCEED_PROJECTED_PCT && !exceeded
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((1 - (EXCEED_PROJECTED_PCT - used) / (pacePerHour * hoursToReset)) * 100),
          ),
        )
      : 0;
  return {
    haveSnapshot: true,
    forecast: {
      usedPct: used,
      projectedPct,
      pacePctPerDay: pacePerHour * 24,
      paceWindowHours,
      hoursToReset,
      resetsAtIso: new Date(resetMs).toISOString(),
      weekStartMs,
      hitAtMs,
      requiredCutPct,
      severity: exceeded || projectedPct >= EXCEED_PROJECTED_PCT ? "high" : "medium",
      exceeded,
    },
  };
}

function topByCost(
  db: Db,
  column: "workspace_id" | "model",
  fromMs: number,
  toMs: number,
): { key: string; share: number } | null {
  const rows = db
    .prepare(
      `SELECT ${column} AS key, COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns
        WHERE ts >= ? AND ts < ? AND ${column} <> ''
        GROUP BY ${column} ORDER BY u DESC, ${column} ASC`,
    )
    .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as Array<{
    key: string;
    u: number;
  }>;
  const total = rows.reduce((sum, r) => sum + r.u, 0);
  const top = rows[0];
  if (top === undefined || total <= 0) return null;
  return { key: top.key, share: top.u / total };
}

export const d5Detector: Detector = {
  contractVersion: 1,
  version: "D5@u7-1",
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "limit_snapshots",
    ],
    clock: true,
  },
  id: "D5",
  name: "LIMIT_BURN_FORECAST",
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const snap = forecastFromSnapshots(db, ctx.now);
    if (snap.forecast !== null) {
      const f = snap.forecast;
      const nowMs = ctx.now.getTime();
      const topWorkspace = topByCost(db, "workspace_id", f.weekStartMs, nowMs);
      const topModel = topByCost(db, "model", f.weekStartMs, nowMs);
      const coeff = resolveCapReadCoeff(db);
      const fired: Fired = {
        scopeKey: "D5|global|LIMIT_BURN_FORECAST",
        scope_workspace_id: null,
        modeled_savings_u_per_wk: null,
        modeled_formula_json: { estimate: d5Estimate({}) },
        payload: {
          version: 1,
          template_id: "D5_LIMIT_BURN_WARNING",
          facts: {
            forecast_state: f.exceeded ? "EXCEEDED" : "WARNING",
            session_ids: sessionIdsForWindow(
              db,
              nowMs - RECENT_BURN_WINDOW_DAYS * MS_PER_DAY,
              nowMs,
            ),
            tokens_used: aggregateCapWeightedBurn(db, f.weekStartMs, nowMs, coeff).tokens,
            limit_tokens: null,
            projected_exhaustion_jd: f.hitAtMs === null ? null : toJulianDay(new Date(f.hitAtMs)),
            limit_scale_legacy: false,
            severity: f.severity,
            used_pct: Math.round(f.usedPct * 10) / 10,
            projected_pct: Math.round(f.projectedPct),
            pace_pct_per_day: Math.round(f.pacePctPerDay * 10) / 10,
            pace_window_hours: Math.round(f.paceWindowHours * 10) / 10,
            hours_to_reset: Math.round(f.hoursToReset),
            resets_at: f.resetsAtIso,
            required_cut_pct: f.requiredCutPct,
            ...(f.hitAtMs === null
              ? {}
              : { projected_limit_hit_at: new Date(f.hitAtMs).toISOString() }),
            ...(topWorkspace === null
              ? {}
              : {
                  top_workspace_id: topWorkspace.key,
                  top_workspace_share: Math.round(topWorkspace.share * 100) / 100,
                }),
            ...(topModel === null ? {} : { top_model: topModel.key }),
          },
        },
      };
      return {
        fired: [fired],
        status: "ACTIVE",
        note: `weekly limit projected at ${Math.round(f.projectedPct)}% by the reset (${Math.round(f.usedPct)}% used)`,
      };
    }
    if (snap.haveSnapshot) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "weekly limit readings project the week ending below the warning line",
      };
    }

    const forecast = forecastFromDb(db, { now: ctx.now, windowDays: LEGACY_WINDOW_DAYS });

    if (forecast.state === "OFF") {
      const trend = degradedBurnTrend(db, ctx.now, forecast.cap_read_coeff);
      if (trend === null) {
        return { fired: [], status: "BLOCKED", note: "Weekly token limit is not configured" };
      }

      const fired: Fired = {
        scopeKey: "D5|global|LIMIT_BURN_FORECAST",
        scope_workspace_id: null,
        modeled_savings_u_per_wk: null,
        modeled_formula_json: { estimate: d5Estimate({}) },
        payload: {
          version: 1,
          template_id: "D5_LIMIT_BURN_DEGRADED",
          facts: {
            forecast_state: forecast.state,
            session_ids: sessionIdsForWindow(
              db,
              ctx.now.getTime() -
                (RECENT_BURN_WINDOW_DAYS + BASELINE_BURN_WINDOW_DAYS) * MS_PER_DAY,
              ctx.now.getTime(),
            ),
            tokens_used: forecast.tokens_used,
            burn_trend: trend.direction,
            recent_cap_weighted_tokens: trend.recentTokens,
            recent_cap_weighted_tokens_per_day: trend.recentTokensPerDay,
            baseline_cap_weighted_tokens: trend.baselineTokens,
            baseline_cap_weighted_tokens_per_day: trend.baselineTokensPerDay,
            baseline_window_days: BASELINE_BURN_WINDOW_DAYS,
          },
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
        scope_workspace_id: null,
        modeled_savings_u_per_wk: null,
        modeled_formula_json: { estimate: d5Estimate({}) },
        payload: {
          version: 1,
          template_id: "D5_LIMIT_BURN_WARNING",
          facts: {
            forecast_state: forecast.state,
            session_ids: sessionIdsForWindow(
              db,
              ctx.now.getTime() - RECENT_BURN_WINDOW_DAYS * MS_PER_DAY,
              ctx.now.getTime(),
            ),
            tokens_used: forecast.tokens_used,
            limit_tokens: forecast.limit_tokens,
            projected_exhaustion_jd: forecast.projected_exhaustion_jd,
            limit_scale_legacy: forecast.limit_scale_legacy,
          },
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
