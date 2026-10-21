/** C9 DENIAL_FRICTION. Only closed classifier labels and argument-count classes are emitted. */

import type { Db } from "../../db/open.js";
import { guardVersions, openFalsePositives } from "../../query/api/rec-actions/trigger.js";
import { guardBlockToolCalls } from "../../query/api/tool-calls.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c9Estimate } from "../savings.js";
import { C9_DENIAL_WHERE, wastedTurnClaims } from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

const C9_LABELS = ["HOOK_BLOCK", "DENY_RULE", "USER_REJECTED"] as const;
const C9_ARGUMENT_CLASSES = ["NONE", "ARGS_0", "ARGS_1", "ARGS_2_3", "ARGS_4_PLUS"] as const;
type C9Label = (typeof C9_LABELS)[number];
type C9ArgumentClass = (typeof C9_ARGUMENT_CLASSES)[number];

interface DenialRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly event_ts: string;
  readonly classifier_label: "hook-block" | "deny-rule" | "user-rejected";
  readonly command_shape: string | null;
}

function labelFor(value: DenialRow["classifier_label"]): C9Label {
  if (value === "hook-block") return "HOOK_BLOCK";
  if (value === "deny-rule") return "DENY_RULE";
  return "USER_REJECTED";
}

function argumentClassFor(commandShape: string | null): C9ArgumentClass {
  if (commandShape === "bash:args-0") return "ARGS_0";
  if (commandShape === "bash:args-1") return "ARGS_1";
  if (commandShape === "bash:args-2-3") return "ARGS_2_3";
  if (commandShape === "bash:args-4+") return "ARGS_4_PLUS";
  return "NONE";
}

export const c9FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C9",
  rule_id: "C9_DENIAL_FRICTION",
  labels: C9_LABELS,
  metrics: {
    DENIAL_CLASS: { kind: "ENUM", values: C9_LABELS },
    COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", values: C9_ARGUMENT_CLASSES },
    DENIAL_COUNT: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "ASSERTED",
      provenance: { source: "CLASSIFIER", version: "c9-v1" },
    },
    // C9 records attributable friction and routes T3 only; no label may imply
    // a Bash allow rule.
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    target_metric: "denial_friction_count",
    title: "Blocked tool requests",
  },
} as const);

