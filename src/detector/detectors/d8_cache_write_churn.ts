/**
 * src/detector/detectors/d8_cache_write_churn.ts — D8 CACHE_WRITE_CHURN (flagship).
 *
 * Fires PER-SESSION when a session repeatedly pays for a full cache re-write on a
 * resume turn — a cache-creation spike after an idle gap that outlived the cache
 * TTL, with little cache_read on that turn (a full-price re-write of the whole
 * window rather than a warm read). These are the dominant reducible cap driver
 * (research 2026-08-25); the meter is cap-weighted, never a raw-token headline.
 *
 * A "churn event" is a resume turn where ALL hold (UNVALIDATED defaults, labeled):
 *   - creation = cache_write_5m + cache_write_1h + cache_write_other ≥ 50k
 *   - idle_gap_min from the previous turn in the session > effective TTL
 *       (> 5 when the 5m tier dominates, > 60 when the 1h tier dominates)
 *   - cache_read < 0.2 × creation on that turn (a re-write, not a warm read)
 *
 * Fires the session rec when churn events ≥ 3/wk OR their creation tokens are
 * ≥ 15% of the session's cap-weighted total (Data Model §2A).
 *
 * TTL-regime facet: when ≥ 80% of churn creation is 5m-tier, annotate regime=5m
 * and extend the lever with the 1h-cache suggestion (no separate rec/id).
 *
 * scopeKey: "D8|<session_id>".
 */

