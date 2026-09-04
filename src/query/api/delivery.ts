/**
 * src/query/api/delivery.ts — query-only L2a delivery metrics.
 *
 * Delivery is inferred from the presence of a harvested commit SHA; SHA values
 * never leave the database through this query surface.
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface DeliveryQueryOpts {
  /** null = global (all workspaces). */
  workspaceId: string | null;
  /** ISO-8601 window bounds (inclusive lower, exclusive upper). */
  from: string;
  to: string;
}

export interface DeliveryMetrics {
  commit_session_count: number;
  total_session_count: number;
  commit_session_rate: number | null;
  spend_per_commit_session_u: number | null;
  abandoned_spend_u: number;
  abandoned_spend_share: number | null;
  from: string;
  to: string;
  workspace_id: string | null;
}

interface DeliveryMetricsRow {
  commit_session_count: number;
  total_session_count: number;
  commit_session_rate: number | null;
  spend_per_commit_session_u: number | null;
  abandoned_spend_u: number;
  abandoned_spend_share: number | null;
}

/**
 * Derive delivery proxy metrics for sessions with turns in [from, to).
 *
 * Reconciled turns only contribute to money figures. Sessions without tool
 * events still count in the total and total-spend denominator, but are neither
 * commit nor abandoned sessions.
 */
export function getDeliveryMetrics(db: Db, opts: DeliveryQueryOpts): ApiResponse<DeliveryMetrics> {
  const workspaceFilter = opts.workspaceId === null ? "" : " AND t.workspace_id = ?";
  const params =
    opts.workspaceId === null ? [opts.from, opts.to] : [opts.from, opts.to, opts.workspaceId];

  const row = db
    .prepare(
      `WITH in_window_turns AS (
         SELECT t.session_id, t.workspace_id, t.cost_equiv_u, t.provisional
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ?${workspaceFilter}
       ),
       in_window_sessions AS (
         SELECT DISTINCT session_id, workspace_id
           FROM in_window_turns
       ),
       session_flags AS (
         SELECT iws.session_id,
                EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.commit_sha IS NOT NULL
                ) AS is_commit_session,
                EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.tool_name IN ('Bash', 'Write', 'Edit', 'NotebookEdit')
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.commit_sha IS NOT NULL
                ) AS is_abandoned_session
           FROM in_window_sessions iws
       ),
       session_spend AS (
         SELECT session_id,
                COALESCE(SUM(CASE WHEN provisional = 0 THEN cost_equiv_u END), 0) AS spend_u
           FROM in_window_turns
          GROUP BY session_id
       )
       SELECT COALESCE(SUM(sf.is_commit_session), 0) AS commit_session_count,
              COUNT(sf.session_id) AS total_session_count,
              CASE WHEN COUNT(sf.session_id) = 0 THEN NULL
                   ELSE SUM(sf.is_commit_session) * 1.0 / COUNT(sf.session_id)
              END AS commit_session_rate,
              CASE WHEN SUM(sf.is_commit_session) = 0 THEN NULL
                   ELSE SUM(CASE WHEN sf.is_commit_session THEN ss.spend_u ELSE 0 END) * 1.0
                        / SUM(sf.is_commit_session)
              END AS spend_per_commit_session_u,
              COALESCE(SUM(CASE WHEN sf.is_abandoned_session THEN ss.spend_u ELSE 0 END), 0)
                AS abandoned_spend_u,
              CASE WHEN COALESCE(SUM(ss.spend_u), 0) = 0 THEN NULL
                   ELSE SUM(CASE WHEN sf.is_abandoned_session THEN ss.spend_u ELSE 0 END) * 1.0
                        / SUM(ss.spend_u)
              END AS abandoned_spend_share
         FROM session_flags sf
         JOIN session_spend ss USING (session_id)`,
    )
    .get(...params) as DeliveryMetricsRow;

  const data: DeliveryMetrics = {
    ...row,
    from: opts.from,
    to: opts.to,
    workspace_id: opts.workspaceId,
  };

  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: data.commit_session_count,
    window: { from: opts.from, to: opts.to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Commit SHA presence is an observed delivery proxy.",
    },
    ...(opts.workspaceId === null ? {} : { drilldown_ids: { workspace_id: opts.workspaceId } }),
  });
}
