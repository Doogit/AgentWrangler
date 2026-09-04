/**
 * src/query/api/overview.ts — LocalQueryAPI: spend-path query methods.
 *
 * WP2 owns this file. These signatures and return types are FROZEN by WP0.
 * Do NOT change method signatures without a plan decision.
 *
 * The exported interfaces + method signatures below are the frozen contract;
 * WP2 fills the method BODIES with SQL over the DB from db-context. The SQL
 * building blocks live in ../spend.js and ../forecast.js; this file resolves
 * windows/cutoffs, maps rows to the frozen DTOs, and attaches the envelope.
 */

import { loadConfig } from "../../daemon/config.js";
import type { Db } from "../../db/open.js";
import { getQueryDb } from "../db-context.js";
import type {
  ApiResponse,
  ClaimKind,
  DrilldownIds,
  Qualification,
  QueryWindow,
} from "../envelope.js";
import { forecastFromDb } from "../forecast.js";
import {
  contextPerTurnByModel,
  globalSpend,
  hasStaleClaim,
  liveSessionCount,
  liveSessions,
  spendByWorkspace,
} from "../spend.js";
import { computeSessionDelivery, getAbandonedSpendSplit } from "./effectiveness.js";

// ---------------------------------------------------------------------------
// Filter types (frozen shapes WP2/WP3 build against)
// ---------------------------------------------------------------------------

/** Common time-window filter passed to overview queries. */
export interface WindowFilter {
  /** ISO-8601 UTC lower bound (inclusive). */
  from?: string;
  /** ISO-8601 UTC upper bound (exclusive). */
  to?: string;
  /** Canned preset: "24h" | "7d" | "30d". Takes priority over from/to when set. */
  preset?: "24h" | "7d" | "30d";
}

