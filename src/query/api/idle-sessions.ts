/** Fail-open idle background-session measurements for the local dashboard. */

import { capWeightExprSql, resolveCapReadCoeff } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { readHookConfig } from "./hook-config.js";

export interface IdleSession {
  session_id: string;
  workspace_id: string | null;
  last_activity_ts: string;
  idle_seconds: number;
  cap_weighted_tokens: number;
  sidechain: boolean;
}

interface IdleSessionRow {
  session_id: string;
  workspace_id: string | null;
  last_activity_ts: string;
  cap_weighted_raw: number;
}

function response(rows: IdleSession[]): ApiResponse<IdleSession[]> {
  return buildResponse(rows, { claim_kind: "OBS_PROXY", n: rows.length });
}

/**
 * Return idle sessions whose reconciled cap-weighted usage is dominated by
 * sidechain turns. This is display-only metadata: no session control occurs.
 */
export function getIdleSessions(): ApiResponse<IdleSession[]> {
  try {
    const db = getQueryDb();
    const config = readHookConfig(db);
    const expr = capWeightExprSql("t", resolveCapReadCoeff(db));
    const rawRows = db
      .prepare(
        `SELECT t.session_id AS session_id,
                MAX(t.workspace_id) AS workspace_id,
                MAX(t.ts) AS last_activity_ts,
                SUM(${expr}) AS cap_weighted_raw
           FROM turns t
          WHERE t.provisional = 0
          GROUP BY t.session_id
         HAVING SUM(CASE WHEN t.is_sidechain = 1 THEN ${expr} ELSE 0 END)
                  > SUM(${expr}) / 2`,
      )
      .all() as IdleSessionRow[];
    const now = Date.now();
    const rows: IdleSession[] = [];
    for (const row of rawRows) {
      const lastActivityMs = Date.parse(row.last_activity_ts);
      if (!Number.isFinite(lastActivityMs)) continue;
      const idleSeconds = Math.floor(Math.max(0, now - lastActivityMs) / 1_000);
      if (idleSeconds < config.d9_idle_seconds) continue;
      rows.push({
        session_id: row.session_id,
        workspace_id: row.workspace_id,
        last_activity_ts: row.last_activity_ts,
        idle_seconds: idleSeconds,
        cap_weighted_tokens: Math.round(row.cap_weighted_raw ?? 0),
        sidechain: true,
      });
    }
    return response(rows);
  } catch {
    return response([]);
  }
}
