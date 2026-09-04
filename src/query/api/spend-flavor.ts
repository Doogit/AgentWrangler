/**
 * src/query/api/spend-flavor.ts — Token-flavor decomposition + cache efficiency.
 *
 * Surface 1 (§1): getFlavorDecomposition() — breakdown by token flavor with cap-proxy weights.
 * Surface 2 (§2): getCacheEfficiency() — cache read:write ratio diagnostic.
 *
 * Subscription cap-proxy weights displayed:
 *   fresh input        1×
 *   output             1×
 *   cache writes       1×
 *   cache read         0.1× (UNVERIFIED coefficient)
 *
 * API list-equivalent dollars remain a separate pricing-snapshot metric. This view
 * deliberately reconciles to capWeightedTokens(); it does not pretend that output
 * tokens share the model's input price or apply API write premiums to a subscription cap.
 *
 * Vocabulary: docs/plans/blog-dashboard-taxonomy-IA.md §1a
 */

import type { Db } from "../../db/open.js";
import { capWeightedTokens, resolveCapReadCoeff } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse, QueryWindow } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import type { WindowFilter } from "./overview.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlavorKey =
  | "fresh_input"
  | "output"
  | "cache_write_5m"
  | "cache_write_1h"
  | "cache_write_other"
  | "cache_read";

/** Display labels — verbatim from taxonomy §1a / A1 §04 */
const FLAVOR_LABELS: Record<FlavorKey, string> = {
  fresh_input: "fresh input",
  output: "output (incl. thinking)",
  cache_write_5m: "cache write (5 min)",
  cache_write_1h: "cache write (1 hr)",
  cache_write_other: "cache write (unspecified)",
  cache_read: "cache read",
};

/** Cap-proxy weights. API prices are intentionally not represented by this chart. */
const CAP_WEIGHTS: Record<FlavorKey, number> = {
  fresh_input: 1.0,
  output: 1.0,
  cache_write_5m: 1.0,
  cache_write_1h: 1.0,
  cache_write_other: 1.0,
  cache_read: 0.1, // default; overridden by coeff at runtime
};

export interface FlavorRow {
  flavor: FlavorKey;
  /** Article-exact display label from A1 §04 */
  label: string;
  /** Relative cap-proxy weight (1.0 or the configured cache-read coefficient). */
  weight: number;
  /** Raw token count (unweighted sum) */
  raw_tokens: number;
  /** Cap-proxy-weighted token count (raw * weight). For cache_read: raw * coeff. */
  weighted_tokens: number;
  /** Share of total cap-proxy-weighted tokens (0–1). */
  weighted_share: number;
  /** Share of total raw tokens (0–1) */
  raw_share: number;
}

export interface FlavorDecomposition {
  /** Six rows in canonical article order plus unspecified cache writes. */
  flavors: FlavorRow[];
  /** Total raw tokens (all six display rows summed) */
  total_raw_tokens: number;
  /** Total cap-proxy-weighted tokens; reconciles to cap_weighted_tokens. */
  total_weighted_tokens: number;
  /** cache_read / (cache_read + cache_write_total); null if no cache activity */
  cache_efficiency_ratio: number | null;
  /** Raw cache-read share; diagnostic only, not a health signal. */
  cache_read_share: number | null;
  /** Raw cache-read tokens, retained separately from the bounded share. */
  cache_read_tokens: number;
  /** Raw cache-creation tokens (all cache-write TTLs). */
  cache_creation_tokens: number;
  /** Reuse band from raw cache_read : cache_creation, never a health assessment. */
  reuse_band: CacheReuseBand;
  /** Selected-window draw from capWeightedTokens(), not the pricing-weighted total. */
  cap_weighted_tokens: number;
  /** The coeff used for cache_read weighting */
  coeff_used: number;
  /** Always true — label every weighted display with the unverified caveat */
  coeff_unverified: true;
  /** Turn count */
  turns: number;
}

export type CacheReuseBand =
  | "NO_DATA"
  | "NO_DENOMINATOR"
  | "WRITE_HEAVY"
  | "MIXED_REUSE"
  | "REUSE_DOMINANT";

