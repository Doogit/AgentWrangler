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
 *     0.025× (docs footnote), giving the split fable-5 vs fable-5-1 tiers, and
 *     Opus 5.5 and Sonnet 5.5, whose cache read is 0.05× ($0.20 on $4, $0.10 on $2).
 * Tiers are per generation only where the corpus carries both AND prices differ:
 *   - opus splits opus-5-5 ($4/$20, cache read $0.20; PRICE-O55, 2026-09-26) vs
 *     opus (4.8 and 5, priced identically);
 *   - sonnet splits sonnet-5-5 (cache read $0.10; F24, 2026-10-14) vs sonnet-5 vs
 *     sonnet-4 ($2 vs $3 base);
 *   - fable splits fable-5-1 vs fable-5 (0.025× vs 0.1× cache read);
 *   - haiku splits haiku-5-5 ($0.10/$0.50; F24) vs haiku (4.5, $1/$5). Haiku 5.5 is
 *     also priced by prompt length: a turn over 100,000 prompt tokens is priced (and
 *     filed) under haiku-5-5-long, see LONG_PROMPT_TIERS.
 * Snapshot ids are list-<tier>-v<LIST_PRICE_VERSIONS[tier]>; `reprice.ts` moves, at
 * boot, turns filed under another tier and turns on an older list-<tier>-v<n>
 * snapshot of their own tier. Fixture (non-list) snapshots are left as priced.
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
  "opus-5-5": [4, 20, 0.2, 5, 8], // 0.05× cache read
  "sonnet-5": [2, 10, 0.2, 2.5, 4],
  "sonnet-5-5": [2, 10, 0.1, 2.5, 4], // 0.05× cache read (F24, page footnote 2)
  "sonnet-4": [3, 15, 0.3, 3.75, 6],
  haiku: [1, 5, 0.1, 1.25, 2],
  "haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2], // prompts ≤ 100,000 tokens
  "haiku-5-5-long": [0.5, 2.5, 0.05, 0.625, 1], // prompts > 100,000 tokens (LONG_PROMPT_TIERS)
  "fable-5": [10, 50, 1, 12.5, 20],
  "fable-5-1": [10, 50, 0.25, 12.5, 20], // 0.025× cache read (5.1 family)
};

/** OV-12: price-weighted tokens = μUSD ÷ the Sonnet 5 input price ("Sonnet-equivalent tokens"). */
export const REF_PRICE_U_PER_TOKEN = LIST_PRICES["sonnet-5"]?.[0] as number;

/**
 * Per-tier list-snapshot version: snapshot id is `list-<tier>-v<version>`. Bump a
 * tier's version (and its LIST_PRICES row) when its published price changes;
 * `reprice.ts` then re-prices that tier's list-priced turns at boot.
 */
export const LIST_PRICE_VERSIONS: Record<string, number> = {
  opus: 2,
  "opus-5-5": 2,
  "sonnet-5": 2,
  "sonnet-5-5": 2,
  "sonnet-4": 2,
  haiku: 2,
  "haiku-5-5": 2,
  "haiku-5-5-long": 2,
  "fable-5": 2,
  "fable-5-1": 2,
};

/** Current list-snapshot id for a tier. */
export function listSnapshotId(tier: string): string {
  return `list-${tier}-v${LIST_PRICE_VERSIONS[tier] ?? 2}`;
}

/**
 * Model ids checked against the official price page (id → tier). A model seen at
 * ingest that is absent here is recorded as unconfirmed (priced by the
 * `modelTier` substring fallback, so spend never drops to $0).
 */
