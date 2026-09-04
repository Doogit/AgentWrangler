/**
 * src/query/api/recommendations.ts — LocalQueryAPI: DetectorEngine read seam.
 *
 * Reads the `recommendations` table (written by the post-ingest DetectorEngine),
 * groups rows by lifecycle state, and attaches the live per-detector status
 * strip (computed from the same detector registry — the non-firing statuses that
 * cannot be persisted rows). Claim kind: EXPERIMENTAL (methodology under
 * validation). No SQL leaves this layer; the UI issues none.
 *
 * FR-REC-103: modeled savings are NEVER summed into an "achieved" total here.
 */

import { getDetectorStatuses } from "../../detector/index.js";
import {
  AFTER_WINDOW_DAYS,
  isWarningClass,
  snapshotBeforeValue,
} from "../../detector/measurement.js";
import type { BeforeSnapshot, MeasurementRecRow } from "../../detector/measurement.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

/**
 * Bounded step shapes for recommendation action items.
 * Each kind clamps its string fields to prevent oversized payloads.
 */
export type BoundedStep =
  | { kind: "trim"; target: "CLAUDE_MD" | "MEMORY_MD"; max_lines?: number }
  | { kind: "disable_plugin"; plugin_id: string } // clamped to 64 chars
  | { kind: "route_model"; from: string; to: string } // each clamped to 64 chars
  | { kind: "session_boundary" }
  | { kind: "generic"; description: string }; // clamped to 500 chars

export interface ModeledFormula {
  model: string;
  inputs: Record<string, number>;
  expression?: string;
  result_usd_per_wk?: number;
  kind?: string;
}

/** Rate-limit headroom block (tokens freed per period). Null when detector has no token model. */
export interface HeadroomBlock {
  tokens_per_wk_freed: number | null;
  tokens_per_session_freed: number | null;
}

export interface RecommendationCard {
  rec_id: string;
  detector_id: string; // 'D1' | 'D2' | 'D5'
  category: string; // 'CONTEXT' | 'LIMIT' | 'CACHE'
  scope_workspace_id: string | null; // null = global/cross-workspace
  lever: string;
  /** Short imperative title from evidence_json.title; falls back to lever when absent. */
  title?: string;
  modeled_savings_u_per_wk: number | null; // null for D5 (warning-class)
  /** Metered Tier-2 run cost in micro-USD; null when unlinked or not recorded. */
  run_cost_u: number | null;
  modeled_formula: ModeledFormula; // parsed modeled_formula_json
  evidence: Record<string, unknown>; // parsed evidence_json (ids + metrics + numbers)
  target_metric: string;
  state:
    | "PROPOSED"
    | "ADOPTED"
    | "DISMISSED"
    | "MEASURING"
    | "MEASURED_EFFECTIVE"
    | "MEASURED_NO_EFFECT";
  created_at: string;
  dismissed_until: string | null;
  // P2 enrichment fields
  /** Rate-limit headroom. Derived from evidence.delta_context_tokens × turns_per_week when present; null otherwise. */
  headroom: HeadroomBlock | null;
  /** Sessions per week in the trailing 7d window (used to derive per-session figures). */
  sessions_per_week: number | null;
  /** Actionable steps. Coerced from evidence.steps to BoundedStep[] in toCard(). */
  steps: BoundedStep[];
  /** True when scope_workspace_id is null (global/cross-workspace). */
  cross_workspace: boolean;
  /** Workspace multiplier for global recs (from evidence.workspace_multiplier) — display-only
   *  ("×N workspaces" badge); NOT a headroom math factor (turns_per_week already aggregates). */
  workspace_multiplier: number | null;
  /** Single target file for one-click apply. Null means route through Copy Prompt. */
  file_ref: string | null;
}

/** Grouped active recommendations used by the Recommendations information architecture. */
export interface RecommendationGroup {
  detector_id: string;
  label: string;
  recs: RecommendationCard[];
  session_count: number;
  total_savings_u_per_wk: number;
}

/** Modeled values below $1/week are useful as evidence, but too small for a top-level card. */
export const ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U = 1_000_000;
export const MINOR_ITEMS_GROUP_ID = "MINOR_ITEMS";

