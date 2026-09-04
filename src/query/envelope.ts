/**
 * src/query/envelope.ts — FROZEN API response envelope for the LocalQueryAPI.
 *
 * FROZEN in WP0 — changing this shape invalidates every downstream track;
 * amend only via plan decision.
 *
 * All LocalQueryAPI methods return `ApiResponse<T>` so the UI always has the
 * same structural envelope to read. The UI never inspects `meta` for business
 * logic (that is the API's job); it uses it for display labels and drilldown.
 *
 * WP2 fills `overview.ts`, WP4 fills `settings.ts`. WP3 and WP4 build against
 * this frozen shape — do not add fields silently.
 */

// ---------------------------------------------------------------------------
// Claim kind enum
// ---------------------------------------------------------------------------

/**
 * ClaimKind: the honesty label attached to a metric value.
 *
 * Derived from Data Model v2 §1 cost_claim column and the traceability table
 * in Phase-1a plan §10. The plan leaves the full envelope enum ambiguous;
 * the set below is the documented union across turns.cost_claim and UI chips.
 *
 * FROZEN-CONTRACT: flag for review — if the doc is later extended (e.g. BILLED
 * is confirmed as a live UI chip), add it here and bump metric_definition_version.
 *
 * - EXACT            — count/id; not a derived money figure (e.g. turn counts)
 * - LIST_EQUIV       — priced at published list rates, not necessarily billed
 * - LIST_EQUIV_STALE — list-price pricing from a stale snapshot
 * - BILLED           — authoritative billed cost (not used in Phase-1a; reserved)
 * - PROXY            — derived proxy value, not directly observed (e.g. burn forecast)
 * - OBS_PROXY        — observed-but-approximated value (e.g. context/turn, ±BPE tokenizer error)
 * - EXPERIMENTAL     — methodology under validation (e.g. outcome linkage)
 * - N_A              — metric is defined but has no value in this context
 *
 * OBS_PROXY is distinct from PROXY: the plan §10 chips the CTX/TRN card as
 * "[OBS PROXY ±9% BPE]" separately from the burn-forecast "[PROXY]".
 */
export type ClaimKind =
  | "EXACT"
  | "LIST_EQUIV"
  | "LIST_EQUIV_STALE"
  | "BILLED"
  | "PROXY"
  | "OBS_PROXY"
  | "EXPERIMENTAL"
  | "N_A";

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * The time window the query covered.
 *
 * - `from`, `to`: ISO-8601 UTC strings (exclusive upper bound, matching SQL convention).
 * - `preset`: optional label for canned windows ("24h", "7d", "30d").
 */
export interface QueryWindow {
  /** ISO-8601 UTC lower bound (inclusive). */
  from: string;
  /** ISO-8601 UTC upper bound (exclusive). */
  to: string;
  /** Optional canned window name, e.g. "7d". */
  preset?: string;
}

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

/**
 * Qualification signals attached to the metric result.
 *
 * These carry the honesty metadata the UI renders as chips and footnotes.
 * The API owns these; the UI never re-derives them.
 */
export interface Qualification {
  /** Whether any rows were excluded as provisional (LIVE, not yet reconciled). */
  provisional_excluded: boolean;
  /** Number of turns with NULL cost_equiv_u (unpriceable). */
  unpriced_turns: number;
  /** When >1, cost_claim kinds were mixed — a guard condition the API must surface. */
  claim_kinds_count: number;
  /**
   * Human-readable note, e.g. "pricing snapshot stale as of …".
   * Empty string when there is nothing to disclose.
   */
  note: string;
}

// ---------------------------------------------------------------------------
// Drilldown IDs
// ---------------------------------------------------------------------------

/**
 * Hierarchy drilldown context (FR-UI-103).
 *
 * Every global aggregate resolves global → workspace → session → turn.
 * Fields are optional because not every response has all levels of context.
 *
 * - `workspace_id`: present on workspace-scoped or narrower responses.
 * - `session_id`: present on session-scoped or narrower responses.
 * - `turn_id`: present on turn-level responses only.
 */
export interface DrilldownIds {
  workspace_id?: string;
  session_id?: string;
  turn_id?: string;
}

// ---------------------------------------------------------------------------
// Meta block
// ---------------------------------------------------------------------------

/**
 * Meta block attached to every API response.
 *
 * Carries everything the UI needs to render honesty labels, pagination state,
 * and drilldown navigation — without touching the underlying SQL.
 */
export interface ResponseMeta {
  /** Row count of the result set (for pagination display and N-disclosures). */
  n: number;
  /** The time window this result covers. */
  window: QueryWindow;
  /** Metric qualification signals (honesty chips). */
  qualification: Qualification;
  /**
   * Version string for the metric definition in use.
   * Any denominator/window/methodology change must bump this.
   * Phase-1a: always "observe-1".
   */
  metric_definition_version: "observe-1";
  /**
   * The strongest honesty claim that applies to the primary value in `data`.
   * The UI renders this as the visible chip (LIST_EQUIV, PROXY, etc.).
   */
  claim_kind: ClaimKind;
  /**
   * Hierarchy drilldown context — which workspace/session/turn this response
   * is scoped to (when applicable).
   */
  drilldown_ids: DrilldownIds;
}

// ---------------------------------------------------------------------------
// Top-level response type
// ---------------------------------------------------------------------------

/**
 * ApiResponse<T> — the envelope every LocalQueryAPI method returns.
 *
 * - `data`: the actual payload, or `null` when there is nothing to show
 *   (no data in window, feature disabled, etc.). `null` is never the same
 *   as "loading" or "error" — those are transport-level signals.
 * - `meta`: always present, even when `data` is null.
 */
export interface ApiResponse<T> {
  data: T | null;
  meta: ResponseMeta;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Default meta for stub responses (WP2/WP4 will replace with real values).
 * The window defaults to the last 7 days.
 */
function defaultWindow(): QueryWindow {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    preset: "7d",
  };
}

function defaultQualification(): Qualification {
  return {
    provisional_excluded: false,
    unpriced_turns: 0,
    claim_kinds_count: 1,
    note: "",
  };
}

/**
 * Build a stub `ApiResponse<null>` for method stubs.
 * WP2/WP4 replace `data` and fill in real `meta` values.
 */
export function stubResponse<T = null>(
  claim_kind: ClaimKind = "N_A",
  drilldown_ids: DrilldownIds = {},
): ApiResponse<T> {
  return {
    data: null,
    meta: {
      n: 0,
      window: defaultWindow(),
      qualification: defaultQualification(),
      metric_definition_version: "observe-1",
      claim_kind,
      drilldown_ids,
    },
  };
}

/**
 * Build a complete `ApiResponse<T>` with the given data and meta overrides.
 * Callers provide the parts they know; the rest gets safe defaults.
 */
export function buildResponse<T>(
  data: T,
  meta: Partial<ResponseMeta> & { claim_kind: ClaimKind },
): ApiResponse<T> {
  return {
    data,
    meta: {
      n: 0,
      window: defaultWindow(),
      qualification: defaultQualification(),
      metric_definition_version: "observe-1",
      drilldown_ids: {},
      ...meta,
    },
  };
}
