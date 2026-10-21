/**
 * src/detector/detectors/d2_session_long_full_context.ts — D2 SESSION_LONG_FULL_CONTEXT.
 *
 * Fires (global scope) when >= N qualifying long-context sessions appear in the
 * trailing week. Qualifying = more than 150 reconciled main-thread turns (subagent turns are
 * their own context, review 6 R6-02) in the same
 * evaluation window AND AVG(context_tokens) > 180_000 over those same rows.
 *
 * Savings: cache-read spend the qualifying sessions generate × the share of their
 * context a split every D2_CALLS_PER_SPLIT calls would stop re-reading (derived from
 * the sessions' own growth, review 3 B5; the 0.33 default only when context is absent).
 * The cache-read price is derived PER-MODEL from each turn's own pricing snapshot
 * (unit_prices_json[2]), never a hard-coded scalar (§1 D2 (b)).
 */

import type { Db } from "../../db/open.js";
import { LIST_PRICES, modelTier } from "../../ingest/pricing.js";
import { capWeightedTokens, resolveCapReadCoeff } from "../../query/cap-weighted.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import {
  D2_AVG_CONTEXT_THRESHOLD,
  D2_CALLS_PER_SPLIT,
  D2_MIN_QUALIFYING_SESSIONS,
  D2_REDUCTION_FRACTION,
  D2_SUMMARY_TOKENS,
  D2_TURN_COUNT_THRESHOLD,
  d2Estimate,
  d2Savings,
} from "../savings.js";
import { turnKey } from "../turn-claim.js";
import type {
  Detector,
  DetectorContext,
  DetectorOutcome,
  Fired,
  ModeledFormula,
} from "../types.js";
import { basePrefixByWorkspace, firstMainTurns } from "./b3_resume_cache_miss.js";

/** Card gate: the net saving must be at least this % of the week's global spend (U7). */
const D2_MIN_PCT_OF_SPEND = 1;

interface QualifyingSession {
  session_id: string;
  avg_context: number;
  qualifying_turns: number;
}

interface CacheReadRow {
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  model: string;
  unit_prices_json: string | null;
}

/** Price at index i of unit_prices_json ([in, out, cacheRead, cw5m, cw1h]), list price fallback. */
function unitPrice(unitPricesJson: string | null, model: string, index: number): number {
  if (unitPricesJson !== null) {
    try {
      const price = (JSON.parse(unitPricesJson) as number[])[index];
      if (typeof price === "number") return price;
    } catch {
      // fall through to list price
    }
  }
  const tier = modelTier(model);
  return (tier ? LIST_PRICES[tier]?.[index] : undefined) ?? 0;
}

/** One qualifying-session turn, split-avoidance already attributed (review 3 B5). */
export interface D2AnalysisRow {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  context: number;
  cacheRead: number;
  avoided: number;
  /** µ$/token cache-read price, same basis as the detector's cache-read spend. */
  readPrice: number;
}

export interface D2Analysis {
  /** False when fewer than D2_MIN_QUALIFYING_SESSIONS sessions qualify — nothing else fired. */
  fired: boolean;
  /** True when the net saving is under 1% of the week's spend: nothing is shown or claimed. */
  belowSpendGate: boolean;
  qualifying: QualifyingSession[];
  sessionIds: string[];
  qualifyingTurnCount: number;
  rawContextAverageTokensPerTurn: number;
  capReadCoefficient: number;
  capWeightedBurnTokensPerWeek: number;
  cacheReadTokensPerWeek: number;
  cacheReadSpendU: number;
  reductionFraction: number;
  splitCount: number;
  /** Commit events in the qualifying sessions, and the splits placed on one of them. */
  commitBoundaryCount: number;
  commitAnchoredSplits: number;
  /** Git commands run in the qualifying sessions, whether or not a commit sha was harvested. */
  gitCommandCount: number;
  /** `<session>|<calls>|<avg context>|<peak context>|<call where context first passed the threshold>`, most calls first. */
  sessionStats: string[];
  basePrefixTokens: number;
  rebuildU: number;
  savingsU: number;
  grossU: number;
  formula: ModeledFormula;
  scopeKey: string;
  rows: D2AnalysisRow[];
  /** [lowest, highest] net saving across the ASSUMED constants' bounds; only when asked for. */
  savingsRangeU?: [number, number];
}

/**
 * D2's qualifying-session analysis, split out of evaluate() (P3.L L2) so d2ClaimProducer
 * shares the exact same quantity evaluate() prices — including the per-turn split-avoidance
 * attribution needed for ledger claims. Must produce byte-identical evaluate() output.
 */
