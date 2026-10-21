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
import { prep } from "../db/stmt-cache.js";
import { LONG_GAP_THRESHOLD_S } from "../ingest/types.js";

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
              COALESCE(SUM(CASE WHEN provisional = 0 THEN 1 ELSE 0 END), 0)     AS turns,
              COUNT(*)                                                         AS turns_total,
              COALESCE(SUM(CASE WHEN provisional = 0 AND cost_equiv_u IS NULL
                       THEN 1 ELSE 0 END), 0)                                  AS unpriced_turns,
              COUNT(DISTINCT CASE WHEN provisional = 0 THEN cost_claim END)    AS claim_kinds
         FROM turns
        WHERE ts >= ? AND ts < ?`,
    )
    .get(tFrom, tTo) as GlobalSpendRow;
  return row;
}

/**
 * Reconciled spend (µ$, `cost_equiv_u`) over [fromMs, toMs) for one workspace, or all
 * workspaces when `workspace` is null. The one "scope spend" denominator for % of spend.
 */
export function workspaceSpendU(
  db: Db,
  workspace: string | null,
  fromMs: number,
  toMs: number,
): number {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  if (workspace === null) return globalSpend(db, from, to).cost_equiv_u;
  return (
    spendByWorkspace(db, from, to).find((s) => s.workspace_id === workspace)?.cost_equiv_u ?? 0
  );
}

/** `u` as a percentage (0-100) of `spendU`; null when either is unusable or spend is 0. */
export function pctOfSpend(
  u: number | null | undefined,
  spendU: number | null | undefined,
): number | null {
  if (u === null || u === undefined || spendU === null || spendU === undefined) return null;
  if (!Number.isFinite(u) || !Number.isFinite(spendU) || spendU <= 0) return null;
  return (u / spendU) * 100;
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
  const row = prep(
    db,
    "SELECT COUNT(*) AS n FROM sessions WHERE state = 'LIVE' AND last_turn_at >= ?",
  ).get(activityCutoff) as { n: number };
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
  title?: string | null;
  repo_owner?: string | null;
  repo_name?: string | null;
  turns: number;
  cost_equiv_u: number;
  total_output_tokens: number;
  avg_output_tokens: number;
  total_context_tokens: number;
  avg_context_tokens: number;
  max_context_tokens: number;
  sum_cache_read_tokens: number;
  sidechain_cost_u: number;
  active_time_s: number;
  wall_time_s: number;
  model: string;
  /** Every model observed in the session, distinct and sorted by model id. */
  models: string[];
  first_turn_at?: string;
  last_turn_at: string;
  /** Operational and interaction/context observations. Legacy counters remain compatible. */
  api_error_count: number;
  /** The adapter records no eligible API-request exposure, so this rate is unavailable. */
  api_error_eligible_request_count?: null;
  api_error_rate?: null;
  compaction_count: number;
  /** Stored legacy zero is unsupported telemetry, not an observed zero. */
  interrupt_count: number;
  interrupts_supported?: false;
  user_turn_count: number;
  tool_error_count: number;
  /** Tool results actually observed, including successful and failed completions. */
  tool_completed_count?: number;
  /** Error numerator limited to the same completed-tool exposure as the rate. */
  tool_completed_error_count?: number;
  tool_error_rate?: number | null;
  test_fail_count: number;
  test_completed_count?: number;
  test_pass_count?: number;
  /** Describes ordered observations only; a later pass is not linked to the same test. */
  test_outcome?:
    | "NO_TEST_OUTCOMES"
    | "NO_FAILURES_OBSERVED"
    | "FAILURES_OBSERVED"
    | "FAILED_THEN_PASSED";
  /** EF3 gap aggregates from the sessions table (post-migration-015). Null when <2 user turns. */
  gap_median_s: number | null;
  gap_p90_s: number | null;
  long_gap_count: number;
  gap_n: number;
}

export type HotSessionSort = "cost" | "output" | "context" | "turns" | "last_active" | "workspace";
export type HotSessionSortDirection = "asc" | "desc";

export interface HotSessionQueryOptions {
  /** Exact turn-model match, applied before aggregation and limiting. */
  model?: string;
  sort?: HotSessionSort;
  direction?: HotSessionSortDirection;
  workspace?: string;
  /** Session-id prefix; `_` is escaped so it matches literally. */
  sessionPrefix?: string;
  offset?: number;
  /** Keep sessions whose activity overlaps [from, to); aggregates stay whole-session. */
  activeWindow?: { from: string; to: string };
  /** Keep sessions with at least one turn on this model; aggregates stay whole-session. */
  sessionModel?: string;
  /** Restrict to these session ids (bound as one JSON array). */
  sessionIds?: readonly string[];
}

/** Every non-empty model observed in turns, sorted for stable filter controls. */
export function listObservedModels(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT model
         FROM turns
        WHERE model <> ''
        ORDER BY model ASC`,
    )
    .all() as Array<{ model: string }>;
  return rows.map((row) => row.model);
}

