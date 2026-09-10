/**
 * Shared ESF observation cohort.
 *
 * This is deliberately an accounting and observation seam. It does not infer
 * task identity or acceptance, and it is not the native D7 detector matcher.
 */

import { createHash } from "node:crypto";
import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface EsfObservationQueryOpts {
  /** null selects all workspaces. */
  workspaceId: string | null;
  /** Optional exact session scope, using the same accounting predicates. */
  sessionId?: string;
  /** Inclusive ISO-8601 lower bound. */
  from: string;
  /** Exclusive ISO-8601 upper bound. */
  to: string;
}

export interface EsfCountSummary {
  value: string;
  count: number;
}

/** One exactly-once RECONCILED session accounting row for future ESF3 allocation. */
export interface EsfAllocationSession {
  session_id: string;
  priced_cost_u: number;
  priced_turn_count: number;
  unpriced_turn_count: number;
  cost_claim_counts: EsfCountSummary[];
  parser_version_counts: EsfCountSummary[];
}

export interface EsfCohortWatermark {
  version: "esf-cohort-watermark-1";
  /** SHA-256 of the sorted, privacy-safe accounting source snapshot. */
  source_fingerprint: string;
  selected_turn_count: number;
  selected_session_count: number;
  nonprovisional_turn_count: number;
  latest_selected_turn_at: string | null;
  cost_claim_counts: EsfCountSummary[];
  parser_version_counts: EsfCountSummary[];
}

export interface EsfObservationCohort {
  cohort_definition_version: "esf-cohort-1";
  resource: {
    selected_session_count: number;
    priced_cost_u: number;
    priced_turn_count: number;
    unpriced_turn_count: number;
    unpriced_session_count: number;
    reconciled_priced_session_count: number;
    live_priced_session_count: number;
  };
  /** RECONCILED qualifying Bash/Write/Edit/NotebookEdit sessions without any observed SHA. */
  no_commit_activity: {
    session_ids: string[];
    session_count: number;
    live_session_excluded_count: number;
  };
  /** Observational test-event sequence, deliberately separate from D7 matching. */
  observed_test_recovery: {
    method_version: "esf-observed-test-recovery-1";
    affected_session_ids: string[];
    recovered_session_ids: string[];
    eligible_reconciled_qualifying_tool_session_count: number;
  };
  /** Exactly one row per selected-turn RECONCILED session; totals conserve exactly. */
  allocation_sessions: EsfAllocationSession[];
  watermark: EsfCohortWatermark;
  from: string;
  to: string;
  workspace_id: string | null;
}

/**
 * Minimal workspace observation context for consumers that need the
 * versioned completed-test recovery denominator but not the full ESF cohort.
 */
export interface EsfObservedTestRecoveryContext {
  workspace_context_from: string;
  workspace_context_to: string;
  workspace_affected_session_ids: string[];
  workspace_recovered_session_ids: string[];
  workspace_qualifying_session_count: number;
}

interface AggregateRow {
  selected_session_count: number;
  priced_cost_u: number;
  priced_turn_count: number;
  unpriced_turn_count: number;
  unpriced_session_count: number;
  reconciled_priced_session_count: number;
  live_priced_session_count: number;
  selected_turn_count: number;
  nonprovisional_turn_count: number;
  latest_selected_turn_at: string | null;
}

interface AllocationRow {
  session_id: string;
  priced_cost_u: number;
  priced_turn_count: number;
  unpriced_turn_count: number;
}

interface CountRow {
  value: string;
  count: number;
}

interface FingerprintRow {
  message_id: string;
  session_id: string;
  state: string;
  ts: string;
  cost_equiv_u: number | null;
  cost_claim: string;
  parser_version: string;
  provisional: number;
}

function countSummary(rows: CountRow[]): EsfCountSummary[] {
  return rows.map((row) => ({ value: row.value, count: row.count }));
}

function sourceFingerprint(opts: EsfObservationQueryOpts, rows: FingerprintRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "esf-cohort-source-fingerprint-1",
        window: { from: opts.from, to: opts.to },
        workspace_id: opts.workspaceId,
        ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
        turns: rows,
      }),
      "utf8",
    )
    .digest("hex");
}