export function d2Analysis(db: Db, ctx: DetectorContext, withRange = false): D2Analysis {
  const qualifying = db
    .prepare(
      `SELECT t.session_id AS session_id,
              AVG(t.context_tokens) AS avg_context,
              COUNT(*) AS qualifying_turns
         FROM turns t
        WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0 AND t.is_sidechain = 0
        GROUP BY t.session_id
       HAVING COUNT(*) > ? AND AVG(t.context_tokens) > ?
        ORDER BY t.session_id ASC`,
    )
    .all(
      ctx.fromIso,
      ctx.toIso,
      D2_TURN_COUNT_THRESHOLD,
      D2_AVG_CONTEXT_THRESHOLD,
    ) as QualifyingSession[];

  if (qualifying.length < D2_MIN_QUALIFYING_SESSIONS) {
    const { savingsU, grossU, formula } = d2Savings(0, 0, D2_REDUCTION_FRACTION, 0);
    return {
      fired: false,
      belowSpendGate: false,
      qualifying,
      sessionIds: [],
      qualifyingTurnCount: 0,
      rawContextAverageTokensPerTurn: 0,
      capReadCoefficient: 0,
      capWeightedBurnTokensPerWeek: 0,
      cacheReadTokensPerWeek: 0,
      cacheReadSpendU: 0,
      reductionFraction: D2_REDUCTION_FRACTION,
      splitCount: 0,
      commitBoundaryCount: 0,
      commitAnchoredSplits: 0,
      gitCommandCount: 0,
      sessionStats: [],
      basePrefixTokens: 0,
      rebuildU: 0,
      savingsU,
      grossU,
      formula,
      scopeKey: `D2|global|${formula.model}`,
      rows: [],
    };
  }

  const sessionIds = qualifying.map((q) => q.session_id).sort();
  const placeholders = sessionIds.map(() => "?").join(",");
  const qualifyingTurnCount = qualifying.reduce(
    (sum, session) => sum + session.qualifying_turns,
    0,
  );
  const rawContextAverageTokensPerTurn =
    qualifyingTurnCount > 0
      ? qualifying.reduce(
          (sum, session) => sum + session.avg_context * session.qualifying_turns,
          0,
        ) / qualifyingTurnCount
      : 0;

  // Cap-weighted burn is a separate annotation on the raw-context rec. It
  // never participates in the qualifying-session gate above.
  const capReadCoefficient = resolveCapReadCoeff(db);
  const capBySession = new Map(
    capWeightedTokens(db, {
      fromIso: ctx.fromIso,
      toIso: ctx.toIso,
      groupBy: "session_id",
      coeff: capReadCoefficient,
      mainOnly: true,
    }).map((row) => [row.group, row.cap_weighted_tokens]),
  );
  const capWeightedBurnTokensPerWeek = sessionIds.reduce(
    (sum, sessionId) => sum + (capBySession.get(sessionId) ?? 0),
    0,
  );

  // Cache-read spend over the qualifying sessions' turns in the window, priced
  // per-model from each turn's own pricing snapshot.
  const rows = db
    .prepare(
      `SELECT t.cache_read_tokens AS cache_read_tokens, t.cache_write_5m, t.cache_write_1h,
              t.cache_write_other, t.model, ps.unit_prices_json AS unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.session_id IN (${placeholders})
          AND t.ts >= ? AND t.ts < ? AND t.provisional = 0 AND t.is_sidechain = 0`,
    )
    .all(...sessionIds, ctx.fromIso, ctx.toIso) as CacheReadRow[];

  let cacheReadTokensPerWeek = 0;
  let cacheReadSpendU = 0;
  let writeTokens = 0;
  let writeSpendU = 0;
  for (const r of rows) {
    cacheReadTokensPerWeek += r.cache_read_tokens;
    // Same basis as D7's read price: the turn's snapshot, else its model's list price (review 4).
    cacheReadSpendU += r.cache_read_tokens * unitPrice(r.unit_prices_json, r.model, 2);
    const fiveMinute = r.cache_write_5m + r.cache_write_other;
    writeTokens += fiveMinute + r.cache_write_1h;
    writeSpendU +=
      fiveMinute * unitPrice(r.unit_prices_json, r.model, 3) +
      r.cache_write_1h * unitPrice(r.unit_prices_json, r.model, 4);
  }

  const basePrefixTokens =
    basePrefixByWorkspace(
      firstMainTurns(db, ctx.fromIso, ctx.toIso).map((turn) => ({ ...turn, workspace_id: "" })),
      ctx.fromIso,
    ).get("") ?? 0;

  // Review 3 B5: the reduction is derived, not assumed. A session's splits divide it into equal
  // parts; after a split, a call re-reads the base, the summary and what it added since, so it
  // avoids the context at the split beyond base + summary (never more than it read).
  const contextRows = db
    .prepare(
      `SELECT t.session_id, t.message_id, t.workspace_id, t.ts, t.context_tokens, t.cache_read_tokens,
              t.model, ps.unit_prices_json
         FROM turns t
         LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
        WHERE t.session_id IN (${placeholders}) AND t.ts >= ? AND t.ts < ? AND t.provisional = 0
          AND t.is_sidechain = 0
        ORDER BY t.session_id, t.ts, t.message_id`,
    )
    .all(...sessionIds, ctx.fromIso, ctx.toIso) as Array<{
    session_id: string;
    message_id: string;
    workspace_id: string;
    ts: string;
    context_tokens: number;
    cache_read_tokens: number;
    model: string;
    unit_prices_json: string | null;
  }>;
  const bySession = new Map<string, typeof contextRows>();
  for (const row of contextRows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }
  const writePrice =
    writeTokens > 0
      ? writeSpendU / writeTokens
      : unitPrice(rows[0]?.unit_prices_json ?? null, rows[0]?.model ?? "", 3);

  // U7: commit boundaries. A split lands best right after a commit, so each evenly spaced split
  // point moves to the nearest commit boundary within a quarter of its part (when there is one).
  const commitTs = new Map<string, string[]>();
  for (const e of db
    .prepare(
      `SELECT session_id, ts FROM tool_events
        WHERE session_id IN (${placeholders}) AND commit_sha IS NOT NULL AND ts >= ? AND ts < ?
        ORDER BY ts`,
    )
    .all(...sessionIds, ctx.fromIso, ctx.toIso) as Array<{ session_id: string; ts: string }>) {
    const list = commitTs.get(e.session_id) ?? [];
    list.push(e.ts);
    commitTs.set(e.session_id, list);
  }
  const commitBoundaryCount = [...commitTs.values()].reduce((sum, list) => sum + list.length, 0);
  // U9 r4: git commands that ran, so a card with no harvested sha can say what was and was not measured.
  const gitCommandCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tool_events
          WHERE session_id IN (${placeholders}) AND bash_command_family = 'BASH_GIT' AND ts >= ? AND ts < ?`,
      )
      .get(...sessionIds, ctx.fromIso, ctx.toIso) as { n: number }
  ).n;

  // U9 r6: what is measured per session (no task boundaries are): its model calls, average and peak
  // context, and the call on which context first passed the qualifying average threshold.
  const sessionStats = [...bySession.entries()]
    .map(([sessionId, sessionRows]) => {
      const contexts = sessionRows.map((row) => row.context_tokens);
      const firstOver = contexts.findIndex((context) => context > D2_AVG_CONTEXT_THRESHOLD);
      return {
        sessionId,
        calls: sessionRows.length,
        avg: Math.round(contexts.reduce((sum, c) => sum + c, 0) / contexts.length),
        peak: Math.max(...contexts),
        firstOver: firstOver < 0 ? 0 : firstOver + 1,
      };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5)
    .map((s) => `${s.sessionId}|${s.calls}|${s.avg}|${s.peak}|${s.firstOver}`);

  /** Row indices where a new part starts: evenly spaced, nudged onto commit boundaries. */
  const splitStarts = (
    sessionRows: typeof contextRows,
    parts: number,
  ): { starts: number[]; anchored: number } => {
    const n = sessionRows.length;
    const boundaries = new Set<number>();
    for (const c of commitTs.get(sessionRows[0]?.session_id ?? "") ?? []) {
      const j = sessionRows.findIndex((r) => r.ts > c);
      if (j > 0) boundaries.add(j);
    }
    const reach = Math.floor(n / parts / 4);
    const starts: number[] = [];
    let anchored = 0;
    for (let k = 1; k < parts; k++) {
      const even = Math.ceil((k * n) / parts);
      let pick = even;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const j of boundaries) {
        const gap = Math.abs(j - even);
        if (gap <= reach && gap < bestGap && j > (starts[k - 2] ?? 0) && j < n) {
          pick = j;
          bestGap = gap;
        }
      }
      if (bestGap !== Number.POSITIVE_INFINITY) anchored++;
      starts.push(pick);
    }
    return { starts, anchored };
  };

  /** The net saving at one split cadence and summary size (D2's two ASSUMED constants). */
  const net = (callsPerSplit: number, summaryTokens: number) => {
    // S6 netting (P3.1-T9): each suggested split writes a fresh start's base prompt plus a short
    // summary again, priced at these sessions' own blended cache-write price. One split per
    // callsPerSplit calls, only where calls follow it. U7: the cadence is capped so a session
    // gets at least one split; a cadence as long as the session no longer rules every split out.
    const cadenceFor = (turns: number) => Math.min(callsPerSplit, Math.max(1, turns - 1));
    const splitCount = qualifying.reduce(
      (sum, session) =>
        sum + Math.floor((session.qualifying_turns - 1) / cadenceFor(session.qualifying_turns)),
      0,
    );
    let anchoredSplits = 0;
    let contextTotal = 0;
    let avoided = 0;
    const turnRows: D2AnalysisRow[] = [];
    for (const sessionRows of bySession.values()) {
      const parts = Math.floor((sessionRows.length - 1) / cadenceFor(sessionRows.length)) + 1;
      const { starts, anchored } = splitStarts(sessionRows, parts);
      anchoredSplits += anchored;
      let atSplit = 0;
      let part = 0;
      sessionRows.forEach((row, i) => {
        if (part < starts.length && i >= (starts[part] as number)) {
          part += 1;
          atSplit = sessionRows[i - 1]?.context_tokens ?? 0;
        }
        contextTotal += row.context_tokens;
        const rowAvoided =
          part > 0
            ? Math.min(row.context_tokens, Math.max(0, atSplit - basePrefixTokens - summaryTokens))
            : 0;
        avoided += rowAvoided;
        turnRows.push({
          sessionId: row.session_id,
          messageId: row.message_id,
          workspaceId: row.workspace_id,
          context: row.context_tokens,
          cacheRead: row.cache_read_tokens,
          avoided: rowAvoided,
          readPrice: unitPrice(row.unit_prices_json, row.model, 2),
        });
      });
    }
    const reductionFraction =
      contextTotal > 0 ? Number((avoided / contextTotal).toFixed(4)) : D2_REDUCTION_FRACTION;
    const rebuildU = splitCount * (basePrefixTokens + summaryTokens) * writePrice;
    return {
      splitCount,
      anchoredSplits,
      turnRows,
      reductionFraction,
      rebuildU,
      ...d2Savings(cacheReadTokensPerWeek, cacheReadSpendU, reductionFraction, rebuildU),
    };
  };

  const {
    splitCount,
    anchoredSplits,
    turnRows,
    reductionFraction,
    rebuildU,
    savingsU,
    grossU,
    formula,
  } = net(D2_CALLS_PER_SPLIT, D2_SUMMARY_TOKENS);
  // F3 (2026-10-04): the saving is not linear in either constant, so its range is the model
  // re-run at each pair of their declared bounds (and the value used), lowest to highest.
  let savingsRangeU: [number, number] | undefined;
  if (withRange) {
    const bounds = (name: string, value: number): number[] => {
      const constant = DETECTOR_CONTRACTS.D2?.constants.find((c) => c.name === name);
      return constant?.status === "ASSUMED" ? [constant.min, value, constant.max] : [value];
    };
    const values: number[] = [];
    for (const calls of bounds("D2_CALLS_PER_SPLIT", D2_CALLS_PER_SPLIT))
      for (const summary of bounds("D2_SUMMARY_TOKENS", D2_SUMMARY_TOKENS))
        values.push(net(calls, summary).savingsU);
    savingsRangeU = [Math.min(...values), Math.max(...values)];
  }

  // U7: card gate as a share of the week's spend, not a fixed $ amount. Unknown spend (no priced
  // turns) cannot be gated.
  const spendPct = pctOfSpend(
    savingsU,
    workspaceSpendU(db, null, Date.parse(ctx.fromIso), Date.parse(ctx.toIso)),
  );

  return {
    fired: true,
    belowSpendGate: spendPct !== null && spendPct < D2_MIN_PCT_OF_SPEND,
    qualifying,
    sessionIds,
    qualifyingTurnCount,
    rawContextAverageTokensPerTurn,
    capReadCoefficient,
    capWeightedBurnTokensPerWeek,
    cacheReadTokensPerWeek,
    cacheReadSpendU,
    reductionFraction,
    splitCount,
    commitBoundaryCount,
    commitAnchoredSplits: anchoredSplits,
    gitCommandCount,
    sessionStats,
    basePrefixTokens,
    rebuildU,
    savingsU,
    grossU,
    formula,
    scopeKey: `D2|global|${formula.model}`,
    rows: turnRows,
    ...(savingsRangeU === undefined ? {} : { savingsRangeU }),
  };
}

/**
 * D2 ledger claims: each turn's avoided context tokens, scaled by one fraction so Σ claim
 * value == the card's net savings (`savingsU`) before overlaps. The fraction folds in both the
 * context→cache-read conversion the detector's aggregate formula makes and the rebuild netting;
 * weighting by each turn's own read price keeps it exact across mixed models.
 */
export const d2ClaimProducer: ClaimProducer = {
  detectorId: "D2",
  *produce(db, ctx) {
    const analysis = d2Analysis(db, ctx);
    if (!analysis.fired || analysis.belowSpendGate || analysis.savingsU <= 0) return;

    let avoidedValueU = 0;
    for (const row of analysis.rows) avoidedValueU += row.avoided * row.readPrice;
    if (avoidedValueU <= 0) return;
    const fraction = Math.min(1, analysis.savingsU / avoidedValueU);

    const claimRecId = recId("D2", null, analysis.scopeKey);
    for (const row of analysis.rows) {
      if (row.avoided <= 0) continue;
      yield {
        detectorId: "D2",
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        turnKey: turnKey(row.sessionId, row.messageId),
        component: "cacheRead" as const,
        slice: "history:*",
        tokens: row.avoided,
        fraction,
        // Not `assumed`: the fraction above is measured from this window's own sessions;
        // D2's ASSUMED parameters (split cadence, summary size) live in the raw avoided-token
        // quantity, not in this ratio.
        recId: claimRecId,
      };
    }
  },
};

export const d2Detector: Detector = {
  contractVersion: 1,
  // U9 r6: records session_stats (calls, context, first call over threshold).
  // O-3: commit_sha now links short-form and -q commits (commit boundaries changed).
  version: "D2@o3-1",
  scope: "session",
  inputs: {
    tables: ["turns", "sessions", "workspaces", "user_config", "pricing_snapshots", "tool_events"],
  },
  id: "D2",
  name: "SESSION_LONG_FULL_CONTEXT",
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const analysis = d2Analysis(db, ctx, true);
    if (!analysis.fired) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${analysis.qualifying.length} qualifying long-context session(s) in window (trigger ≥ ${D2_MIN_QUALIFYING_SESSIONS})`,
      };
    }

    if (analysis.belowSpendGate) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${analysis.qualifying.length} qualifying long-context session(s), but the modeled saving is under ${D2_MIN_PCT_OF_SPEND}% of the week's spend`,
      };
    }

    const n = analysis.qualifying.length;
    const fired: Fired = {
      scopeKey: analysis.scopeKey,
      scope_workspace_id: null,
      modeled_savings_u_per_wk: analysis.savingsU,
      // Basis P: rank value passes the stored modeled figure through.
      modeled_formula_json: {
        estimate: { ...d2Estimate({}), rank_value_u_per_wk: analysis.savingsU },
      },
      payload: {
        version: 1,
        template_id: "D2_LONG_FULL_CONTEXT",
        facts: {
          qualifying_session_count: n,
          qualifying_turn_count: analysis.qualifyingTurnCount,
          session_ids: analysis.sessionIds,
          raw_context_average_tokens_per_turn: Number(
            analysis.rawContextAverageTokensPerTurn.toFixed(2),
          ),
          cap_weighted_burn_tokens_per_week: analysis.capWeightedBurnTokensPerWeek,
          cap_read_coefficient: analysis.capReadCoefficient,
          cache_read_tokens_per_week: analysis.cacheReadTokensPerWeek,
          cache_read_spend_u_per_wk: Math.round(analysis.cacheReadSpendU),
          reduction_fraction: analysis.reductionFraction,
          suggested_split_count: analysis.splitCount,
          commit_boundary_count: analysis.commitBoundaryCount,
          commit_anchored_splits: analysis.commitAnchoredSplits,
          git_command_count: analysis.gitCommandCount,
          ...(analysis.sessionStats.length > 0 ? { session_stats: analysis.sessionStats } : {}),
          base_prefix_tokens: analysis.basePrefixTokens,
          summary_tokens: D2_SUMMARY_TOKENS,
          gross_savings_u_per_wk: analysis.grossU,
          rebuild_u_per_wk: Math.round(analysis.rebuildU),
          ...(analysis.savingsRangeU === undefined
            ? {}
            : {
                savings_low_u_per_wk: Math.round(analysis.savingsRangeU[0]),
                savings_high_u_per_wk: Math.round(analysis.savingsRangeU[1]),
              }),
        },
      },
    };

    return {
      fired: [fired],
      status: "ACTIVE",
      note: `${analysis.qualifying.length} qualifying long-context sessions this week`,
    };
  },
};
