/**
 * src/query/api/headroom-trend.ts — percent-native headroom over time.
 *
 * This is an additive query-side view over the calibrated limit and the two
 * cap-read coefficient regimes. It deliberately does not introduce an
 * absolute-cap denominator: the configured limit is the only denominator.
 */

import type { Db } from "../../db/open.js";
import { DEFAULT_CAP_READ_COEFF } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse, QueryWindow } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { type BucketSize, capWeightedByBucket } from "../trends.js";
import type { WindowFilter } from "./overview.js";

export type { BucketSize };

const UPPER_BOUND_COEFF = 1.0;
const CAVEAT_NOTE =
  "Percent-native headroom (no absolute-cap denominator); cap coefficient is unverified.";

export interface HeadroomPoint {
  bucket: string;
  headroom_headline: number;
  headroom_upper: number;
  cap_weighted_headline: number;
  cap_weighted_upper: number;
}

export interface HeadroomNoLimit {
  state: "NO_LIMIT";
}

export interface HeadroomOk {
  state: "OK";
  bucket: BucketSize;
  points: HeadroomPoint[];
  cap_read_coeff_headline: 0.1;
  cap_read_coeff_upper: 1.0;
  coefficient_unverified: true;
}

export type HeadroomTrendData = HeadroomNoLimit | HeadroomOk;

const PRESET_DAYS: Record<NonNullable<WindowFilter["preset"]>, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function configGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
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

function readLimitTokens(db: Db): number | null {
  const limitRaw = configGet(db, "limit_tokens");
  if (limitRaw === null) return null;
  const limit = Number(limitRaw);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * Return percent-native headroom against the calibrated limit for each trend
 * bucket, using both the 0.1× headline and 1.0× upper-bound cap regimes.
 */
export function getHeadroomTrend(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): ApiResponse<HeadroomTrendData> {
  const db = getQueryDb();
  const window = resolveWindow(filter);
  const limitTokens = readLimitTokens(db);

  if (limitTokens === null) {
    return buildResponse<HeadroomTrendData>(
      { state: "NO_LIMIT" },
      {
        claim_kind: "LIST_EQUIV",
        n: 0,
        window,
        qualification: {
          provisional_excluded: true,
          unpriced_turns: 0,
          claim_kinds_count: 1,
          note: CAVEAT_NOTE,
        },
      },
    );
  }

  const headlineRows = capWeightedByBucket(
    db,
    window.from,
    window.to,
    bucket,
    DEFAULT_CAP_READ_COEFF,
    workspaceId,
  );
  const upperRows = capWeightedByBucket(
    db,
    window.from,
    window.to,
    bucket,
    UPPER_BOUND_COEFF,
    workspaceId,
  );

  const headlineByBucket = new Map(headlineRows.map((row) => [row.bucket, row]));
  const upperByBucket = new Map(upperRows.map((row) => [row.bucket, row]));
  const bucketKeys = new Set([...headlineByBucket.keys(), ...upperByBucket.keys()]);
  const points = [...bucketKeys].sort().map((bucketKey) => {
    const capWeightedHeadline = headlineByBucket.get(bucketKey)?.cap_weighted_tokens ?? 0;
    const capWeightedUpper = upperByBucket.get(bucketKey)?.cap_weighted_tokens ?? 0;
    return {
      bucket: bucketKey,
      headroom_headline: (limitTokens - capWeightedHeadline) / limitTokens,
      headroom_upper: (limitTokens - capWeightedUpper) / limitTokens,
      cap_weighted_headline: capWeightedHeadline,
      cap_weighted_upper: capWeightedUpper,
    };
  });

  return buildResponse<HeadroomTrendData>(
    {
      state: "OK",
      bucket,
      points,
      cap_read_coeff_headline: DEFAULT_CAP_READ_COEFF,
      cap_read_coeff_upper: UPPER_BOUND_COEFF,
      coefficient_unverified: true,
    },
    {
      claim_kind: "LIST_EQUIV",
      n: points.length,
      window,
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: CAVEAT_NOTE,
      },
    },
  );
}
