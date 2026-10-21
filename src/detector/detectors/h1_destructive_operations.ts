/** H1 DESTRUCTIVE_OPERATION_REPORT. This is report-only: no intent or impact is inferred. */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { h1Estimate } from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";

const H1_PERSISTED_DESTRUCTIVE_OPERATIONS = [
  "rm-rf",
  "git-reset-hard",
  "git-clean",
  "sql-drop",
  "truncate",
] as const;
const H1_DESTRUCTIVE_OPERATION_CLASSES = [
  "RM_RF",
  "GIT_RESET_HARD",
  "GIT_CLEAN",
  "SQL_DROP",
  "TRUNCATE",
] as const;
type PersistedDestructiveOperation = (typeof H1_PERSISTED_DESTRUCTIVE_OPERATIONS)[number];
type DestructiveOperationClass = (typeof H1_DESTRUCTIVE_OPERATION_CLASSES)[number];

export interface OperationRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly event_ts: string;
  readonly destructive_op: PersistedDestructiveOperation;
}

interface CallRow {
  readonly interrupt_kind: string | null;
  readonly error: string | null;
}

/** A Bash result showing the call never ran: the user rejected it, or a guard or deny rule blocked it. */
export function neverRan(interruptKind: string | null, error: string | null): boolean {
  return (
    interruptKind === "HUMAN_DENY" ||
    (error !== null &&
      (error.startsWith("The user doesn't want to proceed with this tool use") ||
        /^PreToolUse:\S+ hook error/.test(error) ||
        /^Permission to use .* has been denied/.test(error)))
  );
}

/**
 * Main-chain destructive runs in [from, to) (card review F6): rows the ingest classifier labelled
 * (`src/ingest/destructive.ts`, from the raw command), less calls that never ran. Whether a call ran
 * comes from its Bash `tool_events` row (same session and time) and that row's stored error; the
 * stored command itself is not re-read, because the secrets filter redacts long paths in it. When
 * more than one Bash call shares the time, the run is dropped only if none of them ran. Shared by
 * the detector, the card's read-back and the Diagnostics census so all three count the same runs.
 */
