/**
 * src/query/trends.ts — spend-over-time bucketed queries.
 *
 * Pure query building blocks over a better-sqlite3 handle. No hidden `now()`.
 * All timestamp parameters are explicit so callers (and tests) control boundaries.
 *
 * Reconciliation guarantee: SUM(SpendBucketRow.cost_equiv_u) over all buckets
 * in a window EQUALS globalSpend(db, tFrom, tTo).cost_equiv_u for the same
 * window. Both use `provisional = 0` and the same [tFrom, tTo) half-open interval.
 *
 * Bucket key SQL expressions (document verbatim — do not change without bumping
 * metric_definition_version):
 *   day   → date(ts, 'localtime')           SQLite 'localtime' modifier converts
 *            stored UTC ISO-8601 ts to the process's local calendar day.
 *   week  → strftime('%Y-%W', ts)           UTC-based ISO year-week (no localtime).
 *   month → strftime('%Y-%m', ts)           UTC-based year-month (no localtime).
 *
 * The week/month bucket keys are UTC-based intentionally: cross-day rounding at
 * midnight matters most for the daily bucket; weekly/monthly boundaries are
 * wide enough that UTC vs local is rarely material.
 */

import type { Db } from "../db/open.js";
import { capWeightExprSql } from "./cap-weighted.js";

// ---------------------------------------------------------------------------
// Bucket size type
// ---------------------------------------------------------------------------

export type BucketSize = "day" | "week" | "month";

/** The SQL expression for the given bucket size (verbatim). */
function bucketExpr(bucket: BucketSize): string {
  if (bucket === "day") return "date(ts, 'localtime')";
  if (bucket === "week") return "strftime('%Y-%W', ts)";
  return "strftime('%Y-%m', ts)";
}

/**
 * Like bucketExpr but for an aliased `turns t` reference (used in cap-weighted
 * queries that require the `t.` alias for capWeightExprSql compatibility).
 */
function aliasedBucketExpr(bucket: BucketSize): string {
  if (bucket === "day") return "date(t.ts, 'localtime')";
  if (bucket === "week") return "strftime('%Y-%W', t.ts)";
  return "strftime('%Y-%m', t.ts)";
}

// ---------------------------------------------------------------------------
// Spend by bucket — global aggregate
// ---------------------------------------------------------------------------

export interface SpendBucketRow {
  /** Bucket key: e.g. "2026-01-15" (day), "2026-03" (month), "2026-03" (week). */
  bucket: string;
  /** SUM(cost_equiv_u) micro-USD, reconciled turns only (provisional=0). */
  cost_equiv_u: number;
  /** Reconciled turn count. */
  turns: number;
}

/**
 * Spend grouped by time bucket over [tFrom, tTo), reconciled turns only.
 *
 * SUM(cost_equiv_u) across all returned rows equals globalSpend for the
 * same window (both filter provisional=0 and the same [tFrom, tTo)).
 *
 * Optionally scoped to one workspace.
 */
export function spendByBucket(
  db: Db,
  tFrom: string,
  tTo: string,
  bucket: BucketSize,
  workspaceId?: string,
): SpendBucketRow[] {
  const bk = bucketExpr(bucket);
  const base = `SELECT ${bk}                             AS bucket,
                       COALESCE(SUM(cost_equiv_u), 0)   AS cost_equiv_u,
                       COUNT(*)                          AS turns
                  FROM turns
                 WHERE ts >= ? AND ts < ? AND provisional = 0`;
  const tail = "GROUP BY bucket ORDER BY bucket ASC";

  if (workspaceId !== undefined) {
    return db
      .prepare(`${base} AND workspace_id = ? ${tail}`)
      .all(tFrom, tTo, workspaceId) as SpendBucketRow[];
  }
  return db.prepare(`${base} ${tail}`).all(tFrom, tTo) as SpendBucketRow[];
}

// ---------------------------------------------------------------------------
// Spend by bucket × model — stacked-chart series
// ---------------------------------------------------------------------------

export interface ModelBucketRow {
  bucket: string;
  model: string;
  cost_equiv_u: number;
  turns: number;
}

/**
 * Spend grouped by bucket × model over [tFrom, tTo), reconciled turns only.
 * Used to build the stacked-by-model bar series on TrendChart.
 */