/** @deprecated Use CacheReuseBand; retained as a source-compatible type export. */
export type CacheEfficiencySignal = CacheReuseBand;

export interface CacheEfficiency {
  /** cache_read / (cache_read + cache_write_total); null if no cache traffic */
  ratio: number | null;
  /** Raw cache_read_tokens in window */
  cache_read_tokens: number;
  /** Raw cache_creation_tokens in window (5m + 1h + other) */
  cache_creation_tokens: number;
  /** Banded raw cache_read : cache_creation diagnostic, not a health signal. */
  reuse_band: CacheReuseBand;
  /** Selected-window draw from capWeightedTokens(), not pricing-weighted tokens. */
  cap_weighted_tokens: number;
  /** Coefficient used by the cap-weighted draw. */
  coeff_used: number;
  /** The cap-read coefficient is unverified. */
  coeff_unverified: true;
  /** Turn count */
  turns: number;
}

// ---------------------------------------------------------------------------
// Reuse-band logic
// ---------------------------------------------------------------------------

/**
 * Classify raw cache read:creation values without assigning a health label.
 * A zero creation denominator remains distinct from no data and reuse dominance.
 */
export function classifyCacheReuseBand(
  cacheReadTokens: number,
  cacheCreationTokens: number,
  turns: number,
): CacheReuseBand {
  if (turns === 0) return "NO_DATA";
  if (cacheCreationTokens === 0) return "NO_DENOMINATOR";
  const readToCreation = cacheReadTokens / cacheCreationTokens;
  if (readToCreation < 1) return "WRITE_HEAVY";
  if (readToCreation < 4) return "MIXED_REUSE";
  return "REUSE_DOMINANT";
}

/** @deprecated Use classifyCacheReuseBand with raw counts and turns. */
export const classifyCacheEfficiency = classifyCacheReuseBand;

// ---------------------------------------------------------------------------
// Window resolution (matches the pattern in trends.ts)
// ---------------------------------------------------------------------------

const PRESET_DAYS: Record<NonNullable<WindowFilter["preset"]>, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
// Raw query shape
// ---------------------------------------------------------------------------

interface FlavorAggRow {
  raw_input: number;
  raw_output: number;
  raw_cw5m: number;
  raw_cw1h: number;
  raw_cw_other: number;
  raw_cr: number;
  turns: number;
}

