/**
 * src/query/spend.ts — spend-path metric SQL (metric_definition_version = 'observe-1').
 *
 * Pure query building blocks over a better-sqlite3 handle. Each takes explicit
 * window / cutoff parameters so callers (and tests) control time boundaries with
 * no hidden `now()`. The API-method wrappers in api/overview.ts resolve the
 * window/cutoff and attach the response envelope.
 *
 * Rules encoded here (Data Model v2 §3):
 *  - cost figures keep micro-USD integer precision; only per-turn/USD outputs
 *    divide by 1e6.
 *  - `cost_claim` kinds are surfaced, never silently mixed (COUNT(DISTINCT ...)).
 *  - reconciled (spend) aggregates exclude provisional turns; context-per-turn
 *    and the live strip deliberately include them (a documented difference).
 */

import type { Db } from "../db/open.js";

// ---------------------------------------------------------------------------
// spend-by-workspace
// ---------------------------------------------------------------------------

export interface WorkspaceSpendRow {
  workspace_id: string;
  project_slug: string;
  /** Local checkout path from the workspaces mapping, or null. */
  repo_path: string | null;
  /** Canonical GitHub owner from the workspaces mapping, or null. */
  repo_owner: string | null;
  /** Canonical GitHub repo name from the workspaces mapping, or null. */
  repo_name: string | null;
  /** SUM(cost_equiv_u) micro-USD, reconciled turns only (NULL costs excluded from sum). */
  cost_equiv_u: number;
  input_tok: number;
  output_tok: number;
  cache_read_tok: number;
  /** SUM(cw5m + cw1h + cw_other) — kept SEPARATE from cache_read_tok. */
  cache_write_tok: number;
  turns: number;
  unpriced_turns: number;
  /** COUNT(DISTINCT cost_claim) — >1 means mixed claim kinds (guard, never sum silently). */
  claim_kinds: number;
}

/**
 * Spend grouped by workspace over [tFrom, tTo), reconciled turns only.
 * ORDER BY cost_equiv_usd DESC (i.e., SUM(cost_equiv_u) DESC).
 */
export function spendByWorkspace(db: Db, tFrom: string, tTo: string): WorkspaceSpendRow[] {
  return db
    .prepare(
      `SELECT w.workspace_id                                         AS workspace_id,
              w.project_slug                                         AS project_slug,
              w.repo_path                                            AS repo_path,
              w.repo_owner                                           AS repo_owner,
              w.repo_name                                            AS repo_name,
              COALESCE(SUM(t.cost_equiv_u), 0)                       AS cost_equiv_u,
              COALESCE(SUM(t.input_tokens), 0)                       AS input_tok,
              COALESCE(SUM(t.output_tokens), 0)                      AS output_tok,
              COALESCE(SUM(t.cache_read_tokens), 0)                  AS cache_read_tok,
              COALESCE(SUM(t.cache_write_5m + t.cache_write_1h
                           + t.cache_write_other), 0)               AS cache_write_tok,
              COUNT(*)                                               AS turns,
              SUM(t.cost_equiv_u IS NULL)                            AS unpriced_turns,
              COUNT(DISTINCT t.cost_claim)                           AS claim_kinds
         FROM turns t JOIN workspaces w USING (workspace_id)
        WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
        GROUP BY w.workspace_id
        ORDER BY cost_equiv_u DESC, w.workspace_id ASC`,
    )
    .all(tFrom, tTo) as WorkspaceSpendRow[];
}

// ---------------------------------------------------------------------------
// global spend
// ---------------------------------------------------------------------------

export interface GlobalSpendRow {
  /** SUM(cost_equiv_u) micro-USD over reconciled turns. */
  cost_equiv_u: number;
  /** Reconciled turn count. */
  turns: number;
  /** Turn count including provisional. */
  turns_total: number;
  /** Reconciled turns with NULL cost. */
  unpriced_turns: number;
  /** Distinct cost_claim kinds among reconciled turns (>1 = mixed guard). */
  claim_kinds: number;
}

