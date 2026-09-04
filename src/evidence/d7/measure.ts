import type Database from "better-sqlite3";
import type { ApprovedRepoMapEntry } from "../create-scratch.js";
import {
  type AggregateCoverageCohort,
  type D7ForwardCoverageReport,
  D7_FORWARD_COVERAGE_RUNNER_VERSION,
} from "./types.js";

const WINDOW_DAYS = 30;
const THRESHOLD = 0.8;

export interface MeasureD7ForwardCoverageInput {
  db: Database.Database;
  repositories: readonly ApprovedRepoMapEntry[];
  scratchDbSha256: string;
  repoMapSha256: string;
  sourceCommit: string;
  asOf: string;
  windowDays: 30;
}

type AggregateRow = {
  sessionsN: number;
  eventsN: number;
  coveredSessionsN: number;
  coveredEventsN: number;
  missingMetadataN: number;
  missingOwnerTurnN: number;
  noSignalInputN: number;
  malformedTimestampN: number;
  invariantFailureN: number;
};
type CohortRow = {
  cohort: string;
  sessionsN: number;
  eventsN: number;
  coveredSessionsN: number;
  coveredEventsN: number;
};

function fail(code: string): never {
  throw new Error(code);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("d7_aggregate_invalid");
  return value;
}

function cohort(row: CohortRow): AggregateCoverageCohort {
  const sessionsN = asCount(row.sessionsN);
  const eventsN = asCount(row.eventsN);
  const coveredSessionsN = asCount(row.coveredSessionsN);
  const coveredEventsN = asCount(row.coveredEventsN);
  return {
    cohort: row.cohort,
    reconciledToolUsingSessionsN: sessionsN,
    toolEventsN: eventsN,
    coveredSessionsN,
    coveredEventsN,
    sessionCoverage: ratio(coveredSessionsN, sessionsN),
    eventCoverage: ratio(coveredEventsN, eventsN),
  };
}

