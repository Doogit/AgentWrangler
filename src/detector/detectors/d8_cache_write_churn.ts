/**
 * src/detector/detectors/d8_cache_write_churn.ts — D8 CACHE_WRITE_CHURN (flagship).
 *
 * Fires PER-WORKSPACE when any session in the workspace repeatedly pays for a full
 * cache re-write on a resume turn — a cache-creation spike after an idle gap that
 * outlived the cache TTL, with little cache_read on that turn (a full-price
 * re-write of the whole window rather than a warm read). These are the dominant
 * reducible cap driver (research 2026-08-25); the meter is cap-weighted, never a
 * raw-token headline.
 *
 * A "churn event" is a MAIN-thread resume turn (P3.1 review 3 B6) where ALL hold (UNVALIDATED
 * defaults, labeled):
 *   - creation = cache_write_5m + cache_write_1h + cache_write_other ≥ 50k
 *   - idle_gap_min from the previous turn in the same thread (main vs subagent)
 *       > the thread's TTL (cache-ttl.ts: taken from the thread's prior write tier)
 *   - cache_read < 0.2 × creation on that turn (a re-write, not a warm read)
 *
 * Priced at the net avoided cost per creation token: (write − read) price, since a
 * warm cache would have read those tokens instead of re-writing them.
 *
 * Fires the workspace rec when churn events ≥ 3/wk OR their creation tokens are
 * ≥ 15% of the workspace's contributing sessions' cap-weighted total (Data Model §2A).
 *
 * TTL-regime facet: regime=5m only when ≥ 80% of the (main-thread) churn creation is
 * 5m-tier. That is the one case where the 1h cache helps: main is usually already
 * 1h, and a 1h subagent TTL costs more than it saves (RQ4 2026-09-25).
 *
 * scopeKey: "D8|<workspace_id>".
 */

import type { Db } from "../../db/open.js";
import { modelTier } from "../../ingest/pricing.js";
import { capWeightedTokens } from "../../query/cap-weighted.js";
import { pctOfSpend, spendByWorkspace } from "../../query/spend.js";
import { cacheThreadSteps } from "../cache-ttl.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import {
  D8_AVOIDANCE_FRACTION,
  D8_CREATION_SHARE,
  D8_CREATION_SPIKE_TOKENS,
  D8_EVENT_FLOOR_PCT,
  D8_LOW_READ_RATIO,
  D8_MIN_EVENTS,
  D8_REGIME_5M_SHARE,
  d8Estimate,
  d8Savings,
} from "../savings.js";
import { turnKey } from "../turn-claim.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";
import { basePrefixByWorkspace, cachePrices, firstMainTurns } from "./b3_resume_cache_miss.js";

interface TurnRow {
  message_id: string;
  session_id: string;
  is_sidechain: number;
  agent_id: string | null;
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
  message_id: string;
  ts: string;
  idle_gap_min: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  cache_read_tokens: number;
  creation: number;
  /** µUSD (write − read) cost of this creation (cw_other priced at the 5m rate, OQ-03). */
  write_u: number;
  /** [cacheRead, cw5m, cw1h] µ$/token for this turn (cachePrices()). */
  cache_prices_u: readonly [number, number, number];
  cause_facets: {
    idle_gap: true;
    model_switch: boolean;
    session_reopen: "UNOBSERVABLE";
    prefix_config_change: "UNOBSERVABLE";
    dynamic_content: "UNOBSERVABLE";
  };
}

/** D8's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const D8_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D8?.constants.find(
  (constant) => constant.name === "D8_AVOIDANCE_FRACTION",
);
export const D8_FRACTION_RANGE: readonly [number, number] =
  D8_FRACTION_CONSTANT && D8_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D8_FRACTION_CONSTANT.min, D8_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D8

/** scopeKey for one D8 workspace rec — shared by evaluate() and d8ClaimProducer. */
function d8ScopeKey(workspaceId: string): string {
  return `D8|${workspaceId}`;
}

