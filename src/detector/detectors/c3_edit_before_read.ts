/** C3 EDIT_BEFORE_READ. Uses only migration-025 closed error labels. */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c3Estimate } from "../savings.js";
import { claimedTurnCost, wastedTurnCensus, wastedTurnClaims } from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

interface NotReadRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly tool_name: "Edit" | "Write";
  /** The subagent that made the call; null on the main chain. */
  readonly agent_id: string | null;
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
}

export const c3FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C3",
  rule_id: "C3_EDIT_BEFORE_READ",
  labels: ["EDIT_BEFORE_READ"],
  metrics: {
    ERROR_COUNT: { kind: "COUNT" },
    // How the rejected calls split, so the card can say where they came from. Optional: findings
    // written before U7 lack them.
    WRITE_ERROR_COUNT: { kind: "COUNT", optional: true },
    SUBAGENT_ERROR_COUNT: { kind: "COUNT", optional: true },
    // Write calls among the subagent ones, so the card's Edit/Write split per thread is exact.
    SUBAGENT_WRITE_ERROR_COUNT: { kind: "COUNT", optional: true },
    SESSION_COUNT: { kind: "COUNT", optional: true },
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
    lever: "Read a file's current contents before issuing an Edit or Write to it.",
    target_metric: "edit_before_read_count",
    title: "Edits attempted before reading",
  },
} as const);

export const c3Detector: DetectorV2 = {
  contractVersion: 2,
  version: "C3@u9-1",
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
      "tool_event_content",
      "ingest_metric_events",
    ],
  },
  descriptor: c3FindingDescriptor,
  id: "C3",
  name: "EDIT_BEFORE_READ_V2",

  evaluate(db: Db, ctx) {
    // Subagent turns are priced from the sidechain census pass.
    const c3Claimed = new Set<string>([
      ...(wastedTurnClaims(db, ctx).get("C3") ?? []),
      ...(wastedTurnCensus(db, ctx, "sidechain").claims.get("C3") ?? []),
    ]);
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.tool_name,
                CASE WHEN t.is_sidechain = 1 THEN t.agent_id END AS agent_id,
                m.owner_message_id, t.cost_equiv_u
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND (t.is_sidechain = 0 OR t.agent_id IS NOT NULL)
            AND t.provisional = 0
            AND e.tool_name IN ('Edit', 'Write')
            AND e.tool_error_class = 'NOT_READ'
            AND e.tool_error_classifier_version = 'tool-error-1'
          ORDER BY s.workspace_id, e.ts, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as NotReadRow[];

    // One card per workspace: the cause (a subagent or session that never read the file) is the
    // same wherever it happens, so a card per session only multiplied it.
    const groups = new Map<string, NotReadRow[]>();
    for (const row of rows) {
      const group = groups.get(row.workspace_id);
      if (group === undefined) groups.set(row.workspace_id, [row]);
      else group.push(row);
    }

    const fired: FiredV2[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) continue;
      const sessions = [...new Set(group.map((row) => row.session_id))].sort();
      const { summedCostU, claimedTurnCount } = claimedTurnCost(group, c3Claimed);
      const estimate = c3Estimate({ costEquivU: summedCostU });
      const modeledSavingsU = claimedTurnCount > 0 ? estimate.rank_value_u_per_wk : null;
      fired.push({
        scopeKey: `C3|${first.workspace_id}`,
        scope_workspace_id: first.workspace_id,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c3FindingDescriptor.rule_id,
            label: "EDIT_BEFORE_READ",
            assessment: c3FindingDescriptor.defaults.assessment,
            routing: c3FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: rows are chronological, so retain the newest five.
            anchors: group.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: sessions.slice(0, 20),
            estimate,
            impact: { kind: "FRICTION", severity: "LOW", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              ERROR_COUNT: { kind: "COUNT", value: group.length },
              WRITE_ERROR_COUNT: {
                kind: "COUNT",
                value: group.filter((row) => row.tool_name === "Write").length,
              },
              SUBAGENT_ERROR_COUNT: {
                kind: "COUNT",
                value: group.filter((row) => row.agent_id !== null).length,
              },
              SUBAGENT_WRITE_ERROR_COUNT: {
                kind: "COUNT",
                value: group.filter((row) => row.agent_id !== null && row.tool_name === "Write")
                  .length,
              },
              SESSION_COUNT: { kind: "COUNT", value: sessions.length },
            },
          },
          c3FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no edit-before-read errors" }
      : { fired, status: "ACTIVE", note: `${rows.length} edit-before-read error(s)` };
  },
};
