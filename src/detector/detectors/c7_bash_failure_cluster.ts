/**
 * C7 BASH_FAILURE_CLUSTER.
 *
 * Groups failed Bash calls by the migration-025 closed command-family label.
 * The label is deliberately the coarsest available approximation of a command
 * shape: raw commands, arguments, paths, and hashes never leave the ledger.
 */

import type { Db } from "../../db/open.js";
import { workspaceSpendU } from "../../query/spend.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c7Estimate, wastedTurnAttribution } from "../savings.js";
import {
  C7_MIN_FAILURES,
  c7FailureParts,
  c7FailureSignature,
  claimedTurnCost,
  isBenignFailure,
  wastedTurnClaims,
} from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

export { C7_MIN_FAILURES };

const BASH_COMMAND_FAMILIES = [
  "BASH_GIT",
  "BASH_NPM",
  "BASH_PYTHON",
  "BASH_TEST",
  "BASH_BUILD",
  "BASH_OTHER",
] as const;
type BashCommandFamily = (typeof BASH_COMMAND_FAMILIES)[number];

interface BashFailureRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly block_index: number;
  readonly bash_command_family: BashCommandFamily;
  readonly error_text: string | null;
  readonly command_text: string | null;
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
}

export const c7FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C7",
  rule_id: "C7_BASH_FAILURE_CLUSTER",
  labels: ["BASH_FAILURE_CLUSTER"],
  metrics: {
    BASH_COMMAND_FAMILY: { kind: "ENUM", values: BASH_COMMAND_FAMILIES },
    BASH_FAILURE_COUNT: { kind: "COUNT" },
    // The commonest failure in the cluster, so the card can name its cause. Optional: findings
    // written before U7 lack them.
    FAILURE_EXIT_CODE: { kind: "TEXT", max: 8, optional: true },
    FAILURE_FIRST_LINE: { kind: "TEXT", max: 200, optional: true },
    FAILURE_COMMAND_HEAD: { kind: "TEXT", max: 80, optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "c7-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever:
      "Find the shared cause of the repeated command failures and fix it once before retrying.",
    target_metric: "bash_failure_cluster_count",
    title: "Repeated Bash command failures",
  },
} as const);

function rowOrder(a: BashFailureRow, b: BashFailureRow): number {
  return (
    a.ts.localeCompare(b.ts) ||
    a.block_index - b.block_index ||
    a.event_id.localeCompare(b.event_id)
  );
}