/** Pagination cursor for list methods. */
export interface Cursor {
  /** Opaque cursor token returned from the previous page. */
  after?: string;
  /** Maximum rows to return (default 50). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Response payload types (frozen — WP2 fills these with real data)
// ---------------------------------------------------------------------------

/**
 * Burn-forecast payload (ADR-107 §D-5, 5-state machine). Claim kind: PROXY.
 * Rendered by the BURN FORECAST card. `state = "OFF"` when `limit_tokens` is null
 * (no limit configured); the card then shows "Configure :limit_tokens in Settings".
 */
export interface BurnForecast {
  /** OFF when no limit set; otherwise the ADR-107 §D-5 state. */
  state: "OFF" | "COLD_START" | "EXCEEDED" | "NO_BURN" | "WARNING" | "OK";
  /** Weekly token limit from user_config, or null (=> state OFF). */
  limit_tokens: number | null;
  /** Tokens consumed in the forecast window. */
  tokens_used: number;
  /** Observed burn rate; null on COLD_START/NO_BURN. */
  tokens_per_day: number | null;
  /** Projected exhaustion as a Julian day; null on OFF/COLD_START/EXCEEDED/NO_BURN. */
  projected_exhaustion_jd: number | null;
  /** WARNING threshold in days (ADR-107 default 2). */
  warn_threshold_days: number;
}

/** Context-per-turn row, grouped by model. Claim kind: OBS_PROXY (±BPE tokenizer error). */
export interface ContextPerTurnRow {
  model: string;
  /** Turn count for this model in the window. */
  n: number;
  /** AVG(context_tokens) — the stored generated column. */
  avg_context_per_turn: number;
  /** AVG(output_tokens). */
  avg_output_per_turn: number;
  /** SUM(cost_equiv_u)/COUNT/1e6; null when unpriced. */
  usd_per_turn: number | null;
}

/** Model-mix row (turns by model). Claim kind: EXACT. */
export interface ModelMixRow {
  model: string;
  turns: number;
}

/**
 * Global overview: the composite Overview-surface payload for one window.
 * Feeds the spend cards, the context/turn card, the burn-forecast card, and
 * the model-mix. The per-workspace comparison table comes from listWorkspaces();
 * the live strip comes from listLiveSessions() (independent 30s refresh cadence).
 */
export interface GlobalOverview {
  /** Sum of cost_equiv_u across all reconciled turns in the window (micro-USD). Claim: LIST_EQUIV. */
  cost_equiv_u: number;
  /** Total reconciled turn count in the window. Claim: EXACT. */
  turns: number;
  /** Total turn count including provisional. */
  turns_total: number;
  /** Turns with NULL cost_equiv_u. */
  unpriced_turns: number;
  /** Number of active (LIVE) sessions. */
  live_sessions: number;
  /** Burn-forecast card payload. */
  forecast: BurnForecast;
  /** Context-per-turn card rows (one per model). */
  context_per_turn: ContextPerTurnRow[];
  /** Model-mix rows (turns by model). */
  model_mix: ModelMixRow[];
}

/**
 * One LIVE session row for the live strip.
 * Columns: Workspace | Running cost [LIVE] | Context [LIVE] | Model | Started.
 * Claim kind: LIST_EQUIV (running cost is list-equiv; LIVE-ness is a session
 * state the UI renders as the orange provisional border, not a claim_kind).
 */
export interface LiveSessionRow {
  session_id: string;
  workspace_id: string;
  project_slug: string;
  /** Workspace mapping fields for human-readable labeling (null when unmapped). */
  repo_path: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  /** Running cost so far (micro-USD). */
  running_usd_u: number;
  /** Latest turn's context_tokens. */
  current_context_tokens: number;
  model: string;
  /** first_turn_at ISO-8601, or null. */
  started_at: string | null;
}

/** Per-workspace summary row. */
export interface WorkspaceSummary {
  workspace_id: string;
  project_slug: string;
  /** Workspace mapping fields for human-readable labeling (null when unmapped). */
  repo_path: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  /** Sum of cost_equiv_u (reconciled, micro-USD). */
  cost_equiv_u: number;
  /** Reconciled turn count. */
  turns: number;
  /** Share of global cost (0–1). */
  cost_share: number;
  /** Whether there is at least one LIVE session now. */
  has_live: boolean;
  /** Average USD per turn (list-equiv). */
  usd_per_turn: number | null;
  // RV1 additive efficiency columns (null when no turns in the window)
  /** Average context tokens per turn (provisional-inclusive). */
  avg_context_per_turn?: number | null;
  /** Cache-write share of total tokens (0–1). */
  cache_write_pct?: number | null;
  /** Opus-model share of all turns (0–1). */
  opus_pct?: number | null;
}

/** Full workspace detail. */
export interface WorkspaceDetail extends WorkspaceSummary {
  repo_path: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  registered_at: string;
  /** EF1 split of RV9a abandoned spend: sessions with user_turn_count >= 10.
   *  Optional: populated by getWorkspace; the UI wave that consumes it also wires the fixtures. */
  deep_abandoned_spend_u?: number;
  /** EF1 split of RV9a abandoned spend: sessions with user_turn_count < 10. */
  early_abandoned_spend_u?: number;
}

/** Session summary row. */
export interface SessionSummary {
  session_id: string;
  workspace_id: string;
  /** Workspace mapping fields for human-readable labeling (null when unmapped). */
  repo_path: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  file_path: string;
  state: "LIVE" | "RECONCILED";
  turn_count: number;
  cost_equiv_u: number;
  first_turn_at: string | null;
  last_turn_at: string | null;
  hygiene_flags: string[];
  /** RV2a friction signal counters. Backfilled on next full re-scan; historical rows are 0. */
  compaction_count: number;
  api_error_count: number;
  interrupt_count: number;
  /** Count of user turns in the session. Migration 009. Default 0 for historical rows. */
  user_turn_count: number;
  /** COUNT(tool_events WHERE exit_class='ERROR') for this session. */
  tool_error_count: number;
  /** COUNT(tool_events WHERE exit_class='TEST_FAIL') for this session. */
  test_fail_count: number;
  /** EF1/EF3 session-envelope fields. Always populated by getSession/listSessions
   *  (post-migration-015); EF1 fields remain optional for pre-migration compat. */
  /** EF1: user+assistant turns (is_sidechain=0) up to first commit; null when no commit. */
  turns_to_first_commit?: number | null;
  /** EF1: >=10 user turns, no commit, RECONCILED. */
  deep_abandoned?: boolean;
  /** EF3: median inter-user-turn gap (s); null when <2 user turns. */
  gap_median_s: number | null;
  /** EF3: 90th-percentile inter-user-turn gap (s); null when <2 user turns. */
  gap_p90_s: number | null;
  /** EF3: gaps > threshold. */
  long_gap_count: number;
  /** EF3: number of gaps. */
  gap_n: number;
}

/** Per-turn row in the timeline. */
export interface TurnRow {
  message_id: string;
  session_id: string;
  ts: string;
  model: string;
  is_sidechain: boolean;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number | null;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  context_tokens: number;
  cost_equiv_u: number | null;
  cost_claim: string;
  provisional: boolean;
  effort: string | null;
}

/** Paginated list wrapper. */
export interface PagedList<T> {
  items: T[];
  /** Cursor token for the next page, or null when exhausted. */
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — frozen surface is the methods above)
// ---------------------------------------------------------------------------

const PRESET_DAYS: Record<NonNullable<WindowFilter["preset"]>, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
export const QUERY_CACHE_TTL_MS = 45_000;
const MAX_QUERY_CACHE_ENTRIES = 256;

interface QueryCacheEntry {
  expiresAt: number;
  value: unknown;
}

const queryCacheByDb = new WeakMap<object, Map<string, QueryCacheEntry>>();

/** Cache one pure query result per DB and concrete window until the short TTL expires. */
export function cachedQuery<T>(
  db: Db,
  queryType: string,
  from: string,
  to: string,
  workspaceFilter: string | undefined,
  query: () => T,
): T {
  let entries = queryCacheByDb.get(db);
  if (entries === undefined) {
    entries = new Map();
    queryCacheByDb.set(db, entries);
  }

  const key = JSON.stringify([queryType, from, to, workspaceFilter ?? null]);
  const now = Date.now();
  const cached = entries.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.value as T;

  const value = query();
  if (entries.size >= MAX_QUERY_CACHE_ENTRIES) {
    for (const [entryKey, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(entryKey);
    }
    if (entries.size >= MAX_QUERY_CACHE_ENTRIES) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
  }
  entries.set(key, { expiresAt: now + QUERY_CACHE_TTL_MS, value });
  return value;
}

/**
 * Resolve a WindowFilter to a concrete [from, to) window.
 * Precedence: preset > explicit from/to > default (last 7 days).
 * `to` is exclusive; a missing bound defaults to now / (to - 7d).
 */
function resolveWindow(filters: WindowFilter, now: Date = new Date()): QueryWindow {
  const nowIso = now.toISOString();
  if (filters.preset !== undefined) {
    const from = new Date(now.getTime() - PRESET_DAYS[filters.preset] * MS_PER_DAY).toISOString();
    return { from, to: nowIso, preset: filters.preset };
  }
  if (filters.from !== undefined && filters.to !== undefined) {
    return { from: filters.from, to: filters.to };
  }
  if (filters.from !== undefined) {
    return { from: filters.from, to: nowIso };
  }
  if (filters.to !== undefined) {
    const from = new Date(new Date(filters.to).getTime() - 7 * MS_PER_DAY).toISOString();
    return { from, to: filters.to };
  }
  const from = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
  return { from, to: nowIso, preset: "7d" };
}

/** Activity cutoff for LIVE-ness: now - activityWindowSecs (from daemon config). */
function activityCutoffIso(now: Date = new Date()): string {
  const secs = loadConfig().activityWindowSecs;
  return new Date(now.getTime() - secs * 1000).toISOString();
}

/** Disclosure note for the cost-claim guard (never silently sum mixed kinds). */
function claimNote(claimKinds: number, stale: boolean): string {
  if (claimKinds > 1) {
    return `mixed cost_claim kinds (${claimKinds}): figures span different claim bases and must not be summed as one comparable value`;
  }
  if (stale) {
    return "some turns priced from a stale snapshot (LIST_EQUIV_STALE)";
  }
  return "";
}

interface MetaOpts {
  n: number;
  window: QueryWindow;
  claim_kind: ClaimKind;
  qualification?: Partial<Qualification>;
  drilldown_ids?: DrilldownIds;
}

/** Assemble an ApiResponse with a fully-populated meta block. */
function makeResponse<T>(data: T | null, o: MetaOpts): ApiResponse<T> {
  return {
    data,
    meta: {
      n: o.n,
      window: o.window,
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
        ...o.qualification,
      },
      metric_definition_version: "observe-1",
      claim_kind: o.claim_kind,
      drilldown_ids: o.drilldown_ids ?? {},
    },
  };
}

interface PageBounds {
  offset: number;
  limit: number;
}

/** Decode a pagination cursor to {offset, limit}. Opaque base64 offset token. */
function decodePage(cursor?: Cursor): PageBounds {
  const limit =
    cursor?.limit !== undefined && cursor.limit > 0
      ? Math.min(cursor.limit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
  let offset = 0;
  if (cursor?.after !== undefined) {
    const decoded = Number(Buffer.from(cursor.after, "base64").toString("utf-8"));
    if (Number.isInteger(decoded) && decoded >= 0) offset = decoded;
  }
  return { offset, limit };
}

/** next_cursor for a page, or null when the result set is exhausted. */
function nextCursor(offset: number, limit: number, total: number): string | null {
  const nextOffset = offset + limit;
  return nextOffset < total ? Buffer.from(String(nextOffset), "utf-8").toString("base64") : null;
}

/** Parse a hygiene_flags JSON text column to a string[] (defensive). */
function parseHygieneFlags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/**
 * Return the composite Overview payload for a window: global spend, forecast,
 * context-per-turn, and model-mix. Reconciled aggregates exclude provisional
 * turns; context-per-turn deliberately includes them (Data Model §2/§3).
 */
export function getGlobalOverview(filters: WindowFilter): ApiResponse<GlobalOverview> {
  const db = getQueryDb();
  const window = resolveWindow(filters);
  const { from, to } = window;

  const g = cachedQuery(db, "globalSpend", from, to, undefined, () => globalSpend(db, from, to));
  const stale = cachedQuery(db, "hasStaleClaim", from, to, undefined, () =>
    hasStaleClaim(db, from, to),
  );
  const ctx = cachedQuery(db, "contextPerTurnByModel", from, to, undefined, () =>
    contextPerTurnByModel(db, from, to),
  );
  const forecast = cachedQuery(db, "forecastFromDb", from, to, undefined, () => forecastFromDb(db));
  // Not cached: liveSessionCount depends on the rolling activityCutoffIso(), not
  // on (from,to), so a window-keyed cache would serve a count against a stale
  // cutoff. It is a single COUNT — cheap enough to run each call.
  const live = liveSessionCount(db, activityCutoffIso());

  // NOTE: context_per_turn and model_mix are provisional-INCLUSIVE (they derive
  // from contextPerTurnByModel, which does not filter provisional), so their row
  // counts sum to `turns_total`, NOT the reconciled `turns`. This is the
  // deliberate spend-vs-context difference (Data Model §2/§3) — a consumer must
  // not expect model_mix turns to reconcile with the reconciled `turns` figure.
  const context_per_turn: ContextPerTurnRow[] = ctx.map((r) => ({
    model: r.model,
    n: r.n,
    avg_context_per_turn: r.avg_context_per_turn,
    avg_output_per_turn: r.avg_output_per_turn,
    usd_per_turn: r.usd_per_turn,
  }));
  const model_mix: ModelMixRow[] = ctx.map((r) => ({ model: r.model, turns: r.n }));

  const data: GlobalOverview = {
    cost_equiv_u: g.cost_equiv_u,
    turns: g.turns,
    turns_total: g.turns_total,
    unpriced_turns: g.unpriced_turns,
    live_sessions: live,
    forecast,
    context_per_turn,
    model_mix,
  };

  return makeResponse<GlobalOverview>(data, {
    n: g.turns,
    window,
    claim_kind: stale ? "LIST_EQUIV_STALE" : "LIST_EQUIV",
    qualification: {
      provisional_excluded: g.turns_total > g.turns,
      unpriced_turns: g.unpriced_turns,
      claim_kinds_count: g.claim_kinds,
      note: claimNote(g.claim_kinds, stale),
    },
  });
}

/**
 * Per-workspace summaries for the window, ordered by cost desc. cost_share is
 * each workspace's fraction of the window's global reconciled cost.
 */
export function listWorkspaces(filters: WindowFilter): ApiResponse<PagedList<WorkspaceSummary>> {
  const db = getQueryDb();
  const window = resolveWindow(filters);
  const { from, to } = window;

  const rows = cachedQuery(db, "spendByWorkspace", from, to, undefined, () =>
    spendByWorkspace(db, from, to),
  );
  const g = cachedQuery(db, "globalSpend", from, to, undefined, () => globalSpend(db, from, to));
  const stale = cachedQuery(db, "hasStaleClaim", from, to, undefined, () =>
    hasStaleClaim(db, from, to),
  );
  // Not cached: this liveness set keys on the rolling activityCutoffIso(), not on
  // (from,to) — a window-keyed cache would return a stale live set.
  const cutoff = activityCutoffIso();
  const liveWs = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT workspace_id AS id FROM sessions WHERE state = 'LIVE' AND last_turn_at >= ?",
        )
        .all(cutoff) as Array<{ id: string }>
    ).map((r) => r.id),
  );

  // RV1 additive efficiency columns: avg context/turn, cache-write share, opus share.
  interface WorkspaceAggRow {
    workspace_id: string;
    avg_context_per_turn: number | null;
    cache_write_pct: number | null;
    opus_pct: number | null;
  }
  const aggRows = cachedQuery(
    db,
    "workspaceAgg",
    from,
    to,
    undefined,
    () =>
      db
        .prepare(
          `SELECT workspace_id,
            AVG(CAST(context_tokens AS REAL)) AS avg_context_per_turn,
            CASE WHEN SUM(input_tokens + output_tokens + cache_read_tokens
                         + cache_write_5m + cache_write_1h + cache_write_other) > 0
              THEN CAST(SUM(cache_write_5m + cache_write_1h + cache_write_other) AS REAL)
                   / SUM(input_tokens + output_tokens + cache_read_tokens
                         + cache_write_5m + cache_write_1h + cache_write_other)
              ELSE NULL END AS cache_write_pct,
            CAST(SUM(CASE WHEN model LIKE '%opus%' THEN 1 ELSE 0 END) AS REAL)
              / NULLIF(COUNT(*), 0) AS opus_pct
         FROM turns WHERE ts >= ? AND ts < ?
         GROUP BY workspace_id`,
        )
        .all(from, to) as WorkspaceAggRow[],
  );
  const aggByWorkspace = new Map(aggRows.map((r) => [r.workspace_id, r]));

  const items: WorkspaceSummary[] = rows.map((r) => {
    const agg = aggByWorkspace.get(r.workspace_id);
    return {
      workspace_id: r.workspace_id,
      project_slug: r.project_slug,
      repo_path: r.repo_path,
      repo_owner: r.repo_owner,
      repo_name: r.repo_name,
      cost_equiv_u: r.cost_equiv_u,
      turns: r.turns,
      cost_share: g.cost_equiv_u > 0 ? r.cost_equiv_u / g.cost_equiv_u : 0,
      has_live: liveWs.has(r.workspace_id),
      usd_per_turn: r.turns > 0 ? r.cost_equiv_u / r.turns / 1e6 : null,
      avg_context_per_turn: agg?.avg_context_per_turn ?? null,
      cache_write_pct: agg?.cache_write_pct ?? null,
      opus_pct: agg?.opus_pct ?? null,
    };
  });

  return makeResponse<PagedList<WorkspaceSummary>>(
    { items, next_cursor: null },
    {
      n: items.length,
      window,
      claim_kind: stale ? "LIST_EQUIV_STALE" : "LIST_EQUIV",
      qualification: {
        provisional_excluded: g.turns_total > g.turns,
        unpriced_turns: g.unpriced_turns,
        claim_kinds_count: g.claim_kinds,
        note: claimNote(g.claim_kinds, stale),
      },
    },
  );
}

