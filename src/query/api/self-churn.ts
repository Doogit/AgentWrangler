/**
 * src/query/api/self-churn.ts — query-only L2b self-churn metrics.
 *
 * Self-churn measures later changes to session-authored lines using structural
 * commit data only; no source text, paths, or diff content leave this surface.
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import type { DeliveryQueryOpts } from "./delivery.js";

export type SelfChurnQueryOpts = DeliveryQueryOpts;

export interface SelfChurnMetrics {
  session_count: number;
  measured_session_count: number;
  authored_lines_total: number;
  churned_lines_total: number;
  churn_ratio: number | null;
  commit_shas: string[];
  from: string;
  to: string;
  workspace_id: string | null;
}

interface SelfChurnTotalsRow {
  session_count: number;
  measured_session_count: number;
  authored_lines_total: number;
  churned_lines_total: number;
}

/**
 * Derive 14-day self-churn for sessions with turns in [from, to).
 *
 * A LEFT JOIN keeps in-window sessions that have no session_churn row yet (new
 * sessions accumulate before the churn collector runs); the DB aggregates in one
 * pass. Commit SHAs come from a second scan over the measured sessions only —
 * one JSON array per session unioned into a set.
 */
export function getSelfChurn(db: Db, opts: SelfChurnQueryOpts): ApiResponse<SelfChurnMetrics> {
  const workspaceFilter = opts.workspaceId === null ? "" : " AND t.workspace_id = ?";
  const params =
    opts.workspaceId === null ? [opts.from, opts.to] : [opts.from, opts.to, opts.workspaceId];

  const inWindow = `WITH in_window_turns AS (
         SELECT t.session_id, t.workspace_id
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ?${workspaceFilter}
       ),
       in_window_sessions AS (
         SELECT DISTINCT session_id, workspace_id
           FROM in_window_turns
       )`;

  const totals = db
    .prepare(
      `${inWindow}
       SELECT COUNT(*) AS session_count,
              COALESCE(SUM(CASE WHEN sc.status != 'NO_REPO' AND sc.authored_lines > 0 THEN 1 ELSE 0 END), 0)
                AS measured_session_count,
              COALESCE(SUM(sc.authored_lines), 0) AS authored_lines_total,
              COALESCE(SUM(sc.churned_lines), 0) AS churned_lines_total
         FROM in_window_sessions iws
         LEFT JOIN session_churn sc USING (session_id)`,
    )
    .get(...params) as SelfChurnTotalsRow;

  const shaRows = db
    .prepare(
      `${inWindow}
       SELECT sc.commit_shas
         FROM in_window_sessions iws
         JOIN session_churn sc USING (session_id)
        WHERE sc.status != 'NO_REPO' AND sc.authored_lines > 0`,
    )
    .all(...params) as Array<{ commit_shas: string }>;

  const commitShas = new Set<string>();
  for (const row of shaRows) {
    const shas: unknown = JSON.parse(row.commit_shas);
    if (Array.isArray(shas)) {
      for (const sha of shas) {
        if (typeof sha === "string") commitShas.add(sha);
      }
    }
  }

  const data: SelfChurnMetrics = {
    ...totals,
    churn_ratio:
      totals.authored_lines_total === 0
        ? null
        : totals.churned_lines_total / totals.authored_lines_total,
    commit_shas: [...commitShas].sort(),
    from: opts.from,
    to: opts.to,
    workspace_id: opts.workspaceId,
  };

  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: data.measured_session_count,
    window: { from: opts.from, to: opts.to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "14-day self-churn of session-authored commits (structural proxy).",
    },
    ...(opts.workspaceId === null ? {} : { drilldown_ids: { workspace_id: opts.workspaceId } }),
  });
}
