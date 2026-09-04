/**
 * src/query/cap-weighted.ts — cap-weighted token meter (Data Model v2 §2A).
 *
 * A single scalar that estimates a turn's draw on the *rate-limit cap* (not its
 * dollar cost). It exists because the frozen `context_tokens` generated column
 * and the §2 spend rollups sum `input + cache_read + cache_write_*` at FULL
 * weight, which over-counts cache reads ~10× for cap attribution (economics
 * brief verdict A2). This module is ADDITIVE and QUERY-SIDE: it never alters
 * `context_tokens` (frozen) and adds nothing to the schema.
 *
 *   cap_weighted_tokens
 *     =  full(cache_write_5m + cache_write_1h + cache_write_other)  -- cache CREATES: full weight
 *     +  COEFF × cache_read_tokens                                  -- cached re-reads: ~0.1× (unverified)
 *     +  full(input_tokens + output_tokens)                        -- fresh input + generation: full weight
 *
 * COEFF lives in `user_config.cap_read_coeff` (TEXT; cast to REAL), default 0.1,
 * carrying a visible "unverified" caveat wherever a cap-weighted figure is
 * surfaced. Both regimes ship — 0.1× (default) and 1.0× (upper bound) — selected
 * at runtime by passing `coeff` explicitly.
 *
 * The weighting expression is exported once (`capWeightExprSql` / `capWeightForTurn`)
 * so the D8/D6/D9 detectors reuse a single source of truth instead of re-deriving it.
 */

import type { Db } from "../db/open.js";

/**
 * Default cap-read coefficient. UNVERIFIED — Anthropic has not published a cap
 * coefficient for cache reads. Surface the caveat wherever a cap-weighted figure
 * is shown. Callers may override with the 1.0× upper-bound regime.
 */
export const DEFAULT_CAP_READ_COEFF = 0.1;

/** Per-turn usage fields the meter weights (subset of the `turns` row). */
export interface TurnUsageFields {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
}

/**
 * Resolve the cap-read coefficient from `user_config.cap_read_coeff`.
 * Falls back to DEFAULT_CAP_READ_COEFF when the row is absent or unparseable
 * (mirrors the `limit_tokens` read pattern — config rows are not seeded by a
 * migration, callers default). Never throws.
 */
export function resolveCapReadCoeff(db: Db): number {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'cap_read_coeff'").get() as
    | { value: string | null }
    | undefined;
  if (!row || row.value === null) return DEFAULT_CAP_READ_COEFF;
  // Treat empty/whitespace-only as absent.
  const trimmed = row.value.trim();
  if (trimmed === "") return DEFAULT_CAP_READ_COEFF;
  const n = Number(trimmed);
  // Valid range: (0, 1] — a cap-read weight can't be ≤0 or exceed full weight.
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_CAP_READ_COEFF;
  return n;
}

/**
 * The per-turn cap-weighted token SQL expression for a `turns` row aliased `alias`.
 * `coeff` is validated and inlined as a numeric literal so callers keep using
 * anonymous `?` params for their own predicates (better-sqlite3 forbids mixing
 * named and anonymous params in one statement). Deliberately NOT `context_tokens`.
 */
export function capWeightExprSql(alias: string, coeff: number): string {
  if (!Number.isFinite(coeff)) {
    throw new Error(`capWeightExprSql: coeff must be finite, got ${coeff}`);
  }
  return (
    `((${alias}.cache_write_5m + ${alias}.cache_write_1h + ${alias}.cache_write_other)` +
    ` + ${coeff} * ${alias}.cache_read_tokens` +
    ` + (${alias}.input_tokens + ${alias}.output_tokens))`
  );
}

/** Pure JS mirror of the SQL expression — for unit tests and in-memory callers. */
export function capWeightForTurn(t: TurnUsageFields, coeff: number): number {
  return (
    t.cache_write_5m +
    t.cache_write_1h +
    t.cache_write_other +
    coeff * t.cache_read_tokens +
    (t.input_tokens + t.output_tokens)
  );
}