/**
 * Full detail for one workspace over the default (7d) window — getWorkspace has
 * no window filter in the frozen signature, so it uses resolveWindow({}).
 */
export function getWorkspace(id: string): ApiResponse<WorkspaceDetail> {
  const db = getQueryDb();
  const window = resolveWindow({});
  const { from, to } = window;

  const wsRow = db
    .prepare(
      `SELECT workspace_id, project_slug, repo_path, repo_owner, repo_name, registered_at
         FROM workspaces WHERE workspace_id = ?`,
    )
    .get(id) as
    | {
        workspace_id: string;
        project_slug: string;
        repo_path: string | null;
        repo_owner: string | null;
        repo_name: string | null;
        registered_at: string;
      }
    | undefined;

  if (wsRow === undefined) {
    return makeResponse<WorkspaceDetail>(null, {
      n: 0,
      window,
      claim_kind: "N_A",
      drilldown_ids: { workspace_id: id },
    });
  }

  const spendRow = spendByWorkspace(db, from, to).find((r) => r.workspace_id === id);
  const g = globalSpend(db, from, to);
  const stale = hasStaleClaim(db, from, to, id);
  const cost = spendRow?.cost_equiv_u ?? 0;
  const turns = spendRow?.turns ?? 0;
  // Provisional-inclusive turn count, so the honesty flag reflects the fact
  // that spendByWorkspace filtered provisional turns out of `cost`/`turns`.
  const totalTurns = (
    db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?")
      .get(id, from, to) as { n: number }
  ).n;
  const hasLive =
    db
      .prepare(
        "SELECT 1 FROM sessions WHERE workspace_id = ? AND state = 'LIVE' AND last_turn_at >= ? LIMIT 1",
      )
      .get(id, activityCutoffIso()) !== undefined;

  const abandonedSplit = getAbandonedSpendSplit(db, { workspaceId: id, from, to });

  const data: WorkspaceDetail = {
    workspace_id: wsRow.workspace_id,
    project_slug: wsRow.project_slug,
    cost_equiv_u: cost,
    turns,
    cost_share: g.cost_equiv_u > 0 ? cost / g.cost_equiv_u : 0,
    has_live: hasLive,
    usd_per_turn: turns > 0 ? cost / turns / 1e6 : null,
    repo_path: wsRow.repo_path,
    repo_owner: wsRow.repo_owner,
    repo_name: wsRow.repo_name,
    registered_at: wsRow.registered_at,
    deep_abandoned_spend_u: abandonedSplit.deep_abandoned_spend_u,
    early_abandoned_spend_u: abandonedSplit.early_abandoned_spend_u,
  };

  return makeResponse<WorkspaceDetail>(data, {
    n: turns,
    window,
    claim_kind: stale ? "LIST_EQUIV_STALE" : "LIST_EQUIV",
    drilldown_ids: { workspace_id: id },
    qualification: {
      provisional_excluded: totalTurns > turns,
      unpriced_turns: spendRow?.unpriced_turns ?? 0,
      claim_kinds_count: spendRow?.claim_kinds ?? 0,
      note: claimNote(spendRow?.claim_kinds ?? 0, stale),
    },
  });
}

