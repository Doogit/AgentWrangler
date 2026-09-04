import type { Db } from "../../db/open.js";
import { isoWeekBounds } from "./reports.js";

const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionSpendPercentile {
  percentile: number | null;
  n: number;
  window_days: number;
}

interface SessionRow {
  workspace_id: string;
  cost_equiv_u: number | null;
  last_turn_at: string | null;
}

interface PopulationRow {
  population_count: number;
  at_or_below_count: number;
}

export function getSessionSpendPercentile(db: Db, sessionId: string): SessionSpendPercentile {
  const target = db
    .prepare(
      `SELECT workspace_id, cost_equiv_u, last_turn_at
         FROM sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;

  if (target === undefined || target.cost_equiv_u === null || target.last_turn_at === null) {
    return { percentile: null, n: 0, window_days: WINDOW_DAYS };
  }

  const windowStart = new Date(
    Date.parse(target.last_turn_at) - WINDOW_DAYS * DAY_MS,
  ).toISOString();
  const population = db
    .prepare(
      `SELECT COUNT(*) AS population_count,
              COALESCE(SUM(CASE WHEN cost_equiv_u <= ? THEN 1 ELSE 0 END), 0) AS at_or_below_count
         FROM sessions
        WHERE workspace_id = ?
          AND last_turn_at >= ?
          AND last_turn_at <= ?
          AND cost_equiv_u IS NOT NULL`,
    )
    .get(
      target.cost_equiv_u,
      target.workspace_id,
      windowStart,
      target.last_turn_at,
    ) as PopulationRow;

  if (population.population_count < 20) {
    return { percentile: null, n: population.population_count, window_days: WINDOW_DAYS };
  }

  // Ties count at or below; the UI renders "top X%" as 1 - percentile.
  return {
    percentile: population.at_or_below_count / population.population_count,
    n: population.population_count,
    window_days: WINDOW_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Per-week self-percentiles — this (current, partial) ISO week vs the 8 full
// weeks immediately before it, for spend and cache-write share.
//
// "Your own history" is the honest peer group: the percentile ranks this week
// against the trailing full weeks (<= ties, mirroring the per-session form).
// Deterministic — the caller passes an explicit `now`; every window boundary is
// derived from it plus fixed offsets, never a scattered Date.now().
// ---------------------------------------------------------------------------

const TRAILING_WEEKS = 8;
/**
 * A rank needs a few reference weeks to mean anything; below this the percentile
 * is withheld (null) rather than reported as noise off one or two weeks.
 */
const MIN_TRAILING_WEEKS_WITH_DATA = 4;
const WEEK_MS = 7 * DAY_MS;

/** One metric's this-week value ranked against the trailing full weeks with data. */
export interface WeeklyMetricSelfPercentile {
  /** This week's observed value (µUSD for spend, [0,1] share for cache-write). null when this week has no data for the metric. */
  this_week: number | null;
  /** Fraction of trailing full weeks (with data) at or below this week's value; null when this_week is null or n < the minimum. */
  percentile: number | null;
  /** Median of the trailing full weeks with data; null when none. */
  trailing_median: number | null;
  /** Trailing full weeks that carry data for this metric. */
  n: number;
}

export interface WeeklySelfPercentile {
  /** ISO start (Monday 00:00 UTC) of the current week being ranked. */
  week_start: string;
  /** Size of the trailing window in full weeks. */
  trailing_weeks: number;
  /** Minimum trailing weeks-with-data required before a percentile is reported. */
  min_weeks_with_data: number;
  spend: WeeklyMetricSelfPercentile;
  cache_write_share: WeeklyMetricSelfPercentile;
}

interface WeekAggRow {
  turns: number;
  spend_u: number;
  cache_write: number;
  cache_read: number;
}

interface WeekMetrics {
  /** Reconciled turns in the week; >0 means the week carries spend data. */
  turns: number;
  spend_u: number;
  /** cache_write / (cache_write + cache_read); null when the week had no cache activity. */
  cache_write_share: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (sorted.length % 2 === 0) {
    return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : (hi ?? lo ?? null);
  }
  return hi ?? null;
}

/** Rank `thisValue` against `trailing` values with data — <= ties, mirroring the per-session form. */
function weeklyMetric(
  thisValue: number | null,
  trailing: Array<number | null>,
): WeeklyMetricSelfPercentile {
  const withData = trailing.filter((v): v is number => v !== null);
  const n = withData.length;
  const trailing_median = median(withData);
  if (thisValue === null || n < MIN_TRAILING_WEEKS_WITH_DATA) {
    return { this_week: thisValue, percentile: null, trailing_median, n };
  }
  const atOrBelow = withData.filter((v) => v <= thisValue).length;
  return { this_week: thisValue, percentile: atOrBelow / n, trailing_median, n };
}

export function getWeeklySelfPercentile(db: Db, now: Date): WeeklySelfPercentile {
  const stmt = db.prepare(
    `SELECT COUNT(*)                                                    AS turns,
            COALESCE(SUM(cost_equiv_u), 0)                              AS spend_u,
            COALESCE(SUM(cache_write_5m + cache_write_1h
                         + cache_write_other), 0)                       AS cache_write,
            COALESCE(SUM(cache_read_tokens), 0)                         AS cache_read
       FROM turns
      WHERE ts >= ? AND ts < ? AND provisional = 0`,
  );

  const weekMetrics = (start: string, end: string): WeekMetrics => {
    const row = stmt.get(start, end) as WeekAggRow;
    const cacheTotal = row.cache_write + row.cache_read;
    return {
      turns: row.turns,
      spend_u: row.spend_u,
      cache_write_share: cacheTotal === 0 ? null : row.cache_write / cacheTotal,
    };
  };

  const { period_start, period_end } = isoWeekBounds(now);
  const currentStartMs = Date.parse(period_start);
  const current = weekMetrics(period_start, period_end);

  // The 8 contiguous full weeks immediately before the current week. period_start
  // is a Monday, so each trailing boundary is a whole-week shift from it.
  const trailing: WeekMetrics[] = [];
  for (let k = 1; k <= TRAILING_WEEKS; k += 1) {
    const start = new Date(currentStartMs - k * WEEK_MS).toISOString();
    const end = new Date(currentStartMs - (k - 1) * WEEK_MS).toISOString();
    trailing.push(weekMetrics(start, end));
  }

  const spend = weeklyMetric(
    current.turns > 0 ? current.spend_u : null,
    trailing.map((w) => (w.turns > 0 ? w.spend_u : null)),
  );
  const cache_write_share = weeklyMetric(
    current.cache_write_share,
    trailing.map((w) => w.cache_write_share),
  );

  return {
    week_start: period_start,
    trailing_weeks: TRAILING_WEEKS,
    min_weeks_with_data: MIN_TRAILING_WEEKS_WITH_DATA,
    spend,
    cache_write_share,
  };
}
