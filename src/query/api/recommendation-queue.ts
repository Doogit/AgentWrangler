/**
 * Server-side, snapshot-bound recommendation queue contract.
 *
 * This module deliberately receives composed, privacy-safe records. Storage and
 * route wiring remain integration-owned: this contract must not infer queue
 * fields from legacy rows or fabricate missing HRE-5 effect results.
 */

import {
  type QueueCursorV1,
  type QueueSnapshotRef,
  validateQueueCursor,
} from "../../recommendations/queue-contract.js";
import {
  type QueueRankKey,
  type RankableRecommendation,
  type RankedRecommendation,
  type ReviewedSafetyClass,
  rankRecommendations,
} from "../../recommendations/ranking-policy.js";
import type {
  EffectVerdict,
  RecommendationId,
  RecommendationLifecycle,
  SafeCode,
} from "../../recommendations/types.js";

export type QueueArtifactKind =
  | "installable_hook"
  | "config_diff"
  | "claude_md_rule"
  | "skill"
  | "subagent_def"
  | "cc_prompt"
  | "advice";

export type QueueCompatibility = "NATIVE" | "LEGACY";
export type QueueMeasurementVerdict = "AUTOMATIC" | "VALIDATED_PROXY" | "MANUAL" | "UNMEASURABLE";
export type QueueValueBand = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH";
export type QueueConfidenceTier = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH";
export type QueueSafetyClass = ReviewedSafetyClass | null;
/** Artifact-bound observed outcome supplied by the HRE-5b measured-result feed. */
export type QueueMeasuredResult = EffectVerdict | "PENDING";
/**
 * Why an item has no artifact-bound observed result for its exact active
 * revision. `UNSUPPORTED` is absent by design: the HRE-5b feed reports it as a
 * measured verdict, so it stays inside `QueueMeasuredResult`.
 */
export type QueueMeasuredUnavailableReason = "NO_CYCLE" | "LEGACY_UNLINKED" | "SUPERSEDED_REVISION";
/** Discriminated measured state; unavailable cases stay explicit rather than collapsing to null. */
export type QueueMeasuredState =
  | { readonly kind: "MEASURED"; readonly result: QueueMeasuredResult }
  | { readonly kind: "UNAVAILABLE"; readonly reason: QueueMeasuredUnavailableReason };
export type QueueSort =
  | "RECOMMENDED"
  | "ESTIMATED_VALUE"
  | "CONFIDENCE"
  | "NEWEST_EVIDENCE"
  | "MEASURED_RESULT";
/** The ordering basis actually applied to a page, distinct from per-item admission reason codes. */
export type QueueSortRationale =
  | "EXPECTED_VALUE_ORDER"
  | "CONFIDENCE_ORDER"
  | "NEWEST_EVIDENCE_ORDER"
  | "MEASURED_OUTCOME_ORDER";

/** Privacy-safe, fully composed record supplied by the HRE/storage integration. */
export interface QueueItem extends RankableRecommendation {
  readonly stableId: RecommendationId;
  readonly activeRevisionId: string;
  readonly lifecycle: RecommendationLifecycle;
  readonly handlerFamily: string;
  readonly artifactKind: QueueArtifactKind | null;
  readonly workspaceId: string | null;
  readonly scopeId: string | null;
  readonly safetyClass: QueueSafetyClass;
  readonly measurementVerdict: QueueMeasurementVerdict | null;
  /**
   * Exact-revision artifact-bound measured state. Unavailable when no such cycle
   * exists (no cycle, legacy rec-only, or a superseded revision); modeled value
   * is never promoted into it.
   */
  readonly measuredState: QueueMeasuredState;
  readonly compatibility: QueueCompatibility;
}

export interface QueueFilters {
  readonly lifecycle?: readonly RecommendationLifecycle[];
  readonly artifactKind?: readonly QueueArtifactKind[];
  readonly handlerFamily?: readonly string[];
  readonly workspaceId?: readonly (string | null)[];
  readonly scopeId?: readonly (string | null)[];
  readonly valueBand?: readonly QueueValueBand[];
  readonly confidenceTier?: readonly QueueConfidenceTier[];
  readonly measurementVerdict?: readonly (QueueMeasurementVerdict | null)[];
  /** Matches a measured verdict, or `null` for any unavailable item. */
  readonly measuredResult?: readonly (QueueMeasuredResult | null)[];
  readonly safetyClass?: readonly QueueSafetyClass[];
  readonly compatibility?: readonly QueueCompatibility[];
}

