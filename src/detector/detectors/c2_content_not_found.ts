/** C2 CONTENT_NOT_FOUND. Uses only migration-025 closed error labels. */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c2Estimate } from "../savings.js";
import { claimedTurnCost, wastedTurnCensus, wastedTurnClaims } from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

interface NotFoundRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly tool_name: "Read" | "Grep" | "Glob";
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
}

/**
 * Read/Grep/Glob calls with a closed NOT_FOUND label, on the main chain or in a subagent (subagents
 * make 2-4x the main chain's lookups); the card reads the same calls back.
 */
export const C2_NOT_FOUND_WHERE = `e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND (t.is_sidechain = 0 OR t.agent_id IS NOT NULL)
            AND t.provisional = 0
            AND e.tool_error_class = 'NOT_FOUND'
            AND e.tool_error_classifier_version = 'tool-error-1'
            AND e.tool_name IN ('Read', 'Grep', 'Glob')`;

export const c2FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C2",
  rule_id: "C2_CONTENT_NOT_FOUND",
  labels: ["CONTENT_NOT_FOUND"],
  metrics: {
    ERROR_COUNT: { kind: "COUNT" },
    SESSION_COUNT: { kind: "COUNT" },
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
    lever: "Fix where Claude gets the paths that do not exist.",
    target_metric: "content_not_found_count",
    title: "Missing content lookups",
  },
} as const);

export const c2Detector: DetectorV2 = {
  contractVersion: 2,
  // RC-B: no emit-time spend floor, so stored closed weeks re-run.
  version: "C2@rcb-1",
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
  descriptor: c2FindingDescriptor,
  id: "C2",
  name: "CONTENT_NOT_FOUND_V2",

  evaluate(db: Db, ctx) {
    // Subagent turns are priced from the sidechain census pass.
    const c2Claimed = new Set<string>([
      ...(wastedTurnClaims(db, ctx).get("C2") ?? []),
      ...(wastedTurnCensus(db, ctx, "sidechain").claims.get("C2") ?? []),
    ]);
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.tool_name,
                m.owner_message_id, t.cost_equiv_u
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE ${C2_NOT_FOUND_WHERE}
          ORDER BY s.workspace_id, e.ts, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as NotFoundRow[];

    // One finding per workspace (P3.1 review 1, R2.1): the card groups the calls by cause.
    const groups = new Map<string, NotFoundRow[]>();
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
      const { summedCostU, claimedTurnCount } = claimedTurnCost(group, c2Claimed);
      // No emit-time spend floor (RC-B): the recs view's de-minimis floor routes small cards
      // to below_floor, so the Usage patterns count always has a card behind it.
      const estimate = c2Estimate({ costEquivU: summedCostU });
      fired.push({
        scopeKey: `C2|${first.workspace_id}`,
        scope_workspace_id: first.workspace_id,
        modeled_savings_u_per_wk: claimedTurnCount > 0 ? estimate.rank_value_u_per_wk : null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c2FindingDescriptor.rule_id,
            label: "CONTENT_NOT_FOUND",
            assessment: c2FindingDescriptor.defaults.assessment,
            routing: c2FindingDescriptor.defaults.routing,
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
              SESSION_COUNT: { kind: "COUNT", value: sessions.length },
            },
          },
          c2FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no Read/Grep/Glob not-found errors" }
      : { fired, status: "ACTIVE", note: `${rows.length} content-not-found error(s)` };
  },
};