export const c9Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r4: guard $ covers every open harmless block the card says to fix. r7: a heredoc feeding a command is a correct block.
  version: "C9@u9-2",
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
  descriptor: c9FindingDescriptor,
  id: "C9",
  name: "DENIAL_FRICTION_V2",

  evaluate(db: Db, ctx) {
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.event_ts,
                e.classifier_label, e.command_shape
           FROM ingest_metric_events e
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.event_ts >= ? AND e.event_ts < ?
            AND ${C9_DENIAL_WHERE}
          ORDER BY s.workspace_id ASC, e.session_id ASC, e.event_ts ASC, e.event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso) as DenialRow[];

    // Collect C9-claimed turn keys (session_id|message_id) → cost per session.
    // Does not filter to RECONCILED so LIVE-session denials are included (oracle confirmed).
    const c9Claimed = wastedTurnClaims(db, ctx).get("C9") ?? new Set<string>();
    const sessionToMsgIds = new Map<string, string[]>();
    for (const key of c9Claimed) {
      const pipeIdx = key.indexOf("|");
      if (pipeIdx === -1) continue;
      const sid = key.slice(0, pipeIdx);
      const mid = key.slice(pipeIdx + 1);
      const list = sessionToMsgIds.get(sid);
      if (list === undefined) sessionToMsgIds.set(sid, [mid]);
      else list.push(mid);
    }
    const turnCostQ = db.prepare(
      "SELECT cost_equiv_u FROM turns WHERE session_id = ? AND message_id = ?",
    );

    // Σ cost_equiv_u over C9-claimed turns, per session.
    const sessionCostU = new Map<string, number>();
    for (const [sid, msgIds] of sessionToMsgIds) {
      let sum = 0;
      for (const mid of msgIds) {
        const row = turnCostQ.get(sid, mid) as { cost_equiv_u: number | null } | undefined;
        sum += row?.cost_equiv_u ?? 0;
      }
      sessionCostU.set(sid, sum);
    }
    const sessionDenials = new Map<string, number>();
    for (const row of rows)
      sessionDenials.set(row.session_id, (sessionDenials.get(row.session_id) ?? 0) + 1);

    // One finding per workspace and denial kind, so a workspace's repeated denials read as one card.
    const groups = new Map<string, { workspaceId: string; label: C9Label; rows: DenialRow[] }>();
    for (const row of rows) {
      const label = labelFor(row.classifier_label);
      const key = `${row.workspace_id}\0${label}`;
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, { workspaceId: row.workspace_id, label, rows: [row] });
      else group.rows.push(row);
    }

    const fired: FiredV2[] = [];
    for (const group of [...groups.values()].sort(
      (a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.label.localeCompare(b.label),
    )) {
      const ordered = [...group.rows].sort(
        (a, b) => a.event_ts.localeCompare(b.event_ts) || a.event_id.localeCompare(b.event_id),
      );
      const perSession = new Map<string, number>();
      const perClass = new Map<C9ArgumentClass, number>();
      for (const row of ordered) {
        perSession.set(row.session_id, (perSession.get(row.session_id) ?? 0) + 1);
        const argumentClass = argumentClassFor(row.command_shape);
        perClass.set(argumentClass, (perClass.get(argumentClass) ?? 0) + 1);
      }
      // A session's claimed cost is shared across its denial kinds by denial count, so a session
      // with two kinds is not priced twice. c9Estimate applies the 0.5 avoidance fraction.
      let sumCostU = 0;
      for (const [sid, denials] of perSession) {
        sumCostU += ((sessionCostU.get(sid) ?? 0) * denials) / (sessionDenials.get(sid) ?? denials);
      }
      // Review 6 R6-01: blocks the guard exists to make are worth their turn, so a guard card
      // prices only its harmless blocks. A block whose call cannot be read back is not harmless.
      if (group.label === "HOOK_BLOCK") {
        const calls = guardBlockToolCalls(db, {
          workspaceId: group.workspaceId,
          from: ctx.fromIso,
          to: ctx.toIso,
        });
        // U9: the harmless blocks the card says to fix (its open false positives), including
        // earlier messages of a rule the guard still has, not only the current message's.
        const harmless = openFalsePositives(guardVersions(calls)).reduce(
          (sum, [, n]) => sum + n,
          0,
        );
        sumCostU *= Math.min(harmless, ordered.length) / ordered.length;
      }
      const sessionIds = [...perSession.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
        .map(([sid]) => sid);
      const argumentClass = C9_ARGUMENT_CLASSES.reduce((best, candidate) =>
        (perClass.get(candidate) ?? 0) > (perClass.get(best) ?? 0) ? candidate : best,
      );
      fired.push({
        scopeKey: `C9|${group.workspaceId}|${group.label}`,
        scope_workspace_id: group.workspaceId,
        modeled_savings_u_per_wk: null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c9FindingDescriptor.rule_id,
            label: group.label,
            assessment: c9FindingDescriptor.defaults.assessment,
            routing: c9FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: rows are chronological, so retain the newest five.
            anchors: ordered.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.event_ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: sessionIds,
            estimate: c9Estimate({ costEquivU: sumCostU }),
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              DENIAL_CLASS: { kind: "ENUM", value: group.label },
              // The most common argument-count class across the group.
              COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: argumentClass },
              DENIAL_COUNT: { kind: "COUNT", value: ordered.length },
            },
          },
          c9FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no non-interrupt denial outcomes" }
      : {
          fired,
          status: "ACTIVE",
          note: `${rows.length} denial event(s) across ${fired.length} group(s)`,
        };
  },
};
