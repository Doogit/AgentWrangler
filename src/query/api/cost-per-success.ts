/**
 * src/query/api/cost-per-success.ts — observed cost-per-delivery proxies.
 *
 * The merged-PR ratio intentionally uses lifecycle state='MERGED' only;
 * checks_conclusion is not required.
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface CostPerSuccess {
  merged_pr_count: number;
  closed_unmerged_count: number;
  cost_per_merged_pr_u: number | null;
  commit_session_count: number;
  cost_per_commit_session_u: number | null;
  linkage_coverage_pct: number | null;
  /** Unique linked sessions in the terminal-date merged-PR cohort. */
  unique_linked_session_count?: number;
  /** Of those unique sessions, count linked to more than one merged PR. */
  shared_linked_session_count?: number;
  n: number;
  window: { from: string; to: string };
}

interface CostPerSuccessRow {
  merged_pr_count: number;
  closed_unmerged_count: number;
  cost_per_merged_pr_u: number | null;
  commit_session_count: number;
  cost_per_commit_session_u: number | null;
  linkage_coverage_pct: number | null;
  unique_linked_session_count?: number;
  shared_linked_session_count?: number;
}

/**
 * Derive state-based delivery proxy metrics for the half-open [from, to) window.
 */
export function getCostPerSuccess(
  db: Db,
  workspaceId: string | null,
  from: string,
  to: string,
): ApiResponse<CostPerSuccess> {
  const workItemFilter = workspaceId === null ? "" : " AND wi.workspace_id = ?";
  const sessionFilter = workspaceId === null ? "" : " AND s.workspace_id = ?";
  const params =
    workspaceId === null
      ? [from, to, from, to, from, to]
      : [
          from,
          to,
          workspaceId,
          workspaceId,
          from,
          to,
          workspaceId,
          workspaceId,
          from,
          to,
          workspaceId,
          workspaceId,
        ];

  const row = db
    .prepare(
      `WITH merged_work_items AS (
         SELECT wi.work_item_id
           FROM work_items wi
          WHERE wi.state = 'MERGED'
            AND wi.merged_at >= ? AND wi.merged_at < ?${workItemFilter}
       ),
       closed_unmerged_work_items AS (
         SELECT wi.work_item_id
           FROM work_items wi
          WHERE wi.state = 'CLOSED'
            AND wi.closed_at >= ? AND wi.closed_at < ?${workItemFilter}
       ),
       merged_session_costs AS (
         SELECT DISTINCT s.session_id, s.cost_equiv_u
           FROM sessions s
           JOIN session_work_links swl ON swl.session_id = s.session_id
           JOIN merged_work_items mwi ON mwi.work_item_id = swl.work_item_id
          WHERE 1 = 1${sessionFilter}
       ),
       merged_session_links AS (
         SELECT swl.session_id, COUNT(DISTINCT swl.work_item_id) AS merged_pr_links
           FROM session_work_links swl
           JOIN merged_work_items mwi ON mwi.work_item_id = swl.work_item_id
           JOIN sessions s ON s.session_id = swl.session_id
          WHERE 1 = 1${sessionFilter}
          GROUP BY swl.session_id
       ),
       in_window_sessions AS (
         SELECT s.session_id, s.cost_equiv_u
           FROM sessions s
          WHERE s.first_turn_at >= ? AND s.first_turn_at < ?${sessionFilter}
       ),
       commit_sessions AS (
         SELECT iws.session_id, iws.cost_equiv_u
           FROM in_window_sessions iws
          WHERE EXISTS (
            SELECT 1
              FROM tool_events te
             WHERE te.session_id = iws.session_id
               AND te.commit_sha IS NOT NULL
          )
       )
       SELECT
         (SELECT COUNT(*) FROM merged_work_items) AS merged_pr_count,
         (SELECT COUNT(*) FROM closed_unmerged_work_items) AS closed_unmerged_count,
         (SELECT COUNT(*) FROM merged_session_links) AS unique_linked_session_count,
         (SELECT COUNT(*) FROM merged_session_links WHERE merged_pr_links > 1) AS shared_linked_session_count,
         CASE WHEN (SELECT COUNT(*) FROM merged_work_items) = 0 THEN NULL
              ELSE (SELECT COALESCE(SUM(cost_equiv_u), 0) FROM merged_session_costs) * 1.0
                   / (SELECT COUNT(*) FROM merged_work_items)
         END AS cost_per_merged_pr_u,
         (SELECT COUNT(*) FROM commit_sessions) AS commit_session_count,
         CASE WHEN (SELECT COUNT(*) FROM commit_sessions) = 0 THEN NULL
              ELSE (SELECT COALESCE(SUM(cost_equiv_u), 0) FROM commit_sessions) * 1.0
                   / (SELECT COUNT(*) FROM commit_sessions)
         END AS cost_per_commit_session_u,
         CASE WHEN (SELECT COUNT(*) FROM in_window_sessions) = 0 THEN NULL
              ELSE (SELECT COUNT(*)
                      FROM in_window_sessions iws
                     WHERE EXISTS (
                       SELECT 1
                         FROM session_work_links swl
                         JOIN work_items wi ON wi.work_item_id = swl.work_item_id
                        WHERE swl.session_id = iws.session_id${workItemFilter}
                     )) * 100.0 / (SELECT COUNT(*) FROM in_window_sessions)
         END AS linkage_coverage_pct`,
    )
    .get(...params) as CostPerSuccessRow;

  const data: CostPerSuccess = {
    ...row,
    n: row.merged_pr_count,
    window: { from, to },
  };

  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    metric_definition_version: "esf-1",
    n: data.merged_pr_count,
    window: { from, to },
    qualification: {
      provisional_excluded: false,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Directional (OBS_PROXY): Unique linked-session cost / merged PRs. The terminal-date PR cohort counts each linked session once, even when it links to multiple merged PRs; shared sessions are coverage, not per-PR allocation. Full linked-session lifecycle cost is used, while linkage_coverage_pct is a separate session-start coverage observation. Unknown pricing is not free. Survivorship bias and reviewer dependence remain.",
    },
    ...(workspaceId === null ? {} : { drilldown_ids: { workspace_id: workspaceId } }),
  });
}
