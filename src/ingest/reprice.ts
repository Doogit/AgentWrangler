/**
 * src/ingest/reprice.ts — boot re-price of stored turns (PRICE-O55).
 *
 * A turn keeps the snapshot it was priced with at ingest. This re-prices, and
 * moves each session's roll-up by the same delta, every turn that is:
 *   - filed under a snapshot of a different tier than it resolves to now (a model
 *     got its own tier, e.g. Opus 5.5 split from Opus 5, or Sonnet 5.5 / Haiku 5.5
 *     in F24; a Haiku 5.5 turn over 100k prompt tokens resolves to haiku-5-5-long), or
 *   - filed under an older list snapshot of its own tier (`list-<tier>-v<n>` that
 *     is not the current `LIST_PRICE_VERSIONS` id: a published price changed).
 * A turn on a non-list snapshot of its own tier (fixture prices) is left as
 * priced. Idempotent and cheap when nothing differs, so it runs on every boot.
 * Also records models missing from KNOWN_MODELS (local note, no network).
 */

import type { Db } from "../db/open.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import {
  LONG_PROMPT_TIERS,
  PricingSnapshotStore,
  listSnapshotId,
  modelTier,
  noteUnconfirmedModels,
  seedListPrices,
} from "./pricing.js";

export interface RepriceResult {
  turns: number;
  deltaU: number;
}

interface TurnRow {
  message_id: string;
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  cost_equiv_u: number | null;
  pricing_snapshot_id: string | null;
}

export function repriceTurns(db: Db, nowIso: string): RepriceResult {
  return db.transaction((): RepriceResult => {
    seedListPrices(db, nowIso);
    const store = new PricingSnapshotStore(db, nowIso);
    const models = db.prepare("SELECT DISTINCT model FROM turns").pluck().all() as string[];
    noteUnconfirmedModels(db, models, nowIso);
    // The tier a turn belongs to is per turn for long-prompt tiers (Haiku 5.5 over 100k prompt
    // tokens, LONG_PROMPT_TIERS); context_tokens is the same prompt-length sum as promptTokens().
    const stTurns = db.prepare(
      `SELECT message_id, session_id, input_tokens, output_tokens, cache_read_tokens,
              cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
              pricing_snapshot_id
         FROM turns t
         LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
        WHERE t.model = @model
          AND (p.model_tier IS NOT
                 (CASE WHEN t.context_tokens > @over THEN @longTier ELSE @tier END)
               OR (p.snapshot_id LIKE 'list-%' AND p.snapshot_id <>
                 (CASE WHEN t.context_tokens > @over THEN @longId ELSE @id END)))`,
    );
    const stTurn = db.prepare(
      `UPDATE turns SET cost_equiv_u = ?, pricing_snapshot_id = ?, cost_claim = ?
        WHERE message_id = ?`,
    );
    const stSession = db.prepare(
      "UPDATE sessions SET cost_equiv_u = cost_equiv_u + ? WHERE session_id = ?",
    );
    let turns = 0;
    let deltaU = 0;
    for (const model of models) {
      const probe = store.price(model, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheWriteOther: 0,
      });
      if (probe.snapshotId === null) continue;
      const tier = modelTier(model);
      const long = tier === null ? undefined : LONG_PROMPT_TIERS[tier];
      const id = tier === null ? "" : listSnapshotId(tier);
      const params = {
        model,
        tier,
        id,
        over: long?.overTokens ?? Number.MAX_SAFE_INTEGER,
        longTier: long?.tier ?? tier,
        longId: long === undefined ? id : listSnapshotId(long.tier),
      };
      for (const t of stTurns.all(params) as TurnRow[]) {
        const p = store.price(model, {
          inputTokens: t.input_tokens,
          outputTokens: t.output_tokens,
          cacheReadTokens: t.cache_read_tokens,
          cacheWrite5m: t.cache_write_5m,
          cacheWrite1h: t.cache_write_1h,
          cacheWriteOther: t.cache_write_other,
        });
        if (p.snapshotId === t.pricing_snapshot_id) continue;
        const delta = (p.costU ?? 0) - (t.cost_equiv_u ?? 0);
        stTurn.run(p.costU, p.snapshotId, p.claim, t.message_id);
        stSession.run(delta, t.session_id);
        turns += 1;
        deltaU += delta;
      }
    }
    if (turns > 0) bumpEnrichmentEpoch(db);
    return { turns, deltaU };
  })();
}
