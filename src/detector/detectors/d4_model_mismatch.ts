/**
 * src/detector/detectors/d4_model_mismatch.ts — D4 MODEL_MISMATCH.
 *
 * Fires PER-WORKSPACE when a sustained fraction of Opus subagent turns in the
 * trailing week belong to lookup subagents: subagents whose every turn read a large
 * context but produced little output, work Sonnet could serve at lower cost.
 * Main-session turns are out of scope (P3.1 review 1, R2.14).
 *
 * Conservative thresholds (all UNVALIDATED defaults, labeled in every rec):
 *   min_opus_turns:      5     — cold-start guard, over Opus subagent turns
 *   mismatch_fraction:  40%    — share of Opus subagent turns in lookup subagents
 *   min_context_tokens: 50,000 — well above trivial lookups; below Opus-4-8 avg 155K
 *   max_output_tokens:    500  — short answer from large context ≈ lookup style
 *
 * False-positive guard: a subagent counts only when EVERY turn meets both conditions.
 * One turn with large output (an edit, a long report) keeps the whole subagent out,
 * preserving legitimate architecture/reasoning/security use of Opus.
 *
 * Savings model: per-turn cost differential (Opus − Sonnet) on mismatch turns,
 * scaled by mismatch_turns_per_week × reduction_fraction (0.50 UNVALIDATED).
 * Prices are derived from pricing_snapshots, not hard-coded. Falls back to
 * LIST_PRICES when no snapshot is present for a tier.
 *
 * scopeKey: "D4|<workspace_id>" — one rec per workspace per window.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import {
  D4_LOOKUP_TURN_SHARE,
  D4_MISMATCH_MAX_OUTPUT_TOKENS,
  D4_MISMATCH_MIN_CONTEXT_TOKENS,
  D4_MISMATCH_MIN_FRACTION,
  D4_OPUS_MIN_TURNS,
  D4_REALIZABLE_AVOIDANCE_FRACTION,
  D4_REDUCTION_FRACTION,
  type Estimate,
  d4Estimate,
  d4Savings,
} from "../savings.js";
import { blendedTierPrice, tierPriceVector } from "../tier-price.js";
import { turnKey } from "../turn-claim.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/**
 * Routing target tier: current Sonnet (Sonnet 5 / 5.5 share the sonnet-5 tier). The source side
 * is each lookup turn's own Opus tier (PRICE-O55-F1). Prices come from tier-price.ts.
 */
const D4_TARGET_TIER = "sonnet-5";

/** D4's ASSUMED realizable-avoidance-fraction [min, max], read from the quantity contract (F1). */
const D4_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D4?.constants.find(
  (constant) => constant.name === "D4_REALIZABLE_AVOIDANCE_FRACTION",
);
export const D4_FRACTION_RANGE: readonly [number, number] =
  D4_FRACTION_CONSTANT && D4_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D4_FRACTION_CONSTANT.min, D4_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D4

/** scopeKey for one D4 workspace rec — shared by evaluate() and d4ClaimProducer. */
function d4ScopeKey(workspaceId: string): string {
  return `D4|${workspaceId}`;
}

interface WorkspaceRow {
  workspace_id: string;
}

interface OpusTurnCounts {
  total_opus: number;
  opus_agents: number;
  mismatch_count: number;
  lookup_agents: number;
  main_turns: number;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  inp: number;
  outp: number;
  rd: number;
  w5m: number;
  w1h: number;
}

/** U9 r8: a card lists up to this many lookup subagents, costliest at Opus prices first. */
const D4_TOP_AGENTS = 20;

/** Card gate: the modeled saving must be at least this % of the workspace's 7-day spend (U7). */
const D4_MIN_PCT_OF_SPEND = 0.25;

/**
 * P3.1 review 1 (R2.14): the old per-turn predicate held for 57.5% of all turns. D4 flags an
 * agent when at least 80% of its turns read a large context and wrote little: lookup work a
 * cheaper model can do. U7: the main thread is an agent too (key `session:<id>`), but only in
 * sessions with no Edit/Write/MultiEdit/NotebookEdit call, so editing sessions stay out.
 * Parameters: workspace, from, to, min context, max output.
 */