/**
 * Sessions for a workspace whose last_turn_at falls in the window, most-recent
 * first, paginated (opaque offset cursor). cost_equiv_u/turn_count are the
 * session rollforward columns.
 */
export function listSessions(
  workspace_id: string,
  filters: WindowFilter,
  cursor?: Cursor,
): ApiResponse<PagedList<SessionSummary>> {
  const db = getQueryDb();
  const window = resolveWindow(filters);
  const { from, to } = window;
  const { offset, limit } = decodePage(cursor);

  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND last_turn_at >= ? AND last_turn_at < ?",
      )
      .get(workspace_id, from, to) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT s.session_id, s.workspace_id, w.repo_path, w.repo_owner, w.repo_name,
              s.file_path, s.state, s.turn_count, s.cost_equiv_u,
              s.first_turn_at, s.last_turn_at, s.hygiene_flags,
              s.compaction_count, s.api_error_count, s.interrupt_count, s.user_turn_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id AND te.exit_class = 'ERROR')     AS tool_error_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id AND te.exit_class = 'TEST_FAIL') AS test_fail_count,
              s.gap_median_s, s.gap_p90_s, s.long_gap_count, s.gap_n,
              CASE WHEN EXISTS (
                     SELECT 1 FROM tool_events te
                      WHERE te.session_id = s.session_id AND te.commit_sha IS NOT NULL
                   ) THEN (
                     SELECT COUNT(*) FROM turns t2
                      WHERE t2.session_id = s.session_id
                        AND t2.is_sidechain = 0
                        AND t2.ts <= (
                          SELECT MIN(te2.ts) FROM tool_events te2
                           WHERE te2.session_id = s.session_id AND te2.commit_sha IS NOT NULL
                        )
                   ) ELSE NULL END AS turns_to_first_commit,
              CASE WHEN s.state = 'RECONCILED' AND s.user_turn_count >= 10
                        AND NOT EXISTS (
                          SELECT 1 FROM tool_events te
                           WHERE te.session_id = s.session_id AND te.commit_sha IS NOT NULL
                        ) THEN 1 ELSE 0 END AS deep_abandoned_int
         FROM sessions s JOIN workspaces w USING (workspace_id)
        WHERE s.workspace_id = ? AND s.last_turn_at >= ? AND s.last_turn_at < ?
        ORDER BY s.last_turn_at DESC, s.session_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(workspace_id, from, to, limit, offset) as Array<{
    session_id: string;
    workspace_id: string;
    repo_path: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    file_path: string;
    state: "LIVE" | "RECONCILED";
    turn_count: number;
    cost_equiv_u: number;
    first_turn_at: string | null;
    last_turn_at: string | null;
    hygiene_flags: string;
    compaction_count: number;
    api_error_count: number;
    interrupt_count: number;
    user_turn_count: number;
    tool_error_count: number;
    test_fail_count: number;
    gap_median_s: number | null;
    gap_p90_s: number | null;
    long_gap_count: number;
    gap_n: number;
    turns_to_first_commit: number | null;
    deep_abandoned_int: number;
  }>;

  const items: SessionSummary[] = rows.map((r) => ({
    session_id: r.session_id,
    workspace_id: r.workspace_id,
    repo_path: r.repo_path,
    repo_owner: r.repo_owner,
    repo_name: r.repo_name,
    file_path: r.file_path,
    state: r.state,
    turn_count: r.turn_count,
    cost_equiv_u: r.cost_equiv_u,
    first_turn_at: r.first_turn_at,
    last_turn_at: r.last_turn_at,
    hygiene_flags: parseHygieneFlags(r.hygiene_flags),
    compaction_count: r.compaction_count,
    api_error_count: r.api_error_count,
    interrupt_count: r.interrupt_count,
    user_turn_count: r.user_turn_count,
    tool_error_count: r.tool_error_count,
    test_fail_count: r.test_fail_count,
    gap_median_s: r.gap_median_s,
    gap_p90_s: r.gap_p90_s,
    long_gap_count: r.long_gap_count,
    gap_n: r.gap_n,
    turns_to_first_commit: r.turns_to_first_commit,
    deep_abandoned: r.deep_abandoned_int !== 0,
  }));

  return makeResponse<PagedList<SessionSummary>>(
    { items, next_cursor: nextCursor(offset, limit, total) },
    {
      n: items.length,
      window,
      claim_kind: "LIST_EQUIV",
      drilldown_ids: { workspace_id },
    },
  );
}

