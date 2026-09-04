/**
 * src/query/api/outcomes.ts — LocalQueryAPI: outcomes surface.
 *
 * Mirrors settings.ts pattern: getQueryDb() + buildResponse + typed payload.
 *
 * All responses carry claim_kind:'EXPERIMENTAL' + the 73% methodology
 * disclosure (plan §3 + §6 Q2). COND-1 gate applied in denominators.
 *
 * 73% note: fixed "73% (validation corpus)" methodology disclosure shown
 * ALONGSIDE the live per-workspace getLinkageRate number — never conflated.
 *
 * SQL references: Data Model v2 §2 lines 261-275 / 303-314 / 329-334.
 */

import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

// ---------------------------------------------------------------------------
// Methodology disclosure (fixed — plan §6 Q2)
// ---------------------------------------------------------------------------

const LINKAGE_METHODOLOGY_NOTE =
  "73% (validation corpus): linkage methodology validated on a sample corpus. " +
  "Live linkage rate is per-workspace and shown separately in getLinkageRate. " +
  "All findings are EXPERIMENTAL and excluded from gated denominators (COND-1).";

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** Outcome counts + success rate for the global dashboard card. */
export interface SuccessRateData {
  terminal_n: number;
  success_rate: number | null;
  clean_success_n: number;
  with_deferrals_n: number;
  no_ci_success_n: number;
  linkage_rate: number | null;
  methodology_note: string;
}

/** Per-workspace outcome summary row. */
export interface WorkspaceOutcomeSummary {
  workspace_id: string;
  project_slug: string;
  total_n: number;
  in_progress_n: number;
  terminal_n: number;
  success_n: number;
  failure_n: number;
  success_rate: number | null;
  linkage_rate: number | null;
  /** Existing D4 proxy: 100 minus Opus share over non-sidechain, non-provisional turns. */
  adherence_score: number | null;
}

/** Detail for a single work item. */
export interface WorkItemDetail {
  work_item_id: string;
  number: number;
  state: string;
  outcome: string | null;
  checks_conclusion: string | null;
  merged_at: string | null;
  closed_at: string | null;
  findings: FindingSummary[];
  linked_sessions: string[];
}

export interface FindingSummary {
  finding_id: string;
  source: string;
  severity: string | null;
  status: string;
  evidence_ref: string;
  raised_at: string;
  cleared_at: string | null;
  extractor_version: string;
}

/** Linkage rate result. */
export interface LinkageRateData {
  linkage_rate: number | null;
  denominator_n: number;
  methodology_note: string;
}

// ---------------------------------------------------------------------------
// Helper: experimental envelope meta
// ---------------------------------------------------------------------------

function experimentalMeta(n: number, from?: string) {
  const now = new Date().toISOString();
  return {
    claim_kind: "EXPERIMENTAL" as const,
    n,
    window: { from: from ?? "1970-01-01T00:00:00Z", to: now },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: LINKAGE_METHODOLOGY_NOTE,
    },
  };
}

// ---------------------------------------------------------------------------
// getSuccessRate
// ---------------------------------------------------------------------------

/**
 * Return the global observed success rate.
 * Denominator: terminal (non-IN_PROGRESS) work_items with ≥1 session_work_links.
 * COND-1: findings from EXPERIMENTAL extractors excluded from deferral check.
 */