const LOOKUP_SUBAGENTS = `WITH scoped AS (
       SELECT message_id, session_id, model, input_tokens, output_tokens, context_tokens, cache_read_tokens,
              cache_write_5m, cache_write_1h, is_sidechain, agent_id,
              CASE WHEN is_sidechain = 1 THEN COALESCE(agent_id, 'side:' || session_id)
                   ELSE 'session:' || session_id END AS agent_key
         FROM turns
        WHERE workspace_id = ? AND model LIKE '%opus%'
          AND ts >= ? AND ts < ? AND provisional = 0
          AND (is_sidechain = 1 OR NOT EXISTS (
                SELECT 1 FROM tool_events te
                 WHERE te.session_id = turns.session_id
                   AND te.tool_name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')))),
     lookup AS (
       SELECT agent_key FROM scoped
        GROUP BY agent_key
       HAVING SUM(context_tokens >= ? AND output_tokens <= ?) >= ${D4_LOOKUP_TURN_SHARE} * COUNT(*))`;

interface PerModelSnapshot {
  captured_at: string;
  seven_day_util: number;
  five_hour_util: number;
  per_model: Array<{
    model: string;
    utilization: number;
  }>;
}

type CapEvidence =
  | {
      withheld: true;
      withheld_reason: string;
      title: string;
    }
  | {
      cap_attribution: "all_models_or_opus_binds";
    };

/** Read a fresh, well-formed /usage snapshot once; fail open on any problem. */
function getPerModelSnapshot(db: Db, now: Date): PerModelSnapshot | null {
  try {
    const row = db
      .prepare("SELECT value FROM user_config WHERE key = 'per_model_snapshot'")
      .get() as { value: unknown } | undefined;
    if (!row || typeof row.value !== "string") return null;

    const snapshot = JSON.parse(row.value) as unknown;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;

    const candidate = snapshot as Record<string, unknown>;
    if (
      typeof candidate.captured_at !== "string" ||
      typeof candidate.seven_day_util !== "number" ||
      !Number.isFinite(candidate.seven_day_util) ||
      typeof candidate.five_hour_util !== "number" ||
      !Number.isFinite(candidate.five_hour_util) ||
      !Array.isArray(candidate.per_model)
    ) {
      return null;
    }

    const capturedAtMs = Date.parse(candidate.captured_at);
    if (!Number.isFinite(capturedAtMs) || now.getTime() - capturedAtMs > 24 * 60 * 60 * 1000) {
      return null;
    }

    const perModel: PerModelSnapshot["per_model"] = [];
    for (const entry of candidate.per_model) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const model = entry as Record<string, unknown>;
      if (
        typeof model.model !== "string" ||
        typeof model.utilization !== "number" ||
        !Number.isFinite(model.utilization)
      ) {
        return null;
      }
      perModel.push({ model: model.model, utilization: model.utilization });
    }

    return {
      captured_at: candidate.captured_at,
      seven_day_util: candidate.seven_day_util,
      five_hour_util: candidate.five_hour_util,
      per_model: perModel,
    };
  } catch {
    return null;
  }
}

/** One fired workspace's D4 facts, for evaluate() and d4ClaimProducer (P3.L L5). */
export interface D4WorkspaceAnalysis {
  workspaceId: string;
  totalOpus: number;
  mismatchCount: number;
  mismatchFraction: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  opusAgents: number;
  lookupAgents: number;
  /** Lookup turns that ran on the main thread (editing-free sessions only). */
  mainThreadTurns: number;
  /** Most common subagent types among the lookup agents, by turn count (max 3). */
  topAgentTypes: string[];
  topAgents: string[];
  savingsU: number;
  /** The lookup turns at Opus prices and at Sonnet prices (µ$), the gap the estimate shares. */
  lookupOpusCostU: number;
  lookupSonnetCostU: number;
  estimate: Estimate;
  sessionIds: string[];
  capEvidence: CapEvidence | undefined;
}

export interface D4Analysis {
  /** True when the DB has ≥1 Opus turn in the window, before per-workspace gating. */
  sawOpusTurns: boolean;
  /** One entry per workspace that clears every fire gate (opus min, mismatch fraction, savings). */
  workspaces: D4WorkspaceAnalysis[];
  /** [in, out, cacheRead, cw5m, cw1h] sonnet-5 (target tier) price vector evaluate() and d4ClaimProducer both price against. */
  sonnetFull: readonly number[];
}