export function spendByBucketAndModel(
  db: Db,
  tFrom: string,
  tTo: string,
  bucket: BucketSize,
  workspaceId?: string,
): ModelBucketRow[] {
  const bk = bucketExpr(bucket);
  const base = `SELECT ${bk}                             AS bucket,
                       model,
                       COALESCE(SUM(cost_equiv_u), 0)   AS cost_equiv_u,
                       COUNT(*)                          AS turns
                  FROM turns
                 WHERE ts >= ? AND ts < ? AND provisional = 0`;
  const tail = "GROUP BY bucket, model ORDER BY bucket ASC, model ASC";

  if (workspaceId !== undefined) {
    return db
      .prepare(`${base} AND workspace_id = ? ${tail}`)
      .all(tFrom, tTo, workspaceId) as ModelBucketRow[];
  }
  return db.prepare(`${base} ${tail}`).all(tFrom, tTo) as ModelBucketRow[];
}

// ---------------------------------------------------------------------------
// Spend by bucket × workspace — stacked-chart series
// ---------------------------------------------------------------------------

export interface WorkspaceBucketRow {
  bucket: string;
  workspace_id: string;
  project_slug: string;
  cost_equiv_u: number;
  turns: number;
}

/**
 * Spend grouped by bucket × workspace over [tFrom, tTo), reconciled turns only.
 * Used to build the stacked-by-workspace bar series on TrendChart.
 */
export function spendByBucketAndWorkspace(
  db: Db,
  tFrom: string,
  tTo: string,
  bucket: BucketSize,
): WorkspaceBucketRow[] {
  const bk = bucketExpr(bucket);
  return db
    .prepare(
      `SELECT ${bk}                             AS bucket,
              w.workspace_id,
              w.project_slug,
              COALESCE(SUM(t.cost_equiv_u), 0)  AS cost_equiv_u,
              COUNT(*)                           AS turns
         FROM turns t JOIN workspaces w USING (workspace_id)
        WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
        GROUP BY bucket, w.workspace_id
        ORDER BY bucket ASC, w.workspace_id ASC`,
    )
    .all(tFrom, tTo) as WorkspaceBucketRow[];
}

// ---------------------------------------------------------------------------
// Per-session cost series — from sessions table
// ---------------------------------------------------------------------------

export interface SessionCostRow {
  session_id: string;
  workspace_id: string;
  project_slug: string;
  /** ISO-8601 UTC; use as x-axis date. */
  first_turn_at: string;
  /** Stored rollforward cost (reliable only on RECONCILED sessions). */
  cost_equiv_u: number;
}

// ---------------------------------------------------------------------------
// Cap-weighted tokens by bucket — parallel to spendByBucket
// ---------------------------------------------------------------------------

export interface CapWeightedBucketRow {
  /** Bucket key, same format as SpendBucketRow.bucket. */
  bucket: string;
  /** ROUND(SUM(cap_weight_expr)) — integer cap-draw estimate for the bucket. */
  cap_weighted_tokens: number;
  /** Reconciled turn count (provisional=0). */
  turns: number;
}

/**
 * Cap-weighted token total grouped by time bucket over [tFrom, tTo).
 *
 * Reconciliation guarantee: SUM(cap_weighted_tokens) over all returned buckets
 * equals capWeightedTokens(db, { fromIso: tFrom, toIso: tTo, coeff }).cap_weighted_tokens
 * for the same window + coeff (both filter provisional=0 and the same half-open
 * [tFrom, tTo) interval). Single-bucket windows are exactly equal; multi-bucket
 * windows may differ by at most ±bucketCount due to per-bucket Math.round.
 *
 * Uses an aliased `turns t` so capWeightExprSql("t", coeff) inlines cleanly.
 * Does NOT reference context_tokens (frozen column — see cap-weighted.ts header).
 */
export function capWeightedByBucket(
  db: Db,
  tFrom: string,
  tTo: string,
  bucket: BucketSize,
  coeff: number,
  workspaceId?: string,
): CapWeightedBucketRow[] {
  const bk = aliasedBucketExpr(bucket);
  const expr = capWeightExprSql("t", coeff);
  const base = `SELECT ${bk}                                   AS bucket,
                       CAST(ROUND(SUM(${expr})) AS INTEGER)    AS cap_weighted_tokens,
                       COUNT(*)                                 AS turns
                  FROM turns t
                 WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`;
  const tail = "GROUP BY bucket ORDER BY bucket ASC";
  if (workspaceId !== undefined) {
    return db
      .prepare(`${base} AND t.workspace_id = ? ${tail}`)
      .all(tFrom, tTo, workspaceId) as CapWeightedBucketRow[];
  }
  return db.prepare(`${base} ${tail}`).all(tFrom, tTo) as CapWeightedBucketRow[];
}

