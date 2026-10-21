/**
 * C11 MCP_OUTPUT_CAP. Uses only migration-025 closed error labels.
 *
 * $ (RR U13): the turn that issued each failed capped call plus the retry turn after it (the
 * first settled main-chain turn). The card claims those turns in full in the reliability lane
 * (an upper bound); the detector's own estimate is the avoidable share
 * (CX_WASTED_TURN_AVOIDANCE_FRACTION) of the same turns' cost.
 */

import type { Db } from "../../db/open.js";
import type { ClaimProducer } from "../claim-ledger.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { recId } from "../rec-id.js";
import { c11Estimate } from "../savings.js";
import type { DetectorContext, DetectorV2, FiredV2 } from "../types.js";
import {
  type TurnIndex,
  type WasteTurn,
  createTurnIndex,
  wasteTurnClaims,
  wasteTurnCostU,
} from "../waste-turn-claims.js";

interface McpOutputCapRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly tool_error_class: string;
  readonly owner_message_id: string;
}

function capRows(db: Db, ctx: DetectorContext): McpOutputCapRow[] {
  return db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.tool_error_class,
              m.owner_message_id
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.ts >= ? AND e.ts < ?
          AND s.state = 'RECONCILED'
          AND t.is_sidechain = 0
          AND t.provisional = 0
          AND e.tool_error_class IN ('MCP_CONTENT_TOO_LARGE', 'READ_OUTPUT_TOO_LARGE')
          AND e.tool_error_classifier_version = 'tool-error-1'
        ORDER BY s.workspace_id, e.session_id, e.ts, e.event_id`,
    )
    .all(ctx.fromIso, ctx.toIso) as McpOutputCapRow[];
}

/** Per failed capped call: the turn that issued it, and the retry turn after it. */
function wasteTurns(rows: readonly McpOutputCapRow[], index: TurnIndex): WasteTurn[] {
  return rows.flatMap((row) => {
    const issuing = { sessionId: row.session_id, messageId: row.owner_message_id };
    const retry = index.retryOf(issuing);
    return retry === undefined ? [issuing] : [issuing, retry];
  });
}

export const c11FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C11",
  rule_id: "C11_MCP_OUTPUT_CAP",
  labels: ["MCP_OUTPUT_CAP"],
  metrics: {
    // MCP over-cap errors only. Read over-cap errors are counted separately (U7).
    ERROR_COUNT: { kind: "COUNT" },
    READ_ERROR_COUNT: { kind: "COUNT", optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "CLASSIFIER", version: "tool-error-1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever:
      "Keep tool results under the output cap: read large files in a range or search for the part you need, and page or filter MCP tool results.",
    target_metric: "mcp_output_cap_error_count",
    title: "MCP output-cap errors",
  },
} as const);

export const c11Detector: DetectorV2 = {
  contractVersion: 2,
  version: "C11@u13-1",
  scope: "turn",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
    ],
  },
  descriptor: c11FindingDescriptor,
  id: "C11",
  name: "MCP_OUTPUT_CAP_V2",

  evaluate(db: Db, ctx) {
    const rows = capRows(db, ctx);
    const index = createTurnIndex(db, ctx);

    const groups = new Map<string, McpOutputCapRow[]>();
    for (const row of rows) {
      const key = `${row.workspace_id}\0${row.session_id}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    const fired: FiredV2[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const readCount = group.filter((r) => r.tool_error_class === "READ_OUTPUT_TOO_LARGE").length;
      const estimate = c11Estimate({
        costEquivU: wasteTurnCostU(index, wasteTurns(group, index)),
      });
      fired.push({
        scopeKey: `C11|${first.workspace_id}|${first.session_id}`,
        scope_workspace_id: first.workspace_id,
        modeled_savings_u_per_wk: estimate.rank_value_u_per_wk,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c11FindingDescriptor.rule_id,
            label: "MCP_OUTPUT_CAP",
            assessment: c11FindingDescriptor.defaults.assessment,
            routing: c11FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // The query orders timestamps (then event IDs) ascending. Retain the
            // five final rows so fallback anchors are the five most recent, while
            // emitting them in that same deterministic chronological order.
            anchors: group.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: [first.session_id],
            estimate,
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              ERROR_COUNT: { kind: "COUNT", value: group.length - readCount },
              ...(readCount > 0
                ? { READ_ERROR_COUNT: { kind: "COUNT" as const, value: readCount } }
                : {}),
            },
          },
          c11FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no MCP output-cap errors" }
      : { fired, status: "ACTIVE", note: `${rows.length} output-cap error(s)` };
  },
};

/**
 * C11 ledger claims (RR U13): each failed capped call's issuing turn and retry turn, claimed in
 * full in the reliability lane to its session's card.
 */
export const c11ClaimProducer: ClaimProducer = {
  detectorId: "C11",
  *produce(db, ctx) {
    const rows = capRows(db, ctx);
    const workspaceBySession = new Map(rows.map((row) => [row.session_id, row.workspace_id]));
    const index = createTurnIndex(db, ctx);
    yield* wasteTurnClaims(
      index,
      "C11",
      (turn) => {
        const workspaceId = workspaceBySession.get(turn.sessionId) ?? "";
        return recId("C11", workspaceId, `C11|${workspaceId}|${turn.sessionId}`);
      },
      wasteTurns(rows, index),
    );
  },
};