export function getSuccessRate(): ApiResponse<SuccessRateData> {
  const db = getQueryDb();

  const now = new Date().toISOString();
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // SQL from Data Model v2 §2 lines 261-275
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS terminal_n,
         AVG(outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')) AS success_rate,
         SUM(outcome = 'OBSERVED_SUCCESS')                AS clean_success_n,
         SUM(outcome = 'OBSERVED_SUCCESS_WITH_DEFERRALS') AS with_deferrals_n,
         SUM(outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')
             AND wi.checks_conclusion = 'NONE')           AS no_ci_success_n
       FROM observed_outcomes o JOIN work_items wi USING (work_item_id)
       WHERE o.outcome != 'IN_PROGRESS'
         AND COALESCE(wi.merged_at, wi.closed_at) >= ?
         AND COALESCE(wi.merged_at, wi.closed_at) <  ?
         AND EXISTS (SELECT 1 FROM session_work_links l WHERE l.work_item_id = o.work_item_id)`,
    )
    .get(windowStart, now) as
    | {
        terminal_n: number;
        success_rate: number | null;
        clean_success_n: number;
        with_deferrals_n: number;
        no_ci_success_n: number;
      }
    | undefined;

  // SQL from Data Model v2 §2 lines 329-334
  const lrRow = db
    .prepare(
      `SELECT AVG(EXISTS(SELECT 1 FROM session_work_links l WHERE l.session_id = s.session_id))
              AS linkage_rate
       FROM sessions s WHERE s.state='RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id
                    AND te.tool_name = 'Bash')`,
    )
    .get() as { linkage_rate: number | null } | undefined;

  if (row === undefined || row.terminal_n === 0) {
    const data: SuccessRateData = {
      terminal_n: 0,
      success_rate: null,
      clean_success_n: 0,
      with_deferrals_n: 0,
      no_ci_success_n: 0,
      linkage_rate: lrRow?.linkage_rate ?? null,
      methodology_note: LINKAGE_METHODOLOGY_NOTE,
    };
    return buildResponse(data, experimentalMeta(0, windowStart));
  }

  const data: SuccessRateData = {
    terminal_n: row.terminal_n,
    success_rate: row.success_rate,
    clean_success_n: row.clean_success_n,
    with_deferrals_n: row.with_deferrals_n,
    no_ci_success_n: row.no_ci_success_n,
    linkage_rate: lrRow?.linkage_rate ?? null,
    methodology_note: LINKAGE_METHODOLOGY_NOTE,
  };

  return buildResponse(data, experimentalMeta(row.terminal_n, windowStart));
}

// ---------------------------------------------------------------------------
// listWorkspaceOutcomes
// ---------------------------------------------------------------------------

/**
 * Return per-workspace outcome summaries.
 */
export function listWorkspaceOutcomes(): ApiResponse<WorkspaceOutcomeSummary[]> {
  const db = getQueryDb();

  const rows = db
    .prepare(
      `WITH linked_items AS (
         SELECT wi.*, o.outcome
           FROM work_items wi
           LEFT JOIN observed_outcomes o ON o.work_item_id = wi.work_item_id
          WHERE EXISTS (
            SELECT 1 FROM session_work_links l WHERE l.work_item_id = wi.work_item_id
          )
       )
       SELECT w.workspace_id, w.project_slug,
              COUNT(li.work_item_id) AS total_n,
              SUM(CASE WHEN li.state = 'OPEN' THEN 1 ELSE 0 END) AS in_progress_n,
              SUM(CASE WHEN li.state IN ('MERGED', 'CLOSED') THEN 1 ELSE 0 END) AS terminal_n,
              SUM(CASE WHEN li.outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')
                       THEN 1 ELSE 0 END) AS success_n,
              SUM(CASE WHEN li.outcome = 'OBSERVED_FAILURE' THEN 1 ELSE 0 END) AS failure_n
       FROM workspaces w
       LEFT JOIN linked_items li ON li.workspace_id = w.workspace_id
       GROUP BY w.workspace_id, w.project_slug
       ORDER BY w.project_slug, w.workspace_id`,
    )
    .all() as Array<{
    workspace_id: string;
    project_slug: string;
    total_n: number;
    in_progress_n: number;
    terminal_n: number;
    success_n: number;
    failure_n: number;
  }>;

  // Compute per-workspace linkage rates
  const lrRows = db
    .prepare(
      `SELECT s.workspace_id,
              AVG(EXISTS(SELECT 1 FROM session_work_links l WHERE l.session_id = s.session_id))
              AS linkage_rate
       FROM sessions s WHERE s.state='RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id
                    AND te.tool_name = 'Bash')
       GROUP BY s.workspace_id`,
    )
    .all() as Array<{ workspace_id: string; linkage_rate: number | null }>;

  const lrByWs = new Map(lrRows.map((r) => [r.workspace_id, r.linkage_rate]));

  const adherenceRows = db
    .prepare(
      `SELECT workspace_id, COUNT(*) AS n,
              AVG(CASE WHEN model LIKE '%opus%' THEN 1.0 ELSE 0.0 END) AS premium_share
         FROM turns
        WHERE is_sidechain = 0 AND provisional = 0
        GROUP BY workspace_id`,
    )
    .all() as Array<{ workspace_id: string; n: number; premium_share: number | null }>;
  const adherenceByWs = new Map(
    adherenceRows.map((r) => [
      r.workspace_id,
      r.n > 0 && r.premium_share !== null ? Math.round(100 * (1 - r.premium_share)) : null,
    ]),
  );

  const data: WorkspaceOutcomeSummary[] = rows.map((r) => ({
    ...r,
    success_rate: r.terminal_n > 0 ? r.success_n / r.terminal_n : null,
    linkage_rate: lrByWs.get(r.workspace_id) ?? null,
    adherence_score: adherenceByWs.get(r.workspace_id) ?? null,
  }));

  return buildResponse(data, experimentalMeta(data.length));
}

// ---------------------------------------------------------------------------
// getWorkspaceOutcomeDetail
// ---------------------------------------------------------------------------

/**
 * Return detail for a single work item (findings + linked sessions).
 */
export function getWorkspaceOutcomeDetail(workItemId: string): ApiResponse<WorkItemDetail | null> {
  const db = getQueryDb();

  const wi = db
    .prepare(
      `SELECT wi.work_item_id, wi.number, wi.state, wi.checks_conclusion,
              wi.merged_at, wi.closed_at, o.outcome
       FROM work_items wi
       LEFT JOIN observed_outcomes o USING (work_item_id)
       WHERE wi.work_item_id = ?`,
    )
    .get(workItemId) as
    | {
        work_item_id: string;
        number: number;
        state: string;
        checks_conclusion: string | null;
        merged_at: string | null;
        closed_at: string | null;
        outcome: string | null;
      }
    | undefined;

  if (wi === undefined) {
    return buildResponse(null, experimentalMeta(0));
  }

  const findings = db
    .prepare(
      `SELECT finding_id, source, severity, status, evidence_ref,
              raised_at, cleared_at, extractor_version
       FROM review_findings WHERE work_item_id = ? ORDER BY raised_at`,
    )
    .all(workItemId) as FindingSummary[];

  const linkedSessions = (
    db
      .prepare("SELECT session_id FROM session_work_links WHERE work_item_id = ?")
      .all(workItemId) as Array<{ session_id: string }>
  ).map((r) => r.session_id);

  const data: WorkItemDetail = {
    ...wi,
    findings,
    linked_sessions: linkedSessions,
  };

  return buildResponse(data, experimentalMeta(1));
}

// ---------------------------------------------------------------------------
// getLinkageRate
// ---------------------------------------------------------------------------

/**
 * Return the live linkage rate (per §6 Q2: separate from the 73% disclosure).
 * SQL from Data Model v2 §2 lines 329-334.
 */
export function getLinkageRate(workspaceId?: string): ApiResponse<LinkageRateData> {
  const db = getQueryDb();

  const whereExtra = workspaceId !== undefined ? " AND s.workspace_id = ?" : "";
  const params: string[] = workspaceId !== undefined ? [workspaceId] : [];

  const row = db
    .prepare(
      `SELECT AVG(EXISTS(SELECT 1 FROM session_work_links l WHERE l.session_id = s.session_id))
              AS linkage_rate,
              COUNT(*) AS denominator_n
       FROM sessions s WHERE s.state='RECONCILED'
         AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id
                    AND te.tool_name = 'Bash')${whereExtra}`,
    )
    .get(...params) as { linkage_rate: number | null; denominator_n: number } | undefined;

  const data: LinkageRateData = {
    linkage_rate: row?.linkage_rate ?? null,
    denominator_n: row?.denominator_n ?? 0,
    methodology_note:
      "Live per-workspace linkage rate. Denominator: RECONCILED sessions with ≥1 Bash tool_event. " +
      "See also the fixed 73% validation corpus disclosure in getSuccessRate.",
  };

  return buildResponse(data, {
    ...experimentalMeta(data.denominator_n),
    ...(workspaceId !== undefined ? { drilldown_ids: { workspace_id: workspaceId } } : {}),
  });
}