/** One churn event's ledger-relevant facts, for d8ClaimProducer. */
export interface D8AnalysisEvent {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  creation: number;
  /** [cacheRead, cw5m, cw1h] µ$/token for this turn. */
  cachePricesU: readonly [number, number, number];
}

/**
 * One workspace's D8 analysis: the churn-detection gate plus everything evaluate() and
 * d8ClaimProducer need, computed once so both agree byte-for-byte (P3.L L4).
 */
export interface D8WorkspaceAnalysis {
  workspaceId: string;
  /** Count/share gate only — independent of savingsU > 0. */
  fired: boolean;
  events: D8AnalysisEvent[];
  base: number;
  savingsU: number;
  sortedSessionIds: string[];
  sessionCount: number;
  churnEventCount: number;
  totalCreation: number;
  netCreation: number;
  denominator: number;
  creationShare: number;
  regime5m: boolean;
  cacheReadRatio: number | null;
  longestGapMin: number;
  /** Resumes by idle gap in minutes: [5,15), [15,60), [60,240), 240+. */
  gapHistogram: { m5to15: number; m15to60: number; m60to240: number; m240plus: number };
  /** The biggest resumes (most tokens written again first), for the card's table. */
  topResumes: Array<{
    sessionId: string;
    ts: string;
    gapMin: number;
    written: number;
    net: number;
  }>;
}

/** How many resumes the card's table lists. */
const D8_TOP_RESUMES = 8;

/** Card gate: the modeled saving is at least this % of workspace 7-day spend. */
const D8_CARD_GATE_PCT = 1;

export interface D8Analysis {
  workspaces: D8WorkspaceAnalysis[];
}

/**
 * D8's churn-event detection and per-workspace savings, split out of evaluate() (P3.L L4)
 * so d8ClaimProducer shares the exact same quantities evaluate() prices. Must produce
 * byte-identical evaluate() output.
 */
