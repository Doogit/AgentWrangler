import type { Db } from "../../db/open.js";
import { getQueryDb } from "../db-context.js";
import {
  type HotSessionQueryOptions,
  type HotSessionRow,
  type HotSessionSort,
  hotSessionCandidates,
  hotSessionsByCost,
  listObservedModels,
} from "../spend.js";
import {
  DIAGNOSTIC_CATEGORIES,
  type DiagnosticCategory,
  sessionDiagnosticCategories,
} from "./diagnostics.js";
import { getSessionSpendPercentile } from "./self-percentiles.js";
import { type SessionTopDriver, sessionTopDrivers } from "./session-drivers.js";

/**
 * A hot-session row plus its per-session spend percentile within its own
 * workspace (BM3). The percentile reuses `getSessionSpendPercentile` verbatim —
 * one source of truth shared with the per-`:id` endpoint — so the Hot Sessions
 * chip and Session Detail chip can never diverge. `spend_percentile` is null
 * (chip suppressed) when the peer set is below the n>=20 floor.
 */
export interface HotSessionRowWithPercentile extends HotSessionRow {
  repo_owner: string | null;
  repo_name: string | null;
  spend_percentile: number | null;
  spend_percentile_n: number;
}

function withPercentiles(db: Db, rows: HotSessionRow[]): HotSessionRowWithPercentile[] {
  // One cheap percentile lookup per row (<= limit rows, so no N-per-row HTTP
  // calls). Reuses the per-session query so the two BM3 surfaces stay identical.
  return rows.map((row) => {
    const percentile = getSessionSpendPercentile(db, row.session_id);
    return {
      ...row,
      repo_owner: row.repo_owner ?? null,
      repo_name: row.repo_name ?? null,
      spend_percentile: percentile.percentile,
      spend_percentile_n: percentile.n,
    };
  });
}

export function getHotSessions(
  window?: { from: string; to: string },
  limit = 20,
  options: HotSessionQueryOptions = {},
): HotSessionRowWithPercentile[] {
  const db: Db = getQueryDb();
  return withPercentiles(db, hotSessionsByCost(db, limit, window, options));
}

/** Complete model catalog for the Sessions filter, independent of the result limit. */
export function getHotSessionModels(): string[] {
  return listObservedModels(getQueryDb());
}

const HOT_SESSION_SORTS = new Set<HotSessionSort>([
  "cost",
  "output",
  "context",
  "turns",
  "last_active",
  "workspace",
]);

/** Parse only the closed-enum session query controls accepted by the SQL layer. */
export function parseHotSessionsQuery(params: URLSearchParams): HotSessionQueryOptions {
  const model = params.get("model");
  const requestedSort = params.get("sort");
  const requestedDirection = params.get("direction");
  const sort = HOT_SESSION_SORTS.has(requestedSort as HotSessionSort)
    ? (requestedSort as HotSessionSort)
    : undefined;
  const direction =
    requestedDirection === "asc" || requestedDirection === "desc" ? requestedDirection : undefined;

  return {
    ...(model === null || model === "" ? {} : { model }),
    ...(sort === undefined ? {} : { sort }),
    ...(direction === undefined ? {} : { direction }),
  };
}

// ---------------------------------------------------------------------------
// Paged Sessions list (GET /api/hot-sessions/page)
// ---------------------------------------------------------------------------

export interface HotSessionIssues {
  /** Attributed driver with the largest one-time cost in this session (> 0), else null. */
  top_driver: SessionTopDriver | null;
  /** Every Diagnostics category this session hit (all time), in DIAGNOSTIC_CATEGORIES order. */
  categories: DiagnosticCategory[];
}

export interface HotSessionPageRow extends HotSessionRowWithPercentile {
  issues: HotSessionIssues;
}

export interface HotSessionsPage {
  rows: HotSessionPageRow[];
  /** Opaque token for the next page; null when this is the last page. */
  next_cursor: string | null;
}

