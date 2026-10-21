/**
 * src/detector/write-price.ts — blended cache-write price helper (B4).
 *
 * Workspace-grain analogue of D6's blendedCacheReadPriceForSession, but for the
 * cache-creation (write) column. Mirrors the OQ-03 convention: cache_write_other
 * is priced at the 5m rate (index 3).
 */

import type { Db } from "../db/open.js";
import { LIST_PRICES, modelTier } from "../ingest/pricing.js";

/** Resolve cache-write-5m price ($/MTok) from a pricing snapshot or list price. */
function cacheWrite5mPrice(unitPricesJson: string | null, model: string): number {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[3] === "number") return arr[3];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? lp[3] : 0;
}

/** Resolve cache-write-1h price ($/MTok) from a pricing snapshot or list price. */
function cacheWrite1hPrice(unitPricesJson: string | null, model: string): number {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[4] === "number") return arr[4];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? lp[4] : 0;
}

interface WritePricingRow {
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  model: string;
  unit_prices_json: string | null;
}

/**
 * Blended cache-creation (write) price ($/MTok) for a workspace, weighted by
 * write-token bucket over all in-window non-provisional turns.
 *
 * Σ (cw5m + cw_other) × price[3]  +  cw1h × price[4]
 * ─────────────────────────────────────────────────────
 *      Σ (cw5m + cw1h + cw_other)
 *
 * cache_write_other is priced at the 5m rate (index 3, OQ-03).
 * Returns 0 when no write tokens are present in the window.
 */
export function blendedCacheWritePriceForWorkspace(
  db: Db,
  workspaceId: string,
  fromIso: string,
  toIso: string,
): number {
  const rows = db
    .prepare(
      `SELECT t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
              t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.workspace_id = ? AND t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(workspaceId, fromIso, toIso) as WritePricingRow[];

  let totalTokens = 0;
  let totalSpend = 0;
  for (const r of rows) {
    const p5m = cacheWrite5mPrice(r.unit_prices_json, r.model);
    const p1h = cacheWrite1hPrice(r.unit_prices_json, r.model);
    totalSpend += (r.cache_write_5m + r.cache_write_other) * p5m + r.cache_write_1h * p1h;
    totalTokens += r.cache_write_5m + r.cache_write_1h + r.cache_write_other;
  }
  return totalTokens > 0 ? totalSpend / totalTokens : 0;
}

/** Resolve cache-read price ($/MTok) from a pricing snapshot or list price. */
function cacheReadPrice(unitPricesJson: string | null, model: string): number {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[2] === "number") return arr[2];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? lp[2] : 0;
}

interface ReadPricingRow {
  cache_read_tokens: number;
  model: string;
  unit_prices_json: string | null;
}

/**
 * Blended cache-read price ($/MTok) for a workspace, weighted by
 * cache_read_tokens over all in-window non-provisional turns.
 *
 * price = unit_prices_json[2] → LIST_PRICES[tier][2] fallback.
 * Returns 0 when no cache-read tokens are present in the window.
 */
export function blendedCacheReadPriceForWorkspace(
  db: Db,
  workspaceId: string,
  fromIso: string,
  toIso: string,
): number {
  const rows = db
    .prepare(
      `SELECT t.cache_read_tokens, t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.workspace_id = ? AND t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(workspaceId, fromIso, toIso) as ReadPricingRow[];

  let totalTokens = 0;
  let totalSpend = 0;
  for (const r of rows) {
    const price = cacheReadPrice(r.unit_prices_json, r.model);
    totalSpend += r.cache_read_tokens * price;
    totalTokens += r.cache_read_tokens;
  }
  return totalTokens > 0 ? totalSpend / totalTokens : 0;
}

/**
 * Blended cache-read price ($/MTok) across all workspaces, weighted by
 * cache_read_tokens over all in-window non-provisional turns.
 *
 * Global variant for D10 (null-scope). Returns 0 when no cache-read tokens.
 */
export function blendedCacheReadPriceGlobal(db: Db, fromIso: string, toIso: string): number {
  const rows = db
    .prepare(
      `SELECT t.cache_read_tokens, t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
    )
    .all(fromIso, toIso) as ReadPricingRow[];

  let totalTokens = 0;
  let totalSpend = 0;
  for (const r of rows) {
    const price = cacheReadPrice(r.unit_prices_json, r.model);
    totalSpend += r.cache_read_tokens * price;
    totalTokens += r.cache_read_tokens;
  }
  return totalTokens > 0 ? totalSpend / totalTokens : 0;
}