export const c7Detector: DetectorV2 = {
  contractVersion: 2,
  // RC-B: no emit-time spend floor, so stored closed weeks re-run.
  // rcb-2: a Bash failure with no command family (e.g. a quoted exe path) counts as BASH_OTHER.
  version: "C7@rcb-2",
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
  descriptor: c7FindingDescriptor,
  id: "C7",
  name: "BASH_FAILURE_CLUSTER_V2",

  evaluate(db: Db, ctx) {
    const c7Claimed = wastedTurnClaims(db, ctx).get("C7") ?? new Set<string>();
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
                COALESCE(e.bash_command_family, 'BASH_OTHER') AS bash_command_family,
                json_extract(c.content_json, '$.error') AS error_text,
                json_extract(c.content_json, '$.command') AS command_text,
                m.owner_message_id, t.cost_equiv_u
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           LEFT JOIN tool_event_content c ON c.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND e.tool_name = 'Bash'
            AND e.exit_class = 'ERROR'
            AND m.owner_message_id IS NOT NULL
            AND t.is_sidechain = 0
            AND t.provisional = 0
          ORDER BY s.workspace_id, e.session_id, e.bash_command_family,
                   e.ts, m.block_index, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as BashFailureRow[];

    // Cluster gate is (workspace, session, command-family, error signature): a cluster is
    // >= C7_MIN_FAILURES failures of one family with the same error in one session, so
    // unrelated failures that only share a family do not cluster, and calls blocked before
    // they ran (C9's hook blocks) are left out. Then roll every
    // qualifying cluster up to ONE finding per WORKSPACE. A single failed turn can
    // cluster in two families of the same session; `claimedTurnCost` dedups by turn
    // key over the workspace union, so the turn's cost is attributed once (not once
    // per family) — the anti double-count invariant. Savings are capped at the
    // workspace's own priced spend (previously uncapped).
    const bySessionFamily = new Map<string, BashFailureRow[]>();
    for (const row of rows) {
      if (isBenignFailure(row.command_text, row.error_text, "Bash")) continue;
      const signature = c7FailureSignature(row.error_text);
      if (signature === null) continue;
      // The command family is no part of the key: 88% of failures are BASH_OTHER, so it only
      // split one cause across families.
      const key = `${row.workspace_id}\0${row.session_id}\0${signature}`;
      const group = bySessionFamily.get(key);
      if (group === undefined) bySessionFamily.set(key, [row]);
      else group.push(row);
    }

    const byWorkspace = new Map<string, BashFailureRow[]>();
    for (const failures of bySessionFamily.values()) {
      const first = failures[0];
      if (first === undefined || failures.length < C7_MIN_FAILURES) continue;
      const bucket = byWorkspace.get(first.workspace_id);
      if (bucket === undefined) byWorkspace.set(first.workspace_id, [...failures]);
      else bucket.push(...failures);
    }

    const fromMs = Date.parse(ctx.fromIso);
    const toMs = Date.parse(ctx.toIso);

    const fired: FiredV2[] = [];
    for (const [workspaceId, clusterRows] of [...byWorkspace.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const ordered = [...clusterRows].sort(rowOrder);
      const { summedCostU, claimedTurnCount } = claimedTurnCost(ordered, c7Claimed);
      const wsSpendU = workspaceSpendU(db, workspaceId, fromMs, toMs);
      // No emit-time spend floor (RC-B): small clusters reach recs, whose de-minimis floor
      // routes them to below_floor. A cluster whose turns D7 owns claims none and stays unpriced.
      const modeledSavingsU =
        claimedTurnCount > 0
          ? Math.min(wastedTurnAttribution(summedCostU, claimedTurnCount).savingsU, wsSpendU)
          : null;

      // Dominant family (most failures, alphabetical tiebreak) represents the rolled-up ENUM.
      const familyCounts = new Map<BashCommandFamily, number>();
      for (const row of clusterRows) {
        familyCounts.set(
          row.bash_command_family,
          (familyCounts.get(row.bash_command_family) ?? 0) + 1,
        );
      }
      const [dominantFamily] = [...familyCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0] ?? ["BASH_OTHER" as BashCommandFamily];

      // The commonest failure (by masked signature) names the cause on the card.
      const signatureCounts = new Map<string, BashFailureRow[]>();
      for (const row of clusterRows) {
        const signature = c7FailureSignature(row.error_text) ?? "";
        const bucket = signatureCounts.get(signature);
        if (bucket === undefined) signatureCounts.set(signature, [row]);
        else bucket.push(row);
      }
      const topRows =
        [...signatureCounts.entries()].sort(
          (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
        )[0]?.[1] ?? [];
      const topParts = c7FailureParts(topRows[0]?.error_text ?? null);
      const commandHead = (topRows[0]?.command_text ?? "")
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .join(" ");

      const sessionIds = [...new Set(clusterRows.map((r) => r.session_id))].sort().slice(0, 20);
      fired.push({
        scopeKey: `C7|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c7FindingDescriptor.rule_id,
            label: "BASH_FAILURE_CLUSTER",
            assessment: c7FindingDescriptor.defaults.assessment,
            routing: c7FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: rows are chronological, so retain the newest five.
            anchors: ordered.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: sessionIds,
            // basis P pass-through: rank == headline modeled_savings_u_per_wk
            estimate: { ...c7Estimate({}), rank_value_u_per_wk: Math.round(modeledSavingsU ?? 0) },
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              BASH_COMMAND_FAMILY: { kind: "ENUM", value: dominantFamily },
              BASH_FAILURE_COUNT: { kind: "COUNT", value: ordered.length },
              ...(topParts === null
                ? {}
                : {
                    FAILURE_EXIT_CODE: {
                      kind: "TEXT" as const,
                      value: topParts.exitCode.slice(0, 8),
                    },
                    FAILURE_FIRST_LINE: {
                      kind: "TEXT" as const,
                      value: topParts.firstLine.slice(0, 200),
                    },
                  }),
              ...(commandHead === ""
                ? {}
                : {
                    FAILURE_COMMAND_HEAD: {
                      kind: "TEXT" as const,
                      value: commandHead.slice(0, 80),
                    },
                  }),
            },
          },
          c7FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no repeated Bash command-family failures" }
      : { fired, status: "ACTIVE", note: `${fired.length} workspace Bash failure cluster(s)` };
  },
};