import type { Db } from "../../db/open.js";
import { LIST_PRICES, modelTier } from "../../ingest/pricing.js";
import { capWeightedTokens } from "../../query/cap-weighted.js";
import {
  D8_AVOIDANCE_FRACTION,
  D8_CREATION_SHARE,
  D8_CREATION_SPIKE_TOKENS,
  D8_LOW_READ_RATIO,
  D8_MIN_EVENTS,
  D8_REGIME_5M_SHARE,
  D8_TTL_1H_GAP_MIN,
  D8_TTL_5M_GAP_MIN,
  d8Savings,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

interface TurnRow {
  session_id: string;
  workspace_id: string;
  ts: string;
  model: string;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  unit_prices_json: string | null;
}

interface ChurnEvent {
  ts: string;
  idle_gap_min: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  cache_read_tokens: number;
  creation: number;
  /** µUSD write cost of this creation (cw_other priced at the 5m rate, OQ-03). */
  write_u: number;
  cause_facets: {
    idle_gap: true;
    model_switch: boolean;
    session_reopen: "UNOBSERVABLE";
    prefix_config_change: "UNOBSERVABLE";
    dynamic_content: "UNOBSERVABLE";
  };
}

/** Resolve [cw5m, cw1h] write prices ($/MTok) for a turn, snapshot first, list-price fallback. */
function writePrices(unitPricesJson: string | null, model: string): [number, number] {
  if (unitPricesJson) {
    try {
      const arr = JSON.parse(unitPricesJson) as number[];
      if (typeof arr[3] === "number" && typeof arr[4] === "number") return [arr[3], arr[4]];
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  const lp = tier ? LIST_PRICES[tier] : undefined;
  return lp ? [lp[3], lp[4]] : [0, 0];
}

export const d8Detector: Detector = {
  id: "D8",
  name: "CACHE_WRITE_CHURN",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    // Per-session cap-weighted totals (denominator for the creation-share gate).
    const capRows = capWeightedTokens(db, {
      fromIso: ctx.fromIso,
      toIso: ctx.toIso,
      groupBy: "session_id",
    });
    const capBySession = new Map(capRows.map((r) => [r.group ?? "", r]));

    // All reconciled turns in the window, ordered by session then time (for gaps).
    const turns = db
      .prepare(
        `SELECT t.session_id, t.workspace_id, t.ts, t.model,
                t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
                ps.unit_prices_json AS unit_prices_json
           FROM turns t
           LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
          ORDER BY t.session_id ASC, t.ts ASC`,
      )
      .all(ctx.fromIso, ctx.toIso) as TurnRow[];

    // Group churn events by session (single pass; gap = delta from prev turn in session).
    const eventsBySession = new Map<string, { workspace_id: string; events: ChurnEvent[] }>();
    let prevSession: string | null = null;
    let prevTsMs = 0;
    let prevModel: string | null = null;
    for (const t of turns) {
      const tsMs = new Date(t.ts).getTime();
      const hasPrev = prevSession === t.session_id;
      const creation = t.cache_write_5m + t.cache_write_1h + t.cache_write_other;
      if (hasPrev && creation >= D8_CREATION_SPIKE_TOKENS) {
        const idleGapMin = (tsMs - prevTsMs) / 60_000;
        const fiveMinDominant = t.cache_write_5m > t.cache_write_1h;
        const ttlGap = fiveMinDominant ? D8_TTL_5M_GAP_MIN : D8_TTL_1H_GAP_MIN;
        const lowRead = t.cache_read_tokens < D8_LOW_READ_RATIO * creation;
        if (idleGapMin > ttlGap && lowRead) {
          const [p5m, p1h] = writePrices(t.unit_prices_json, t.model);
          const writeU =
            t.cache_write_5m * p5m + t.cache_write_1h * p1h + t.cache_write_other * p5m;
          const entry = eventsBySession.get(t.session_id) ?? {
            workspace_id: t.workspace_id,
            events: [],
          };
          entry.events.push({
            ts: t.ts,
            idle_gap_min: Number(idleGapMin.toFixed(2)),
            cache_write_5m: t.cache_write_5m,
            cache_write_1h: t.cache_write_1h,
            cache_write_other: t.cache_write_other,
            cache_read_tokens: t.cache_read_tokens,
            creation,
            write_u: writeU,
            cause_facets: {
              idle_gap: true,
              model_switch: modelTier(prevModel) !== modelTier(t.model),
              session_reopen: "UNOBSERVABLE",
              prefix_config_change: "UNOBSERVABLE",
              dynamic_content: "UNOBSERVABLE",
            },
          });
          eventsBySession.set(t.session_id, entry);
        }
      }
      prevSession = t.session_id;
      prevTsMs = tsMs;
      prevModel = t.model;
    }

    const fired: Fired[] = [];
    for (const [sessionId, { workspace_id, events }] of eventsBySession) {
      const totalCreation = events.reduce((s, e) => s + e.creation, 0);
      const cap = capBySession.get(sessionId);
      const sessionCapTotal = cap?.cap_weighted_tokens ?? 0;
      const creationShare = sessionCapTotal > 0 ? totalCreation / sessionCapTotal : 0;

      const meetsCount = events.length >= D8_MIN_EVENTS;
      const meetsShare = creationShare >= D8_CREATION_SHARE;
      if (!meetsCount && !meetsShare) continue;

      // Blended write price ($/MTok) weighted by creation across the churn events.
      const totalWriteU = events.reduce((s, e) => s + e.write_u, 0);
      const blendedWritePrice = totalCreation > 0 ? totalWriteU / totalCreation : 0;
      const { savingsU, formula } = d8Savings(
        totalCreation,
        blendedWritePrice,
        D8_AVOIDANCE_FRACTION,
      );
      if (savingsU <= 0) continue;

      // TTL-regime facet: is this session dominated by 5m-tier creation?
      const fiveMinCreation = events.reduce((s, e) => s + e.cache_write_5m, 0);
      const regime5m = totalCreation > 0 && fiveMinCreation / totalCreation >= D8_REGIME_5M_SHARE;
      const baseLever =
        "Use /clear (or resume-from-summary) before idling past the cache TTL, and batch prefix/CLAUDE.md edits to a session boundary so they don't invalidate the warm cache mid-session.";
      const lever = regime5m
        ? `${baseLever} This session's creation is mostly 5m-tier — enable the 1h cache regime (ENABLE_PROMPT_CACHING_1H) where long pauses are unavoidable.`
        : baseLever;

      fired.push({
        scopeKey: `D8|${sessionId}`,
        category: "CACHE",
        scope_workspace_id: workspace_id,
        lever,
        target_metric: "cache_read_to_creation_ratio",
        modeled_savings_u_per_wk: savingsU,
        modeled_formula: formula,
        evidence: {
          title: `Reduce cache-write churn: ${events.length} re-write${events.length === 1 ? "" : "s"} in session`,
          session_id: sessionId,
          workspace_id,
          churn_event_count: events.length,
          total_churn_creation_tokens: totalCreation,
          session_cap_weighted_tokens: sessionCapTotal,
          creation_share: Number(creationShare.toFixed(4)),
          modeled_savings_basis: "LIST_EQUIV",
          billed_cost_claim: "UNAVAILABLE",
          cache_read_to_creation_ratio: cap?.cache_read_to_creation_ratio ?? null,
          regime: regime5m ? "5m" : "mixed",
          cause_facets: {
            idle_gap: true,
            model_switch: events.some((e) => e.cause_facets.model_switch),
            session_reopen: "UNOBSERVABLE",
            prefix_config_change: "UNOBSERVABLE",
            dynamic_content: "UNOBSERVABLE",
          },
          creation_spike_threshold: D8_CREATION_SPIKE_TOKENS,
          ttl_5m_gap_min_threshold: D8_TTL_5M_GAP_MIN,
          ttl_1h_gap_min_threshold: D8_TTL_1H_GAP_MIN,
          low_read_ratio_threshold: D8_LOW_READ_RATIO,
          min_events_threshold: D8_MIN_EVENTS,
          creation_share_threshold: D8_CREATION_SHARE,
          avoidance_fraction: D8_AVOIDANCE_FRACTION,
          thresholds_unvalidated: true,
          events: events.map((e) => ({
            ts: e.ts,
            idle_gap_min: e.idle_gap_min,
            cache_write_5m: e.cache_write_5m,
            cache_write_1h: e.cache_write_1h,
            cache_write_other: e.cache_write_other,
            cache_read_tokens: e.cache_read_tokens,
            creation_tokens: e.creation,
            cause_facets: e.cause_facets,
          })),
          steps: [
            "Open the session and find the resume turns with a large cache-creation spike after an idle gap",
            "Before stepping away, /clear or resume from a summary so the next turn reads a warm cache instead of re-writing it",
            "Batch CLAUDE.md / prefix edits to a session boundary so they don't invalidate the cache mid-session",
            regime5m
              ? "This session is 5m-tier dominant — enable the 1h cache regime where long pauses are unavoidable"
              : "Where long pauses are unavoidable, prefer the 1h cache regime",
          ],
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no session met the cache-write-churn threshold",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} session(s) with cache-write churn`,
    };
  },
};