const DETECTOR_GROUP_LABELS: Record<string, string> = {
  D1: "CLAUDE.md / memory",
  D2: "Session hygiene",
  D4: "Model routing",
  D5: "Limit warning",
  D6: "Tool-result bloat",
  D7: "Retry / redundant-read",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
};

function groupLabel(detectorId: string): string {
  return DETECTOR_GROUP_LABELS[detectorId] ?? detectorId;
}

function recommendationSessionIds(rec: RecommendationCard): string[] {
  const ids = new Set<string>();
  const sessionId = rec.evidence.session_id;
  if (typeof sessionId === "string" && sessionId.length > 0) ids.add(sessionId);
  const sessionIds = rec.evidence.session_ids;
  if (Array.isArray(sessionIds)) {
    for (const id of sessionIds) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

function groupSessionCount(recs: RecommendationCard[]): number {
  const sessionIds = new Set<string>();
  for (const rec of recs) {
    for (const sessionId of recommendationSessionIds(rec)) sessionIds.add(sessionId);
  }
  return sessionIds.size;
}

function groupSavings(recs: RecommendationCard[]): number {
  return recs.reduce((total, rec) => total + (rec.modeled_savings_u_per_wk ?? 0), 0);
}

/**
 * Derive the display groups from the complete active list without mutating it.
 *
 * Groups are created in first-seen order, which preserves the API's detector-family
 * ordering. Modeled recommendations below the de-minimis floor are collected into one
 * final expandable group; directional/null-savings recommendations remain visible in
 * their detector group because they are not proven to be minor.
 */
export function deriveActiveGroups(active: RecommendationCard[]): RecommendationGroup[] {
  const grouped = new Map<string, RecommendationCard[]>();
  const minorItems: RecommendationCard[] = [];

  for (const rec of active) {
    if (
      rec.modeled_savings_u_per_wk !== null &&
      rec.modeled_savings_u_per_wk < ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U
    ) {
      minorItems.push(rec);
      continue;
    }
    const members = grouped.get(rec.detector_id);
    if (members === undefined) grouped.set(rec.detector_id, [rec]);
    else members.push(rec);
  }

  const groups: RecommendationGroup[] = [...grouped].map(([detector_id, recs]) => ({
    detector_id,
    label: groupLabel(detector_id),
    recs,
    session_count: groupSessionCount(recs),
    total_savings_u_per_wk: groupSavings(recs),
  }));

  if (minorItems.length > 0) {
    groups.push({
      detector_id: MINOR_ITEMS_GROUP_ID,
      label: "Minor items",
      recs: minorItems,
      session_count: groupSessionCount(minorItems),
      total_savings_u_per_wk: groupSavings(minorItems),
    });
  }

  return groups;
}

export interface DetectorStatus {
  detector_id: string;
  name: string; // e.g. 'SESSION_LONG_FULL_CONTEXT'
  status: "ACTIVE" | "INACTIVE" | "BLOCKED" | "NOT_EVALUATED";
  note: string; // honest reason, e.g. 'no :limit_tokens configured'
}

export interface RecommendationsView {
  active: RecommendationCard[]; // state = PROPOSED, category != LIMIT
  active_groups: RecommendationGroup[];
  limit_warnings: RecommendationCard[]; // state = PROPOSED, category == LIMIT — rendered as alert strip above active
  adopted: RecommendationCard[]; // ADOPTED / MEASURING / MEASURED_*
  dismissed: RecommendationCard[]; // DISMISSED (in cool-down)
  detectors: DetectorStatus[];
}

interface RecRow {
  rec_id: string;
  detector_id: string | null;
  category: string;
  scope_workspace_id: string | null;
  lever: string;
  modeled_savings_u_per_wk: number | null;
  run_cost_u: number | null;
  modeled_formula_json: string;
  evidence_json: string;
  target_metric: string;
  state: RecommendationCard["state"];
  created_at: string;
  dismissed_until: string | null;
}

function parseFormula(raw: string): ModeledFormula {
  try {
    const v = JSON.parse(raw) as ModeledFormula;
    if (v && typeof v === "object") return v;
  } catch {
    // fall through
  }
  return { model: "unknown", inputs: {} };
}

/**
 * Coerce one raw step item (from evidence.steps) into a BoundedStep.
 * Per spec:
 *   - matching known shape: keep kind, clamp fields
 *   - unknown/missing kind: generic with String(item).slice(0,500)
 *   - if a description was truncated: append " [truncated]"
 */
function coerceStep(item: unknown): BoundedStep {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const { kind } = obj;
    if (kind === "trim") {
      const tgt = obj.target;
      if (tgt === "CLAUDE_MD" || tgt === "MEMORY_MD") {
        const step: BoundedStep = { kind: "trim", target: tgt };
        if (typeof obj.max_lines === "number")
          (
            step as { kind: "trim"; target: "CLAUDE_MD" | "MEMORY_MD"; max_lines?: number }
          ).max_lines = obj.max_lines;
        return step;
      }
      // Invalid target: coerce to generic, preserving available info (never "[object Object]").
      const itemStr = JSON.stringify(item);
      const truncated = itemStr.length > 500;
      return {
        kind: "generic",
        description: truncated ? `${itemStr.slice(0, 500)} [truncated]` : itemStr,
      };
    }
    if (kind === "disable_plugin") {
      const plugin_id = typeof obj.plugin_id === "string" ? obj.plugin_id.slice(0, 64) : "unknown";
      return { kind: "disable_plugin", plugin_id };
    }
    if (kind === "route_model") {
      const from = typeof obj.from === "string" ? obj.from.slice(0, 64) : "unknown";
      const to = typeof obj.to === "string" ? obj.to.slice(0, 64) : "unknown";
      return { kind: "route_model", from, to };
    }
    if (kind === "session_boundary") {
      return { kind: "session_boundary" };
    }
    if (kind === "generic") {
      const raw = typeof obj.description === "string" ? obj.description : String(item);
      const truncated = raw.length > 500;
      return { kind: "generic", description: truncated ? `${raw.slice(0, 500)} [truncated]` : raw };
    }
  }
  // Unknown kind or non-object → generic
  const raw = String(item);
  const truncated = raw.length > 500;
  return { kind: "generic", description: truncated ? `${raw.slice(0, 500)} [truncated]` : raw };
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}

/**
 * Derive rate-limit headroom for a CONTEXT rec.
 * Formula: delta_context_tokens × turns_per_week. For a global rec, turns_per_week is
 * ALREADY the cross-workspace aggregate (the full per-turn re-read footprint across every
 * workspace), so it is NOT multiplied again by workspace_multiplier — that value is
 * display-only (the "×N workspaces" badge). Multiplying here would double-count global
 * headroom by N and disagree with the detector's own µUSD figure.
 * Null when evidence lacks the required fields or for non-CONTEXT categories.
 */
function deriveHeadroom(
  category: string,
  evidence: Record<string, unknown>,
  sessionsPerWeek: number | null,
): HeadroomBlock | null {
  if (category !== "CONTEXT") return null;
  const delta =
    typeof evidence.delta_context_tokens === "number" ? evidence.delta_context_tokens : null;
  const tpw = typeof evidence.turns_per_week === "number" ? evidence.turns_per_week : null;
  if (delta === null || tpw === null) return null;
  const tokens_per_wk_freed = delta * tpw;
  const tokens_per_session_freed =
    sessionsPerWeek !== null && sessionsPerWeek > 0 ? tokens_per_wk_freed / sessionsPerWeek : null;
  return { tokens_per_wk_freed, tokens_per_session_freed };
}

function toCard(r: RecRow, sessionsPerWeek: number | null): RecommendationCard {
  const evidence = parseEvidence(r.evidence_json);
  const stepsRaw = evidence.steps;
  const steps: BoundedStep[] =
    Array.isArray(stepsRaw) && stepsRaw.length > 0
      ? (stepsRaw as unknown[]).map(coerceStep)
      : [
          {
            kind: "generic",
            description: r.lever.length > 500 ? `${r.lever.slice(0, 500)} [truncated]` : r.lever,
          },
        ];
  const workspace_multiplier =
    typeof evidence.workspace_multiplier === "number" ? evidence.workspace_multiplier : null;
  const title = typeof evidence.title === "string" ? evidence.title : r.lever;
  return {
    rec_id: r.rec_id,
    detector_id: r.detector_id ?? "",
    category: r.category,
    scope_workspace_id: r.scope_workspace_id,
    lever: r.lever,
    title,
    modeled_savings_u_per_wk: r.modeled_savings_u_per_wk,
    run_cost_u: r.run_cost_u,
    modeled_formula: parseFormula(r.modeled_formula_json),
    evidence,
    target_metric: r.target_metric,
    state: r.state,
    created_at: r.created_at,
    dismissed_until: r.dismissed_until,
    headroom: deriveHeadroom(r.category, evidence, sessionsPerWeek),
    sessions_per_week: sessionsPerWeek,
    steps,
    cross_workspace: r.scope_workspace_id === null,
    workspace_multiplier,
    file_ref: typeof evidence.file_ref === "string" ? evidence.file_ref : null,
  };
}

/**
 * Article priority rank from taxonomy §5 (blog-dashboard-taxonomy-IA.md).
 * Lower number = higher priority in the active list.
 * Taxonomy R3: replace alphabetical category sort with article priority order.
 * D5 (LIMIT_BURN_FORECAST) is a warning-class detector — floats last via
 * the category='LIMIT' guard in articlePriority().
 */
const DETECTOR_PRIORITY: Record<string, number> = {
  D8: 1, // Cache misses: idle-resume of big contexts (A1 §07 rank 1, flagship)
  D2: 2, // Oversized context and marathon sessions
  D6: 3, // Tool-result bloat
  D7: 4, // Retry loops and redundant reads
  D4: 5, // Model over-use (advisory-gated)
  D9: 6, // Background and idle sessions
  D10: 7, // Too many connected tools, plugins, and skills (A1 §07 rank 7)
  D1: 8, // Bloated CLAUDE.md / memory — secondary lever (taxonomy R9: smallest lever)
};

/** Priority rank for a card. LIMIT-category always sorts last (R3: "LIMIT warnings last"). */
function articlePriority(card: RecommendationCard): number {
  if (card.category === "LIMIT") return 9999;
  return DETECTOR_PRIORITY[card.detector_id] ?? 99;
}

function confidenceRank(rec: RecommendationCard): number {
  const kind = rec.modeled_formula.kind;
  if (kind === "WARNING") return 0; // WARNING
  if (kind === "ADVISORY" || rec.detector_id === "D4") return 1; // ADVISORY
  if (kind === "DIRECTIONAL") return 3; // explicit DIRECTIONAL (even with savings)
  if (rec.modeled_savings_u_per_wk !== null) return 2; // MODELED SAVINGS
  return 3; // DIRECTIONAL default
}

/**
 * Sort active recs by article priority (taxonomy §5 + R3):
 *
 *   1. articlePriority() ASC — D8 first (cache misses, #1 waste lever), D1 last
 *      among detected waste sources (secondary lever, #8 in article ranking).
 *   2. confidenceRank() ASC — WARNING, ADVISORY, MODELED SAVINGS, DIRECTIONAL.
 *      Detector priority normally gives each detector a unique rank, so confidence only
 *      re-orders cards sharing an articlePriority bucket: the same detector, the
 *      category='LIMIT' 9999 bucket, or the unknown-detector 99 bucket.
 *   3. modeled_savings_u_per_wk DESC within the same priority and confidence group.
 *      Savings-approximated tiebreak (API prices; subscription-cap
 *      coefficients for writes are not yet validated). Both D1 and D8
 *      savings are computed via the same pricing_snapshots table:
 *        D1: delta_ctx × turns × cache_read_price (~0.1× weight)
 *        D8: churn_write × write_price × avoidance  (1.25–2× weight per tier)
 *      Using savings as the tiebreak within a priority group is directionally
 *      correct because both use the same pricing table.
 *      unverified coeff: write weights 1.25×/2× are API prices; Anthropic has
 *      not published subscription-cap coefficients for writes.
 *   4. rec_id ASC for determinism.
 *
 * headroom.tokens_per_wk_freed is a DISPLAY field only (raw cache-read tokens,
 * ~0.1× weight) — it is NOT used as a sort key because it cannot be compared
 * reliably across detector types that produce different token flavors.
 */
function byArticlePriority(a: RecommendationCard, b: RecommendationCard): number {
  const pa = articlePriority(a);
  const pb = articlePriority(b);
  if (pa !== pb) return pa - pb;
  const ca = confidenceRank(a);
  const cb = confidenceRank(b);
  if (ca !== cb) return ca - cb;
  // Within the same priority group: cap-weighted savings DESC (null = -1).
  const sa = a.modeled_savings_u_per_wk ?? -1;
  const sb = b.modeled_savings_u_per_wk ?? -1;
  if (sb !== sa) return sb - sa;
  return a.rec_id < b.rec_id ? -1 : a.rec_id > b.rec_id ? 1 : 0;
}

const ADOPTED_STATES = new Set([
  "ADOPTED",
  "MEASURING",
  "MEASURED_EFFECTIVE",
  "MEASURED_NO_EFFECT",
]);

const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Dismiss a PROPOSED recommendation.
 * By default uses a 30-day cool-down. Pass `dismissedUntilOverride` (ISO string)
 * to set a custom wake date (e.g. for an explicit snooze duration from the UI).
 * When the `dismissed_until` date passes, `listRecommendations` auto-restores the
 * card to the active list without a DB state change.
 * nowMs is injectable for deterministic tests; defaults to Date.now().
 */
export function dismissRecommendation(
  rec_id: string,
  nowMs: number = Date.now(),
  dismissedUntilOverride?: string,
): ApiResponse<{ ok: true }> {
  const db = getQueryDb();
  const dismissedUntil =
    dismissedUntilOverride ?? new Date(nowMs + DISMISS_COOLDOWN_MS).toISOString();
  const result = db
    .prepare(
      `UPDATE recommendations SET state='DISMISSED', dismissed_until=?
         WHERE rec_id=? AND state='PROPOSED'`,
    )
    .run(dismissedUntil, rec_id);
  if (result.changes === 0) {
    throw new Error(`rec ${rec_id} not found or not in PROPOSED state`);
  }
  return buildResponse<{ ok: true }>(
    { ok: true },
    { claim_kind: "EXPERIMENTAL", n: 1, drilldown_ids: {} },
  );
}

/**
 * Adopt a PROPOSED recommendation — marks state → ADOPTED and records adopted_at,
 * and atomically snapshots the pre-adoption baseline into `recommendation_effects`
 * (W4). The snapshot reads the REALIZED signal (context_inventory_history for D1;
 * session floor context for D2; routing adherence for D4) — never a modeled figure.
 * When no baseline signal exists, the effect row is still written with
 * before_value = NULL and MEASURING will attempt the delta at close time.
 * nowMs is injectable for deterministic tests; defaults to Date.now().
 */
export function adoptRecommendation(
  rec_id: string,
  nowMs: number = Date.now(),
): ApiResponse<{ ok: true }> {
  const db = getQueryDb();
  const adoptedAt = new Date(nowMs).toISOString();
  const afterTo = new Date(nowMs + AFTER_WINDOW_DAYS * MS_PER_DAY).toISOString();

  // Read the rec BEFORE the transaction so snapshotBeforeValue sees stable input.
  const rec = db
    .prepare(
      `SELECT rec_id, detector_id, category, scope_workspace_id, evidence_json, target_metric, state
         FROM recommendations WHERE rec_id = ?`,
    )
    .get(rec_id) as (MeasurementRecRow & { state: RecommendationCard["state"] }) | undefined;

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE recommendations SET state='ADOPTED', adopted_at=?
           WHERE rec_id=? AND state='PROPOSED'`,
      )
      .run(adoptedAt, rec_id);
    if (result.changes === 0) {
      throw new Error(`rec ${rec_id} not found or not in PROPOSED state`);
    }

    // W4 baseline snapshot. Warning-class recs (D5/LIMIT) get NO effect row
    // (design §2d); everything else gets one, even with a null before_value.
    if (rec !== undefined && !isWarningClass(rec)) {
      const beforeValue: BeforeSnapshot | null = snapshotBeforeValue(db, rec, new Date(nowMs));
      const beforeFrom = beforeValue?.from_ts ?? adoptedAt;
      db.prepare(
        `INSERT INTO recommendation_effects
           (rec_id, measured_at, before_from, before_to, after_from, after_to,
            before_value, before_n, verdict)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        rec_id,
        adoptedAt, // measured_at = adoption timestamp (adoption-cycle grain; verdict written on close)
        beforeFrom,
        adoptedAt, // before_to closes at adoption
        adoptedAt, // after_from opens at adoption
        afterTo, // after_to = measuring deadline (adopted + AFTER_WINDOW_DAYS)
        beforeValue?.value ?? null,
        beforeValue?.n ?? null,
      );
    }
  });
  tx();

  return buildResponse<{ ok: true }>(
    { ok: true },
    { claim_kind: "EXPERIMENTAL", n: 1, drilldown_ids: {} },
  );
}

