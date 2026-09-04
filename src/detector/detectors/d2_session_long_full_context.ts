/**
 * src/detector/detectors/d2_session_long_full_context.ts — D2 SESSION_LONG_FULL_CONTEXT.
 *
 * Fires (global scope) when >= N qualifying long-context sessions appear in the
 * trailing week. Qualifying = more than 150 reconciled turns in the same
 * evaluation window AND AVG(context_tokens) > 180_000 over those same rows.
 *
 * Savings: cache-read spend the qualifying sessions generate × an (unvalidated)
 * reduction fraction. The cache-read price is derived PER-MODEL from each turn's
 * own pricing snapshot (unit_prices_json[2]), never a hard-coded scalar (§1 D2 (b)).
 */

import type { Db } from "../../db/open.js";
import { capWeightedTokens, resolveCapReadCoeff } from "../../query/cap-weighted.js";
import {
  D2_AVG_CONTEXT_THRESHOLD,
  D2_MIN_QUALIFYING_SESSIONS,
  D2_REDUCTION_FRACTION,
  D2_TURN_COUNT_THRESHOLD,
  d2Savings,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

interface QualifyingSession {
  session_id: string;
  avg_context: number;
  qualifying_turns: number;
}

interface CacheReadRow {
  cache_read_tokens: number;
  unit_prices_json: string | null;
}

/** Cache-read price is index 2 of unit_prices_json ([in, out, cacheRead, cw5m, cw1h]). */
function cacheReadPrice(unitPricesJson: string | null): number {
  if (unitPricesJson === null) return 0;
  try {
    const arr = JSON.parse(unitPricesJson) as number[];
    return arr[2] ?? 0;
  } catch {
    return 0;
  }
}

export const d2Detector: Detector = {
  id: "D2",
  name: "SESSION_LONG_FULL_CONTEXT",
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const qualifying = db
      .prepare(
        `SELECT t.session_id AS session_id,
                AVG(t.context_tokens) AS avg_context,
                COUNT(*) AS qualifying_turns
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
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
      return {
        fired: [],
        status: "INACTIVE",
        note: `${qualifying.length} qualifying long-context session(s) in window (trigger ≥ ${D2_MIN_QUALIFYING_SESSIONS})`,
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
        `SELECT t.cache_read_tokens AS cache_read_tokens, ps.unit_prices_json AS unit_prices_json
           FROM turns t
           LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
          WHERE t.session_id IN (${placeholders})
            AND t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
      )
      .all(...sessionIds, ctx.fromIso, ctx.toIso) as CacheReadRow[];

    let cacheReadTokensPerWeek = 0;
    let cacheReadSpendU = 0;
    for (const r of rows) {
      cacheReadTokensPerWeek += r.cache_read_tokens;
      cacheReadSpendU += r.cache_read_tokens * cacheReadPrice(r.unit_prices_json);
    }

    const { savingsU, formula } = d2Savings(
      cacheReadTokensPerWeek,
      cacheReadSpendU,
      D2_REDUCTION_FRACTION,
    );

    const n = qualifying.length;
    const fired: Fired = {
      scopeKey: `D2|global|${formula.model}`,
      category: "CONTEXT",
      scope_workspace_id: null,
      lever: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
      target_metric: "avg_context_per_turn",
      modeled_savings_u_per_wk: savingsU,
      modeled_formula: formula,
      evidence: {
        title: `Shorten sessions: ${n} long-context run${n === 1 ? "" : "s"} this week`,
        qualifying_session_count: qualifying.length,
        qualifying_turn_count: qualifyingTurnCount,
        session_ids: sessionIds,
        denominator: "reconciled turns in the evaluation window",
        turn_count_threshold: D2_TURN_COUNT_THRESHOLD,
        avg_context_threshold: D2_AVG_CONTEXT_THRESHOLD,
        raw_context_average_tokens_per_turn: Number(rawContextAverageTokensPerTurn.toFixed(2)),
        raw_context_basis: "RAW_USAGE",
        cap_weighted_burn_tokens_per_week: capWeightedBurnTokensPerWeek,
        cap_weighted_burn_basis: "CAP_PROXY",
        cap_read_coefficient: capReadCoefficient,
        cap_read_coefficient_unvalidated: true,
        cache_read_tokens_per_week: cacheReadTokensPerWeek,
        cache_read_spend_u_per_week: Math.round(cacheReadSpendU),
        cache_read_exposure_tokens_per_week: cacheReadTokensPerWeek,
        cache_read_exposure_spend_u_per_week: Math.round(cacheReadSpendU),
        cache_read_exposure_spend_basis: "LIST_EQUIV",
        modeled_savings_basis: "LIST_EQUIV",
        billed_cost_claim: "UNAVAILABLE",
        reduction_fraction: D2_REDUCTION_FRACTION,
        thresholds_unvalidated: true,
      },
    };

    return {
      fired: [fired],
      status: "ACTIVE",
      note: `${qualifying.length} qualifying long-context sessions this week`,
    };
  },
};
