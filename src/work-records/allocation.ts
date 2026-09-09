import type { Db } from "../db/open.js";
import { getEsfObservations } from "../query/api/esf-observations.js";
import type { DaemonIdIssuer } from "./ids.js";
import type { AllocationDisposition, AllocationSummary, OutcomeState } from "./types.js";
import { WorkRecordError } from "./types.js";
import { hashRequest, isoField, objectWithKeys, opaqueIdField, stringField } from "./validation.js";

interface Receipt {
  operation: string;
  request_sha256: string;
  allocation_revision_id: string | null;
}

function transaction<T>(db: Db, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function recomputeWorkAllocation(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): { allocation: AllocationSummary; replayed: boolean } {
  const input = objectWithKeys(raw, [
    "mutation_id",
    "allocation_revision_id",
    "workspace_id",
    "cohort_from",
    "cohort_to",
    "evidence_as_of",
  ]);
  const mutationId = opaqueIdField(input, "mutation_id");
  const allocationId = opaqueIdField(input, "allocation_revision_id");
  const workspaceId = stringField(input, "workspace_id", 128);
  const from = isoField(input, "cohort_from");
  const to = isoField(input, "cohort_to");
  const asOf = isoField(input, "evidence_as_of");
  if (to <= from || asOf < to)
    throw new WorkRecordError(400, "INVALID_REQUEST", "allocation window is invalid");
  const hash = hashRequest(input);

  return transaction(db, () => {
    const old = db
      .prepare(
        "SELECT operation, request_sha256, allocation_revision_id FROM work_record_mutations WHERE mutation_id = ?",
      )
      .get(mutationId) as Receipt | undefined;
    if (old !== undefined) {
      if (
        old.operation !== "RECOMPUTE_ALLOCATION" ||
        old.request_sha256 !== hash ||
        old.allocation_revision_id === null
      )
        throw new WorkRecordError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "mutation id was reused with different input",
        );
      return { allocation: getWorkAllocation(db, old.allocation_revision_id), replayed: true };
    }
    if (
      db
        .prepare("SELECT 1 FROM work_record_tombstones WHERE delete_mutation_id = ?")
        .get(mutationId) !== undefined
    )
      throw new WorkRecordError(409, "IDEMPOTENCY_CONFLICT", "mutation id is already used");
    if (
      db
        .prepare("SELECT 1 FROM work_allocation_revisions WHERE allocation_revision_id = ?")
        .get(allocationId) !== undefined
    )
      throw new WorkRecordError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "allocation revision id is already used",
      );
    if (
      db.prepare("SELECT 1 FROM workspaces WHERE workspace_id = ?").get(workspaceId) === undefined
    )
      throw new WorkRecordError(404, "NOT_FOUND", "workspace not found");

    const claims = [
      { id: mutationId, kind: "MUTATION" as const },
      { id: allocationId, kind: "ALLOCATION_REVISION" as const },
    ];
    issuer.claimMany(claims);
    try {
      const response = getEsfObservations(db, { workspaceId, from, to });
      const cohort = response.data;
      if (cohort === null)
        throw new WorkRecordError(422, "INSUFFICIENT_EVIDENCE", "ESF cohort is unavailable");
      if (cohort.cohort_definition_version !== "esf-cohort-1")
        throw new WorkRecordError(422, "UNSUPPORTED_VERSION", "unsupported ESF cohort definition");
      const createdAt = now().toISOString();
      const records = db
        .prepare(`SELECT wr.work_record_id, wr.current_revision_no,
          r.revision_no, r.outcome_state, r.feedback_source,
          CASE WHEN (
            SELECT m.operation FROM work_record_mutations m
             WHERE m.work_record_id = wr.work_record_id
               AND m.operation IN ('ARCHIVE', 'REOPEN') AND m.applied_at <= ?
             ORDER BY m.applied_at DESC, m.resulting_revision_no DESC LIMIT 1
          ) = 'ARCHIVE' THEN 1 ELSE 0 END AS archived
        FROM work_records wr JOIN work_record_revisions r ON r.work_record_id = wr.work_record_id
       WHERE wr.workspace_id = ? AND wr.created_at <= ? AND r.revision_no = (
         SELECT MAX(r2.revision_no) FROM work_record_revisions r2
          WHERE r2.work_record_id = wr.work_record_id AND r2.recorded_at <= ?
       ) ORDER BY wr.work_record_id`)
        .all(asOf, workspaceId, asOf, asOf) as Array<{
        work_record_id: string;
        revision_no: number;
        outcome_state: OutcomeState;
        feedback_source: string;
        archived: number;
      }>;

      db.prepare(`INSERT INTO work_allocation_revisions
        (allocation_revision_id, workspace_id, cohort_from, cohort_to, created_at, evidence_as_of,
         contract_version, metric_definition_version, source_ingestion_watermark, frozen_record_count, report_status)
        VALUES (?, ?, ?, ?, ?, ?, 'esf-work-allocation-1', ?, ?, ?, 'COMPLETE')`).run(
        allocationId,
        workspaceId,
        from,
        to,
        createdAt,
        asOf,
        response.meta.metric_definition_version,
        JSON.stringify(cohort.watermark),
        records.length,
      );

      const snapshot = db.prepare(`INSERT INTO work_allocation_record_snapshots
        (allocation_revision_id, work_record_id, revision_no, outcome_state, feedback_source, archived)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const record of records)
        snapshot.run(
          allocationId,
          record.work_record_id,
          record.revision_no,
          record.outcome_state,
          record.feedback_source,
          record.archived,
        );

      const active = db.prepare(`SELECT l.work_record_id FROM work_record_session_links l
        JOIN work_records wr ON wr.work_record_id = l.work_record_id
       WHERE l.session_id = ? AND wr.workspace_id = ?
         AND l.linked_at <= ? AND (l.unlinked_at IS NULL OR l.unlinked_at > ?)
       ORDER BY l.work_record_id`);
      const insert = db.prepare(`INSERT INTO work_session_allocations
        (allocation_revision_id, session_id, owner_snapshot_id, disposition, priced_reconciled_cost_u,
         priced_turn_count, unpriced_turn_count, parser_claim_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const session of cohort.allocation_sessions) {
        const owners = active.all(session.session_id, workspaceId, asOf, asOf) as Array<{
          work_record_id: string;
        }>;
        const disposition: AllocationDisposition =
          owners.length === 0
            ? "UNALLOCATED_UNGROUPED"
            : owners.length === 1
              ? "OWNED"
              : "UNALLOCATED_SHARED";
        insert.run(
          allocationId,
          session.session_id,
          owners.length === 1 ? owners[0]?.work_record_id : null,
          disposition,
          session.priced_cost_u,
          session.priced_turn_count,
          session.unpriced_turn_count,
          JSON.stringify({
            cost_claim_counts: session.cost_claim_counts,
            parser_version_counts: session.parser_version_counts,
          }),
        );
      }
      db.prepare(`INSERT INTO work_record_mutations
        (mutation_id, operation, request_sha256, work_record_id, expected_revision_no,
         resulting_revision_no, allocation_revision_id, applied_at, result)
        VALUES (?, 'RECOMPUTE_ALLOCATION', ?, NULL, NULL, NULL, ?, ?, 'APPLIED')`).run(
        mutationId,
        hash,
        allocationId,
        createdAt,
      );
      return { allocation: getWorkAllocation(db, allocationId), replayed: false };
    } catch (error) {
      issuer.restoreMany(claims);
      throw error;
    }
  });
}