// ---------------------------------------------------------------------------
// Cache-write by bucket — Spend-Viz-v2 Surface 3
// ---------------------------------------------------------------------------

export interface CacheWriteBucketRow {
  /** Bucket key — same format as SpendBucketRow.bucket */
  bucket: string;
  /** SUM(cache_write_5m + cache_write_1h + cache_write_other) — raw creation tokens */
  cache_creation_tokens: number;
  /** SUM(cache_read_tokens) — for per-bucket ratio */
  cache_read_tokens: number;
  /** cache_read / (cache_read + cache_creation); null if both are 0 */
  efficiency_ratio: number | null;
  /** Reconciled turn count */
  turns: number;
}

/**
 * Cache write + read tokens grouped by time bucket over [tFrom, tTo).
 *
 * Reconciliation guarantee: SUM(cache_creation_tokens) over all returned buckets
 * equals cache_creation_tokens from capWeightedTokens(db, { fromIso: tFrom, toIso: tTo })
 * for the same window (both filter provisional=0, same [tFrom, tTo) interval).
 *
 * efficiency_ratio is computed in TypeScript to avoid SQLite division edge cases.
 */
export function cacheWriteByBucket(
  db: Db,
  tFrom: string,
  tTo: string,
  bucket: BucketSize,
  workspaceId?: string,
): CacheWriteBucketRow[] {
  const bk = aliasedBucketExpr(bucket);
  const base = `SELECT ${bk}                                                AS bucket,
                       COALESCE(SUM(t.cache_write_5m + t.cache_write_1h
                                    + t.cache_write_other), 0)              AS cache_creation_tokens,
                       COALESCE(SUM(t.cache_read_tokens), 0)                AS cache_read_tokens,
                       COUNT(*)                                             AS turns
                  FROM turns t
                 WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`;
  const tail = "GROUP BY bucket ORDER BY bucket ASC";

  type RawCwRow = {
    bucket: string;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    turns: number;
  };

  let rawRows: RawCwRow[];
  if (workspaceId !== undefined) {
    rawRows = db
      .prepare(`${base} AND t.workspace_id = ? ${tail}`)
      .all(tFrom, tTo, workspaceId) as RawCwRow[];
  } else {
    rawRows = db.prepare(`${base} ${tail}`).all(tFrom, tTo) as RawCwRow[];
  }

  return rawRows.map((r) => ({
    ...r,
    efficiency_ratio:
      r.cache_creation_tokens + r.cache_read_tokens > 0
        ? r.cache_read_tokens / (r.cache_read_tokens + r.cache_creation_tokens)
        : null,
  }));
}

// ---------------------------------------------------------------------------
// Per-session cost series — from sessions table
// ---------------------------------------------------------------------------

/**
 * Per-session cost over time, RECONCILED sessions only (state='RECONCILED').
 *
 * The sessions.cost_equiv_u column is only reliable after reconciliation at
 * close; LIVE sessions are intentionally excluded (their cost is computed
 * on-demand from turns in the live strip — see liveSessions() in spend.ts).
 *
 * Optionally scoped to one workspace.
 */
export function sessionCostSeries(
  db: Db,
  tFrom: string,
  tTo: string,
  workspaceId?: string,
): SessionCostRow[] {
  const base = `SELECT s.session_id,
                       s.workspace_id,
                       w.project_slug,
                       s.first_turn_at,
                       s.cost_equiv_u
                  FROM sessions s JOIN workspaces w USING (workspace_id)
                 WHERE s.state = 'RECONCILED'
                   AND s.first_turn_at >= ? AND s.first_turn_at < ?`;
  const tail = "ORDER BY s.first_turn_at ASC, s.session_id ASC";

  if (workspaceId !== undefined) {
    return db
      .prepare(`${base} AND s.workspace_id = ? ${tail}`)
      .all(tFrom, tTo, workspaceId) as SessionCostRow[];
  }
  return db.prepare(`${base} ${tail}`).all(tFrom, tTo) as SessionCostRow[];
}
