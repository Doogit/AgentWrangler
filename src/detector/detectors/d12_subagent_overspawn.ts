/**
 * D12 SUBAGENT_OVERSPAWN.
 *
 * Measures what each parent-issued Agent call brings back: the subagent's last turn (linked by
 * subagent_meta.tool_use_id = the Agent event_id, then turns.agent_id), sized as
 * output_tokens x bytes/token. Only returns over D12_MIN_RETURN_BYTES count. Each is priced as a
 * result carried along the parent owner chain (one write + carry - 1 reads, via
 * createResultCarry) x D12_AVOIDANCE_FRACTION. A workspace needs >= 3 sessions and
 * D12_MIN_PCT_OF_SPEND of its 7-day spend.
 *
 * SEC-101: evidence contains only workspace ids, aggregate counts, and byte sums.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import { resolveBytesPerToken } from "../calibration.js";
import { createResultCarry } from "../result-claims.js";
import {
  D12_AVOIDANCE_FRACTION,
  ESTIMATOR_BYTES_PER_TOKEN,
  carryPriceUsdPerMtok,
  d12Estimate,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

const D12_MIN_SIDECHAIN_SESSIONS = 3; // UNVALIDATED heuristic anchor
/** A return at or under this is already compact; only heavier ones count (review 1 R2.13). */
const D12_MIN_RETURN_BYTES = 10 * 1024;
/** Settled % floor: the priced savings must reach this share of the workspace's 7-day spend. */
export const D12_MIN_PCT_OF_SPEND = 0.25;

interface AgentCallRow {
  workspace_id: string;
  session_id: string;
  message_id: string;
  ts: string;
  agent_id: string;
}

export const d12Detector: Detector = {
  contractVersion: 1,
  version: "D12@u7-1",
  scope: "session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
      "subagent_meta",
      "ingest_metric_events",
    ],
  },
  id: "D12",
  name: "SUBAGENT_OVERSPAWN",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const bptResolution = resolveBytesPerToken(db);
    const bpt = bptResolution.calibrated ? bptResolution.ratio : ESTIMATOR_BYTES_PER_TOKEN;
    const resultCarry = createResultCarry(db);
    const lastTurn = db.prepare(
      `SELECT output_tokens FROM turns
        WHERE session_id = ? AND agent_id = ? AND is_sidechain = 1
        ORDER BY ts DESC, message_id DESC LIMIT 1`,
    );

    const rows = db
      .prepare(
        `SELECT turns.workspace_id, turns.session_id, turns.message_id,
                tool_events.ts, subagent_meta.agent_id
           FROM tool_events
           JOIN tool_event_metadata
             ON tool_event_metadata.event_id = tool_events.event_id
           JOIN turns
             ON turns.message_id = tool_event_metadata.owner_message_id
           JOIN subagent_meta
             ON subagent_meta.tool_use_id = tool_events.event_id
          WHERE tool_events.ts >= ? AND tool_events.ts < ?
            AND turns.is_sidechain = 0
            AND tool_events.tool_name = 'Agent'
          ORDER BY turns.workspace_id ASC, tool_events.ts ASC, tool_events.event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso) as AgentCallRow[];

    const byWorkspace = new Map<
      string,
      {
        sidechain_result_bytes: number;
        priced_u: number;
        sidechain_turn_ids: Set<string>;
        session_ids: Set<string>;
      }
    >();
    for (const row of rows) {
      const last = lastTurn.get(row.session_id, row.agent_id) as
        | { output_tokens: number }
        | undefined;
      const bytes = (last?.output_tokens ?? 0) * bpt;
      if (bytes <= D12_MIN_RETURN_BYTES) continue;
      const carried = resultCarry(row.session_id, row.ts, row.message_id);
      if (carried === undefined) continue;
      let aggregate = byWorkspace.get(row.workspace_id);
      if (!aggregate) {
        aggregate = {
          sidechain_result_bytes: 0,
          priced_u: 0,
          sidechain_turn_ids: new Set<string>(),
          session_ids: new Set<string>(),
        };
        byWorkspace.set(row.workspace_id, aggregate);
      }
      aggregate.sidechain_result_bytes += Math.round(bytes);
      aggregate.priced_u +=
        (bytes / bpt) *
        D12_AVOIDANCE_FRACTION *
        carryPriceUsdPerMtok(carried.carry, carried.writePrice, carried.readPrice);
      aggregate.sidechain_turn_ids.add(row.message_id);
      aggregate.session_ids.add(row.session_id);
    }

    const fired: Fired[] = [];
    for (const [workspaceId, aggregate] of byWorkspace) {
      const sidechainTurnCount = aggregate.sidechain_turn_ids.size;
      const sessionIds = [...aggregate.session_ids].sort().slice(0, 20);
      if (aggregate.session_ids.size < D12_MIN_SIDECHAIN_SESSIONS) {
        continue;
      }
      const spendU = workspaceSpendU(
        db,
        workspaceId,
        Date.parse(ctx.fromIso),
        Date.parse(ctx.toIso),
      );
      if ((pctOfSpend(aggregate.priced_u, spendU) ?? 0) < D12_MIN_PCT_OF_SPEND) continue;

      // Modeled savings only on a calibrated bytes/token ratio.
      const pricedU = Math.round(aggregate.priced_u);
      const modeledSavingsU = bptResolution.calibrated && pricedU > 0 ? pricedU : null;
      const estimate = { ...d12Estimate({}), rank_value_u_per_wk: pricedU };
      fired.push({
        scopeKey: `D12|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: modeledSavingsU,
        modeled_formula_json: { estimate },
        payload: {
          version: 1,
          template_id: "D12_SUBAGENT_OVERSPAWN",
          facts: {
            workspace_id: workspaceId,
            sidechain_result_bytes: aggregate.sidechain_result_bytes,
            sidechain_turn_count: sidechainTurnCount,
            sidechain_session_count: aggregate.session_ids.size,
            session_ids: sessionIds,
          },
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no workspace met the sidechain return-volume, session-count and spend-share thresholds",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with high aggregate sidechain return volume`,
    };
  },
};