/**
 * Build a hardened seeded prompt for "Analyze with Claude" from a recommendation card.
 * Re-exported from src/query/api/rec-prompt.ts which is browser-safe (pure function, no
 * Node.js imports). Keeping this export here satisfies the single-source-of-truth contract:
 * the function is accessible from recommendations.ts while the implementation lives in a
 * browser-compatible module.
 */
export { buildSeededPrompt } from "./rec-prompt.js";

export function getRecommendationCard(rec_id: string): RecommendationCard | null {
  const db = getQueryDb();
  const row = db
    .prepare(
      `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
              r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
              r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
              r.created_at, r.dismissed_until
         FROM recommendations r
         LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
        WHERE r.rec_id = ?`,
    )
    .get(rec_id) as RecRow | undefined;
  if (row === undefined) return null;
  return toCard(row, null);
}

// ---------------------------------------------------------------------------
// Detector-status strip cache (DR8)
// ---------------------------------------------------------------------------
// getDetectorStatuses() re-evaluates the whole detector registry live over the
// ingested corpus and measures ~1s — it was the synchronous cost that queued
// every other daemon request when Overview and Recommendations both fetched
// /api/recommendations on mount. It is a pure function of the ingested data, so
// memoize it per DB connection, keyed on a cheap ingest-generation marker (row
// counts + max rowids of the tables the registry reads). Any ingest tick or
// detector pass advances the marker and forces a recompute; repeat reads with
// no intervening ingest serve the cached strip. The recommendation CARDS below
// are still assembled live every call, so dismiss/adopt/measurement state
// changes are never served stale. Residual: a Settings-only change (e.g.
// limit_tokens) that flips a detector's status without any new ingest is
// reflected on the next ingest tick rather than instantly — acceptable for the
// EXPERIMENTAL status strip.
interface DetectorStatusCacheEntry {
  key: string;
  detectors: DetectorStatus[];
}
const detectorStatusCache = new WeakMap<object, DetectorStatusCacheEntry>();
let detectorStatusComputeCount = 0;

