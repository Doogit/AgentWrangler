/**
 * C4 FAILED_EDIT_RECOVERY_LOOP.
 *
 * Detects runs of at least three failed Edits for the same opaque file identity
 * per (session, agent). File hashes are used only for local grouping and
 * never leave the detector in the persisted finding.
 */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c4Estimate } from "../savings.js";
import {
  C4_MIN_CONSECUTIVE_FAILURES,
  claimedTurnCost,
  wastedTurnCensus,
  wastedTurnClaims,
} from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

export { C4_MIN_CONSECUTIVE_FAILURES };

interface EditRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly block_index: number;
  readonly file_path_hash: string;
  readonly exit_class: string | null;
  readonly tool_error_class: string | null;
  readonly tool_error_classifier_version: string | null;
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
  /** The subagent that made the call; null on the main chain. */
  readonly agent_id: string | null;
  readonly error_text: string | null;
}

/** The first line of an Edit's error, without the harness wrapper: what the card names the cause from. */
function errorFirstLine(text: string | null): string | null {
  const line = (text ?? "")
    .replace(/^\s*<tool_use_error>/i, "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? null : line.slice(0, 200);
}

/** The commonest failure's first line across a card's failed edits (digits masked to group); null if none had text. */
function dominantErrorLine(rows: readonly EditRow[]): string | null {
  const counts = new Map<string, { line: string; n: number }>();
  for (const row of rows) {
    const line = errorFirstLine(row.error_text);
    if (line === null) continue;
    const key = line.toLowerCase().replace(/\d+/g, "#");
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { line, n: 1 });
    else entry.n += 1;
  }
  return (
    [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))[0]?.[1]
      .line ?? null
  );
}

interface FailureRun {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly filePathHash: string;
  readonly failures: readonly EditRow[];
}

export const c4FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C4",
  rule_id: "C4_FAILED_EDIT_RECOVERY_LOOP",
  labels: ["FAILED_EDIT_RECOVERY_LOOP"],
  metrics: {
    RECOVERY_LOOP_COUNT: { kind: "COUNT" },
    FAILED_EDIT_COUNT: { kind: "COUNT" },
    AFFECTED_FILE_COUNT: { kind: "COUNT" },
    // First line of the commonest failure, so the card can name the cause. Optional: findings
    // written before U7 lack it, and edits stored without error text have none.
    TOP_FAILURE_ERROR_TEXT: { kind: "TEXT", max: 200, optional: true },
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
      "After a failed Edit, re-read the file and shrink the hunk instead of retrying the same edit.",
    target_metric: "failed_edit_recovery_loop_count",
    title: "Repeated failed edit recovery",
  },
} as const);

function rowOrder(a: EditRow, b: EditRow): number {
  return (
    a.ts.localeCompare(b.ts) ||
    a.block_index - b.block_index ||
    a.event_id.localeCompare(b.event_id)
  );
}

/** Any Edit that errored: the classifier labels only some of them, and any failed Edit is a failed edit. */
function isClassifiedRecoveryFailure(row: EditRow): boolean {
  return row.exit_class === "ERROR";
}

function qualifyingRuns(rows: readonly EditRow[]): FailureRun[] {
  const runs: FailureRun[] = [];
  let current: EditRow[] = [];

  const finishRun = (): void => {
    const first = current[0];
    if (first !== undefined && current.length >= C4_MIN_CONSECUTIVE_FAILURES) {
      runs.push({
        sessionId: first.session_id,
        workspaceId: first.workspace_id,
        filePathHash: first.file_path_hash,
        failures: current,
      });
    }
    current = [];
  };

  for (const row of [...rows].sort(rowOrder)) {
    if (isClassifiedRecoveryFailure(row)) current.push(row);
    else finishRun();
  }
  finishRun();
  return runs;
}