function selectedTurnCohort(opts: EsfObservationQueryOpts): {
  cohort: string;
  params: string[];
} {
  const workspaceFilter = opts.workspaceId === null ? "" : " AND t.workspace_id = ?";
  const sessionFilter = opts.sessionId === undefined ? "" : " AND t.session_id = ?";
  const params =
    opts.workspaceId === null ? [opts.from, opts.to] : [opts.from, opts.to, opts.workspaceId];
  if (opts.sessionId !== undefined) params.push(opts.sessionId);

  return {
    params,
    cohort: `WITH selected_turns AS (
      SELECT t.message_id, t.session_id, t.ts, t.cost_equiv_u, t.cost_claim, t.parser_version, t.provisional
        FROM turns t
       WHERE t.ts >= ? AND t.ts < ?${workspaceFilter}${sessionFilter}
    ),
    selected_sessions AS (
      SELECT DISTINCT st.session_id, s.state
        FROM selected_turns st
        JOIN sessions s USING (session_id)
    )`,
  };
}

/**
 * Read only the bounded, versioned completed-test recovery context. This keeps
 * the exact ESF observation definitions available to detector evidence without
 * constructing unrelated resource, allocation, or fingerprint aggregates.
 * esf-cohort-1 selects sessions by in-window turns, then qualifies tool activity
 * over the session. Only the completed-test sequence is bounded to this window.
 */
export function getEsfObservedTestRecoveryContext(
  db: Db,
  opts: EsfObservationQueryOpts,
): EsfObservedTestRecoveryContext {
  const { cohort, params } = selectedTurnCohort(opts);
  const obstacleRows = db
    .prepare(
      `${cohort},
       eligible AS (
         SELECT ss.session_id
           FROM selected_sessions ss
          WHERE ss.state = 'RECONCILED'
            AND EXISTS (
              SELECT 1 FROM tool_events te
               WHERE te.session_id = ss.session_id
                 AND te.tool_name IN ('Bash', 'Write', 'Edit', 'NotebookEdit')
            )
       ),
       completed_tests AS (
         SELECT te.session_id, te.ts, te.exit_class
           FROM tool_events te
           JOIN tool_event_metadata tem USING (event_id)
           JOIN eligible e USING (session_id)
          WHERE te.ts >= ? AND te.ts < ?
            AND tem.is_test_command = 1 AND te.result_bytes IS NOT NULL
       ),
       failures AS (
         SELECT session_id, COUNT(*) AS failure_count
           FROM completed_tests WHERE exit_class = 'TEST_FAIL'
          GROUP BY session_id HAVING COUNT(*) >= 2
       )
       SELECT f.session_id,
              EXISTS (
                SELECT 1 FROM completed_tests failed
                JOIN completed_tests pass ON pass.session_id = failed.session_id
                 WHERE failed.session_id = f.session_id
                   AND failed.exit_class = 'TEST_FAIL'
                   AND pass.exit_class = 'OK' AND pass.ts > failed.ts
              ) AS recovered
         FROM failures f ORDER BY f.session_id`,
    )
    .all(...params, opts.from, opts.to) as Array<{ session_id: string; recovered: number }>;
  const eligibleToolRow = db
    .prepare(
      `${cohort}
       SELECT COUNT(*) AS count FROM selected_sessions ss
        WHERE ss.state = 'RECONCILED'
          AND EXISTS (
            SELECT 1 FROM tool_events te WHERE te.session_id = ss.session_id
              AND te.tool_name IN ('Bash', 'Write', 'Edit', 'NotebookEdit')
          )`,
    )
    .get(...params) as { count: number };

  return {
    workspace_context_from: opts.from,
    workspace_context_to: opts.to,
    workspace_affected_session_ids: obstacleRows.map((row) => row.session_id),
    workspace_recovered_session_ids: obstacleRows
      .filter((row) => row.recovered === 1)
      .map((row) => row.session_id),
    workspace_qualifying_session_count: eligibleToolRow.count,
  };
}

/**
 * Read the bounded selected-turn cohort once for ESF resource, activity,
 * obstacle, and future allocation consumers. The selected session predicate is
 * `DISTINCT session_id` with at least one turn in `[from, to)`.
 *
 * Money includes every nonprovisional priced turn, including turns in LIVE
 * session rows. Allocation rows intentionally include only RECONCILED
 * sessions, preserving the ESF3 eligibility contract.
 */