/** Global spend aggregate over [tFrom, tTo). Reconciled unless noted per column. */
export function globalSpend(db: Db, tFrom: string, tTo: string): GlobalSpendRow {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN provisional = 0 THEN cost_equiv_u END), 0) AS cost_equiv_u,
              SUM(CASE WHEN provisional = 0 THEN 1 ELSE 0 END)                  AS turns,
              COUNT(*)                                                         AS turns_total,
              SUM(CASE WHEN provisional = 0 AND cost_equiv_u IS NULL
                       THEN 1 ELSE 0 END)                                      AS unpriced_turns,
              COUNT(DISTINCT CASE WHEN provisional = 0 THEN cost_claim END)    AS claim_kinds
         FROM turns
        WHERE ts >= ? AND ts < ?`,
    )
    .get(tFrom, tTo) as GlobalSpendRow;
  return row;
}

/**
 * Whether any reconciled turn in the window carries a stale claim.
 * Used to choose the response's claim_kind (LIST_EQUIV vs LIST_EQUIV_STALE).
 */
export function hasStaleClaim(db: Db, tFrom: string, tTo: string, workspaceId?: string): boolean {
  const base = `SELECT 1 FROM turns
                 WHERE ts >= ? AND ts < ? AND provisional = 0
                   AND cost_claim = 'LIST_EQUIV_STALE'`;
  const row = workspaceId
    ? db.prepare(`${base} AND workspace_id = ? LIMIT 1`).get(tFrom, tTo, workspaceId)
    : db.prepare(`${base} LIMIT 1`).get(tFrom, tTo);
  return row !== undefined;
}

/** Count LIVE sessions whose last_turn_at is at or after the activity cutoff. */
export function liveSessionCount(db: Db, activityCutoff: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'LIVE' AND last_turn_at >= ?")
    .get(activityCutoff) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// context-per-turn by model (+ model-mix)
// ---------------------------------------------------------------------------

export interface ContextPerTurnRow {
  model: string;
  n: number;
  avg_context_per_turn: number;
  avg_output_per_turn: number;
  /** SUM(cost_equiv_u)/COUNT/1e6 USD; null when the model's turns are all unpriced. */
  usd_per_turn: number | null;
}

/**
 * Context per turn grouped by model over [tFrom, tTo).
 * GUARD: window only — deliberately does NOT filter provisional (differs from
 * spend). Claim kind OBS_PROXY. Ordered by turn count desc for stable output.
 */
export function contextPerTurnByModel(db: Db, tFrom: string, tTo: string): ContextPerTurnRow[] {
  return db
    .prepare(
      `SELECT model                                          AS model,
              COUNT(*)                                        AS n,
              AVG(context_tokens)                             AS avg_context_per_turn,
              AVG(output_tokens)                              AS avg_output_per_turn,
              SUM(cost_equiv_u) * 1.0 / COUNT(*) / 1e6        AS usd_per_turn
         FROM turns
        WHERE ts >= ? AND ts < ?
        GROUP BY model
        ORDER BY n DESC, model ASC`,
    )
    .all(tFrom, tTo) as ContextPerTurnRow[];
}

// ---------------------------------------------------------------------------
// live strip
// ---------------------------------------------------------------------------

export interface LiveSessionRow {
  session_id: string;
  workspace_id: string;
  project_slug: string;
  /** Local checkout path from the workspaces mapping, or null. */
  repo_path: string | null;
  /** Canonical GitHub owner from the workspaces mapping, or null. */
  repo_owner: string | null;
  /** Canonical GitHub repo name from the workspaces mapping, or null. */
  repo_name: string | null;
  /** On-demand SUM over the session's turns (micro-USD). Includes provisional. */
  running_usd_u: number;
  /** Latest turn's context_tokens (correlated subquery, ORDER BY ts DESC LIMIT 1). */
  current_context_tokens: number;
  /** Latest turn's model. */
  model: string;
  started_at: string | null;
}

/**
 * LIVE sessions active at/after `activityCutoff`.
 *
 * running_usd_u is computed by an on-demand SUM over the session's turns at
 * query time — NOT read from sessions.cost_equiv_u, which WP1 only maintains at
 * reconcile/close and is therefore unreliable for mid-flight LIVE sessions.
 * Provisional turns are intentionally included here (this is the live view).
 */
export function liveSessions(db: Db, activityCutoff: string): LiveSessionRow[] {
  return db
    .prepare(
      `SELECT s.session_id                                   AS session_id,
              s.workspace_id                                 AS workspace_id,
              w.project_slug                                 AS project_slug,
              w.repo_path                                    AS repo_path,
              w.repo_owner                                   AS repo_owner,
              w.repo_name                                    AS repo_name,
              COALESCE((SELECT SUM(t.cost_equiv_u) FROM turns t
                         WHERE t.session_id = s.session_id), 0)          AS running_usd_u,
              COALESCE((SELECT tt.context_tokens FROM turns tt
                         WHERE tt.session_id = s.session_id
                         ORDER BY tt.ts DESC LIMIT 1), 0)                AS current_context_tokens,
              COALESCE((SELECT tm.model FROM turns tm
                         WHERE tm.session_id = s.session_id
                         ORDER BY tm.ts DESC LIMIT 1), '')               AS model,
              s.first_turn_at                                AS started_at
         FROM sessions s JOIN workspaces w USING (workspace_id)
        WHERE s.state = 'LIVE' AND s.last_turn_at >= ?
        ORDER BY s.last_turn_at DESC, s.session_id ASC`,
    )
    .all(activityCutoff) as LiveSessionRow[];
}

// ---------------------------------------------------------------------------
// hot sessions by cost
// ---------------------------------------------------------------------------

export interface HotSessionRow {
  session_id: string;
  workspace_id: string;
  turns: number;
  cost_equiv_u: number;
  total_output_tokens: number;
  avg_output_tokens: number;
  total_context_tokens: number;
  avg_context_tokens: number;
  model: string;
  last_turn_at: string;
  /** RV2b friction fields — counts from sessions + tool_events; 0 for pre-RV2a rows. */
  api_error_count: number;
  compaction_count: number;
  interrupt_count: number;
  user_turn_count: number;
  tool_error_count: number;
  test_fail_count: number;
  /** EF3 gap aggregates from the sessions table (post-migration-015). Null when <2 user turns. */
  gap_median_s: number | null;
  gap_p90_s: number | null;
  long_gap_count: number;
  gap_n: number;
}

/**
 * Sessions ranked by total list-equivalent cost across all turns.
 *
 * This deliberately includes provisional turns and applies no turn-count or
 * average-context threshold: the view is a cost ranking, not a thresholded
 * context-pressure detector.
 */
export function hotSessionsByCost(
  db: Db,
  limit = 20,
  window?: { from: string; to: string },
): HotSessionRow[] {
  // Optional window bounds the JOINed turns to [from, to); absent = all-time
  // (preserves the /api/hot-sessions default). Matches the `t.ts >= ? AND t.ts < ?`
  // string-bound convention used by globalSpend and the other spend queries.
  const turnWindow = window === undefined ? "" : "AND t.ts >= @from AND t.ts < @to";
  const rows = db
    .prepare(
      `SELECT s.session_id                                                   AS session_id,
              s.workspace_id                                                 AS workspace_id,
              COUNT(*)                                                        AS turns,
              COALESCE(SUM(t.cost_equiv_u), 0)                                AS cost_equiv_u,
              COALESCE(SUM(t.output_tokens), 0)                               AS total_output_tokens,
              ROUND(COALESCE(SUM(t.output_tokens), 0) * 1.0 / COUNT(*))       AS avg_output_tokens,
              COALESCE(SUM(t.context_tokens), 0)                              AS total_context_tokens,
              ROUND(COALESCE(SUM(t.context_tokens), 0) * 1.0 / COUNT(*))      AS avg_context_tokens,
              COALESCE((SELECT tm.model FROM turns tm
                         WHERE tm.session_id = s.session_id
                         GROUP BY tm.model
                         ORDER BY COUNT(*) DESC, tm.model ASC LIMIT 1), '')   AS model,
              COALESCE(s.last_turn_at, MAX(t.ts))                             AS last_turn_at,
              s.api_error_count                                                AS api_error_count,
              s.compaction_count                                               AS compaction_count,
              s.interrupt_count                                                AS interrupt_count,
              s.user_turn_count                                                AS user_turn_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id
                  AND te.exit_class = 'ERROR')                                AS tool_error_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id
                  AND te.exit_class = 'TEST_FAIL')                            AS test_fail_count,
              s.gap_median_s                                                   AS gap_median_s,
              s.gap_p90_s                                                      AS gap_p90_s,
              s.long_gap_count                                                 AS long_gap_count,
              s.gap_n                                                          AS gap_n
         FROM sessions s JOIN turns t ON t.session_id = s.session_id
        WHERE 1 = 1 ${turnWindow}
        GROUP BY s.session_id, s.workspace_id, s.last_turn_at
        ORDER BY cost_equiv_u DESC, s.session_id ASC
        LIMIT @limit`,
    )
    .all(window === undefined ? { limit } : { limit, from: window.from, to: window.to });
  return rows as HotSessionRow[];
}