export type HotSessionPageSort = HotSessionSort | "issues" | "subagent";

export interface HotSessionsPageQuery {
  /** Sessions whose activity overlaps [from, to); absent = all history. */
  window?: { from: string; to: string };
  workspace?: string;
  model?: string;
  category?: DiagnosticCategory[];
  q?: string;
  sort?: HotSessionPageSort;
  direction?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}

export const HOT_SESSIONS_PAGE_DEFAULT_LIMIT = 50;
export const HOT_SESSIONS_PAGE_MAX_LIMIT = 200;
const SESSION_PREFIX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One page of the Sessions list. Filters select sessions; every aggregate covers the
 * session's full turns, so list figures equal the session-detail figures. Issues (top
 * driver + category chips) are computed once per page, never per row over HTTP.
 */
export function getHotSessionsPage(query: HotSessionsPageQuery = {}): HotSessionsPage {
  const db: Db = getQueryDb();
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid cursor");
  const limit = query.limit ?? HOT_SESSIONS_PAGE_DEFAULT_LIMIT;

  const categoriesBySession = sessionDiagnosticCategories(db);
  const options: HotSessionQueryOptions = {
    ...(query.window === undefined ? {} : { activeWindow: query.window }),
    ...(query.workspace === undefined ? {} : { workspace: query.workspace }),
    ...(query.model === undefined ? {} : { sessionModel: query.model }),
    ...(query.q === undefined ? {} : { sessionPrefix: query.q }),
  };
  if (query.category !== undefined && query.category.length > 0) {
    const wanted = new Set(query.category);
    options.sessionIds = [...categoriesBySession]
      .filter(([, categories]) => categories.some((category) => wanted.has(category)))
      .map(([sessionId]) => sessionId);
  }

  let rows: HotSessionRow[];
  let hasMore: boolean;
  let topDrivers: Map<string, SessionTopDriver | null>;
  if (query.sort === "subagent") {
    const candidates = hotSessionCandidates(db, undefined, options);
    const direction = query.direction === "asc" ? "ASC" : "DESC";
    const ranked = db
      .prepare(`WITH candidate AS (
      SELECT value AS session_id FROM json_each(@sessionIds)
    ), costs AS (
      SELECT t.session_id,
        COALESCE(SUM(CASE WHEN t.is_sidechain = 1 THEN t.cost_equiv_u ELSE 0 END), 0) AS sidechain_cost_u
      FROM turns t JOIN candidate c ON c.session_id = t.session_id
      GROUP BY t.session_id
    )
    SELECT c.session_id FROM candidate c LEFT JOIN costs USING (session_id)
    ORDER BY COALESCE(costs.sidechain_cost_u, 0) ${direction}, c.session_id ASC
    LIMIT @limit OFFSET @offset`)
      .all({
        sessionIds: JSON.stringify(candidates.map((row) => row.session_id)),
        limit: limit + 1,
        offset,
      }) as Array<{ session_id: string }>;
    hasMore = ranked.length > limit;
    const pageIds = ranked.slice(0, limit).map((row) => row.session_id);
    const byId = new Map(
      hotSessionsByCost(db, pageIds.length, undefined, { sessionIds: pageIds }).map((row) => [
        row.session_id,
        row,
      ]),
    );
    rows = pageIds.flatMap((id) => byId.get(id) ?? []);
    topDrivers = sessionTopDrivers(db, rows);
  } else if (query.sort === "issues") {
    // Driver $ is not a SQL column: rank every filtered candidate in JS (only sessions
    // with an attributed driver pay for sessionDriverCosts), then load the page's rows.
    const candidates = hotSessionCandidates(db, undefined, options);
    topDrivers = sessionTopDrivers(db, candidates);
    const sign = query.direction === "asc" ? 1 : -1;
    candidates.sort((a, b) => {
      const aCost = topDrivers.get(a.session_id)?.session_cost_u;
      const bCost = topDrivers.get(b.session_id)?.session_cost_u;
      if (aCost === undefined || bCost === undefined) {
        if (aCost !== bCost) return aCost === undefined ? 1 : -1; // nulls last either way
      } else if (aCost !== bCost) {
        return sign * (aCost - bCost);
      }
      return b.cost_equiv_u - a.cost_equiv_u || a.session_id.localeCompare(b.session_id);
    });
    const pageIds = candidates.slice(offset, offset + limit).map((row) => row.session_id);
    hasMore = offset + limit < candidates.length;
    const byId = new Map(
      hotSessionsByCost(db, pageIds.length, undefined, { sessionIds: pageIds }).map((row) => [
        row.session_id,
        row,
      ]),
    );
    rows = pageIds.flatMap((id) => byId.get(id) ?? []);
  } else {
    const fetched = hotSessionsByCost(db, limit + 1, undefined, {
      ...options,
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(query.direction === undefined ? {} : { direction: query.direction }),
      offset,
    });
    hasMore = fetched.length > limit;
    rows = fetched.slice(0, limit);
    topDrivers = sessionTopDrivers(db, rows);
  }

  return {
    rows: withPercentiles(db, rows).map((row) => ({
      ...row,
      issues: {
        top_driver: topDrivers.get(row.session_id) ?? null,
        categories: categoriesBySession.get(row.session_id) ?? [],
      },
    })),
    next_cursor: hasMore ? String(offset + limit) : null,
  };
}

