/**
 * src/ingest/pricing.ts — PricingSnapshotStore + per-turn pricing.
 *
 * Prices are stored as a snapshot per model tier in `pricing_snapshots`.
 * unit_prices_json = [input, output, cacheRead, cacheWrite5m, cacheWrite1h] in
 * $/MTok, which is numerically μUSD/token — so cost_equiv_u (integer micro-USD)
 * is a direct token×price sum, no scaling. This matches the proven reference
 * scripts (token-usage-analyze.mjs / s1-all.mjs) exactly.
 *
 * Pricing rules (Ingestion Spec §1.2):
 *   - price each turn against the freshest NON-STALE snapshot for its tier;
 *   - no snapshot for the tier ⇒ cost_equiv_u = NULL (tokens still counted);
 *   - only a stale snapshot available ⇒ cost computed, cost_claim = LIST_EQUIV_STALE.
 *
 * PRICE SOURCE (BM0, re-fetched 2026-09-03 from platform.claude.com models
 * overview — the authoritative Anthropic docs): current per-model list prices.
 *   - Base $/MTok: opus 5/4.8 $5/$25 · sonnet-5 $2/$10 · sonnet-4.x $3/$15 ·
 *     haiku-4.5 $1/$5 · fable 5/5.1 $10/$50.
 *   - Cache multipliers (all families): 5m write 1.25×, 1h write 2.0×, read 0.1×
 *     of base input — EXCEPT the Fable/Mythos 5.1 family, whose cache read is
 *     0.025× (docs footnote), giving the split fable-5 vs fable-5-1 tiers.
 * Tiers are per generation only where the corpus carries both AND prices differ:
 *   - opus stays a single tier (4.8 and 5 are priced identically → no split);
 *   - sonnet splits sonnet-5 vs sonnet-4 ($2 vs $3 base);
 *   - fable splits fable-5-1 vs fable-5 (0.025× vs 0.1× cache read).
 * Every haiku model maps to the single `haiku` tier (only 4.5 in the corpus).
 * Re-pricing bumps snapshot ids to list-<tier>-v2; historical turns keep their
 * old snapshot provenance until the next full re-scan (RV2a backfill stance).
 */

import type { Db } from "../db/open.js";

/** Cache-write "other" (unsplit cache_creation) is priced at the 5m rate (OQ-03). */
export type UnitPrices = readonly [
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
];

/**
 * Canonical list-price table ($/MTok = μUSD/token), one row per model tier.
 * [input, output, cacheRead, cacheWrite5m, cacheWrite1h].
 */
export const LIST_PRICES: Record<string, UnitPrices> = {
  opus: [5, 25, 0.5, 6.25, 10],
  "sonnet-5": [2, 10, 0.2, 2.5, 4],
  "sonnet-4": [3, 15, 0.3, 3.75, 6],
  haiku: [1, 5, 0.1, 1.25, 2],
  "fable-5": [10, 50, 1, 12.5, 20],
  "fable-5-1": [10, 50, 0.25, 12.5, 20], // 0.025× cache read (5.1 family)
};

/** Default snapshot staleness horizon (days) when seeding list prices. */
const DEFAULT_STALE_DAYS = 30;

export type CostClaim = "LIST_EQUIV" | "LIST_EQUIV_STALE";

export interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
}

export interface PricedTurn {
  costU: number | null;
  snapshotId: string | null;
  claim: CostClaim;
}

/**
 * Resolve a model string to a pricing tier, or null if unpriceable.
 * Generation-sensitive families (sonnet, fable) match the more specific
 * generation first; opus and haiku are single-tier (see LIST_PRICES doc).
 */