/**
 * D4's per-workspace mismatch gate and savings, split out of evaluate() (P3.L L5) so
 * d4ClaimProducer shares the exact same quantities evaluate() prices. Must produce
 * byte-identical evaluate() output.
 */
export function d4Analysis(db: Db, ctx: DetectorContext): D4Analysis {
  // Cap attribution is advisory metadata only; any read or parse failure fails open.
  const perModelSnapshot = getPerModelSnapshot(db, ctx.now);

  // All non-global workspaces with at least one turn in the window.
  const workspaceRows = db
    .prepare(
      `SELECT DISTINCT workspace_id
         FROM turns
        WHERE ts >= ? AND ts < ?
          AND model LIKE '%opus%'
          AND provisional = 0`,
    )
    .all(ctx.fromIso, ctx.toIso) as WorkspaceRow[];

  // Target prices resolve once; source prices resolve per workspace from each turn's own tier.
  const sonnetFull = tierPriceVector(db, D4_TARGET_TIER);
  const sonnetInputPrice = sonnetFull[0] ?? 0;
  const sonnetOutputPrice = sonnetFull[1] ?? 0;

  const workspaces: D4WorkspaceAnalysis[] = [];

  for (const { workspace_id } of workspaceRows) {
    const scope = [
      workspace_id,
      ctx.fromIso,
      ctx.toIso,
      D4_MISMATCH_MIN_CONTEXT_TOKENS,
      D4_MISMATCH_MAX_OUTPUT_TOKENS,
    ];
    const mismatch = db
      .prepare(
        `${LOOKUP_SUBAGENTS}
         SELECT COUNT(*) AS mismatch_count,
                COUNT(DISTINCT agent_key) AS lookup_agents,
                COALESCE(SUM(is_sidechain = 0), 0) AS main_turns,
                AVG(input_tokens) AS avg_input_tokens,
                AVG(output_tokens) AS avg_output_tokens,
                COALESCE(SUM(input_tokens), 0) AS inp,
                COALESCE(SUM(output_tokens), 0) AS outp,
                COALESCE(SUM(cache_read_tokens), 0) AS rd,
                COALESCE(SUM(cache_write_5m), 0) AS w5m,
                COALESCE(SUM(cache_write_1h), 0) AS w1h,
                (SELECT COUNT(*) FROM scoped) AS total_opus,
                (SELECT COUNT(DISTINCT agent_key) FROM scoped) AS opus_agents
           FROM scoped
          WHERE agent_key IN (SELECT agent_key FROM lookup)`,
      )
      .get(...scope) as OpusTurnCounts;
    const totalOpus = mismatch.total_opus;

    // Cold-start guard: skip workspaces with too few Opus subagent turns.
    if (totalOpus < D4_OPUS_MIN_TURNS) continue;

    const mismatchCount = mismatch.mismatch_count ?? 0;
    if (mismatchCount === 0) continue;

    const mismatchFraction = mismatchCount / totalOpus;
    if (mismatchFraction < D4_MISMATCH_MIN_FRACTION) continue;

    const avgInputTokens = Math.round(mismatch.avg_input_tokens ?? 0);
    const avgOutputTokens = Math.round(mismatch.avg_output_tokens ?? 0);

    // Source side: each lookup turn's own Opus tier, summed per model then blended by token weight.
    const byModel = db
      .prepare(
        `${LOOKUP_SUBAGENTS}
         SELECT model,
                COALESCE(SUM(input_tokens), 0) AS inp,
                COALESCE(SUM(output_tokens), 0) AS outp,
                COALESCE(SUM(cache_read_tokens), 0) AS rd,
                COALESCE(SUM(cache_write_5m), 0) AS w5m,
                COALESCE(SUM(cache_write_1h), 0) AS w1h
           FROM scoped
          WHERE agent_key IN (SELECT agent_key FROM lookup)
          GROUP BY model`,
      )
      .all(...scope) as Array<{
      model: string;
      inp: number;
      outp: number;
      rd: number;
      w5m: number;
      w1h: number;
    }>;
    const opusPrice = (index: number, column: "inp" | "outp" | "rd" | "w5m" | "w1h"): number =>
      blendedTierPrice(
        db,
        byModel.map((r) => ({ model: r.model, weight: r[column] })),
        index,
      );
    const opusInputPrice = opusPrice(0, "inp");
    const opusOutputPrice = opusPrice(1, "outp");

    const { savingsU } = d4Savings(
      avgInputTokens,
      avgOutputTokens,
      mismatchCount,
      opusInputPrice,
      opusOutputPrice,
      sonnetInputPrice,
      sonnetOutputPrice,
      D4_REDUCTION_FRACTION,
    );

    // Skip zero-savings recs (e.g., prices not loaded). The computed figure is
    // retained as DIAGNOSTIC evidence only (see advisory gate below).
    if (savingsU <= 0) continue;

    // P2 estimate (D4 knob): the lookup subagents' turns, priced over every token
    // component. The headline stays advisory-gated (null).
    const opusFull: [number, number, number, number, number] = [
      opusInputPrice,
      opusOutputPrice,
      opusPrice(2, "rd"),
      opusPrice(3, "w5m"),
      opusPrice(4, "w1h"),
    ];
    // U9 r7: the lookup turns' cost at each model's prices (tokens × $/Mtok = µ$), so the card can
    // show the price gap its estimate takes a share of.
    const lookupTokens = [mismatch.inp, mismatch.outp, mismatch.rd, mismatch.w5m, mismatch.w1h];
    const costAt = (prices: readonly number[]) =>
      Math.round(lookupTokens.reduce((sum, tokens, i) => sum + tokens * (prices[i] ?? 0), 0));
    const lookupOpusCostU = costAt(opusFull);
    const lookupSonnetCostU = costAt(sonnetFull);
    const estimate = d4Estimate({
      totalInputTokens: mismatch.inp,
      totalOutputTokens: mismatch.outp,
      totalCacheReadTokens: mismatch.rd,
      totalCacheWrite5mTokens: mismatch.w5m,
      totalCacheWrite1hTokens: mismatch.w1h,
      opusInputPriceUsdPerMtok: opusInputPrice,
      opusOutputPriceUsdPerMtok: opusOutputPrice,
      opusCacheReadPriceUsdPerMtok: opusFull[2],
      opusCacheWrite5mPriceUsdPerMtok: opusFull[3],
      opusCacheWrite1hPriceUsdPerMtok: opusFull[4],
      sonnetInputPriceUsdPerMtok: sonnetFull[0],
      sonnetOutputPriceUsdPerMtok: sonnetFull[1],
      sonnetCacheReadPriceUsdPerMtok: sonnetFull[2],
      sonnetCacheWrite5mPriceUsdPerMtok: sonnetFull[3],
      sonnetCacheWrite1hPriceUsdPerMtok: sonnetFull[4],
    });
    const spendU = workspaceSpendU(
      db,
      workspace_id,
      Date.parse(ctx.fromIso),
      Date.parse(ctx.toIso),
    );
    const pct = pctOfSpend(estimate.rank_value_u_per_wk, spendU);
    // Unknown spend (no priced turns) cannot be gated; a known spend must clear 0.25%.
    if (pct !== null && pct < D4_MIN_PCT_OF_SPEND) continue;

    const topAgentTypes = (
      db
        .prepare(
          `${LOOKUP_SUBAGENTS}
           SELECT m.agent_type AS agent_type
             FROM scoped s JOIN subagent_meta m ON m.agent_id = s.agent_id
            WHERE s.agent_key IN (SELECT agent_key FROM lookup) AND m.agent_type IS NOT NULL
            GROUP BY m.agent_type
            ORDER BY COUNT(*) DESC, m.agent_type ASC LIMIT 3`,
        )
        .all(...scope) as Array<{ agent_type: string }>
    ).map((row) => row.agent_type);
    // U9 r3: the lookup subagents with the most turns, so the card names the dispatches to change.
    const topAgents = (
      db
        .prepare(
          `${LOOKUP_SUBAGENTS}
           SELECT s.agent_key AS agent, MIN(s.session_id) AS session_id,
                  COALESCE(MAX(m.agent_type), 'unknown') AS agent_type,
                  COUNT(*) AS turns, CAST(ROUND(AVG(s.output_tokens)) AS INTEGER) AS avg_output,
                  CAST(ROUND(SUM(s.input_tokens) * ${opusFull[0]} + SUM(s.output_tokens) * ${opusFull[1]}
                    + SUM(s.cache_read_tokens) * ${opusFull[2]} + SUM(s.cache_write_5m) * ${opusFull[3]}
                    + SUM(s.cache_write_1h) * ${opusFull[4]}) AS INTEGER) AS cost_u
             FROM scoped s LEFT JOIN subagent_meta m ON m.agent_id = s.agent_id
            WHERE s.agent_key IN (SELECT agent_key FROM lookup) AND s.is_sidechain = 1
            GROUP BY s.agent_key
            ORDER BY cost_u DESC, s.agent_key ASC LIMIT ${D4_TOP_AGENTS}`,
        )
        .all(...scope) as Array<{
        agent: string;
        session_id: string;
        agent_type: string;
        turns: number;
        avg_output: number;
        cost_u: number;
      }>
    ).map(
      (row) =>
        `${row.agent}|${row.session_id}|${row.agent_type}|${row.turns}|${row.avg_output}|${row.cost_u}`,
    );
    const sessionIds = (
      db
        .prepare(
          `${LOOKUP_SUBAGENTS}
           SELECT DISTINCT session_id FROM scoped
            WHERE agent_key IN (SELECT agent_key FROM lookup)
            ORDER BY session_id LIMIT 20`,
        )
        .all(...scope) as Array<{ session_id: string }>
    ).map((row) => row.session_id);

    const mismatchPct = Math.round(mismatchFraction * 100);
    const sonnetEntries = perModelSnapshot?.per_model.filter((entry) =>
      entry.model.toLowerCase().includes("sonnet"),
    );
    const bindingSonnet = sonnetEntries?.find(
      (entry) =>
        entry.utilization >= (perModelSnapshot?.seven_day_util ?? Number.POSITIVE_INFINITY),
    );
    const capEvidence: CapEvidence | undefined =
      bindingSonnet && perModelSnapshot
        ? {
            withheld: true,
            withheld_reason: `Sonnet weekly cap is the binding constraint (Sonnet util ${bindingSonnet.utilization} >= all-models ${perModelSnapshot.seven_day_util}) — routing Opus->Sonnet would worsen it`,
            title: `Model change is not recommended: ${mismatchPct}% of Opus turns have large context and little output`,
          }
        : perModelSnapshot && sonnetEntries && sonnetEntries.length > 0
          ? { cap_attribution: "all_models_or_opus_binds" }
          : undefined;

    workspaces.push({
      workspaceId: workspace_id,
      totalOpus,
      mismatchCount,
      mismatchFraction,
      avgInputTokens,
      avgOutputTokens,
      opusAgents: mismatch.opus_agents,
      lookupAgents: mismatch.lookup_agents,
      mainThreadTurns: mismatch.main_turns ?? 0,
      topAgentTypes,
      topAgents,
      savingsU,
      lookupOpusCostU,
      lookupSonnetCostU,
      estimate,
      sessionIds,
      capEvidence,
    });
  }

  return { sawOpusTurns: workspaceRows.length > 0, workspaces, sonnetFull };
}