/** Whitelisted GROUP BY dimensions (guards against SQL injection via `groupBy`). */
const GROUP_COLUMNS = {
  workspace_id: "t.workspace_id",
  session_id: "t.session_id",
  model: "t.model",
} as const;

export type CapWeightGroupBy = keyof typeof GROUP_COLUMNS;

export interface CapWeightedQuery {
  /** ISO lower bound (inclusive). */
  fromIso: string;
  /** ISO upper bound (exclusive). */
  toIso: string;
  /** Optional GROUP BY dimension; omitted → a single global-total row (group=null). */
  groupBy?: CapWeightGroupBy;
  /** Cap-read coefficient. Defaults to resolveCapReadCoeff(db). */
  coeff?: number;
  /** Include provisional turns (default false — matches reconciled aggregates). */
  includeProvisional?: boolean;
}

export interface CapWeightedRow {
  /** Group key value when groupBy is set; null for the global total. */
  group: string | null;
  /** Rounded cap-weighted token total (the meter). */
  cap_weighted_tokens: number;
  /** full(cache_write_5m + 1h + other) — cache creations at full weight. */
  cache_creation_tokens: number;
  /** COEFF × cache_read_tokens — the down-weighted read contribution. */
  cache_read_weighted: number;
  /** Raw (unweighted) cache_read_tokens — for the efficiency ratio. */
  cache_read_tokens: number;
  /** full(input + output). */
  input_output_tokens: number;
  /** cache_read : cache_creation ratio; null when no creation (diagnostic, never a headline). */
  cache_read_to_creation_ratio: number | null;
  /** Turns folded into this group. */
  turns: number;
}

interface RawRow {
  group: string | null;
  cap_weighted_raw: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_output_tokens: number;
  turns: number;
}

/**
 * Cap-weighted tokens over [fromIso, toIso), optionally grouped by
 * workspace_id / session_id / model. Reads the raw usage fields directly; never
 * references `context_tokens`. Returns a single group=null row when `groupBy` is
 * omitted. This is the entry point T5/T6/T2 consume.
 */
export function capWeightedTokens(db: Db, opts: CapWeightedQuery): CapWeightedRow[] {
  const coeff = opts.coeff ?? resolveCapReadCoeff(db);
  const expr = capWeightExprSql("t", coeff);
  const groupCol = opts.groupBy ? GROUP_COLUMNS[opts.groupBy] : null;
  const selectGroup = groupCol ?? "NULL";
  const provClause = opts.includeProvisional ? "" : "AND t.provisional = 0";
  const groupByClause = groupCol ? `GROUP BY ${groupCol}` : "";

  const rows = db
    .prepare(
      `SELECT ${selectGroup}                                            AS "group",
              SUM(${expr})                                              AS cap_weighted_raw,
              COALESCE(SUM(t.cache_write_5m + t.cache_write_1h
                           + t.cache_write_other), 0)                   AS cache_creation_tokens,
              COALESCE(SUM(t.cache_read_tokens), 0)                     AS cache_read_tokens,
              COALESCE(SUM(t.input_tokens + t.output_tokens), 0)        AS input_output_tokens,
              COUNT(*)                                                  AS turns
         FROM turns t
        WHERE t.ts >= ? AND t.ts < ? ${provClause}
        ${groupByClause}
        ORDER BY cap_weighted_raw DESC, "group" ASC`,
    )
    .all(opts.fromIso, opts.toIso) as RawRow[];

  // A no-group query always yields one row (aggregate over zero turns → group=null,
  // sums 0). Drop that empty global row so callers see an empty array when there is
  // no data, matching the grouped case.
  return rows
    .filter((r) => r.turns > 0)
    .map((r) => ({
      group: r.group,
      cap_weighted_tokens: Math.round(r.cap_weighted_raw ?? 0),
      cache_creation_tokens: r.cache_creation_tokens,
      cache_read_weighted: Math.round(coeff * r.cache_read_tokens),
      cache_read_tokens: r.cache_read_tokens,
      input_output_tokens: r.input_output_tokens,
      cache_read_to_creation_ratio:
        r.cache_creation_tokens > 0 ? r.cache_read_tokens / r.cache_creation_tokens : null,
      turns: r.turns,
    }));
}
