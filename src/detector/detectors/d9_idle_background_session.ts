/**
 * D9 FORK_SUBAGENT.
 *
 * Fires once per workspace when parent sessions spawned fork subagents. The
 * `subagent_meta.agent_type = 'fork'` marker is definitive; D9 deliberately
 * does not infer forks from token volume or sidechain activity.
 *
 * U7: a fork counts in the window by its own turn times (not the parent session's last turn),
 * and the card carries a real estimate: the cache reads on the fork's turns, which re-read the
 * context it inherited from its parent, priced from each turn's snapshot. A fork with no
 * priced turns reads "cost not measured", never $0. The card needs the estimate to be at least
 * 0.25% of the workspace's 7-day spend (unknown spend is not gated).
 *
 * SEC-101: evidence contains only structural workspace/session ids and counts.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, spendByWorkspace } from "../../query/spend.js";
import { type Estimate, d9Estimate } from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/** Card gate: the estimate is at least this % of the workspace's 7-day spend. */
const D9_MIN_PCT_OF_SPEND = 0.25;

interface ForkRow {
  agent_id: string;
  workspace_id: string;
  session_id: string;
  session_last_turn_at: string | null;
}

interface ForkTurnAgg {
  agent_id: string;
  turns_total: number;
  turns_in_window: number;
  cache_read_tokens: number;
  priced_read_tokens: number;
  priced_read_spend_u: number;
}

const NOT_MEASURED: Estimate = {
  basis: "X",
  rank_value_u_per_wk: null,
  summable: false,
  label: "cost not measured",
};

export const d9Detector: Detector = {
  contractVersion: 1,
  version: "D9@u7-1",
  scope: "session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "subagent_meta",
    ],
  },
  id: "D9",
  name: "FORK_SUBAGENT",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const forks = db
      .prepare(
        `SELECT subagent_meta.agent_id AS agent_id,
                sessions.workspace_id AS workspace_id,
                subagent_meta.session_id AS session_id,
                sessions.last_turn_at AS session_last_turn_at
           FROM subagent_meta
           JOIN sessions ON sessions.session_id = subagent_meta.session_id
          WHERE subagent_meta.agent_type = 'fork'
          ORDER BY sessions.workspace_id, subagent_meta.session_id, subagent_meta.agent_id`,
      )
      .all() as ForkRow[];

    const aggByAgent = new Map<string, ForkTurnAgg>();
    if (forks.length > 0) {
      const aggs = db
        .prepare(
          `SELECT t.agent_id AS agent_id,
                  COUNT(*) AS turns_total,
                  SUM(t.ts >= @from AND t.ts < @to) AS turns_in_window,
                  COALESCE(SUM(CASE WHEN t.ts >= @from AND t.ts < @to THEN t.cache_read_tokens END), 0)
                    AS cache_read_tokens,
                  COALESCE(SUM(CASE WHEN t.ts >= @from AND t.ts < @to AND ps.unit_prices_json IS NOT NULL
                                    THEN t.cache_read_tokens END), 0) AS priced_read_tokens,
                  COALESCE(SUM(CASE WHEN t.ts >= @from AND t.ts < @to AND ps.unit_prices_json IS NOT NULL
                                    THEN t.cache_read_tokens
                                         * CAST(json_extract(ps.unit_prices_json, '$[2]') AS REAL) END), 0)
                    AS priced_read_spend_u
             FROM turns t
             LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
            WHERE t.provisional = 0 AND t.agent_id IN (
                    SELECT agent_id FROM subagent_meta WHERE agent_type = 'fork')
            GROUP BY t.agent_id`,
        )
        .all({ from: ctx.fromIso, to: ctx.toIso }) as ForkTurnAgg[];
      for (const agg of aggs) aggByAgent.set(agg.agent_id, agg);
    }

    interface WorkspaceAggregate {
      forkCount: number;
      sessionIds: string[];
      cacheReadTokens: number;
      pricedReadTokens: number;
      pricedReadSpendU: number;
    }
    const byWorkspace = new Map<string, WorkspaceAggregate>();
    for (const fork of forks) {
      const agg = aggByAgent.get(fork.agent_id);
      // In the window by its own turns; a fork whose turns were never ingested falls back to
      // its parent session's last turn.
      const inWindow =
        agg !== undefined
          ? agg.turns_in_window > 0
          : fork.session_last_turn_at !== null &&
            fork.session_last_turn_at >= ctx.fromIso &&
            fork.session_last_turn_at < ctx.toIso;
      if (!inWindow) continue;
      let aggregate = byWorkspace.get(fork.workspace_id);
      if (!aggregate) {
        aggregate = {
          forkCount: 0,
          sessionIds: [],
          cacheReadTokens: 0,
          pricedReadTokens: 0,
          pricedReadSpendU: 0,
        };
        byWorkspace.set(fork.workspace_id, aggregate);
      }
      aggregate.forkCount += 1;
      if (!aggregate.sessionIds.includes(fork.session_id))
        aggregate.sessionIds.push(fork.session_id);
      if (agg !== undefined) {
        aggregate.cacheReadTokens += agg.cache_read_tokens;
        aggregate.pricedReadTokens += agg.priced_read_tokens;
        aggregate.pricedReadSpendU += agg.priced_read_spend_u;
      }
    }

    const spendByWs = new Map(
      spendByWorkspace(db, ctx.fromIso, ctx.toIso).map((s) => [s.workspace_id, s.cost_equiv_u]),
    );
    const fired: Fired[] = [];
    for (const [workspaceId, aggregate] of byWorkspace) {
      const measured = aggregate.pricedReadTokens > 0 && aggregate.pricedReadSpendU > 0;
      const estimate = measured
        ? d9Estimate({
            idleSidechainCapTokens: aggregate.pricedReadTokens,
            cacheReadPriceUsdPerMtok: aggregate.pricedReadSpendU / aggregate.pricedReadTokens,
          })
        : NOT_MEASURED;
      const pct = pctOfSpend(estimate.rank_value_u_per_wk, spendByWs.get(workspaceId));
      if (pct !== null && pct < D9_MIN_PCT_OF_SPEND) continue;
      fired.push({
        scopeKey: `D9|${workspaceId}`,
        scope_workspace_id: workspaceId,
        // F6: the measured estimate is the card's standalone $ (non-summable).
        modeled_savings_u_per_wk: estimate.rank_value_u_per_wk,
        modeled_formula_json: { estimate },
        payload: {
          version: 1,
          template_id: "D9_BACKGROUND_SESSION",
          facts: {
            workspace_id: workspaceId,
            fork_count: aggregate.forkCount,
            session_ids: aggregate.sessionIds.slice(0, 20),
            fork_cache_read_tokens: aggregate.cacheReadTokens,
            cost_basis: measured ? "measured" : "not_measured",
          },
        },
      });
    }

    if (fired.length === 0) {
      return { fired: [], status: "INACTIVE", note: "no fork subagents in the time window" };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with fork subagents`,
    };
  },
};