const HOT_SESSION_SORT_SQL: Record<HotSessionSort, string> = {
  cost: "cost_equiv_u",
  output: "avg_output_tokens",
  context: "avg_context_tokens",
  turns: "turns",
  last_active: "last_turn_at",
  workspace: "workspace_id",
};

/** Shared WHERE/HAVING + bound params for the hot-session candidate aggregation. */
function hotSessionFilters(
  window: { from: string; to: string } | undefined,
  options: HotSessionQueryOptions,
): { where: string; having: string; turnFilter: string; params: Record<string, unknown> } {
  // Optional window bounds the JOINed turns to [from, to); absent = all-time
  // (preserves the /api/hot-sessions default). Matches the `t.ts >= ? AND t.ts < ?`
  // string-bound convention used by globalSpend and the other spend queries.
  const turnWindow = window === undefined ? "" : "AND t.ts >= @from AND t.ts < @to";
  const modelFilter = options.model === undefined ? "" : "AND t.model = @model";
  const where = [
    turnWindow,
    modelFilter,
    options.workspace === undefined ? "" : "AND s.workspace_id = @workspace",
    options.sessionPrefix === undefined
      ? ""
      : "AND t.session_id LIKE @sessionPrefix || '%' ESCAPE '\\'",
    options.sessionModel === undefined
      ? ""
      : "AND t.session_id IN (SELECT tm.session_id FROM turns tm WHERE tm.model = @sessionModel)",
    options.sessionIds === undefined
      ? ""
      : "AND t.session_id IN (SELECT value FROM json_each(@sessionIds))",
  ].join(" ");
  return {
    where,
    having:
      options.activeWindow === undefined
        ? ""
        : "HAVING MAX(t.ts) >= @activeFrom AND MIN(t.ts) < @activeTo",
    turnFilter: `${turnWindow} ${modelFilter}`,
    params: {
      ...(window === undefined ? {} : { from: window.from, to: window.to }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.sessionPrefix === undefined
        ? {}
        : { sessionPrefix: options.sessionPrefix.replace(/[\\%_]/g, "\\$&") }),
      ...(options.sessionModel === undefined ? {} : { sessionModel: options.sessionModel }),
      ...(options.sessionIds === undefined
        ? {}
        : { sessionIds: JSON.stringify(options.sessionIds) }),
      ...(options.activeWindow === undefined
        ? {}
        : { activeFrom: options.activeWindow.from, activeTo: options.activeWindow.to }),
    },
  };
}