export const KNOWN_MODELS: Record<string, string> = {
  "claude-opus-4-5": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-8": "opus",
  "claude-opus-5": "opus",
  "claude-opus-5-5": "opus-5-5",
  "claude-sonnet-4-5": "sonnet-4",
  "claude-sonnet-4-6": "sonnet-4",
  "claude-sonnet-5": "sonnet-5",
  "claude-sonnet-5-5": "sonnet-5-5",
  "claude-haiku-4-5-20251001": "haiku",
  "claude-haiku-5-5": "haiku-5-5",
  "claude-fable-5": "fable-5",
  "claude-fable-5-1": "fable-5-1",
  "claude-mythos-5": "fable-5",
  "claude-mythos-5-1": "fable-5-1",
};

/** Date KNOWN_MODELS was last checked against the price page. */
export const KNOWN_MODELS_CHECKED = "2026-10-14";

/**
 * Tiers whose price depends on prompt length (F24). Per the pricing page (platform.claude.com/
 * docs/en/about-claude/pricing, "Long context pricing", 2026-10-14): a Haiku 5.5 request whose
 * prompt is over 100,000 tokens pays the higher prices, and "a request's prompt length counts all
 * of its input tokens, including cache reads and cache writes" — i.e. `promptTokens()` below
 * (same sum as the `turns.context_tokens` column). Each request is priced on its own.
 */
export const LONG_PROMPT_TIERS: Readonly<Record<string, { tier: string; overTokens: number }>> = {
  "haiku-5-5": { tier: "haiku-5-5-long", overTokens: 100_000 },
};

/** Prompt length of one request: input + cache read + all cache writes. */
export function promptTokens(t: TurnTokens): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteOther;
}

/** The tier one turn is priced at: its model's tier, or that tier's long-prompt tier. */
export function turnTier(model: string | null | undefined, tokens: TurnTokens): string | null {
  const tier = modelTier(model);
  const long = tier === null ? undefined : LONG_PROMPT_TIERS[tier];
  return long !== undefined && promptTokens(tokens) > long.overTokens ? long.tier : tier;
}

export const UNCONFIRMED_MODEL_PREFIX = "unconfirmed_model:";

/**
 * Record each model not in KNOWN_MODELS once (user_config, INSERT OR IGNORE).
 * Local only. Skips empty ids and Claude Code's `<synthetic>` pseudo-model.
 */
export function noteUnconfirmedModels(
  db: Db,
  models: Iterable<string | null | undefined>,
  nowIso: string,
): void {
  const unknown: string[] = [];
  for (const model of models) {
    if (!model || model === "<synthetic>" || Object.hasOwn(KNOWN_MODELS, model)) continue;
    unknown.push(model);
  }
  if (unknown.length === 0) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO user_config (key, value, updated_at) VALUES (?, ?, ?)",
  );
  for (const model of unknown) {
    insert.run(
      `${UNCONFIRMED_MODEL_PREFIX}${model}`,
      JSON.stringify({ tier: modelTier(model), first_seen: nowIso }),
      nowIso,
    );
  }
}

/**
 * Published list-price multipliers relative to fresh input (×base input),
 * derived from LIST_PRICES and identical across tiers EXCEPT the fable-5-1
 * (0.025×) and opus-5-5 / sonnet-5-5 (0.05×) cache reads, see LIST_PRICES doc. Exported so the UI's "Where your tokens
 * go" weights table reads the same source spend-equivalent uses and the two can
 * never disagree (overview-v2 §5). cache_creation is already split into 5m/1h at
 * ingest (parser.ts), so spend-equivalent totals are unchanged by this export.
 */
export const LIST_PRICE_WEIGHTS = {
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  output: 5,
  input: 1,
} as const;

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
 * Cache weights expressed in base-input-token equivalents for reclaimable CEU.
 *
 * These values are derived from the selected per-tier price vector, rather than
 * from LIST_PRICE_WEIGHTS: Fable/Mythos 5.1 has a 0.025× cache-read exception.
 */
export interface ReclaimableCeuWeights {
  tier: string;
  snapshotId: string | null;
  wRead: number;
  wWrite5m: number;
  wWrite1h: number;
  /** Unknown model IDs or an absent snapshot use the conservative fallback. */
  provenance: "OFFICIAL" | "UNVERIFIED";
}