export function modelTier(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return model.includes("sonnet-5") ? "sonnet-5" : "sonnet-4";
  if (model.includes("haiku")) return "haiku";
  // Fable and Mythos share the same per-token pricing per generation; the 5.1
  // family (fable-5-1 / mythos-5-1) has the 0.025× cache-read exception.
  if (model.includes("fable") || model.includes("mythos")) {
    return model.includes("fable-5-1") || model.includes("mythos-5-1") ? "fable-5-1" : "fable-5";
  }
  return null;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Seed `pricing_snapshots` with the canonical list-price table (one snapshot per
 * tier) if not already present. Deterministic snapshot ids keep re-seeding and
 * rebuild-equality idempotent. Returns the number of snapshots inserted.
 */
export function seedListPrices(db: Db, capturedAtIso: string): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?,?,?,?,?)`,
  );
  const staleAfter = addDaysIso(capturedAtIso, DEFAULT_STALE_DAYS);
  let inserted = 0;
  for (const [tier, prices] of Object.entries(LIST_PRICES)) {
    const res = insert.run(
      `list-${tier}-v2`,
      tier,
      JSON.stringify(prices),
      capturedAtIso,
      staleAfter,
    );
    inserted += res.changes;
  }
  return inserted;
}

interface SnapshotRow {
  snapshot_id: string;
  model_tier: string;
  unit_prices_json: string;
  stale_after: string;
}

/**
 * Prices turns against the snapshots present in the DB at construction time.
 * Load once, price many; the `now` reference fixes staleness for the batch.
 */
export class PricingSnapshotStore {
  private readonly nowIso: string;
  /** tier → chosen snapshot (freshest non-stale, else freshest stale). */
  private readonly byTier = new Map<string, { id: string; prices: UnitPrices; stale: boolean }>();

  constructor(db: Db, nowIso: string = new Date().toISOString()) {
    this.nowIso = nowIso;
    const rows = db
      .prepare(
        `SELECT snapshot_id, model_tier, unit_prices_json, stale_after
         FROM pricing_snapshots`,
      )
      .all() as SnapshotRow[];

    // Group by tier, then choose: prefer non-stale with max captured proxy.
    // We select the freshest by stale_after (later horizon ⇒ newer capture).
    const grouped = new Map<string, SnapshotRow[]>();
    for (const r of rows) {
      const list = grouped.get(r.model_tier) ?? [];
      list.push(r);
      grouped.set(r.model_tier, list);
    }

    for (const [tier, list] of grouped) {
      const nonStale = list.filter((r) => r.stale_after > this.nowIso);
      const pool = nonStale.length > 0 ? nonStale : list;
      // Freshest = latest stale_after horizon.
      let chosen = pool[0];
      if (chosen === undefined) continue;
      for (const r of pool) {
        if (r.stale_after > chosen.stale_after) chosen = r;
      }
      this.byTier.set(tier, {
        id: chosen.snapshot_id,
        prices: parsePrices(chosen.unit_prices_json),
        stale: nonStale.length === 0,
      });
    }
  }

  /** Price a single turn. Returns cost in micro-USD, the snapshot used, and the claim. */
  price(model: string, tokens: TurnTokens): PricedTurn {
    const tier = modelTier(model);
    if (tier === null) {
      return { costU: null, snapshotId: null, claim: "LIST_EQUIV" };
    }
    const snap = this.byTier.get(tier);
    if (snap === undefined) {
      return { costU: null, snapshotId: null, claim: "LIST_EQUIV" };
    }
    const [pin, pout, pcr, pcw5, pcw1] = snap.prices;
    const costU = Math.round(
      tokens.inputTokens * pin +
        tokens.outputTokens * pout +
        tokens.cacheReadTokens * pcr +
        (tokens.cacheWrite5m + tokens.cacheWriteOther) * pcw5 +
        tokens.cacheWrite1h * pcw1,
    );
    return {
      costU,
      snapshotId: snap.id,
      claim: snap.stale ? "LIST_EQUIV_STALE" : "LIST_EQUIV",
    };
  }
}

function parsePrices(json: string): UnitPrices {
  const arr = JSON.parse(json) as number[];
  return [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0, arr[4] ?? 0];
}