/** Every filtered session id with its workspace and cost — cheap input for non-SQL rankings. */
export function hotSessionCandidates(
  db: Db,
  window?: { from: string; to: string },
  options: HotSessionQueryOptions = {},
): Array<{ session_id: string; workspace_id: string; cost_equiv_u: number }> {
  const filters = hotSessionFilters(window, options);
  return db
    .prepare(
      `SELECT t.session_id AS session_id, s.workspace_id AS workspace_id,
              COALESCE(SUM(t.cost_equiv_u), 0) AS cost_equiv_u
         FROM turns t JOIN sessions s ON s.session_id = t.session_id
        WHERE 1 = 1 ${filters.where}
        GROUP BY t.session_id
        ${filters.having}`,
    )
    .all(filters.params) as Array<{
    session_id: string;
    workspace_id: string;
    cost_equiv_u: number;
  }>;
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
  options: HotSessionQueryOptions = {},
): HotSessionRow[] {
  const filters = hotSessionFilters(window, options);
  const sortSql = HOT_SESSION_SORT_SQL[options.sort ?? "cost"] ?? HOT_SESSION_SORT_SQL.cost;
  const directionSql = options.direction === "asc" ? "ASC" : "DESC";
  // Rank a bounded candidate set from the turns aggregation alone, then run the
  // per-session enrichment subqueries against only the selected rows (PERF1).
  // The CTE's ORDER BY/LIMIT must stay identical to the outer ordering so the
  // selected set and tie order match the previous single-query form exactly.
  const rows = db
    .prepare(
      `WITH candidate AS (
         SELECT t.session_id                                                  AS session_id,
                s.workspace_id                                                 AS workspace_id,
                COUNT(*)                                                       AS turns,
                COALESCE(SUM(t.cost_equiv_u), 0)                               AS cost_equiv_u,
                COALESCE(SUM(t.output_tokens), 0)                              AS total_output_tokens,
                COALESCE(SUM(t.context_tokens), 0)                             AS total_context_tokens,
                COALESCE(MAX(t.context_tokens), 0)                             AS max_context_tokens,
                COALESCE(SUM(t.cache_read_tokens), 0)                          AS sum_cache_read_tokens,
                COALESCE(SUM(CASE WHEN t.is_sidechain = 1 THEN t.cost_equiv_u ELSE 0 END), 0) AS sidechain_cost_u,
                MIN(t.ts)                                                      AS first_turn_at,
                MAX(t.ts)                                                      AS final_turn_at,
                ROUND(COALESCE(SUM(t.output_tokens), 0) * 1.0 / COUNT(*))       AS avg_output_tokens,
                ROUND(COALESCE(SUM(t.context_tokens), 0) * 1.0 / COUNT(*))      AS avg_context_tokens,
                COALESCE(s.last_turn_at, MAX(t.ts))                            AS last_turn_at
           FROM turns t JOIN sessions s ON s.session_id = t.session_id
          WHERE 1 = 1 ${filters.where}
          GROUP BY t.session_id
          ${filters.having}
          ORDER BY ${sortSql} ${directionSql}, t.session_id ASC
          LIMIT @limit OFFSET @offset
       )
       SELECT s.session_id                                                   AS session_id,
              c.workspace_id                                                 AS workspace_id,
              s.title                                                        AS title,
              w.repo_owner                                                   AS repo_owner,
              w.repo_name                                                    AS repo_name,
              c.turns                                                         AS turns,
              c.cost_equiv_u                                                  AS cost_equiv_u,
              c.total_output_tokens                                           AS total_output_tokens,
              c.avg_output_tokens                                             AS avg_output_tokens,
              c.total_context_tokens                                          AS total_context_tokens,
              c.avg_context_tokens                                            AS avg_context_tokens,
              c.max_context_tokens                                            AS max_context_tokens,
              c.sum_cache_read_tokens                                         AS sum_cache_read_tokens,
              c.sidechain_cost_u                                              AS sidechain_cost_u,
              MAX(0, ROUND((julianday(c.final_turn_at) - julianday(c.first_turn_at)) * 86400)) AS wall_time_s,
              COALESCE((SELECT SUM(MAX((julianday(ts) - julianday(previous_ts)) * 86400, 0))
                FROM (SELECT t.ts, LAG(t.ts) OVER (ORDER BY t.ts, t.message_id) AS previous_ts
                  FROM turns t WHERE t.session_id = s.session_id ${filters.turnFilter}) gaps
                WHERE previous_ts IS NOT NULL
                  AND (julianday(ts) - julianday(previous_ts)) * 86400 <= @longGapS), 0) AS active_time_s,
              COALESCE((SELECT tm.model FROM turns tm
                         WHERE tm.session_id = s.session_id
                         GROUP BY tm.model
                         ORDER BY COUNT(*) DESC, tm.model ASC LIMIT 1), '')   AS model,
              (SELECT json_group_array(observed.model)
                 FROM (SELECT DISTINCT tm.model AS model
                         FROM turns tm
                        WHERE tm.session_id = s.session_id
                        ORDER BY tm.model ASC) observed)                       AS models_json,
              c.last_turn_at                                                  AS last_turn_at,
              c.first_turn_at                                                 AS first_turn_at,
              s.api_error_count                                                AS api_error_count,
              s.compaction_count                                               AS compaction_count,
              s.interrupt_count                                                AS interrupt_count,
              s.user_turn_count                                                AS user_turn_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id
                  AND te.exit_class = 'ERROR')                                AS tool_error_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id
                  AND te.exit_class = 'ERROR'
                  AND te.result_bytes IS NOT NULL)                             AS tool_completed_error_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id
                  AND te.result_bytes IS NOT NULL)                             AS tool_completed_count,
              (SELECT json_array(
                 COALESCE(SUM(te.exit_class = 'TEST_FAIL'), 0),
                 COALESCE(SUM(te.result_bytes IS NOT NULL), 0),
                 COALESCE(SUM(te.exit_class = 'OK' AND te.result_bytes IS NOT NULL), 0),
                 MIN(CASE WHEN te.exit_class = 'TEST_FAIL' AND te.result_bytes IS NOT NULL THEN te.ts END),
                 MAX(CASE WHEN te.exit_class = 'OK' AND te.result_bytes IS NOT NULL THEN te.ts END)
               ) FROM tool_events te
                 JOIN tool_event_metadata metadata ON metadata.event_id = te.event_id
              WHERE te.session_id = s.session_id AND metadata.is_test_command = 1) AS test_stats_json,
              s.gap_median_s                                                   AS gap_median_s,
              s.gap_p90_s                                                      AS gap_p90_s,
              s.long_gap_count                                                 AS long_gap_count,
              s.gap_n                                                          AS gap_n
         FROM candidate c JOIN sessions s ON s.session_id = c.session_id
         LEFT JOIN workspaces w ON w.workspace_id = c.workspace_id
        ORDER BY c.${sortSql} ${directionSql}, s.session_id ASC`,
    )
    .all({
      limit,
      offset: options.offset ?? 0,
      longGapS: LONG_GAP_THRESHOLD_S,
      ...filters.params,
    });
  return (
    rows as Array<
      Omit<
        HotSessionRow,
        | "models"
        | "api_error_eligible_request_count"
        | "api_error_rate"
        | "interrupts_supported"
        | "tool_error_rate"
        | "test_fail_count"
        | "test_completed_count"
        | "test_pass_count"
        | "test_outcome"
      > & {
        models_json: string;
        test_stats_json: string;
        tool_completed_count: number;
        tool_completed_error_count: number;
      }
    >
  ).map(({ models_json, test_stats_json, ...row }) => {
    const models = JSON.parse(models_json) as string[];
    const [
      testFailCount,
      testCompletedCount,
      testPassCount,
      firstCompletedFail,
      lastCompletedPass,
    ] = JSON.parse(test_stats_json) as [number, number, number, string | null, string | null];
    const testOutcome =
      testCompletedCount === 0
        ? "NO_TEST_OUTCOMES"
        : firstCompletedFail === null
          ? "NO_FAILURES_OBSERVED"
          : lastCompletedPass !== null && firstCompletedFail < lastCompletedPass
            ? "FAILED_THEN_PASSED"
            : "FAILURES_OBSERVED";
    return {
      ...row,
      models,
      test_fail_count: testFailCount,
      test_completed_count: testCompletedCount,
      test_pass_count: testPassCount,
      test_outcome: testOutcome,
      api_error_eligible_request_count: null,
      api_error_rate: null,
      interrupts_supported: false,
      tool_error_rate:
        row.tool_completed_count > 0
          ? row.tool_completed_error_count / row.tool_completed_count
          : null,
    };
  });
}