/** Test-only: total number of live detector-strip assemblies (cache misses). */
export function __detectorStatusComputeCount(): number {
  return detectorStatusComputeCount;
}

function ingestGenerationKey(db: ReturnType<typeof getQueryDb>): string {
  const t = db.prepare("SELECT COUNT(*) AS c, IFNULL(MAX(rowid), 0) AS m FROM turns").get() as {
    c: number;
    m: number;
  };
  const s = db.prepare("SELECT COUNT(*) AS c, IFNULL(MAX(rowid), 0) AS m FROM sessions").get() as {
    c: number;
    m: number;
  };
  const ci = db.prepare("SELECT COUNT(*) AS c FROM context_inventory").get() as { c: number };
  return `t${t.c}:${t.m}|s${s.c}:${s.m}|ci${ci.c}`;
}

function cachedDetectorStatuses(db: ReturnType<typeof getQueryDb>): DetectorStatus[] {
  const key = ingestGenerationKey(db);
  const hit = detectorStatusCache.get(db);
  if (hit !== undefined && hit.key === key) return hit.detectors;
  const detectors = getDetectorStatuses(db) as DetectorStatus[];
  detectorStatusCache.set(db, { key, detectors });
  detectorStatusComputeCount += 1;
  return detectors;
}

/**
 * Read `recommendations` grouped by lifecycle plus the live per-detector status.
 * When `scope` is given, only that workspace's rows and global (NULL-scope) rows
 * are returned. Claim kind: EXPERIMENTAL.
 */