/** The query fingerprint prevents a changed filter/sort from reusing a rank cursor. */
export interface QueueCursor extends QueueCursorV1 {
  readonly queryFingerprint: string;
}

export interface QueueRankedItem extends QueueItem {
  readonly rankKey: QueueRankKey;
  readonly reasonCodes: readonly SafeCode[];
}

export interface RecommendationQueueSnapshot {
  readonly snapshot: QueueSnapshotRef;
  /**
   * Ranked before a query filters or pages, so no page-local sort can disagree with a cursor.
   *
   * The measured dimension is captured with these items, so one snapshot object
   * orders deterministically. The reader rebuilds the snapshot from the live
   * effect feed on every call, so measured order and counts are best-effort
   * across calls that share a composition snapshot id: a cursor still resolves
   * by its stableId rank key, but a shifted measured order can move an item
   * across the cursor boundary.
   */
  readonly ranked: readonly QueueRankedItem[];
}

export type QueueQueryResult =
  | {
      readonly kind: "PAGE";
      readonly snapshot: QueueSnapshotRef;
      readonly items: readonly QueueRankedItem[];
      readonly sortRationale: QueueSortRationale;
      readonly counts: {
        readonly total: number;
        readonly byLifecycle: Readonly<Record<string, number>>;
        /**
         * Keyed by measured verdict, or by unavailable reason when no result
         * exists, so every fail-closed state stays countable.
         */
        readonly byMeasuredResult: Readonly<Record<string, number>>;
      };
      readonly nextCursor: QueueCursor | null;
    }
  | {
      readonly kind: "REFRESH_REQUIRED";
      readonly reason:
        | "SNAPSHOT_CHANGED"
        | "SNAPSHOT_EXPIRED"
        | "POLICY_CHANGED"
        | "QUERY_CHANGED"
        | "CURSOR_NOT_FOUND";
    }
  | { readonly kind: "INVALID_QUERY"; readonly reason: "PAGE_SIZE" | "EMPTY_FILTER" };

export interface RecommendationQueueQuery {
  readonly current: RecommendationQueueSnapshot;
  readonly availableSnapshotIds: ReadonlySet<string>;
  readonly pageSize: number;
  readonly cursor?: QueueCursor;
  readonly filters?: QueueFilters;
  readonly sort?: QueueSort;
}

export type LegacyQueueProjection<T> =
  | {
      readonly kind: "PAGE";
      readonly snapshot: QueueSnapshotRef;
      readonly items: readonly T[];
      readonly total: number;
      readonly nextCursor: QueueCursor | null;
    }
  | Exclude<QueueQueryResult, { readonly kind: "PAGE" }>;

const MAX_PAGE_SIZE = 100;