export function d8Analysis(db: Db, ctx: DetectorContext): D8Analysis {
  // Per-session cap-weighted totals (denominator for the creation-share gate).
  const capRows = capWeightedTokens(db, {
    fromIso: ctx.fromIso,
    toIso: ctx.toIso,
    groupBy: "session_id",
  });
  const capBySession = new Map(capRows.map((r) => [r.group ?? "", r]));
  const spendByWs = new Map(
    spendByWorkspace(db, ctx.fromIso, ctx.toIso).map((s) => [s.workspace_id, s.cost_equiv_u]),
  );

  // Reconciled turns up to the window end, ordered per thread (for gaps and the
  // thread's write tier). Pre-window turns are history only; events are in-window.
  // Same order and history as B1, so the two share one gap/TTL per turn.
  const turns = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.is_sidechain, t.agent_id, t.workspace_id, t.ts, t.model,
              t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
              ps.unit_prices_json AS unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.ts < ? AND t.provisional = 0
        ORDER BY t.session_id ASC, t.is_sidechain ASC, t.agent_id ASC, t.ts ASC, t.message_id ASC`,
    )
    .all(ctx.toIso) as TurnRow[];

  // Group churn events by session (single pass; gap = delta from prev turn in thread).
  const eventsBySession = new Map<string, { workspace_id: string; events: ChurnEvent[] }>();
  for (const { row: t, previous, gapMin, ttlMin } of cacheThreadSteps(turns)) {
    // Subagent resumes are left out: a subagent cannot run /clear, and its gaps are mostly
    // slow tools, not breaks (P3.1 review 3 B6). Their thread still sets B1's TTL.
    if (previous === undefined || t.ts < ctx.fromIso || t.is_sidechain !== 0) continue;
    const creation = t.cache_write_5m + t.cache_write_1h + t.cache_write_other;
    if (creation <= 0) continue;
    const lowRead = t.cache_read_tokens < D8_LOW_READ_RATIO * creation;
    if (gapMin > ttlMin && lowRead) {
      const prices = cachePrices(t.unit_prices_json, t.model);
      const [pRead, p5m, p1h] = prices;
      const writeU =
        t.cache_write_5m * (p5m - pRead) +
        t.cache_write_1h * (p1h - pRead) +
        t.cache_write_other * (p5m - pRead);
      // U7: the event floor is a share of the workspace's 7-day spend (write minus read), not a
      // fixed 50K tokens; with no priced spend to compare against, the token floor still applies.
      const wsSpendU = spendByWs.get(t.workspace_id) ?? 0;
      const meetsFloor =
        wsSpendU > 0
          ? writeU >= (wsSpendU * D8_EVENT_FLOOR_PCT) / 100
          : creation >= D8_CREATION_SPIKE_TOKENS;
      if (!meetsFloor) continue;
      const entry = eventsBySession.get(t.session_id) ?? {
        workspace_id: t.workspace_id,
        events: [],
      };
      entry.events.push({
        message_id: t.message_id,
        ts: t.ts,
        idle_gap_min: Number(gapMin.toFixed(2)),
        cache_write_5m: t.cache_write_5m,
        cache_write_1h: t.cache_write_1h,
        cache_write_other: t.cache_write_other,
        cache_read_tokens: t.cache_read_tokens,
        creation,
        write_u: writeU,
        cache_prices_u: prices,
        cause_facets: {
          idle_gap: true,
          model_switch: modelTier(previous.model) !== modelTier(t.model),
          session_reopen: "UNOBSERVABLE",
          prefix_config_change: "UNOBSERVABLE",
          dynamic_content: "UNOBSERVABLE",
        },
      });
      eventsBySession.set(t.session_id, entry);
    }
  }

  // Group churn events by workspace, carrying session id for sorting.
  type WithSid = ChurnEvent & { _sid: string };
  const byWorkspace = new Map<string, { sessionIds: string[]; events: WithSid[] }>();
  for (const [sessionId, { workspace_id, events }] of eventsBySession) {
    const ws = byWorkspace.get(workspace_id) ?? { sessionIds: [], events: [] };
    ws.sessionIds.push(sessionId);
    for (const e of events) ws.events.push({ ...e, _sid: sessionId });
    byWorkspace.set(workspace_id, ws);
  }

  const basePrefix = basePrefixByWorkspace(firstMainTurns(db, ctx.fromIso, ctx.toIso), ctx.fromIso);
  const workspaces: D8WorkspaceAnalysis[] = [];
  for (const [workspaceId, { sessionIds, events: rawEvents }] of byWorkspace) {
    // S6 netting (P3.1-T9): a fresh start after the break writes the base prompt anyway, so each
    // resume's avoidable part is what it wrote beyond that.
    const base = basePrefix.get(workspaceId) ?? 0;
    const netOf = (e: ChurnEvent) => Math.max(0, e.creation - base);
    // Sessions by what they wrote again, most first, so a card lists its biggest (review 3 B8).
    const writtenBy = new Map<string, number>();
    for (const e of rawEvents) writtenBy.set(e._sid, (writtenBy.get(e._sid) ?? 0) + e.creation);
    const sortedSessionIds = [...sessionIds].sort(
      (a, b) => (writtenBy.get(b) ?? 0) - (writtenBy.get(a) ?? 0) || (a < b ? -1 : 1),
    );
    const sessionCount = sortedSessionIds.length;

    // Sort events by ts ascending then session id for determinism.
    const events = [...rawEvents].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a._sid < b._sid ? -1 : a._sid > b._sid ? 1 : 0,
    );
    const churnEventCount = events.length;

    const totalCreation = events.reduce((s, e) => s + e.creation, 0);
    const netCreation = events.reduce((s, e) => s + netOf(e), 0);
    const netWriteU = events.reduce(
      (s, e) => s + (e.creation > 0 ? (e.write_u * netOf(e)) / e.creation : 0),
      0,
    );
    const blendedWritePrice = netCreation > 0 ? netWriteU / netCreation : 0;

    // Denominator: cap_weighted_tokens summed over sessions that contributed ≥1 churn event.
    const denominator = sessionIds.reduce(
      (s, sid) => s + (capBySession.get(sid)?.cap_weighted_tokens ?? 0),
      0,
    );
    const creationShare = denominator > 0 ? totalCreation / denominator : 0;

    const meetsCount = churnEventCount >= D8_MIN_EVENTS;
    const meetsShare = creationShare >= D8_CREATION_SHARE;
    // Blended net (write − read) price ($/MTok) weighted by creation across the churn events.
    const { savingsU } = d8Savings(netCreation, blendedWritePrice, D8_AVOIDANCE_FRACTION);

    // U7: card gate as a share of the workspace's 7-day spend; unknown spend cannot be gated.
    const spendPct = pctOfSpend(savingsU, spendByWs.get(workspaceId));
    const fired = (meetsCount || meetsShare) && !(spendPct !== null && spendPct < D8_CARD_GATE_PCT);

    // Idle-gap histogram of the resumes: how long the breaks were, in minutes.
    const gapHistogram = { m5to15: 0, m15to60: 0, m60to240: 0, m240plus: 0 };
    for (const e of events) {
      if (e.idle_gap_min < 15) gapHistogram.m5to15++;
      else if (e.idle_gap_min < 60) gapHistogram.m15to60++;
      else if (e.idle_gap_min < 240) gapHistogram.m60to240++;
      else gapHistogram.m240plus++;
    }

    // TTL-regime facet: is the (main-thread) churn dominated by 5m-tier creation?
    const fiveMinCreation = events.reduce((s, e) => s + e.cache_write_5m, 0);
    const regime5m = totalCreation > 0 && fiveMinCreation / totalCreation >= D8_REGIME_5M_SHARE;

    // cache_read_to_creation_ratio is only meaningful for a single session.
    const cacheReadRatio =
      sessionCount === 1
        ? (capBySession.get(sortedSessionIds[0] ?? "")?.cache_read_to_creation_ratio ?? null)
        : null;

    const longestGapMin =
      events.length > 0 ? Math.round(Math.max(...events.map((e) => e.idle_gap_min))) : 0;

    workspaces.push({
      workspaceId,
      fired,
      events: events.map((e) => ({
        sessionId: e._sid,
        messageId: e.message_id,
        workspaceId,
        cacheWrite5m: e.cache_write_5m,
        cacheWrite1h: e.cache_write_1h,
        cacheWriteOther: e.cache_write_other,
        creation: e.creation,
        cachePricesU: e.cache_prices_u,
      })),
      base,
      savingsU,
      sortedSessionIds,
      sessionCount,
      churnEventCount,
      totalCreation,
      netCreation,
      denominator,
      creationShare,
      regime5m,
      cacheReadRatio,
      longestGapMin,
      gapHistogram,
      topResumes: [...events]
        .sort((a, b) => b.creation - a.creation || (a.ts < b.ts ? -1 : 1))
        .slice(0, D8_TOP_RESUMES)
        .map((e) => ({
          sessionId: e._sid,
          ts: e.ts,
          gapMin: Math.round(e.idle_gap_min),
          written: e.creation,
          net: netOf(e),
        })),
    });
  }
  return { workspaces };
}

export const d8Detector: Detector = {
  contractVersion: 1,
  // U9 r5: records the 5m/1h tier mix of the resume turns' cache writes.
  version: "D8@u9-2",
  scope: "session",
  inputs: { tables: ["turns", "sessions", "workspaces", "user_config", "pricing_snapshots"] },
  id: "D8",
  name: "CACHE_WRITE_CHURN",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const analysis = d8Analysis(db, ctx);
    const fired: Fired[] = [];
    for (const ws of analysis.workspaces) {
      if (!ws.fired || ws.savingsU <= 0) continue;
      fired.push({
        scopeKey: d8ScopeKey(ws.workspaceId),
        scope_workspace_id: ws.workspaceId,
        modeled_savings_u_per_wk: ws.savingsU,
        // Basis P: rank value passes the stored modeled figure through.
        modeled_formula_json: {
          estimate: { ...d8Estimate({}), rank_value_u_per_wk: ws.savingsU },
        },
        payload: {
          version: 1,
          template_id: "D8_CACHE_WRITE_CHURN",
          facts: {
            session_ids: ws.sortedSessionIds,
            session_count: ws.sessionCount,
            workspace_id: ws.workspaceId,
            churn_event_count: ws.churnEventCount,
            total_churn_creation_tokens: ws.totalCreation,
            session_cap_weighted_tokens: ws.denominator,
            creation_share: Number(ws.creationShare.toFixed(4)),
            cache_read_to_creation_ratio: ws.cacheReadRatio,
            regime: ws.regime5m ? "5m" : "mixed",
            // U9 r5: the cache tier these resume turns wrote to (the lifetime this user has).
            churn_write_5m_tokens: ws.events.reduce((s, e) => s + e.cacheWrite5m, 0),
            churn_write_1h_tokens: ws.events.reduce((s, e) => s + e.cacheWrite1h, 0),
            base_prefix_tokens: ws.base,
            net_churn_creation_tokens: ws.netCreation,
            longest_gap_min: ws.longestGapMin,
            gap_5_15_min_count: ws.gapHistogram.m5to15,
            gap_15_60_min_count: ws.gapHistogram.m15to60,
            gap_60_240_min_count: ws.gapHistogram.m60to240,
            gap_240_plus_min_count: ws.gapHistogram.m240plus,
            top_resumes: ws.topResumes.map(
              (r) => `${r.sessionId}|${r.ts}|${r.gapMin}|${r.written}|${r.net}`,
            ),
          },
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no workspace met the cache-write-churn threshold",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with cache-write churn`,
    };
  },
};