export function listRecommendations(scope?: string): ApiResponse<RecommendationsView> {
  const db = getQueryDb();

  const rows = (
    scope !== undefined
      ? db
          .prepare(
            `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
                    r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
                    r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
                    r.created_at, r.dismissed_until
               FROM recommendations r
               LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
              WHERE r.scope_workspace_id = ? OR r.scope_workspace_id IS NULL
              ORDER BY r.created_at DESC, r.rec_id ASC`,
          )
          .all(scope)
      : db
          .prepare(
            `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
                    r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
                    r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
                    r.created_at, r.dismissed_until
               FROM recommendations r
               LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
              ORDER BY r.created_at DESC, r.rec_id ASC`,
          )
          .all()
  ) as RecRow[];

  // Derive sessions_per_week per scope: a global rec divides by all-workspace sessions
  // (matching its cross-workspace turns_per_week basis); a per-workspace rec divides by
  // that workspace's own sessions. ISO cutoff bound as a param — last_turn_at is stored
  // via toISOString() ('T' separator), so a SQLite datetime('now') string (space
  // separator) mis-compares on the boundary day; spend.ts/overview.ts use this same
  // bound-param pattern.
  const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sessionRows = db
    .prepare(
      `SELECT workspace_id AS workspace_id, COUNT(*) AS cnt
         FROM sessions WHERE last_turn_at >= ? GROUP BY workspace_id`,
    )
    .all(cutoffIso) as Array<{ workspace_id: string; cnt: number }>;
  const sessionsByWorkspace = new Map<string, number>();
  let totalSessions = 0;
  for (const s of sessionRows) {
    sessionsByWorkspace.set(s.workspace_id, s.cnt);
    totalSessions += s.cnt;
  }

  const active: RecommendationCard[] = [];
  const limit_warnings: RecommendationCard[] = [];
  const adopted: RecommendationCard[] = [];
  const dismissed: RecommendationCard[] = [];
  const nowIso = new Date(Date.now()).toISOString();
  for (const r of rows) {
    const sessionsPerWeek =
      r.scope_workspace_id === null
        ? totalSessions
        : (sessionsByWorkspace.get(r.scope_workspace_id) ?? 0);
    const card = toCard(r, sessionsPerWeek);
    if (card.state === "PROPOSED") {
      // D5/LIMIT recs are time-sensitive warnings surfaced as an alert strip
      // above the ranked waste-source list (taxonomy §7 IA §4 §2.1).
      if (card.category === "LIMIT") limit_warnings.push(card);
      else active.push(card);
    } else if (card.state === "DISMISSED") {
      // Auto-expire: if the cool-down (dismissed_until) has passed, restore to proposed.
      // This makes snooze reversible — the card re-proposes after its wake date without
      // a DB state change. dismissed_until=null means a permanent dismiss (no auto-return).
      if (card.dismissed_until !== null && card.dismissed_until <= nowIso) {
        if (card.category === "LIMIT") limit_warnings.push(card);
        else active.push(card);
      } else {
        dismissed.push(card);
      }
    } else if (ADOPTED_STATES.has(card.state)) adopted.push(card);
  }
  active.sort(byArticlePriority);

  const detectors = cachedDetectorStatuses(db);

  const data: RecommendationsView = {
    active,
    active_groups: deriveActiveGroups(active),
    limit_warnings,
    adopted,
    dismissed,
    detectors,
  };

  return buildResponse<RecommendationsView>(data, {
    claim_kind: "EXPERIMENTAL",
    n: active.length,
    drilldown_ids: scope !== undefined ? { workspace_id: scope } : {},
  });
}