export function getEsfObservations(
  db: Db,
  opts: EsfObservationQueryOpts,
): ApiResponse<EsfObservationCohort> {
  const { cohort, params } = selectedTurnCohort(opts);

  const aggregate = db
    .prepare(
      `${cohort}
       SELECT COUNT(DISTINCT ss.session_id) AS selected_session_count,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
                                THEN st.cost_equiv_u ELSE 0 END), 0) AS priced_cost_u,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
                                THEN 1 ELSE 0 END), 0) AS priced_turn_count,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NULL
                                THEN 1 ELSE 0 END), 0) AS unpriced_turn_count,
              COALESCE(COUNT(DISTINCT CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NULL
                                             THEN st.session_id END), 0) AS unpriced_session_count,
              COALESCE(COUNT(DISTINCT CASE WHEN ss.state = 'RECONCILED'
                                               AND st.provisional = 0
                                               AND st.cost_equiv_u IS NOT NULL
                                             THEN st.session_id END), 0) AS reconciled_priced_session_count,
              COALESCE(COUNT(DISTINCT CASE WHEN ss.state = 'LIVE'
                                               AND st.provisional = 0
                                               AND st.cost_equiv_u IS NOT NULL
                                             THEN st.session_id END), 0) AS live_priced_session_count,
              COUNT(st.session_id) AS selected_turn_count,
              COALESCE(SUM(CASE WHEN st.provisional = 0 THEN 1 ELSE 0 END), 0)
                AS nonprovisional_turn_count,
              MAX(st.ts) AS latest_selected_turn_at
         FROM selected_sessions ss
         LEFT JOIN selected_turns st USING (session_id)`,
    )
    .get(...params) as AggregateRow;

  const allocationRows = db
    .prepare(
      `${cohort}
       SELECT st.session_id,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
                                THEN st.cost_equiv_u ELSE 0 END), 0) AS priced_cost_u,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
                                THEN 1 ELSE 0 END), 0) AS priced_turn_count,
              COALESCE(SUM(CASE WHEN st.provisional = 0 AND st.cost_equiv_u IS NULL
                                THEN 1 ELSE 0 END), 0) AS unpriced_turn_count
         FROM selected_turns st
         JOIN sessions s USING (session_id)
        WHERE s.state = 'RECONCILED'
        GROUP BY st.session_id
        ORDER BY st.session_id`,
    )
    .all(...params) as AllocationRow[];

  const allocationClaims = db
    .prepare(
      `${cohort}
       SELECT st.session_id, st.cost_claim AS value, COUNT(*) AS count
         FROM selected_turns st JOIN sessions s USING (session_id)
        WHERE s.state = 'RECONCILED' AND st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
        GROUP BY st.session_id, st.cost_claim
        ORDER BY st.session_id, st.cost_claim`,
    )
    .all(...params) as Array<CountRow & { session_id: string }>;
  const allocationParsers = db
    .prepare(
      `${cohort}
       SELECT st.session_id, st.parser_version AS value, COUNT(*) AS count
         FROM selected_turns st JOIN sessions s USING (session_id)
        WHERE s.state = 'RECONCILED' AND st.provisional = 0
        GROUP BY st.session_id, st.parser_version
        ORDER BY st.session_id, st.parser_version`,
    )
    .all(...params) as Array<CountRow & { session_id: string }>;

  const claimsBySession = new Map<string, CountRow[]>();
  const parsersBySession = new Map<string, CountRow[]>();
  for (const row of allocationClaims) {
    const rows = claimsBySession.get(row.session_id) ?? [];
    rows.push(row);
    claimsBySession.set(row.session_id, rows);
  }
  for (const row of allocationParsers) {
    const rows = parsersBySession.get(row.session_id) ?? [];
    rows.push(row);
    parsersBySession.set(row.session_id, rows);
  }
  const allocation_sessions = allocationRows.map((row) => ({
    ...row,
    cost_claim_counts: countSummary(claimsBySession.get(row.session_id) ?? []),
    parser_version_counts: countSummary(parsersBySession.get(row.session_id) ?? []),
  }));

  const aggregateClaims = db
    .prepare(
      `${cohort}
       SELECT st.cost_claim AS value, COUNT(*) AS count
         FROM selected_turns st
        WHERE st.provisional = 0 AND st.cost_equiv_u IS NOT NULL
        GROUP BY st.cost_claim ORDER BY st.cost_claim`,
    )
    .all(...params) as CountRow[];
  const fingerprintRows = db
    .prepare(
      `${cohort}
       SELECT st.message_id, st.session_id, ss.state, st.ts, st.cost_equiv_u,
              st.cost_claim, st.parser_version, st.provisional
         FROM selected_turns st
         JOIN selected_sessions ss USING (session_id)
        ORDER BY st.message_id, st.session_id, ss.state, st.ts, st.cost_equiv_u,
                 st.cost_claim, st.parser_version, st.provisional`,
    )
    .all(...params) as FingerprintRow[];
  const aggregateParsers = db
    .prepare(
      `${cohort}
       SELECT st.parser_version AS value, COUNT(*) AS count
         FROM selected_turns st WHERE st.provisional = 0
        GROUP BY st.parser_version ORDER BY st.parser_version`,
    )
    .all(...params) as CountRow[];

  const activityRows = db
    .prepare(
      `${cohort}
       SELECT ss.session_id, ss.state
         FROM selected_sessions ss
        WHERE EXISTS (
                SELECT 1 FROM tool_events te
                 WHERE te.session_id = ss.session_id
                   AND te.tool_name IN ('Bash', 'Write', 'Edit', 'NotebookEdit')
              )
          AND NOT EXISTS (
                SELECT 1 FROM tool_events te
                 WHERE te.session_id = ss.session_id AND te.commit_sha IS NOT NULL
              )
        ORDER BY ss.session_id`,
    )
    .all(...params) as Array<{ session_id: string; state: string }>;
  const noCommitIds = activityRows
    .filter((row) => row.state === "RECONCILED")
    .map((row) => row.session_id);

  const recoveryContext = getEsfObservedTestRecoveryContext(db, opts);

  const data: EsfObservationCohort = {
    cohort_definition_version: "esf-cohort-1",
    resource: {
      selected_session_count: aggregate.selected_session_count,
      priced_cost_u: aggregate.priced_cost_u,
      priced_turn_count: aggregate.priced_turn_count,
      unpriced_turn_count: aggregate.unpriced_turn_count,
      unpriced_session_count: aggregate.unpriced_session_count,
      reconciled_priced_session_count: aggregate.reconciled_priced_session_count,
      live_priced_session_count: aggregate.live_priced_session_count,
    },
    no_commit_activity: {
      session_ids: noCommitIds,
      session_count: noCommitIds.length,
      live_session_excluded_count: activityRows.filter((row) => row.state === "LIVE").length,
    },
    observed_test_recovery: {
      method_version: "esf-observed-test-recovery-1",
      affected_session_ids: recoveryContext.workspace_affected_session_ids,
      recovered_session_ids: recoveryContext.workspace_recovered_session_ids,
      eligible_reconciled_qualifying_tool_session_count:
        recoveryContext.workspace_qualifying_session_count,
    },
    allocation_sessions,
    watermark: {
      version: "esf-cohort-watermark-1",
      source_fingerprint: sourceFingerprint(opts, fingerprintRows),
      selected_turn_count: aggregate.selected_turn_count,
      selected_session_count: aggregate.selected_session_count,
      nonprovisional_turn_count: aggregate.nonprovisional_turn_count,
      latest_selected_turn_at: aggregate.latest_selected_turn_at,
      cost_claim_counts: countSummary(aggregateClaims),
      parser_version_counts: countSummary(aggregateParsers),
    },
    from: opts.from,
    to: opts.to,
    workspace_id: opts.workspaceId,
  };

  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    metric_definition_version: "esf-1",
    n: data.resource.selected_session_count,
    window: { from: opts.from, to: opts.to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: data.resource.unpriced_turn_count,
      claim_kinds_count: data.watermark.cost_claim_counts.length,
      note: "Selected-turn cohort is [from,to). Unpriced turns are unknown, not zero-cost. Test recovery is a versioned observation of completed test events, not D7 detector matching or a task outcome.",
    },
    drilldown_ids: {
      ...(opts.workspaceId === null ? {} : { workspace_id: opts.workspaceId }),
      ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
    },
  });
}

/** Full session evidence; the exclusive end includes the final turn/tool event. */
export function getSessionEsfObservations(
  db: Db,
  sessionId: string,
): ApiResponse<EsfObservationCohort> {
  const session = db
    .prepare("SELECT workspace_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as { workspace_id: string } | undefined;
  if (session === undefined) {
    const missing = buildResponse(null, {
      claim_kind: "N_A",
      metric_definition_version: "esf-1",
      n: 0,
      drilldown_ids: { session_id: sessionId },
    });
    return { data: null, meta: missing.meta };
  }
  const span = db
    .prepare(`SELECT MIN(ts) AS first_at, MAX(ts) AS last_at FROM (
    SELECT ts FROM turns WHERE session_id = ?
    UNION ALL SELECT ts FROM tool_events WHERE session_id = ?
  )`)
    .get(sessionId, sessionId) as { first_at: string | null; last_at: string | null };
  const from = span.first_at ?? "1970-01-01T00:00:00.000Z";
  const to = new Date(Date.parse(span.last_at ?? from) + 1).toISOString();
  return getEsfObservations(db, { workspaceId: session.workspace_id, sessionId, from, to });
}
