/**
 * src/query/api/trends.ts — LocalQueryAPI: spend-over-time trends method.
 *
 * Mirrors the window resolution and response-building pattern in overview.ts.
 * The FROZEN overview contract (api/index.ts) is not modified by this file.
 */

import type { Db } from "../../db/open.js";
import { resolveCapReadCoeff } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse, QueryWindow } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import {
  type BucketSize,
  type CacheWriteBucketRow,
  type CapWeightedBucketRow,
  type ModelBucketRow,
  type SessionCostRow,
  type SpendBucketRow,
  type WorkspaceBucketRow,
  cacheWriteByBucket,
  capWeightedByBucket,
  sessionCostSeries,
  spendByBucket,
  spendByBucketAndModel,
  spendByBucketAndWorkspace,
} from "../trends.js";
import { cachedQuery } from "./overview.js";
import type { WindowFilter } from "./overview.js";

// ---------------------------------------------------------------------------
// Response payload type
// ---------------------------------------------------------------------------

export type { BucketSize };

export interface AdoptionMarker {
  rec_id: string;
  detector_id: string | null;
  lever: string;
  adopted_at: string;
  /** X-axis coordinate normalized to the response bucket size. */
  bucket: string;
}

export interface TrendData {
  /** The bucket size used for this response. */
  bucket: BucketSize;
  /** Aggregate spend per time bucket (provisional=0; reconciles with /api/overview). */
  buckets: SpendBucketRow[];
  /** Spend per (bucket, model) — for stacked-by-model bar chart. */
  by_model: ModelBucketRow[];
  /** Spend per (bucket, workspace) — for stacked-by-workspace bar chart. */
  by_workspace: WorkspaceBucketRow[];
  /** Per-session cost over time (RECONCILED only; source: sessions table). */
  sessions: SessionCostRow[];
  /** Cap-weighted tokens per bucket (unverified COEFF — see cap-weighted.ts). */
  cap_weighted: CapWeightedBucketRow[];
  /** The cap-read coefficient used (for the UI caveat label). */
  cap_read_coeff: number;
  /** Adopted recommendations in the same half-open window and workspace scope. */
  adoption_markers: AdoptionMarker[];
}

export type { CapWeightedBucketRow, CacheWriteBucketRow };

// ---------------------------------------------------------------------------
// Cache-write spike timeline — Spend-Viz-v2 Surface 3
// ---------------------------------------------------------------------------

export interface CacheWriteTrend {
  /** Per-bucket cache write + read counts, ordered by bucket ASC */
  buckets: CacheWriteBucketRow[];
  /** Bucket keys where cache_creation_tokens > mean + 2σ (empty if < 3 buckets) */
  spike_buckets: string[];
}

/**
 * Detect spike buckets: mean + 2 × population stddev.
 * Returns empty set when fewer than 3 buckets (insufficient baseline).
 */
export function detectSpikes(rows: CacheWriteBucketRow[]): Set<string> {
  if (rows.length < 3) return new Set();
  const vals = rows.map((r) => r.cache_creation_tokens);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + 2 * stddev;
  return new Set(rows.filter((r) => r.cache_creation_tokens > threshold).map((r) => r.bucket));
}

// ---------------------------------------------------------------------------
// Internal helpers (mirrors overview.ts pattern, not re-exported from index)
// ---------------------------------------------------------------------------

const PRESET_DAYS: Record<NonNullable<WindowFilter["preset"]>, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function adoptionBucketExpr(bucket: BucketSize): string {
  if (bucket === "day") return "date(adopted_at, 'localtime')";
  if (bucket === "week") return "strftime('%Y-%W', adopted_at)";
  return "strftime('%Y-%m', adopted_at)";
}

function adoptionMarkers(
  db: Db,
  from: string,
  to: string,
  bucket: BucketSize,
  workspaceId?: string,
): AdoptionMarker[] {
  const bucketSql = adoptionBucketExpr(bucket);
  const base = `SELECT rec_id, detector_id, lever, adopted_at, ${bucketSql} AS bucket
                  FROM recommendations
                 WHERE adopted_at IS NOT NULL
                   AND adopted_at >= ? AND adopted_at < ?
                   AND state IN ('ADOPTED', 'MEASURING', 'MEASURED_EFFECTIVE',
                                 'MEASURED_NO_EFFECT')`;
  const tail = "ORDER BY adopted_at ASC, rec_id ASC";

  if (workspaceId !== undefined) {
    return db
      .prepare(`${base} AND scope_workspace_id = ? ${tail}`)
      .all(from, to, workspaceId) as AdoptionMarker[];
  }
  return db.prepare(`${base} ${tail}`).all(from, to) as AdoptionMarker[];
}