/** Full detail for one session. */
export function getSession(id: string): ApiResponse<SessionSummary> {
  const db = getQueryDb();
  const row = db
    .prepare(
      `SELECT s.session_id, s.workspace_id, w.repo_path, w.repo_owner, w.repo_name,
              s.file_path, s.state, s.turn_count, s.cost_equiv_u,
              s.first_turn_at, s.last_turn_at, s.hygiene_flags,
              s.compaction_count, s.api_error_count, s.interrupt_count, s.user_turn_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id AND te.exit_class = 'ERROR')     AS tool_error_count,
              (SELECT COUNT(*) FROM tool_events te
                WHERE te.session_id = s.session_id AND te.exit_class = 'TEST_FAIL') AS test_fail_count,
              s.gap_median_s, s.gap_p90_s, s.long_gap_count, s.gap_n
         FROM sessions s JOIN workspaces w USING (workspace_id)
        WHERE s.session_id = ?`,
    )
    .get(id) as
    | {
        session_id: string;
        workspace_id: string;
        repo_path: string | null;
        repo_owner: string | null;
        repo_name: string | null;
        file_path: string;
        state: "LIVE" | "RECONCILED";
        turn_count: number;
        cost_equiv_u: number;
        first_turn_at: string | null;
        last_turn_at: string | null;
        hygiene_flags: string;
        compaction_count: number;
        api_error_count: number;
        interrupt_count: number;
        user_turn_count: number;
        tool_error_count: number;
        test_fail_count: number;
        gap_median_s: number | null;
        gap_p90_s: number | null;
        long_gap_count: number;
        gap_n: number;
      }
    | undefined;

  const window = resolveWindow({});
  if (row === undefined) {
    return makeResponse<SessionSummary>(null, {
      n: 0,
      window,
      claim_kind: "N_A",
      drilldown_ids: { session_id: id },
    });
  }

  const delivery = computeSessionDelivery(db, id);

  const data: SessionSummary = {
    session_id: row.session_id,
    workspace_id: row.workspace_id,
    repo_path: row.repo_path,
    repo_owner: row.repo_owner,
    repo_name: row.repo_name,
    file_path: row.file_path,
    state: row.state,
    turn_count: row.turn_count,
    cost_equiv_u: row.cost_equiv_u,
    first_turn_at: row.first_turn_at,
    last_turn_at: row.last_turn_at,
    hygiene_flags: parseHygieneFlags(row.hygiene_flags),
    compaction_count: row.compaction_count,
    api_error_count: row.api_error_count,
    interrupt_count: row.interrupt_count,
    user_turn_count: row.user_turn_count,
    tool_error_count: row.tool_error_count,
    test_fail_count: row.test_fail_count,
    gap_median_s: row.gap_median_s,
    gap_p90_s: row.gap_p90_s,
    long_gap_count: row.long_gap_count,
    gap_n: row.gap_n,
    ...delivery,
  };

  return makeResponse<SessionSummary>(data, {
    n: 1,
    window,
    claim_kind: "LIST_EQUIV",
    drilldown_ids: { session_id: id, workspace_id: row.workspace_id },
  });
}