/**
 * D8 ledger claims: for each fired workspace with savingsU > 0, each churn event's net
 * (creation − base) split to the cw5m/cw1h cells (the cw_other share has no ledger cell).
 * Priced as a repricing (counterfactual = the turn's own cacheRead price), never pre-scaled
 * by fraction — the ledger applies it.
 */
export const d8ClaimProducer: ClaimProducer = {
  detectorId: "D8",
  *produce(db, ctx) {
    const analysis = d8Analysis(db, ctx);
    for (const ws of analysis.workspaces) {
      if (!ws.fired || ws.savingsU <= 0) continue;
      const claimRecId = recId("D8", ws.workspaceId, d8ScopeKey(ws.workspaceId));
      for (const e of ws.events) {
        const net = Math.max(0, e.creation - ws.base);
        if (!(e.creation > 0 && net > 0)) continue;
        const raw5 = Math.round((net * e.cacheWrite5m) / e.creation);
        const raw1h = Math.round((net * e.cacheWrite1h) / e.creation);
        const tk = turnKey(e.sessionId, e.messageId);
        const readPriceU = e.cachePricesU[0];
        if (raw5 > 0) {
          yield {
            detectorId: "D8",
            workspaceId: e.workspaceId,
            sessionId: e.sessionId,
            turnKey: tk,
            component: "cw5m" as const,
            slice: `cache:${e.messageId}`,
            tokens: raw5,
            fraction: D8_AVOIDANCE_FRACTION,
            fractionRange: D8_FRACTION_RANGE,
            assumed: true,
            counterfactualPriceU: readPriceU,
            recId: claimRecId,
          };
        }
        if (raw1h > 0) {
          yield {
            detectorId: "D8",
            workspaceId: e.workspaceId,
            sessionId: e.sessionId,
            turnKey: tk,
            component: "cw1h" as const,
            slice: `cache:${e.messageId}`,
            tokens: raw1h,
            fraction: D8_AVOIDANCE_FRACTION,
            fractionRange: D8_FRACTION_RANGE,
            assumed: true,
            counterfactualPriceU: readPriceU,
            recId: claimRecId,
          };
        }
      }
    }
  },
};