function resolveWindow(filter: WindowFilter, now: Date = new Date()): QueryWindow {
  const nowIso = now.toISOString();
  if (filter.preset !== undefined) {
    const from = new Date(now.getTime() - PRESET_DAYS[filter.preset] * MS_PER_DAY).toISOString();
    return { from, to: nowIso, preset: filter.preset };
  }
  if (filter.from !== undefined && filter.to !== undefined) {
    return { from: filter.from, to: filter.to };
  }
  if (filter.from !== undefined) {
    return { from: filter.from, to: nowIso };
  }
  if (filter.to !== undefined) {
    const from = new Date(new Date(filter.to).getTime() - 7 * MS_PER_DAY).toISOString();
    return { from, to: filter.to };
  }
  const from = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
  return { from, to: nowIso, preset: "7d" };
}

// ---------------------------------------------------------------------------
// Public API method
// ---------------------------------------------------------------------------

/**
 * Cache-write spike timeline over a window.
 *
 * Endpoint: GET /api/trends/cache-write?preset=7d&bucket=day
 *
 * Reconciliation: SUM(data.buckets[].cache_creation_tokens) equals
 * cache_creation_tokens from capWeightedTokens() for the same window.
 *
 * spike_buckets: server-computed via detectSpikes() (mean + 2σ).
 * Skipped when < 3 buckets in the window.
 */
export function getCacheWriteTrend(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): ApiResponse<CacheWriteTrend> {
  const db: ReturnType<typeof getQueryDb> = getQueryDb();
  const win = resolveWindow(filter);
  const { from, to } = win;

  const buckets = cacheWriteByBucket(db, from, to, bucket, workspaceId);
  const spikes = detectSpikes(buckets);

  const data: CacheWriteTrend = {
    buckets,
    spike_buckets: [...spikes],
  };

  return buildResponse(data, {
    claim_kind: "LIST_EQUIV",
    n: buckets.length,
    window: win,
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "",
    },
  });
}

/**
 * Fetch spend-over-time data grouped by the requested bucket size.
 *
 * Endpoint: GET /api/trends?preset=&bucket=day|week|month&workspace_id=
 *
 * Reconciliation: SUM(data.buckets[].cost_equiv_u) equals the cost_equiv_u
 * returned by GET /api/overview for the same window (both exclude provisional).
 */
export function getTrends(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): ApiResponse<TrendData> {
  const db: Db = getQueryDb();
  const win = resolveWindow(filter);
  const { from, to } = win;

  const coeff = cachedQuery(db, "resolveCapReadCoeff", from, to, workspaceId, () =>
    resolveCapReadCoeff(db),
  );
  const buckets = cachedQuery(db, `spendByBucket:${bucket}`, from, to, workspaceId, () =>
    spendByBucket(db, from, to, bucket, workspaceId),
  );
  const by_model = cachedQuery(db, `spendByBucketAndModel:${bucket}`, from, to, workspaceId, () =>
    spendByBucketAndModel(db, from, to, bucket, workspaceId),
  );
  const by_workspace =
    workspaceId === undefined
      ? cachedQuery(db, `spendByBucketAndWorkspace:${bucket}`, from, to, undefined, () =>
          spendByBucketAndWorkspace(db, from, to, bucket),
        )
      : [];
  const sessions = cachedQuery(db, "sessionCostSeries", from, to, workspaceId, () =>
    sessionCostSeries(db, from, to, workspaceId),
  );
  const cap_weighted = cachedQuery(db, `capWeightedByBucket:${bucket}`, from, to, workspaceId, () =>
    capWeightedByBucket(db, from, to, bucket, coeff, workspaceId),
  );
  const adoption_markers = cachedQuery(db, `adoptionMarkers:${bucket}`, from, to, workspaceId, () =>
    adoptionMarkers(db, from, to, bucket, workspaceId),
  );

  const data: TrendData = {
    bucket,
    buckets,
    by_model,
    by_workspace,
    sessions,
    cap_weighted,
    cap_read_coeff: coeff,
    adoption_markers,
  };

  return buildResponse(data, {
    claim_kind: "LIST_EQUIV",
    n: buckets.length,
    window: win,
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "",
    },
  });
}