function parseInstant(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw new RangeError(`Invalid ${name}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid ${name}`);
  return new Date(ms).toISOString();
}

/** Validate the page query; any invalid control throws RangeError (route → 400). */
export function parseHotSessionsPageQuery(params: URLSearchParams): HotSessionsPageQuery {
  const category = params
    .getAll("category")
    .flatMap((value) => value.split(","))
    .filter((value) => value !== "");
  if (category.some((value) => !DIAGNOSTIC_CATEGORIES.includes(value as DiagnosticCategory))) {
    throw new RangeError("Invalid category");
  }
  const fromRaw = params.get("from") || null;
  const toRaw = params.get("to") || null;
  let window: { from: string; to: string } | undefined;
  if (fromRaw !== null || toRaw !== null) {
    const from = fromRaw === null ? "0000-01-01T00:00:00.000Z" : parseInstant(fromRaw, "from");
    const to = toRaw === null ? "9999-12-31T23:59:59.999Z" : parseInstant(toRaw, "to");
    if (from >= to) throw new RangeError("Invalid window");
    window = { from, to };
  }
  const sort = params.get("sort");
  if (
    sort !== null &&
    sort !== "issues" &&
    sort !== "subagent" &&
    !HOT_SESSION_SORTS.has(sort as HotSessionSort)
  ) {
    throw new RangeError("Invalid sort");
  }
  const direction = params.get("direction");
  if (direction !== null && direction !== "asc" && direction !== "desc") {
    throw new RangeError("Invalid direction");
  }
  const q = params.get("q") || undefined;
  if (q !== undefined && !SESSION_PREFIX.test(q)) throw new RangeError("Invalid session prefix");
  const cursor = params.get("cursor") || undefined;
  if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) throw new RangeError("Invalid cursor");
  const rawLimit = params.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= 1 && limit <= HOT_SESSIONS_PAGE_MAX_LIMIT))
      throw new RangeError("Invalid limit");
  }
  const workspace = params.get("workspace") || undefined;
  const model = params.get("model") || undefined;
  return {
    ...(window === undefined ? {} : { window }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(model === undefined ? {} : { model }),
    ...(category.length === 0 ? {} : { category: category as DiagnosticCategory[] }),
    ...(q === undefined ? {} : { q }),
    ...(sort === null ? {} : { sort: sort as HotSessionPageSort }),
    ...(direction === null ? {} : { direction }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}
