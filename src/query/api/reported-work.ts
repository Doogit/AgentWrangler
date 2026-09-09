import type { Db } from "../../db/open.js";
import { OUTCOME_STATES, type OutcomeState } from "../../work-records/types.js";
import { workRecordResponse } from "./work-records.js";

export interface ReportedWorkSummary {
  workspace_id: string | null;
  as_of: string;
  records_total: number;
  archived_count: number;
  reported: number;
  useful: number;
  reported_terminal: number;
  outcome_counts: Record<OutcomeState | "UNREPORTED", number>;
}

/** Current retained records, deliberately independent of spend/allocation windows. */
export function getReportedWork(db: Db, workspaceId: string | null, now = new Date()) {
  const rows = db
    .prepare(`SELECT r.outcome_state, r.feedback_source, wr.archived_at,
    wr.created_at FROM work_records wr JOIN work_record_revisions r
    ON r.work_record_id = wr.work_record_id AND r.revision_no = wr.current_revision_no
    WHERE (? IS NULL OR wr.workspace_id = ?)`)
    .all(workspaceId, workspaceId) as Array<{
    outcome_state: OutcomeState;
    feedback_source: string;
    archived_at: string | null;
    created_at: string;
  }>;
  const counts = Object.fromEntries(
    [...OUTCOME_STATES, "UNREPORTED"].map((key) => [key, 0]),
  ) as ReportedWorkSummary["outcome_counts"];
  let archived = 0;
  for (const row of rows) {
    if (row.archived_at !== null) {
      archived++;
    }
    counts[row.feedback_source === "NONE" ? "UNREPORTED" : row.outcome_state]++;
  }
  const total = rows.length;
  const asOf = now.toISOString();
  const data: ReportedWorkSummary = {
    workspace_id: workspaceId,
    as_of: asOf,
    records_total: total,
    archived_count: archived,
    reported: total - counts.UNREPORTED,
    useful: counts.USEFUL,
    reported_terminal: counts.USEFUL + counts.PARTIAL + counts.UNSUCCESSFUL + counts.ABANDONED,
    outcome_counts: counts,
  };
  const from = rows.reduce(
    (earliest, row) => (row.created_at < earliest ? row.created_at : earliest),
    asOf,
  );
  return workRecordResponse(data, {
    n: total,
    claimKind: "EXPERIMENTAL",
    meta: {
      window: { from, to: new Date(now.getTime() + 1).toISOString() },
      drilldown_ids: workspaceId === null ? {} : { workspace_id: workspaceId },
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 0,
        note: "All current retained non-deleted records as of read time. Window describes record retention, not selected spend or a frozen allocation. Feedback is user-reported; deleted records are absent.",
      },
    },
  });
}