/** Turn timeline for a session, oldest-first, paginated (opaque offset cursor). */
export function getTurnTimeline(
  session_id: string,
  cursor?: Cursor,
): ApiResponse<PagedList<TurnRow>> {
  const db = getQueryDb();
  const window = resolveWindow({});
  const { offset, limit } = decodePage(cursor);

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(session_id) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT message_id, session_id, ts, model, is_sidechain,
              input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
              cache_write_5m, cache_write_1h, cache_write_other,
              context_tokens, cost_equiv_u, cost_claim, provisional, effort
         FROM turns
        WHERE session_id = ?
        ORDER BY ts ASC, message_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(session_id, limit, offset) as Array<{
    message_id: string;
    session_id: string;
    ts: string;
    model: string;
    is_sidechain: number;
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number | null;
    cache_read_tokens: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_write_other: number;
    context_tokens: number;
    cost_equiv_u: number | null;
    cost_claim: string;
    provisional: number;
    effort: string | null;
  }>;

  const items: TurnRow[] = rows.map((r) => ({
    message_id: r.message_id,
    session_id: r.session_id,
    ts: r.ts,
    model: r.model,
    is_sidechain: r.is_sidechain !== 0,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    thinking_tokens: r.thinking_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_5m: r.cache_write_5m,
    cache_write_1h: r.cache_write_1h,
    cache_write_other: r.cache_write_other,
    context_tokens: r.context_tokens,
    cost_equiv_u: r.cost_equiv_u,
    cost_claim: r.cost_claim,
    provisional: r.provisional !== 0,
    effort: r.effort,
  }));

  return makeResponse<PagedList<TurnRow>>(
    { items, next_cursor: nextCursor(offset, limit, total) },
    {
      n: items.length,
      window,
      claim_kind: "LIST_EQUIV",
      drilldown_ids: { session_id },
    },
  );
}

/**
 * Currently-LIVE sessions for the live strip (state='LIVE' AND last_turn_at >=
 * activity cutoff). running cost is an on-demand SUM per session (see spend.ts);
 * provisional turns are intentionally included.
 */
export function listLiveSessions(): ApiResponse<PagedList<LiveSessionRow>> {
  const db = getQueryDb();
  const now = new Date();
  const cutoff = activityCutoffIso(now);
  const rows = liveSessions(db, cutoff);

  const items: LiveSessionRow[] = rows.map((r) => ({
    session_id: r.session_id,
    workspace_id: r.workspace_id,
    project_slug: r.project_slug,
    repo_path: r.repo_path,
    repo_owner: r.repo_owner,
    repo_name: r.repo_name,
    running_usd_u: r.running_usd_u,
    current_context_tokens: r.current_context_tokens,
    model: r.model,
    started_at: r.started_at,
  }));

  return makeResponse<PagedList<LiveSessionRow>>(
    { items, next_cursor: null },
    {
      n: items.length,
      window: { from: cutoff, to: now.toISOString() },
      claim_kind: "LIST_EQUIV",
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "live sessions include provisional (in-flight) turns",
      },
    },
  );
}
