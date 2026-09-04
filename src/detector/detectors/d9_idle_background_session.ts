/**
 * src/detector/detectors/d9_idle_background_session.ts — D9 IDLE_BACKGROUND_SESSION.
 *
 * Fires PER-WORKSPACE when background / subagent fan-out (is_sidechain turns)
 * dominates the cap-weighted volume — work that may not convert to forward
 * progress. Built on the buildable is_sidechain share proxy; user_turn_count is
 * now ingested per migration 009, so the zero-user-turn facet is available.
 * Savings are marked DIRECTIONAL — fan-out is a real quality/throughput
 * tradeoff, not pure waste (research B), and parent-child linkage remains
 * heuristic (issue #32175). No crisp $ headline is emitted.
 *
 * Trigger (UNVALIDATED defaults, labeled): a workspace where is_sidechain=1 turns
 * contribute ≥ 25% of cap-weighted tokens AND absolute sidechain cap-weighted
 * tokens ≥ 100k in the trailing week.
 *
 * scopeKey: "D9|<workspace_id>".
 */

import type { Db } from "../../db/open.js";
import {
  capWeightExprSql,
  capWeightedTokens,
  resolveCapReadCoeff,
} from "../../query/cap-weighted.js";
import {
  D9_SIDECHAIN_ABS_CAP_TOKENS,
  D9_SIDECHAIN_SHARE,
  D9_UNPRODUCTIVE_FRACTION,
  d9Formula,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

interface SidechainRow {
  workspace_id: string;
  sidechain_cap_raw: number;
  sidechain_turns: number;
  zero_utc_cap_raw: number;
  zero_utc_sessions: number;
}

export const d9Detector: Detector = {
  id: "D9",
  name: "IDLE_BACKGROUND_SESSION",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const coeff = resolveCapReadCoeff(db);

    // Cap-weighted total per workspace (denominator for the share gate).
    const totals = capWeightedTokens(db, {
      fromIso: ctx.fromIso,
      toIso: ctx.toIso,
      groupBy: "workspace_id",
      coeff,
    });
    const totalByWorkspace = new Map(totals.map((r) => [r.group ?? "", r.cap_weighted_tokens]));

    // Sidechain-only cap-weighted tokens per workspace (reuses the shared meter expression).
    const sidechainRows = db
      .prepare(
        `SELECT t.workspace_id                    AS workspace_id,
                SUM(${capWeightExprSql("t", coeff)}) AS sidechain_cap_raw,
                SUM(CASE WHEN s.user_turn_count = 0
                         THEN ${capWeightExprSql("t", coeff)} ELSE 0 END) AS zero_utc_cap_raw,
                COUNT(DISTINCT CASE WHEN s.user_turn_count = 0 THEN t.session_id END) AS zero_utc_sessions,
                COUNT(*)                           AS sidechain_turns
           FROM turns t
           JOIN sessions s ON t.session_id = s.session_id
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0 AND t.is_sidechain = 1
          GROUP BY t.workspace_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as SidechainRow[];

    const fired: Fired[] = [];
    for (const row of sidechainRows) {
      const sidechainCap = Math.round(row.sidechain_cap_raw ?? 0);
      const totalCap = totalByWorkspace.get(row.workspace_id) ?? 0;
      const share = totalCap > 0 ? sidechainCap / totalCap : 0;
      const zeroUtcCap = Math.round(row.zero_utc_cap_raw ?? 0);
      const zeroUtcShare = sidechainCap > 0 ? zeroUtcCap / sidechainCap : 0;

      if (share < D9_SIDECHAIN_SHARE || sidechainCap < D9_SIDECHAIN_ABS_CAP_TOKENS) continue;

      fired.push({
        scopeKey: `D9|${row.workspace_id}`,
        category: "SESSION_HYGIENE",
        scope_workspace_id: row.workspace_id,
        lever:
          "Tighten subagent briefs and cap fan-out in plan mode; kill idle background sessions and /clear idle terminals. Directional — much fan-out is justified; review before cutting.",
        target_metric: "sidechain_cap_weighted_share",
        // Directional: no crisp $ headline (research B). Estimate lives in the formula inputs.
        modeled_savings_u_per_wk: null,
        modeled_formula: d9Formula(sidechainCap, D9_UNPRODUCTIVE_FRACTION),
        evidence: {
          title: `Review background fan-out: ${Math.round(share * 100)}% cap-weighted sidechain`,
          workspace_id: row.workspace_id,
          sidechain_cap_weighted_tokens: sidechainCap,
          total_cap_weighted_tokens: totalCap,
          sidechain_share: Number(share.toFixed(4)),
          sidechain_turn_count: row.sidechain_turns,
          zero_user_turn_sidechain_cap: zeroUtcCap,
          zero_user_turn_sidechain_share: Number(zeroUtcShare.toFixed(4)),
          zero_user_turn_session_count: row.zero_utc_sessions,
          sidechain_share_threshold: D9_SIDECHAIN_SHARE,
          sidechain_abs_cap_tokens_threshold: D9_SIDECHAIN_ABS_CAP_TOKENS,
          unproductive_fraction: D9_UNPRODUCTIVE_FRACTION,
          thresholds_unvalidated: true,
          directional: true,
          linkage_note:
            "user_turn_count is now ingested per migration 009, so the zero-user-turn facet is available; parent-child subagent linkage remains heuristic (issue #32175)",
          steps: [
            "Review the highest-volume background/subagent sessions in this workspace",
            "Tighten subagent briefs so fan-out returns tight, scoped results",
            "Cap fan-out in plan mode; kill idle background sessions and /clear idle terminals",
          ],
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no workspace met the sidechain-share threshold",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with background-heavy fan-out`,
    };
  },
};
