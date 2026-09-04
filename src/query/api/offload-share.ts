/**
 * src/query/api/offload-share.ts — query-only L2c subagent offload metrics.
 *
 * Offload share uses structural turn counts only; no transcript, tool text,
 * or paths leave this surface (SEC-101).
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import type { DeliveryQueryOpts } from "./delivery.js";

export type OffloadShareQueryOpts = DeliveryQueryOpts;

export interface OffloadShareMetrics {
  session_count: number;
  sidechain_session_count: number;
  total_turns: number;
  sidechain_turns: number;
  offload_share: number | null;
  from: string;
  to: string;
  workspace_id: string | null;
}

interface OffloadShareTotalsRow {
  session_count: number;
  sidechain_session_count: number;
  total_turns: number;
  sidechain_turns: number;
}

/**
 * Derive subagent offload share for non-provisional turns in [from, to).
 */
export function getOffloadShare(
  db: Db,
  opts: OffloadShareQueryOpts,
): ApiResponse<OffloadShareMetrics> {
  const workspaceFilter = opts.workspaceId === null ? "" : " AND workspace_id = ?";
  const params =
    opts.workspaceId === null ? [opts.from, opts.to] : [opts.from, opts.to, opts.workspaceId];

  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) AS session_count,
              COUNT(DISTINCT CASE WHEN is_sidechain = 1 THEN session_id END) AS sidechain_session_count,
              COUNT(*) AS total_turns,
              COALESCE(SUM(CASE WHEN is_sidechain = 1 THEN 1 ELSE 0 END), 0) AS sidechain_turns
         FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0${workspaceFilter}`,
    )
    .get(...params) as OffloadShareTotalsRow;

  const data: OffloadShareMetrics = {
    ...totals,
    offload_share: totals.total_turns === 0 ? null : totals.sidechain_turns / totals.total_turns,
    from: opts.from,
    to: opts.to,
    workspace_id: opts.workspaceId,
  };

  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: data.total_turns,
    window: { from: opts.from, to: opts.to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Within-session subagent offload share: is_sidechain turns / all turns (structural).",
    },
    ...(opts.workspaceId === null ? {} : { drilldown_ids: { workspace_id: opts.workspaceId } }),
  });
}