export const d4Detector: Detector = {
  contractVersion: 1,
  // U9 r3: records the busiest lookup subagents (top_agents). r7: lookup cost at Opus and Sonnet prices. r8: up to 20 agents, full ids, costliest first.
  version: "D4@u9-3",
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "subagent_meta",
    ],
    clock: true,
  },
  id: "D4",
  name: "MODEL_MISMATCH",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const analysis = d4Analysis(db, ctx);

    if (!analysis.sawOpusTurns) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no Opus turns in window",
      };
    }

    const fired: Fired[] = [];
    for (const ws of analysis.workspaces) {
      fired.push({
        scopeKey: d4ScopeKey(ws.workspaceId),
        scope_workspace_id: ws.workspaceId,
        modeled_savings_u_per_wk: null,
        modeled_formula_json: { estimate: ws.estimate },
        payload: {
          version: 1,
          template_id: "D4_MODEL_MISMATCH",
          facts: {
            workspace_id: ws.workspaceId,
            session_ids: ws.sessionIds,
            total_opus_turns_per_week: ws.totalOpus,
            mismatch_turns_per_week: ws.mismatchCount,
            opus_subagent_count: ws.opusAgents,
            lookup_subagent_count: ws.lookupAgents,
            mismatch_fraction: Number(ws.mismatchFraction.toFixed(4)),
            avg_input_tokens: ws.avgInputTokens,
            avg_output_tokens: ws.avgOutputTokens,
            main_thread_turns: ws.mainThreadTurns,
            lookup_opus_cost_u: ws.lookupOpusCostU,
            lookup_sonnet_cost_u: ws.lookupSonnetCostU,
            ...(ws.topAgentTypes.length > 0 ? { top_agent_types: ws.topAgentTypes } : {}),
            ...(ws.topAgents.length > 0 ? { top_agents: ws.topAgents } : {}),
            ...(ws.capEvidence === undefined
              ? {}
              : {
                  cap_attribution:
                    "withheld" in ws.capEvidence ? "sonnet_binds" : "all_models_or_opus_binds",
                }),
          },
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `no workspace met the mismatch threshold (≥${D4_OPUS_MIN_TURNS} Opus turns, ≥${Math.round(D4_MISMATCH_MIN_FRACTION * 100)}% high-context-low-output)`,
      };
    }

    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with sustained Opus mismatch pattern`,
    };
  },
};

interface D4LookupTurnRow {
  message_id: string;
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

/** Ledger component + its `scoped` column + its index into the [in,out,cacheRead,cw5m,cw1h] price vector. */
const D4_COMPONENT_COLUMNS = [
  { component: "input", column: "input_tokens", priceIndex: 0 },
  { component: "output", column: "output_tokens", priceIndex: 1 },
  { component: "cacheRead", column: "cache_read_tokens", priceIndex: 2 },
  { component: "cw5m", column: "cache_write_5m", priceIndex: 3 },
  { component: "cw1h", column: "cache_write_1h", priceIndex: 4 },
] as const;

/**
 * D4 ledger claims: the residual `model:*` repricing. For each fired workspace, every
 * lookup-subagent turn's token components are claimed at the sonnet-5 target price, so the ledger
 * only credits what D2/B1/B3/D8 didn't already remove or reprice for that turn. No module-level
 * cache — d4Analysis is re-run per call, same as d2/d8ClaimProducer.
 */
export const d4ClaimProducer: ClaimProducer = {
  detectorId: "D4",
  *produce(db, ctx) {
    const analysis = d4Analysis(db, ctx);
    for (const ws of analysis.workspaces) {
      const claimRecId = recId("D4", ws.workspaceId, d4ScopeKey(ws.workspaceId));
      const scope = [
        ws.workspaceId,
        ctx.fromIso,
        ctx.toIso,
        D4_MISMATCH_MIN_CONTEXT_TOKENS,
        D4_MISMATCH_MAX_OUTPUT_TOKENS,
      ];
      const turns = db
        .prepare(
          `${LOOKUP_SUBAGENTS}
           SELECT message_id, session_id, input_tokens, output_tokens, cache_read_tokens,
                  cache_write_5m, cache_write_1h
             FROM scoped
            WHERE agent_key IN (SELECT agent_key FROM lookup)`,
        )
        .all(...scope) as D4LookupTurnRow[];
      for (const t of turns) {
        const tk = turnKey(t.session_id, t.message_id);
        for (const { component, column, priceIndex } of D4_COMPONENT_COLUMNS) {
          const tokens = t[column];
          if (tokens <= 0) continue;
          yield {
            detectorId: "D4",
            workspaceId: ws.workspaceId,
            sessionId: t.session_id,
            turnKey: tk,
            component,
            slice: "model:*",
            tokens,
            assumed: true,
            fraction: D4_REALIZABLE_AVOIDANCE_FRACTION,
            fractionRange: D4_FRACTION_RANGE,
            counterfactualPriceU: analysis.sonnetFull[priceIndex] ?? 0,
            recId: claimRecId,
          };
        }
      }
    }
  },
};