function isFiniteUnit(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function valueBand(value: number | null): QueueValueBand {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "UNKNOWN";
  if (value < 1) return "LOW";
  if (value < 10) return "MEDIUM";
  return "HIGH";
}

function confidenceTier(value: number | null): QueueConfidenceTier {
  if (!isFiniteUnit(value)) return "UNKNOWN";
  if (value < 0.4) return "LOW";
  if (value < 0.75) return "MEDIUM";
  return "HIGH";
}

function has<T>(values: readonly T[] | undefined, value: T): boolean {
  return values === undefined || values.includes(value);
}

function measuredResultValue(item: QueueItem): QueueMeasuredResult | null {
  return item.measuredState.kind === "MEASURED" ? item.measuredState.result : null;
}

function measuredResultCountKey(item: QueueItem): string {
  return item.measuredState.kind === "MEASURED"
    ? item.measuredState.result
    : item.measuredState.reason;
}

function hasEmptyFilter(filters: QueueFilters | undefined): boolean {
  return (
    filters !== undefined &&
    Object.values(filters).some((value) => Array.isArray(value) && value.length === 0)
  );
}

function eligible(item: QueueItem, filters: QueueFilters | undefined): boolean {
  if (filters === undefined) return true;
  return (
    has(filters.lifecycle, item.lifecycle) &&
    has(filters.artifactKind, item.artifactKind) &&
    has(filters.handlerFamily, item.handlerFamily) &&
    has(filters.workspaceId, item.workspaceId) &&
    has(filters.scopeId, item.scopeId) &&
    has(filters.valueBand, valueBand(item.expectedSavingsUsdPerWeek)) &&
    has(filters.confidenceTier, confidenceTier(item.confidence)) &&
    has(filters.measurementVerdict, item.measurementVerdict) &&
    has(filters.measuredResult, measuredResultValue(item)) &&
    has(filters.safetyClass, item.safetyClass) &&
    has(filters.compatibility, item.compatibility)
  );
}

function canonicalFilters(filters: QueueFilters | undefined): string {
  if (filters === undefined) return "{}";
  const normalized = Object.entries(filters)
    .map(([key, values]) => [key, [...(values ?? [])].map(String).sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalized);
}

function effectiveFilters(filters: QueueFilters | undefined): QueueFilters {
  if (filters?.lifecycle !== undefined) return filters;
  return { ...filters, lifecycle: ["ACTIONABLE"] };
}

function queryFingerprint(filters: QueueFilters | undefined, sort: QueueSort): string {
  return `${sort}|${canonicalFilters(filters)}`;
}

function compareRankKey(a: QueueRankKey, b: QueueRankKey): boolean {
  return (
    a.safetyPinOrdinal === b.safetyPinOrdinal &&
    a.expectedSavingsUsdPerWeek === b.expectedSavingsUsdPerWeek &&
    a.confidence === b.confidence &&
    a.applicability === b.applicability &&
    a.evidenceNewestAt === b.evidenceNewestAt &&
    a.stableId === b.stableId
  );
}

function compareNullableDescending(a: number | null, b: number | null): number {
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (a !== null && b !== null && a !== b) return b - a;
  return 0;
}

function alternateOrder(
  items: readonly QueueRankedItem[],
  sort: Exclude<QueueSort, "MEASURED_RESULT">,
): readonly QueueRankedItem[] {
  if (sort === "RECOMMENDED" || sort === "ESTIMATED_VALUE") return items;
  return [...items].sort((a, b) => {
    const first =
      sort === "CONFIDENCE"
        ? b.rankKey.confidence - a.rankKey.confidence
        : b.rankKey.evidenceNewestAt.localeCompare(a.rankKey.evidenceNewestAt);
    if (first !== 0) return first;
    const value = compareNullableDescending(
      a.rankKey.expectedSavingsUsdPerWeek,
      b.rankKey.expectedSavingsUsdPerWeek,
    );
    if (value !== 0) return value;
    if (a.rankKey.applicability !== b.rankKey.applicability)
      return b.rankKey.applicability - a.rankKey.applicability;
    return a.rankKey.stableId.localeCompare(b.rankKey.stableId);
  });
}

/**
 * Observed-outcome precedence, mirroring `projectLifecycle` in
 * `src/recommendations/types.ts`. Anything without an artifact-bound result
 * fails closed below every measured item rather than inheriting modeled value.
 */
const MEASURED_RESULT_ORDER: Record<QueueMeasuredResult, number> = {
  IMPROVED: 0,
  NO_EFFECT: 1,
  INCONCLUSIVE: 2,
  WORSE: 3,
  UNSUPPORTED: 4,
  PENDING: 5,
};

function measuredResultOrdinal(item: QueueRankedItem): number {
  return item.measuredState.kind === "MEASURED"
    ? MEASURED_RESULT_ORDER[item.measuredState.result]
    : 6;
}

/**
 * Keeps the bounded safety block ahead of measured ordering, then orders the
 * remainder by observed outcome and the default value rank tuple.
 */
function measuredOrder(items: readonly QueueRankedItem[]): readonly QueueRankedItem[] {
  const pinned = items.filter((item) => item.rankKey.safetyPinOrdinal !== null);
  const rest = items
    .filter((item) => item.rankKey.safetyPinOrdinal === null)
    .sort((a, b) => {
      const outcome = measuredResultOrdinal(a) - measuredResultOrdinal(b);
      if (outcome !== 0) return outcome;
      const value = compareNullableDescending(
        a.rankKey.expectedSavingsUsdPerWeek,
        b.rankKey.expectedSavingsUsdPerWeek,
      );
      if (value !== 0) return value;
      if (a.rankKey.confidence !== b.rankKey.confidence)
        return b.rankKey.confidence - a.rankKey.confidence;
      if (a.rankKey.applicability !== b.rankKey.applicability)
        return b.rankKey.applicability - a.rankKey.applicability;
      return (
        b.rankKey.evidenceNewestAt.localeCompare(a.rankKey.evidenceNewestAt) ||
        a.rankKey.stableId.localeCompare(b.rankKey.stableId)
      );
    });
  return [...pinned, ...rest];
}

function sortRationale(sort: QueueSort): QueueSortRationale {
  switch (sort) {
    case "CONFIDENCE":
      return "CONFIDENCE_ORDER";
    case "NEWEST_EVIDENCE":
      return "NEWEST_EVIDENCE_ORDER";
    case "MEASURED_RESULT":
      return "MEASURED_OUTCOME_ORDER";
    default:
      return "EXPECTED_VALUE_ORDER";
  }
}

/** Freezes the complete ranking before any filter, count, cursor, or page operation. */
export function createRecommendationQueueSnapshot(input: {
  readonly snapshot: QueueSnapshotRef;
  readonly items: readonly QueueItem[];
}): RecommendationQueueSnapshot {
  const ids = new Set<string>();
  for (const item of input.items) {
    if (ids.has(item.stableId)) throw new Error("duplicate queue recommendation id");
    ids.add(item.stableId);
  }
  const byId = new Map(input.items.map((item) => [item.stableId, item] as const));
  const ranked = rankRecommendations(input.items).map((rankedItem: RankedRecommendation) => {
    const item = byId.get(rankedItem.candidate.stableId);
    if (item === undefined) throw new Error("ranked queue recommendation missing source item");
    return Object.freeze({
      ...item,
      rankKey: rankedItem.rankKey,
      reasonCodes: rankedItem.reasonCodes,
    });
  });
  return Object.freeze({ snapshot: input.snapshot, ranked: Object.freeze(ranked) });
}

/**
 * Applies one predicate to a frozen ranking for both result rows and counts.
 * Every declared sort is supported: measured ordering fails closed for items
 * with no artifact-bound observed result.
 */
export function queryRecommendationQueue(query: RecommendationQueueQuery): QueueQueryResult {
  if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > MAX_PAGE_SIZE)
    return { kind: "INVALID_QUERY", reason: "PAGE_SIZE" };
  if (hasEmptyFilter(query.filters)) return { kind: "INVALID_QUERY", reason: "EMPTY_FILTER" };

  const sort = query.sort ?? "RECOMMENDED";
  const filters = effectiveFilters(query.filters);
  const fingerprint = queryFingerprint(filters, sort);

  if (query.cursor !== undefined) {
    const decision = validateQueueCursor(
      query.cursor,
      query.current.snapshot,
      query.availableSnapshotIds,
    );
    if (decision.kind === "REFRESH_REQUIRED") return decision;
    if (query.cursor.queryFingerprint !== fingerprint)
      return { kind: "REFRESH_REQUIRED", reason: "QUERY_CHANGED" };
  }

  const eligibleItems = query.current.ranked.filter((item) => eligible(item, filters));
  const filtered =
    sort === "MEASURED_RESULT" ? measuredOrder(eligibleItems) : alternateOrder(eligibleItems, sort);
  const byLifecycle: Record<string, number> = {};
  const byMeasuredResult: Record<string, number> = {};
  for (const item of filtered) {
    byLifecycle[item.lifecycle] = (byLifecycle[item.lifecycle] ?? 0) + 1;
    const measuredKey = measuredResultCountKey(item);
    byMeasuredResult[measuredKey] = (byMeasuredResult[measuredKey] ?? 0) + 1;
  }

  let start = 0;
  const cursor = query.cursor;
  if (cursor !== undefined) {
    const cursorIndex = filtered.findIndex((item) => compareRankKey(item.rankKey, cursor.after));
    if (cursorIndex < 0) return { kind: "REFRESH_REQUIRED", reason: "CURSOR_NOT_FOUND" };
    start = cursorIndex + 1;
  }
  const items = filtered.slice(start, start + query.pageSize);
  const last = items.at(-1);
  const nextCursor =
    last !== undefined && start + items.length < filtered.length
      ? {
          version: 1 as const,
          snapshot: query.current.snapshot,
          after: last.rankKey,
          queryFingerprint: fingerprint,
        }
      : null;
  return {
    kind: "PAGE",
    snapshot: query.current.snapshot,
    items,
    sortRationale: sortRationale(sort),
    counts: { total: filtered.length, byLifecycle, byMeasuredResult },
    nextCursor,
  };
}

/**
 * Compatibility seam for Overview and the pre-RQU UI. The integrator
 * supplies its existing typed card projection; this module preserves queue order,
 * total, snapshot, and cursor rather than re-ranking legacy data client-side.
 */
export function projectQueuePageToLegacy<T>(
  result: QueueQueryResult,
  project: (item: QueueRankedItem) => T,
): LegacyQueueProjection<T> {
  if (result.kind !== "PAGE") return result;
  return {
    kind: "PAGE",
    snapshot: result.snapshot,
    items: result.items.map(project),
    total: result.counts.total,
    nextCursor: result.nextCursor,
  };
}