export const c4Detector: DetectorV2 = {
  contractVersion: 2,
  version: "C4@u9-1",
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
  descriptor: c4FindingDescriptor,
  id: "C4",
  name: "FAILED_EDIT_RECOVERY_LOOP_V2",

  evaluate(db: Db, ctx) {
    // Runs are keyed by (session, agent), so the sidechain pass's claims price subagent turns too.
    const c4Claimed = new Set<string>([
      ...(wastedTurnClaims(db, ctx).get("C4") ?? []),
      ...(wastedTurnCensus(db, ctx, "sidechain").claims.get("C4") ?? []),
    ]);
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
                m.file_path_hash, e.exit_class, e.tool_error_class,
                e.tool_error_classifier_version, m.owner_message_id, t.cost_equiv_u,
                CASE WHEN t.is_sidechain = 1 THEN t.agent_id END AS agent_id,
                json_extract(c.content_json, '$.error') AS error_text
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           LEFT JOIN tool_event_content c ON c.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND e.tool_name = 'Edit'
            AND m.file_path_hash IS NOT NULL
            AND m.owner_message_id IS NOT NULL
            AND NOT (COALESCE(e.tool_error_class, '') = 'NOT_READ'
                     AND COALESCE(e.tool_error_classifier_version, '') = 'tool-error-1')
            AND (t.is_sidechain = 0 OR t.agent_id IS NOT NULL)
            AND t.provisional = 0
          ORDER BY s.workspace_id, e.session_id, m.file_path_hash, e.ts, m.block_index, e.event_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as EditRow[];

    const byFile = new Map<string, EditRow[]>();
    for (const row of rows) {
      const key = `${row.workspace_id}\0${row.session_id}\0${row.agent_id ?? ""}\0${row.file_path_hash}`;
      const group = byFile.get(key);
      if (group === undefined) byFile.set(key, [row]);
      else group.push(row);
    }

    const runs = [...byFile.values()].flatMap(qualifyingRuns);
    const bySession = new Map<string, FailureRun[]>();
    for (const run of runs) {
      const key = `${run.workspaceId}\0${run.sessionId}`;
      const group = bySession.get(key);
      if (group === undefined) bySession.set(key, [run]);
      else group.push(run);
    }

    const fired: FiredV2[] = [];
    for (const sessionRuns of bySession.values()) {
      const first = sessionRuns[0];
      if (first === undefined) continue;
      const failures = sessionRuns.flatMap((run) => run.failures).sort(rowOrder);
      const { summedCostU, claimedTurnCount } = claimedTurnCost(failures, c4Claimed);
      const estimate = c4Estimate({ costEquivU: summedCostU });
      const modeledSavingsU = claimedTurnCount > 0 ? estimate.rank_value_u_per_wk : null;
      const topError = dominantErrorLine(failures);
      fired.push({
        scopeKey: `C4|${first.workspaceId}|${first.sessionId}`,
        scope_workspace_id: first.workspaceId,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c4FindingDescriptor.rule_id,
            label: "FAILED_EDIT_RECOVERY_LOOP",
            assessment: c4FindingDescriptor.defaults.assessment,
            routing: c4FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // No per-anchor CEU: failures are chronological, so retain the newest five.
            anchors: failures.slice(-5).map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: [...new Set(failures.map((row) => row.session_id))].sort().slice(0, 20),
            estimate,
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "CONFIRMED", method: "RULE" },
            metrics: {
              RECOVERY_LOOP_COUNT: { kind: "COUNT", value: sessionRuns.length },
              FAILED_EDIT_COUNT: { kind: "COUNT", value: failures.length },
              AFFECTED_FILE_COUNT: {
                kind: "COUNT",
                value: new Set(sessionRuns.map((run) => run.filePathHash)).size,
              },
              ...(topError === null
                ? {}
                : { TOP_FAILURE_ERROR_TEXT: { kind: "TEXT" as const, value: topError } }),
            },
          },
          c4FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? { fired, status: "INACTIVE", note: "no repeated failed Edit recovery loops" }
      : { fired, status: "ACTIVE", note: `${runs.length} failed Edit recovery loop(s)` };
  },
};