export function destructiveRuns(
  db: Db,
  fromIso: string,
  toIso: string,
  sidechain = false,
): OperationRow[] {
  // Two steps, not a join: the candidates are few, and a join lets the planner pick a full scan.
  // `sidechain` selects subagent runs instead (U7: counted beside the card, never firing it).
  const candidates = db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, e.event_ts, e.destructive_op
         FROM ingest_metric_events e
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.event_ts >= ? AND e.event_ts < ?
          AND e.is_sidechain = ?
          AND e.destructive_op IN ('rm-rf', 'git-reset-hard', 'git-clean', 'sql-drop', 'truncate')`,
    )
    .all(fromIso, toIso, sidechain ? 1 : 0) as OperationRow[];
  const bashCalls = db.prepare(
    `SELECT t.interrupt_kind, json_extract(c.content_json, '$.error') AS error
       FROM tool_events t INDEXED BY idx_tool_session
       LEFT JOIN tool_event_content c ON c.event_id = t.event_id
      WHERE t.session_id = ? AND t.ts = ? AND t.tool_name = 'Bash'`,
  );
  const runs = candidates.filter((row) => {
    const calls = bashCalls.all(row.session_id, row.event_ts) as CallRow[];
    return calls.length === 0 || calls.some((call) => !neverRan(call.interrupt_kind, call.error));
  });
  return runs.sort(
    (a, b) =>
      a.workspace_id.localeCompare(b.workspace_id) ||
      a.session_id.localeCompare(b.session_id) ||
      a.destructive_op.localeCompare(b.destructive_op) ||
      a.event_ts.localeCompare(b.event_ts) ||
      a.event_id.localeCompare(b.event_id),
  );
}

function operationClassFor(value: PersistedDestructiveOperation): DestructiveOperationClass {
  if (value === "rm-rf") return "RM_RF";
  if (value === "git-reset-hard") return "GIT_RESET_HARD";
  if (value === "git-clean") return "GIT_CLEAN";
  if (value === "sql-drop") return "SQL_DROP";
  return "TRUNCATE";
}

export const h1FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "H1",
  rule_id: "H1_DESTRUCTIVE_OPERATION_REPORT",
  labels: ["DESTRUCTIVE_OPERATION_REPORTED"],
  metrics: {
    DESTRUCTIVE_OPERATION: { kind: "ENUM", values: H1_DESTRUCTIVE_OPERATION_CLASSES },
    OPERATION_COUNT: { kind: "COUNT" },
    // Optional so findings persisted before U7 keep validating.
    SIDECHAIN_OPERATION_COUNT: { kind: "COUNT", optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REPORT_ONLY",
      provenance: { source: "CLASSIFIER", version: "h1-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "Add a confirmation guard for this destructive command class before it runs again.",
    target_metric: "destructive_operation_count",
    title: "Reported destructive operations",
  },
} as const);

export const h1Detector: DetectorV2 = {
  contractVersion: 2,
  version: "H1@u7-1",
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
  descriptor: h1FindingDescriptor,
  id: "H1",
  name: "DESTRUCTIVE_OPERATION_REPORT_V2",

  evaluate(db: Db, ctx) {
    const rows = destructiveRuns(db, ctx.fromIso, ctx.toIso);
    // Subagent runs: shown as a separate count on a card a main-chain run fires; never fire one.
    const sidechainCounts = new Map<string, number>();
    for (const row of destructiveRuns(db, ctx.fromIso, ctx.toIso, true)) {
      const key = `${row.workspace_id}\0${row.destructive_op}`;
      sidechainCounts.set(key, (sidechainCounts.get(key) ?? 0) + 1);
    }

    const groups = new Map<string, OperationRow[]>();
    for (const row of rows) {
      const key = `${row.workspace_id}\0${row.destructive_op}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    const fired: FiredV2[] = [];
    for (const group of [...groups.values()].sort((a, b) => {
      const firstA = a[0];
      const firstB = b[0];
      if (firstA === undefined || firstB === undefined) return 0;
      return (
        firstA.workspace_id.localeCompare(firstB.workspace_id) ||
        firstA.destructive_op.localeCompare(firstB.destructive_op)
      );
    })) {
      const first = group[0];
      if (first === undefined) continue;
      const ordered = [...group].sort(
        (a, b) => a.event_ts.localeCompare(b.event_ts) || a.event_id.localeCompare(b.event_id),
      );
      // Rank the grouped cause using each involved session's spend through its
      // latest operation of this class. Never count later work or another session's cutoff.
      const latestOpBySession = new Map<string, string>();
      for (const row of ordered) latestOpBySession.set(row.session_id, row.event_ts);
      const sessionCost = db.prepare(
        `SELECT COALESCE(SUM(cost_equiv_u), 0) AS total_cost
           FROM turns
          WHERE session_id = ? AND provisional = 0 AND ts <= ?`,
      );
      let sessionCostU = 0;
      for (const [sessionId, latestOpTs] of latestOpBySession) {
        sessionCostU += (sessionCost.get(sessionId, latestOpTs) as { total_cost: number })
          .total_cost;
      }
      const estimate = h1Estimate({
        costEquivU: sessionCostU,
        operationClass: first.destructive_op,
      });
      fired.push({
        scopeKey: `H1|${first.workspace_id}|${first.destructive_op}`,
        scope_workspace_id: first.workspace_id,
        modeled_savings_u_per_wk: null,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: h1FindingDescriptor.rule_id,
            label: "DESTRUCTIVE_OPERATION_REPORTED",
            assessment: h1FindingDescriptor.defaults.assessment,
            routing: h1FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: rows are chronological, so retain the newest five.
            anchors: ordered.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.event_ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: [...new Set(ordered.map((row) => row.session_id))],
            estimate,
            impact: { kind: "RISK", severity: "HIGH", direction: "NONE" },
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics: {
              DESTRUCTIVE_OPERATION: {
                kind: "ENUM",
                value: operationClassFor(first.destructive_op),
              },
              OPERATION_COUNT: { kind: "COUNT", value: ordered.length },
              SIDECHAIN_OPERATION_COUNT: {
                kind: "COUNT",
                value: sidechainCounts.get(`${first.workspace_id}\0${first.destructive_op}`) ?? 0,
              },
            },
          },
          h1FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no persisted destructive operation classes" }
      : { fired, status: "ACTIVE", note: `${rows.length} destructive operation event(s)` };
  },
};