export function assertD7AsOf(value: string): void {
  if (
    !Number.isFinite(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    fail("d7_as_of_invalid");
}

/** Aggregate the approved query-only snapshot without returning private identifiers. */
export function measureD7ForwardCoverage(
  input: MeasureD7ForwardCoverageInput,
): D7ForwardCoverageReport {
  if (input.windowDays !== WINDOW_DAYS) fail("d7_window_days_invalid");
  assertD7AsOf(input.asOf);
  if (!/^[0-9a-f]{40}$/u.test(input.sourceCommit)) fail("d7_source_commit_invalid");
  const from = new Date(Date.parse(input.asOf) - WINDOW_DAYS * 86_400_000).toISOString();
  const aliases = input.repositories.map(
    (repository) => [repository.workspaceId, repository.reportAlias] as const,
  );
  if (
    aliases.length === 0 ||
    aliases.some(
      ([workspaceId, reportAlias]) =>
        workspaceId.length === 0 || !/^repo-[0-9]{3,}$/u.test(reportAlias),
    ) ||
    new Set(aliases.map(([workspaceId]) => workspaceId)).size !== aliases.length ||
    new Set(aliases.map(([, reportAlias]) => reportAlias)).size !== aliases.length
  )
    fail("d7_repository_map_invalid");
  const values = aliases.map(() => "(?, ?)").join(", ");
  const aliasArgs = aliases.flat();
  const base = `
    WITH approved(workspace_id, report_alias) AS (VALUES ${values}),
    params(from_ts, as_of_ts) AS (VALUES (?, ?)),
    metadata AS (
      SELECT event_id, COUNT(*) AS metadata_rows,
             MAX(file_path_hash) AS file_path_hash, MAX(owner_message_id) AS owner_message_id
      FROM tool_event_metadata GROUP BY event_id
    ),
    owners AS (
      SELECT message_id, COUNT(*) AS owner_rows, MAX(session_id) AS owner_session_id,
             MAX(workspace_id) AS owner_workspace_id, MAX(ts) AS owner_ts,
             MAX(provisional) AS owner_provisional
      FROM turns GROUP BY message_id
    ),
    candidates AS (
      SELECT e.event_id, e.session_id, e.ts AS event_ts, e.input_hash, e.exit_class,
             s.workspace_id AS session_workspace_id, a.report_alias,
             COALESCE(m.metadata_rows, 0) AS metadata_rows, m.file_path_hash, m.owner_message_id,
             COALESCE(t.owner_rows, 0) AS owner_rows, t.owner_session_id,
             t.owner_workspace_id, t.owner_ts, t.owner_provisional,
             p.from_ts, p.as_of_ts
      FROM tool_events e
      JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
      LEFT JOIN approved a ON a.workspace_id = s.workspace_id
      LEFT JOIN metadata m ON m.event_id = e.event_id
      LEFT JOIN owners t ON t.message_id = m.owner_message_id
      CROSS JOIN params p
    ),
    classified AS (
      SELECT *,
        CASE WHEN strftime('%s', event_ts) IS NULL THEN 1 ELSE 0 END AS event_malformed,
        CASE WHEN strftime('%s', event_ts) IS NOT NULL
              AND julianday(event_ts) >= julianday(from_ts)
              AND julianday(event_ts) < julianday(as_of_ts) THEN 1 ELSE 0 END AS in_window,
        CASE WHEN metadata_rows = 1 AND owner_rows = 1
              AND owner_session_id = session_id AND owner_workspace_id = session_workspace_id
              AND owner_provisional = 0 AND strftime('%s', owner_ts) IS NOT NULL
              AND julianday(owner_ts) >= julianday(from_ts)
              AND julianday(owner_ts) < julianday(as_of_ts) THEN 1 ELSE 0 END AS owner_eligible
      FROM candidates
    ),
    eligible AS (
      SELECT *, in_window AS denominator_event,
        CASE WHEN in_window = 1 AND metadata_rows = 1 AND owner_eligible = 1
              AND report_alias IS NOT NULL AND (input_hash IS NOT NULL OR exit_class IS NOT NULL OR file_path_hash IS NOT NULL)
             THEN 1 ELSE 0 END AS covered_event
      FROM classified
    )`;
  const aggregateSql = `${base}
    SELECT
      COUNT(DISTINCT CASE WHEN denominator_event = 1 THEN session_id END) AS sessionsN,
      COALESCE(SUM(denominator_event), 0) AS eventsN,
      COUNT(DISTINCT CASE WHEN covered_event = 1 THEN session_id END) AS coveredSessionsN,
      COALESCE(SUM(covered_event), 0) AS coveredEventsN,
      COALESCE(SUM(CASE WHEN denominator_event = 1 AND metadata_rows = 0 THEN 1 ELSE 0 END), 0) AS missingMetadataN,
      COALESCE(SUM(CASE WHEN denominator_event = 1 AND metadata_rows = 1 AND owner_eligible = 0 THEN 1 ELSE 0 END), 0) AS missingOwnerTurnN,
      COALESCE(SUM(CASE WHEN denominator_event = 1 AND metadata_rows = 1 AND owner_eligible = 1 AND report_alias IS NOT NULL
                    AND input_hash IS NULL AND exit_class IS NULL AND file_path_hash IS NULL THEN 1 ELSE 0 END), 0) AS noSignalInputN,
      COALESCE(SUM(CASE
        WHEN event_malformed = 1 THEN 1
        WHEN denominator_event = 1 AND metadata_rows = 1 AND owner_rows = 1
          AND strftime('%s', owner_ts) IS NULL THEN 1 ELSE 0 END), 0) AS malformedTimestampN,
      COALESCE(SUM(CASE WHEN denominator_event = 1 AND (
        report_alias IS NULL OR metadata_rows > 1 OR owner_rows > 1 OR
        (metadata_rows = 1 AND owner_rows = 1 AND
          (owner_session_id <> session_id OR owner_workspace_id <> session_workspace_id))
      ) THEN 1 ELSE 0 END), 0) AS invariantFailureN
    FROM eligible`;
  const args = [...aliasArgs, from, input.asOf];
  const aggregate = input.db.prepare(aggregateSql).get(...args) as AggregateRow;
  const daySql = `${base}
    SELECT strftime('%Y-%m-%d', event_ts) AS cohort, COUNT(DISTINCT session_id) AS sessionsN,
      COUNT(*) AS eventsN, COUNT(DISTINCT CASE WHEN covered_event = 1 THEN session_id END) AS coveredSessionsN,
      SUM(covered_event) AS coveredEventsN
    FROM eligible WHERE denominator_event = 1 GROUP BY strftime('%Y-%m-%d', event_ts) ORDER BY cohort`;
  const workspaceSql = `${base}
    SELECT report_alias AS cohort, COUNT(DISTINCT session_id) AS sessionsN, COUNT(*) AS eventsN,
      COUNT(DISTINCT CASE WHEN covered_event = 1 THEN session_id END) AS coveredSessionsN,
      SUM(covered_event) AS coveredEventsN
    FROM eligible WHERE denominator_event = 1 AND report_alias IS NOT NULL GROUP BY report_alias ORDER BY report_alias`;
  const aggregateCounts = {
    sessionsN: asCount(aggregate.sessionsN),
    eventsN: asCount(aggregate.eventsN),
    coveredSessionsN: asCount(aggregate.coveredSessionsN),
    coveredEventsN: asCount(aggregate.coveredEventsN),
    missingMetadataN: asCount(aggregate.missingMetadataN),
    missingOwnerTurnN: asCount(aggregate.missingOwnerTurnN),
    noSignalInputN: asCount(aggregate.noSignalInputN),
    malformedTimestampN: asCount(aggregate.malformedTimestampN),
    invariantFailureN: asCount(aggregate.invariantFailureN),
  };
  const sessionCoverage = ratio(aggregateCounts.coveredSessionsN, aggregateCounts.sessionsN);
  const eventCoverage = ratio(aggregateCounts.coveredEventsN, aggregateCounts.eventsN);
  const incomplete =
    aggregateCounts.eventsN === 0 ||
    aggregateCounts.malformedTimestampN > 0 ||
    aggregateCounts.invariantFailureN > 0;
  const sufficient =
    !incomplete &&
    aggregateCounts.sessionsN >= 20 &&
    sessionCoverage !== null &&
    eventCoverage !== null &&
    sessionCoverage >= THRESHOLD &&
    eventCoverage >= THRESHOLD;
  const status = incomplete ? "DATA_INSUFFICIENT" : sufficient ? "SUFFICIENT" : "INSUFFICIENT";
  return {
    campaign: "D7_FORWARD_COVERAGE",
    status,
    identity: {
      sourceCommit: input.sourceCommit,
      runnerVersion: D7_FORWARD_COVERAGE_RUNNER_VERSION,
      scratchDbSha256: input.scratchDbSha256,
      repoMapSha256: input.repoMapSha256,
      asOf: input.asOf,
      windowDays: 30,
    },
    denominator: {
      reconciledToolUsingSessionsN: aggregateCounts.sessionsN,
      toolEventsN: aggregateCounts.eventsN,
    },
    covered: {
      sessionsN: aggregateCounts.coveredSessionsN,
      eventsN: aggregateCounts.coveredEventsN,
      sessionCoverage,
      eventCoverage,
    },
    exclusions: {
      missingMetadataN: aggregateCounts.missingMetadataN,
      missingOwnerTurnN: aggregateCounts.missingOwnerTurnN,
      noSignalInputN: aggregateCounts.noSignalInputN,
      malformedTimestampN: aggregateCounts.malformedTimestampN,
      invariantFailureN: aggregateCounts.invariantFailureN,
    },
    byUtcDay: (input.db.prepare(daySql).all(...args) as CohortRow[]).map(cohort),
    byWorkspaceAlias: (input.db.prepare(workspaceSql).all(...args) as CohortRow[]).map(cohort),
    decision: {
      minimumSessions: 20,
      sessionCoverageThreshold: 0.8,
      eventCoverageThreshold: 0.8,
      replayProofEligible: status === "INSUFFICIENT",
    },
    privacy: { sessionIdN: 0, workspaceIdN: 0, eventIdN: 0, hashN: 0, pathN: 0, transcriptN: 0 },
  };
}