const FLAVOR_SQL = `
  SELECT
    COALESCE(SUM(input_tokens), 0)                              AS raw_input,
    COALESCE(SUM(output_tokens), 0)                             AS raw_output,
    COALESCE(SUM(cache_write_5m), 0)                            AS raw_cw5m,
    COALESCE(SUM(cache_write_1h), 0)                            AS raw_cw1h,
    COALESCE(SUM(cache_write_other), 0)                         AS raw_cw_other,
    COALESCE(SUM(cache_read_tokens), 0)                         AS raw_cr,
    COUNT(*)                                                    AS turns
  FROM turns
  WHERE ts >= ? AND ts < ? AND provisional = 0
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFlavors(agg: FlavorAggRow, coeff: number): FlavorRow[] {
  const raws: Record<FlavorKey, number> = {
    fresh_input: agg.raw_input,
    output: agg.raw_output,
    cache_write_5m: agg.raw_cw5m,
    cache_write_1h: agg.raw_cw1h,
    cache_write_other: agg.raw_cw_other,
    cache_read: agg.raw_cr,
  };

  const weights: Record<FlavorKey, number> = {
    ...CAP_WEIGHTS,
    cache_read: coeff, // override with resolved coeff
  };

  const totalRaw = Object.values(raws).reduce((s, v) => s + v, 0);
  const totalWeighted = (Object.keys(raws) as FlavorKey[]).reduce(
    (s, k) => s + raws[k] * weights[k],
    0,
  );

  const keys: FlavorKey[] = [
    "fresh_input",
    "output",
    "cache_write_5m",
    "cache_write_1h",
    "cache_write_other",
    "cache_read",
  ];

  return keys.map((flavor) => {
    const raw_tokens = raws[flavor];
    const weight = weights[flavor];
    const weighted_tokens = raw_tokens * weight;
    return {
      flavor,
      label: FLAVOR_LABELS[flavor],
      weight,
      raw_tokens,
      weighted_tokens,
      weighted_share: totalWeighted > 0 ? weighted_tokens / totalWeighted : 0,
      raw_share: totalRaw > 0 ? raw_tokens / totalRaw : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API methods
// ---------------------------------------------------------------------------

/**
 * Token-flavor decomposition over a window.
 *
 * Endpoint: GET /api/overview/flavor?preset=7d
 *
 * claim_kind: PROXY (reconciled turns only, provisional=0).
 *
 * Internal reconciliation: total_weighted_tokens === SUM(flavors[].weighted_tokens).
 * total_weighted_tokens uses the same cap-proxy weights as capWeightedTokens().
 */
export function getFlavorDecomposition(filter: WindowFilter): ApiResponse<FlavorDecomposition> {
  const db: Db = getQueryDb();
  const win = resolveWindow(filter);
  const { from, to } = win;
  const coeff = resolveCapReadCoeff(db);

  const agg = db.prepare(FLAVOR_SQL).get(from, to) as FlavorAggRow;

  const flavors = buildFlavors(agg, coeff);
  const total_raw_tokens = flavors.reduce((s, f) => s + f.raw_tokens, 0);
  const total_weighted_tokens = flavors.reduce((s, f) => s + f.weighted_tokens, 0);

  const cacheCreation = agg.raw_cw5m + agg.raw_cw1h + agg.raw_cw_other;
  const cacheTotal = agg.raw_cr + cacheCreation;
  const cache_efficiency_ratio = cacheTotal > 0 ? agg.raw_cr / cacheTotal : null;
  const capRow = capWeightedTokens(db, { fromIso: from, toIso: to, coeff })[0];

  const data: FlavorDecomposition = {
    flavors,
    total_raw_tokens,
    total_weighted_tokens,
    cache_efficiency_ratio,
    cache_read_share: cache_efficiency_ratio,
    cache_read_tokens: agg.raw_cr,
    cache_creation_tokens: cacheCreation,
    reuse_band: classifyCacheReuseBand(agg.raw_cr, cacheCreation, agg.turns),
    cap_weighted_tokens: capRow?.cap_weighted_tokens ?? 0,
    coeff_used: coeff,
    coeff_unverified: true,
    turns: agg.turns,
  };

  return buildResponse(data, {
    claim_kind: "PROXY",
    n: 6,
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
 * Cache read:write efficiency KPI over a window.
 *
 * Derives from capWeightedTokens() — no additional SQL.
 * Uses raw token counts (not pricing-weighted) so the ratio is exact.
 *
 * Endpoint: GET /api/overview/flavor (embedded in FlavorDecomposition).
 * Also exported as a standalone function for independent use.
 */
export function getCacheEfficiency(filter: WindowFilter): ApiResponse<CacheEfficiency> {
  const db: Db = getQueryDb();
  const win = resolveWindow(filter);
  const { from, to } = win;

  const rows = capWeightedTokens(db, { fromIso: from, toIso: to });
  const row = rows[0];

  const cache_read_tokens = row?.cache_read_tokens ?? 0;
  const cache_creation_tokens = row?.cache_creation_tokens ?? 0;
  const cacheTotal = cache_read_tokens + cache_creation_tokens;
  const ratio = cacheTotal > 0 ? cache_read_tokens / cacheTotal : null;

  const data: CacheEfficiency = {
    ratio,
    cache_read_tokens,
    cache_creation_tokens,
    reuse_band: classifyCacheReuseBand(cache_read_tokens, cache_creation_tokens, row?.turns ?? 0),
    cap_weighted_tokens: row?.cap_weighted_tokens ?? 0,
    coeff_used: resolveCapReadCoeff(db),
    coeff_unverified: true,
    turns: row?.turns ?? 0,
  };

  return buildResponse(data, {
    claim_kind: "PROXY",
    n: 1,
    window: win,
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "",
    },
  });
}
