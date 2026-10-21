/**
 * src/detector/tier-price.ts — price rec-lane tokens at the tier of the turns they came from
 * (PRICE-O55-F1, rule 1). modelTier(model) → freshest pricing_snapshots row for that tier,
 * falling back to LIST_PRICES[tier]. Never a fixed tier.
 */

import type { Db } from "../db/open.js";
import { LIST_PRICES, modelTier } from "../ingest/pricing.js";

type TierPrices = readonly [number, number, number, number, number];

interface PriceRow {
  unit_prices_json: string;
}

/** [input, output, cacheRead, cw5m, cw1h] $/MTok for a pricing tier; zeros when unknown. */
export function tierPriceVector(db: Db, tier: string | null): TierPrices {
  if (tier === null) return [0, 0, 0, 0, 0];
  const row = db
    .prepare(
      `SELECT unit_prices_json FROM pricing_snapshots
        WHERE model_tier = ?
        ORDER BY stale_after DESC
        LIMIT 1`,
    )
    .get(tier) as PriceRow | undefined;
  if (row) {
    try {
      const arr = JSON.parse(row.unit_prices_json) as number[];
      return [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0, arr[4] ?? 0];
    } catch {
      // fall through to list price
    }
  }
  return LIST_PRICES[tier] ?? [0, 0, 0, 0, 0];
}

/**
 * Weight-averaged $/MTok for price-vector `index` over `items`, each priced at its own
 * model's tier. weight × blended price = Σ weight_i × price_i, so an estimator that takes
 * (tokens × price) gets the exact per-tier sum. Zero total weight → unweighted mean.
 */
export function blendedTierPrice(
  db: Db,
  items: readonly { model: string | null; weight: number }[],
  index: number,
): number {
  const cache = new Map<string, number>();
  const priceOf = (model: string | null): number => {
    const tier = modelTier(model);
    const key = tier ?? "";
    let price = cache.get(key);
    if (price === undefined) {
      price = tierPriceVector(db, tier)[index] ?? 0;
      cache.set(key, price);
    }
    return price;
  };
  let totalWeight = 0;
  let spend = 0;
  for (const item of items) {
    totalWeight += item.weight;
    spend += item.weight * priceOf(item.model);
  }
  if (totalWeight > 0) return spend / totalWeight;
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + priceOf(item.model), 0) / items.length;
}