/** The lowest known cache-read tier is the conservative fallback for unknown models. */
export const CONSERVATIVE_CEU_DEFAULT_TIER = "fable-5-1";

function ceuWeight(numerator: number, inputPrice: number): number {
  return Number((numerator / inputPrice).toPrecision(12));
}

/**
 * Resolve a model string to a pricing tier, or null if unpriceable.
 * Generation-sensitive families match the more specific generation first (see
 * LIST_PRICES doc). Model-level only: a long Haiku 5.5 prompt is `turnTier`'s job.
 */
export function modelTier(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes("opus")) return model.includes("opus-5-5") ? "opus-5-5" : "opus";
  if (model.includes("sonnet")) {
    if (model.includes("sonnet-5-5")) return "sonnet-5-5";
    return model.includes("sonnet-5") ? "sonnet-5" : "sonnet-4";
  }
  if (model.includes("haiku")) return model.includes("haiku-5-5") ? "haiku-5-5" : "haiku";
  // Fable and Mythos share the same per-token pricing per generation; the 5.1
  // family (fable-5-1 / mythos-5-1) has the 0.025× cache-read exception.
  if (model.includes("fable") || model.includes("mythos")) {
    return model.includes("fable-5-1") || model.includes("mythos-5-1") ? "fable-5-1" : "fable-5";
  }
  return null;
}

/**
 * SQL predicate matching premium-priced models on a `model` column: Opus plus
 * the Fable/Mythos families (Fable's $10/$50 base is 2× Opus). Shared by every
 * premium-share aggregate so the family list can't drift between queries.
 */
export const PREMIUM_MODEL_SQL =
  "(model LIKE '%opus%' OR model LIKE '%fable%' OR model LIKE '%mythos%')";

/**
 * Input list price ($/MTok) for a model, for ordering model lists
 * most-expensive first. Derived from LIST_PRICES via modelTier so a new tier
 * automatically sorts by its price; unpriceable models return 0 (sort last).
 */
export function modelInputListPrice(model: string): number {
  const tier = modelTier(model);
  return tier === null ? 0 : (LIST_PRICES[tier]?.[0] ?? 0);
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
      listSnapshotId(tier),
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
    const tier = turnTier(model, tokens);
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

  /**
   * Return per-session reclaimable-CEU weights from the chosen pricing snapshot.
   *
   * The fallback deliberately uses the newest model's lower cache-read rate, so
   * an unknown model cannot inflate a CEU estimate. LIST_PRICES is used only if
   * this store has no default-tier snapshot; normal ingestion seeds that tier.
   */
  reclaimableCeuWeights(model: string | null | undefined): ReclaimableCeuWeights {
    const requestedTier = modelTier(model);
    const snapshot = requestedTier === null ? undefined : this.byTier.get(requestedTier);
    const tier =
      requestedTier !== null && snapshot !== undefined
        ? requestedTier
        : CONSERVATIVE_CEU_DEFAULT_TIER;
    const fallback = this.byTier.get(CONSERVATIVE_CEU_DEFAULT_TIER);
    const prices =
      snapshot?.prices ?? fallback?.prices ?? LIST_PRICES[CONSERVATIVE_CEU_DEFAULT_TIER];
    if (prices === undefined) {
      throw new Error(`Missing ${CONSERVATIVE_CEU_DEFAULT_TIER} CEU fallback prices`);
    }
    const input = prices[0];

    return {
      tier,
      snapshotId: snapshot?.id ?? fallback?.id ?? null,
      wRead: ceuWeight(prices[2], input),
      wWrite5m: ceuWeight(prices[3], input),
      wWrite1h: ceuWeight(prices[4], input),
      provenance: snapshot === undefined ? "UNVERIFIED" : "OFFICIAL",
    };
  }
}

function parsePrices(json: string): UnitPrices {
  const arr = JSON.parse(json) as number[];
  return [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0, arr[4] ?? 0];
}