export function getWorkAllocation(db: Db, allocationId: string): AllocationSummary {
  const revision = db
    .prepare(`SELECT allocation_revision_id, workspace_id, cohort_from, cohort_to,
    evidence_as_of, report_status, frozen_record_count FROM work_allocation_revisions
    WHERE allocation_revision_id = ?`)
    .get(allocationId) as
    | {
        allocation_revision_id: string;
        workspace_id: string;
        cohort_from: string;
        cohort_to: string;
        evidence_as_of: string;
        report_status: "COMPLETE" | "PARTIAL";
        frozen_record_count: number;
      }
    | undefined;
  if (revision === undefined)
    throw new WorkRecordError(404, "NOT_FOUND", "allocation revision not found");
  const rows = db
    .prepare(`SELECT a.session_id,
      CASE WHEN t.work_record_id IS NOT NULL THEN 'DELETED_RECORD' ELSE a.owner_snapshot_id END AS owner_snapshot_id,
      a.disposition, a.priced_reconciled_cost_u AS priced_cost_u, a.priced_turn_count, a.unpriced_turn_count
    FROM work_session_allocations a LEFT JOIN work_record_tombstones t ON t.work_record_id = a.owner_snapshot_id
    WHERE a.allocation_revision_id = ? ORDER BY a.session_id`)
    .all(allocationId) as AllocationSummary["sessions"];
  const snapshots = db
    .prepare(`SELECT outcome_state, feedback_source, archived
    FROM work_allocation_record_snapshots WHERE allocation_revision_id = ?`)
    .all(allocationId) as Array<{
    outcome_state: OutcomeState;
    feedback_source: string;
    archived: number;
  }>;
  const outcome_counts: AllocationSummary["outcome_counts"] = {
    ACTIVE: 0,
    USEFUL: 0,
    PARTIAL: 0,
    UNSUCCESSFUL: 0,
    ABANDONED: 0,
    UNKNOWN: 0,
    UNREPORTED: 0,
  };
  for (const row of snapshots) {
    outcome_counts[row.outcome_state] += 1;
    if (row.feedback_source === "NONE") outcome_counts.UNREPORTED += 1;
  }
  const terminal = new Set(["USEFUL", "PARTIAL", "UNSUCCESSFUL", "ABANDONED"]);
  const allocated = rows.filter((row) => row.disposition === "OWNED");
  const eligibleCost = rows.reduce((sum, row) => sum + row.priced_cost_u, 0);
  const allocatedCost = allocated.reduce((sum, row) => sum + row.priced_cost_u, 0);
  const sourceDeleted = revision.frozen_record_count - snapshots.length;
  const reportedTerminal = snapshots.filter(
    (row) => row.feedback_source !== "NONE" && terminal.has(row.outcome_state),
  );
  const usefulCount = reportedTerminal.filter((row) => row.outcome_state === "USEFUL").length;
  const terminalIds = new Set(
    (
      db
        .prepare(`SELECT work_record_id FROM work_allocation_record_snapshots
      WHERE allocation_revision_id = ? AND feedback_source <> 'NONE'
        AND outcome_state IN ('USEFUL','PARTIAL','UNSUCCESSFUL','ABANDONED')`)
        .all(allocationId) as Array<{ work_record_id: string }>
    ).map((row) => row.work_record_id),
  );
  const terminalOwnedRows = rows.filter(
    (row) => typeof row.owner_snapshot_id === "string" && terminalIds.has(row.owner_snapshot_id),
  );
  const terminalOwnersWithCost = new Set(
    terminalOwnedRows.map((row) => row.owner_snapshot_id).filter((id): id is string => id !== null),
  );
  const terminalAttemptCost = terminalOwnedRows.reduce((sum, row) => sum + row.priced_cost_u, 0);
  const terminalSharedSessionCount = (
    db
      .prepare(`SELECT COUNT(DISTINCT a.session_id) AS n
      FROM work_session_allocations a
      JOIN work_record_session_links l ON l.session_id = a.session_id
      JOIN work_allocation_record_snapshots s
        ON s.allocation_revision_id = a.allocation_revision_id
       AND s.work_record_id = l.work_record_id
      WHERE a.allocation_revision_id = ? AND a.disposition <> 'OWNED'
        AND l.linked_at <= ? AND (l.unlinked_at IS NULL OR l.unlinked_at > ?)
        AND s.feedback_source <> 'NONE'
        AND s.outcome_state IN ('USEFUL','PARTIAL','UNSUCCESSFUL','ABANDONED')`)
      .get(allocationId, revision.evidence_as_of, revision.evidence_as_of) as { n: number }
  ).n;
  const terminalCostComplete =
    reportedTerminal.length === terminalOwnersWithCost.size &&
    terminalOwnedRows.every((row) => row.unpriced_turn_count === 0) &&
    terminalSharedSessionCount === 0;
  const ratio = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;
  return {
    allocation_revision_id: revision.allocation_revision_id,
    workspace_id: revision.workspace_id,
    cohort_from: revision.cohort_from,
    cohort_to: revision.cohort_to,
    evidence_as_of: revision.evidence_as_of,
    report_status: sourceDeleted > 0 ? "SOURCE_DELETED" : revision.report_status,
    eligible_session_count: rows.length,
    allocated_session_count: allocated.length,
    unallocated_ungrouped_count: rows.filter((row) => row.disposition === "UNALLOCATED_UNGROUPED")
      .length,
    unallocated_shared_count: rows.filter((row) => row.disposition === "UNALLOCATED_SHARED").length,
    eligible_priced_cost_u: eligibleCost,
    allocated_priced_cost_u: allocatedCost,
    unallocated_priced_cost_u: eligibleCost - allocatedCost,
    priced_turn_count: rows.reduce((sum, row) => sum + row.priced_turn_count, 0),
    unpriced_turn_count: rows.reduce((sum, row) => sum + row.unpriced_turn_count, 0),
    unpriced_session_count: rows.filter((row) => row.unpriced_turn_count > 0).length,
    records_total: snapshots.length,
    records_with_feedback: snapshots.filter((row) => row.feedback_source !== "NONE").length,
    reported_terminal_records: reportedTerminal.length,
    outcome_counts,
    archived_count: snapshots.filter((row) => row.archived === 1).length,
    source_deleted_count: sourceDeleted,
    useful_work_rate: {
      numerator: usefulCount,
      denominator: reportedTerminal.length,
      value: ratio(usefulCount, reportedTerminal.length),
    },
    feedback_coverage: {
      numerator: snapshots.filter((row) => row.feedback_source !== "NONE").length,
      denominator: snapshots.length,
      value: ratio(
        snapshots.filter((row) => row.feedback_source !== "NONE").length,
        snapshots.length,
      ),
    },
    allocation_session_coverage: {
      numerator: allocated.length,
      denominator: rows.length,
      value: ratio(allocated.length, rows.length),
    },
    allocation_cost_coverage: {
      numerator_u: allocatedCost,
      denominator_u: eligibleCost,
      value: ratio(allocatedCost, eligibleCost),
    },
    terminal_attempt_priced_cost_u: terminalAttemptCost,
    cost_per_useful_u:
      usefulCount > 0 && terminalCostComplete ? terminalAttemptCost / usefulCount : null,
    cost_per_useful_unavailable_reason:
      usefulCount === 0
        ? "NO_USEFUL_RECORDS"
        : terminalCostComplete
          ? null
          : "INCOMPLETE_COST_COVERAGE",
    sessions: rows,
  };
}
