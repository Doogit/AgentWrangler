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

import { createHash } from "node:crypto";
import path from "node:path";
import { withSpan } from "../../daemon/perf-monitor.js";
import { CERTIFICATION, type CertEntry } from "../../detector/certification.js";
import {
  RELIABILITY_LANE_DETECTOR_IDS,
  SPEND_LANE_DETECTOR_IDS,
} from "../../detector/claim-ledger.js";
import { DETECTOR_CONTRACTS, hasAssumed, rangeFor } from "../../detector/contracts.js";
import { getDetectorStatuses } from "../../detector/index.js";
import {
  AFTER_WINDOW_DAYS,
  isWarningClass,
  snapshotBeforeValue,
} from "../../detector/measurement.js";
import type { BeforeSnapshot, MeasurementRecRow } from "../../detector/measurement.js";
import {
  RECENCY_FACT_KEYS,
  type RecommendationPayloadV1,
  recommendationTemplate,
} from "../../detector/privacy-contract.js";
import { DETECTORS, UNEVALUATED_DETECTORS } from "../../detector/registry.js";
import type { Estimate } from "../../detector/savings.js";
import type { EffectProjection } from "../../effects/api-contract.js";
import { ESF_EFFECT_WRITER_ENABLED } from "../../effects/gate.js";
import { EFFECT_HANDLERS } from "../../effects/registry.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { trustedRecommendationContract } from "../recommendation-contract.js";
import { pctOfSpend, spendByWorkspace, workspaceSpendU } from "../spend.js";
import type { Exclusion, RankingGoal, Warning } from "./decision-ranker-types.js";
import {
  EffectRequestError,
  capabilityForRecommendation,
  effectEngineForDb,
  latestEffectCycle,
  trackCompletedChange,
  trackMachineConfirmedChange,
} from "./effect-service.js";
import { aggregateClaims } from "./ledger-aggregate.js";
import { numberMetric, stringMetric } from "./rec-actions/accessor.js";
import { buildCardActions, buildTrigger, cardTitle } from "./rec-actions/index.js";
import type { CardActions, CardTrigger } from "./rec-actions/index.js";
import { belowFloor } from "./rec-actions/trigger.js";
import type { CardActionRecommendation, CardToolCall } from "./rec-actions/types.js";
import { type ActionValidation, validateAction } from "./rec-actions/validate.js";
import { RecEvidenceContext } from "./rec-evidence.js";
import {
  type EvidenceAnchor,
  anchoredToolCalls,
  destructiveToolCalls,
  eventToolCalls,
  guardBlockToolCalls,
  mechanicalRunToolCalls,
  midSizeToolCalls,
  notFoundToolCalls,
  notReadToolCalls,
  orientationToolCalls,
  oversizedToolCalls,
  rereadToolCalls,
  shellFailureToolCalls,
} from "./tool-calls.js";

/**
 * Bounded step shapes for recommendation action items.
 * Each kind clamps its string fields to prevent oversized payloads.
 */
export type BoundedStep =
  | { kind: "trim"; target: "CLAUDE_MD" | "MEMORY_MD"; max_lines?: number }
  | { kind: "disable_plugin"; plugin_id: string } // clamped to 64 chars
  | { kind: "route_model"; from: string; to: string } // each clamped to 64 chars
  | { kind: "route_tool"; from: string; to: string } // each clamped to 64 chars
  | { kind: "session_boundary" }
  | { kind: "generic"; description: string }; // clamped to 500 chars

export interface ModeledFormula {
  model: string;
  inputs: Record<string, unknown>;
  expression?: string;
  result_usd_per_wk?: number;
  kind?: string;
  estimate?: Estimate;
}

/** Rate-limit headroom block (tokens freed per period). Null when detector has no token model. */
export interface HeadroomBlock {
  tokens_per_wk_freed: number | null;
  tokens_per_session_freed: number | null;
}

export interface RecommendationCard extends EffectProjection {
  rec_id: string;
  detector_id: string; // 'D1' | 'D2' | 'D5'
  category: string; // 'CONTEXT' | 'LIMIT' | 'CACHE'
  scope_workspace_id: string | null; // null = global/cross-workspace
  lever: string;
  /** Short imperative title from evidence_json.title; falls back to lever when absent. */
  title?: string;
  modeled_savings_u_per_wk: number | null; // null for D5 (warning-class)
  /**
   * The card headline (P3.L L6): this rec's allocated spend-lane ledger claims over the
   * trailing 7d window, net of overlaps (each token counted once, for the most specific fix).
   * `null` when its detector has no spend-lane claim producer ("not estimated" — never $0);
   * `0` is a real, priced $0 (a spend-producer detector with no claims for this rec, e.g. a
   * stale rec). Optional so pre-L6 fixtures that omit it fall back to `modeled_savings_u_per_wk`.
   */
  allocated_u_per_wk?: number | null;
  /**
   * Reliability cards only: the ledger's recovery-turn claims for this rec over the same 7d
   * window (full cost of the turn after each failure, an UPPER BOUND). A separate lane: never
   * summed into headlines, groups or totals. `null` for non-reliability detectors; `0` is a real
   * $0. Optional so older fixtures that omit it keep showing "Not estimated".
   */
  reliability_u_per_wk?: number | null;
  /**
   * Reliability cards only: the same upper bound for this rec's subagent (sidechain) failures.
   * Shown beside the headline, never in it (operator 2026-10-04). Omitted when zero.
   */
  reliability_sidechain_u_per_wk?: number;
  /**
   * Safety cards (H1, C9 guard blocks; operator 2026-10-04): the headline is a count, never a $.
   * They sort after $ cards, most irreversible operation first.
   */
  safety_lane?: true;
  /**
   * Modeled weekly savings as a percentage (0–100) of this workspace's reconciled
   * trailing-7d spend; null for null-scope recs and workspaces with no 7d spend.
   * Same scale as the golden-economic parity oracle. Badge context only, not a sort key.
   * P3.L L6: derived from `allocated_u_per_wk`, following the card headline.
   */
  pct_of_weekly_spend: number | null;
  /**
   * Modeled weekly savings as a percentage (0–100) of the trailing-7d spend across all
   * workspaces; null without savings or spend. Shown next to the $ on the card.
   * P3.L L6: derived from `allocated_u_per_wk`, following the card headline.
   */
  pct_of_total_weekly_spend?: number | null;
  /** Metered Tier-2 run cost in micro-USD; null when unlinked or not recorded. */
  run_cost_u: number | null;
  modeled_formula: ModeledFormula; // parsed modeled_formula_json
  estimate?: Estimate | null;
  certification?: "CERTIFIED" | "UNVERIFIED";
  confidence_tier?: "VERIFIED" | "ESTIMATED" | "UNVERIFIED";
  range_u_per_wk?: [number, number] | null;
  actions?: CardActions | null;
  /** Present on query cards; optional for pre-validation fixture compatibility. */
  action_validation?: {
    primary: ActionValidation;
    alternatives: Record<string, ActionValidation>;
  } | null;
  trigger?: CardTrigger;
  last_seen_week_start?: string | null;
  weeks_ago?: number | null;
  weeks_fired?: number | null;
  weeks_evaluated?: number | null;
  evidence: Record<string, unknown>; // parsed evidence_json (ids + metrics + numbers)
  target_metric: string;
  state:
    | "PROPOSED"
    | "ADOPTED"
    | "DISMISSED"
    | "MEASURING"
    | "MEASURED_EFFECTIVE"
    | "MEASURED_NO_EFFECT"
    | "RETIRED";
  created_at: string;
  dismissed_until: string | null;
  /** Latest W4 verdict when no versioned effect cycle exists. */
  legacy_effect_verdict?: "EFFECTIVE" | "NO_EFFECT" | "INCONCLUSIVE" | null;
  // P2 enrichment fields
  /** Rate-limit headroom. Derived from evidence.delta_context_tokens × turns_per_week when present; null otherwise. */
  headroom: HeadroomBlock | null;
  /** Sessions per week in the trailing 7d window (used to derive per-session figures). */
  sessions_per_week: number | null;
  /** Actionable steps. Coerced from evidence.steps to BoundedStep[] in toCard(). */
  steps: BoundedStep[];
  /**
   * Whether DetectorEngine found a concrete typed action when this rec was upserted.
   * Query cards always populate this boolean; optionality keeps older direct card builders compatible.
   */
  actionability_ok?: boolean;
  /** True when scope_workspace_id is null (global/cross-workspace). */
  cross_workspace: boolean;
  /** Workspace multiplier for global recs (from evidence.workspace_multiplier) — display-only
   *  ("×N workspaces" badge); NOT a headroom math factor (turns_per_week already aggregates). */
  workspace_multiplier: number | null;
  /** Single target file for one-click apply. Null means route through Copy Prompt. */
  file_ref: string | null;
  /**
   * PP3 ranking hint: the rec's most-recent evidence session timestamp (epoch ms), or null
   * for zero-session recs. Populated by listRecommendations for the recency tiebreak in
   * byArticlePriority; absent on cards built outside the list path (getRecommendationCard,
   * fixtures) — the tiebreak treats absent/null as least-recent, which never mis-orders across
   * detector families (they differ earlier in the sort).
   */
  session_recency_ms?: number | null;
  /**
   * Active cards that split one cost with this one (P3.1-T9, operator 2026-09-26): each says what
   * the other card counts. Set on the list path only.
   */
  related?: Array<{ rec_id: string; title: string; why: string }>;
}

/** Grouped active recommendations used by the Recommendations information architecture. */
export interface RecommendationGroup {
  detector_id: string;
  label: string;
  recs: RecommendationCard[];
  session_count: number;
  total_savings_u_per_wk: number;
}

/**
 * Legacy detector id for the destructive-op safety guard. H1 now ranks in active.
 * Retained for callers that still import the constant during the UI transition.
 */
export const PINNED_SAFETY_DETECTOR_ID = "H1";

/** Modeled values below 0.2% of the scope's 7-day spend are evidence, but too small for a top-level card. */
export const ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_PCT = 0.2;

/** 7-day spend (µ$) per scope: the denominator of the de-minimis floor. */
export interface ScopeSpendU {
  global: number;
  byWorkspace: ReadonlyMap<string, number>;
}

/** The floor (µ$) for a scope with `spendU` of 7-day spend; with no spend nothing is above it. */
export function deMinimisFloorU(
  spendU: number,
  pct: number = ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_PCT,
): number {
  return spendU > 0 ? (spendU * pct) / 100 : Number.POSITIVE_INFINITY;
}
export const MINOR_ITEMS_GROUP_ID = "MINOR_ITEMS";

/** Same strings as the UI's `DETECTOR_GROUP_LABELS` (`src/ui/recommendations/RecCard.tsx`). */
const DETECTOR_GROUP_LABELS: Record<string, string> = {
  A1: "Large tool results",
  A2: "Large task outputs",
  B1: "Cache read drops",
  B2: "Cache timeouts",
  B3: "Resume cache misses",
  B4: "Cache prefix breaks",
  C1: "Failed tool calls",
  C2: "Content not found",
  C3: "Edits before reads",
  C4: "Failed edits",
  C5: "Repeated errors",
  C6: "Edit flip-flops",
  C7: "Shell failure clusters",
  C9: "Guard blocks",
  C11: "Output cap errors",
  D1: "CLAUDE.md / memory",
  D2: "Long sessions",
  D4: "Model choice",
  D5: "Limit warning",
  D6: "Large tool results",
  D7: "Repeated attempts and reads",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
  D11: "Shell errors",
  D12: "Subagent overuse",
  D14: "Interrupted turns",
  E1: "Long orientation",
  E2: "Main-model routine runs",
  G11: "Costly failures",
  H1: "Destructive commands",
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

/**
 * The card headline (P3.L L6): `allocated_u_per_wk` when the card carries it (present, even
 * if `null` — "not estimated"); `modeled_savings_u_per_wk` for pre-L6 fixtures that omit it.
 */
export function headlineSavings(rec: RecommendationCard): number | null {
  return rec.allocated_u_per_wk !== undefined
    ? rec.allocated_u_per_wk
    : rec.modeled_savings_u_per_wk;
}

/** Spend-lane claim µ$ by rec id, from the request's shared (cached) ledger for `window`. */
function allocatedByRecId(
  recEvidence: RecEvidenceContext,
  window: { from: string; to: string },
): Map<string, number> {
  const byRec = new Map<string, number>();
  for (const claim of aggregateClaims(recEvidence.aggregate(window))) {
    if (claim.lane !== "spend" || claim.recId === undefined) continue;
    byRec.set(claim.recId, (byRec.get(claim.recId) ?? 0) + claim.value_u);
  }
  return byRec;
}

/** A rec's reliability-lane µ$, split by chain: the card headline is main-chain only. */
interface ReliabilitySplit {
  main: number;
  sidechain: number;
}

/** Reliability-lane claim µ$ by rec id (recovery turns); a separate lane, never added to spend. */
function reliabilityByRecId(
  recEvidence: RecEvidenceContext,
  window: { from: string; to: string },
): Map<string, ReliabilitySplit> {
  const byRec = new Map<string, ReliabilitySplit>();
  for (const claim of aggregateClaims(recEvidence.aggregate(window))) {
    if (claim.lane !== "reliability" || claim.recId === undefined) continue;
    const split = byRec.get(claim.recId) ?? { main: 0, sidechain: 0 };
    if (claim.sidechain) split.sidechain += claim.value_u;
    else split.main += claim.value_u;
    byRec.set(claim.recId, split);
  }
  return byRec;
}

function groupSavings(recs: RecommendationCard[]): number {
  return recs.reduce((total, rec) => total + (headlineSavings(rec) ?? 0), 0);
}

/**
 * Derive the display groups from the complete active list without mutating it.
 *
 * Groups are ordered by their cards' summed shown $ (ties: first-seen order); members keep the
 * API's $ order.
 * Recommendations whose modeled value, or failing that the top of their range,
 * is below the de-minimis floor are collected into one final expandable group; a range
 * topping out under the floor is proven minor. Recommendations with neither remain in
 * their detector group because they are not proven to be minor.
 */
export function deriveActiveGroups(
  active: RecommendationCard[],
  spend: ScopeSpendU,
): RecommendationGroup[] {
  const grouped = new Map<string, RecommendationCard[]>();
  const minorItems: RecommendationCard[] = [];

  for (const rec of active) {
    // A null headline ("not estimated", no spend-ledger producer) is decided by the standalone
    // figure, as before L6, so sub-floor C-family recs stay minor instead of becoming major cards.
    const value =
      rec.allocated_u_per_wk === null
        ? (rec.modeled_savings_u_per_wk ?? rec.range_u_per_wk?.[1] ?? null)
        : (headlineSavings(rec) ?? rec.range_u_per_wk?.[1] ?? null);
    const scopeSpendU =
      rec.scope_workspace_id === null
        ? spend.global
        : (spend.byWorkspace.get(rec.scope_workspace_id) ?? 0);
    if (value !== null && value < deMinimisFloorU(scopeSpendU)) {
      minorItems.push(rec);
      continue;
    }
    const members = grouped.get(rec.detector_id);
    if (members === undefined) grouped.set(rec.detector_id, [rec]);
    else members.push(rec);
  }

  // Groups by the summed $ their cards show (reliability included, unlike the spend-only
  // total), descending; ties keep first-seen order. Standalone estimates overlap, so they add
  // only their largest card, never a sum.
  const shownTotal = (recs: RecommendationCard[]) => {
    let sum = 0;
    let standaloneMax = 0;
    for (const rec of recs) {
      const shown = shownU(rec) ?? 0;
      if (isStandaloneShown(rec)) standaloneMax = Math.max(standaloneMax, shown);
      else sum += shown;
    }
    return sum + standaloneMax;
  };
  const groups: RecommendationGroup[] = [...grouped]
    .sort(([, a], [, b]) => shownTotal(b) - shownTotal(a))
    .map(([detector_id, recs]) => ({
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
  active: RecommendationCard[]; // all PROPOSED cards, ranked by the stored estimate
  active_groups: RecommendationGroup[];
  limit_warnings: RecommendationCard[]; // state = PROPOSED, category == LIMIT — rendered as alert strip above active
  adopted: RecommendationCard[]; // ADOPTED / MEASURING / MEASURED_*
  dismissed: RecommendationCard[]; // DISMISSED (in cool-down)
  history: RecommendationCard[]; // prior-window and retired recommendations
  /** Proposed cards under their floor (review 2): built and checked, but not listed. */
  below_floor?: RecommendationCard[];
  detectors: DetectorStatus[];
  rank_warnings: Warning[];
  overflow_count: number;
  excluded: Exclusion[];
  ranking_goal: RankingGoal;
  packet_identity_hash: string;
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
  contract_version: number | null;
  template_id: string | null;
  contract_status: string;
  rule_id: string | null;
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

// V1 structured steps stay: Tier-3 apply (src/apply/jobs.ts) reads them for the prompt payload and
// the D1 trim cache-backfire warning. Card UI copy comes from `actions`.
function trustedSteps(payload: RecommendationPayloadV1): BoundedStep[] {
  const definition = recommendationTemplate(payload.template_id);
  switch (payload.template_id) {
    case "D1_CONTEXT_ALWAYS_LOADED": {
      const component = payload.facts.component;
      if (component === "CLAUDE_MD" || component === "MEMORY") {
        return [{ kind: "trim", target: component === "CLAUDE_MD" ? "CLAUDE_MD" : "MEMORY_MD" }];
      }
      break;
    }
    case "D2_LONG_FULL_CONTEXT":
      return [{ kind: "session_boundary" }];
    case "D4_MODEL_MISMATCH":
      return [{ kind: "route_model", from: "Opus", to: "Sonnet" }];
    case "D11_TOOL_ERROR_RATE":
      return [
        {
          kind: "route_tool",
          from: payload.facts.higher_error_tool,
          to: payload.facts.preferred_tool,
        },
      ];
  }
  return [{ kind: "generic", description: definition.lever }];
}

function trustedFileRef(
  payload: RecommendationPayloadV1,
  scopeWorkspaceId: string | null,
): string | null {
  if (payload.template_id === "D1_CONTEXT_ALWAYS_LOADED") {
    const { probe_id: probeId, component } = payload.facts;
    if (typeof probeId !== "string" || (component !== "CLAUDE_MD" && component !== "MEMORY"))
      return null;
    const source = getQueryDb()
      .prepare(
        `SELECT file_ref FROM context_inventory
       WHERE probe_id = ? AND component = ? AND workspace_id = ?`,
      )
      .get(probeId, component, scopeWorkspaceId ?? "__global__") as
      | { file_ref: string }
      | undefined;
    if (!source?.file_ref || !path.isAbsolute(source.file_ref)) return null;
    return component === "MEMORY" ? path.join(source.file_ref, "MEMORY.md") : source.file_ref;
  }
  if (payload.template_id === "D4_MODEL_MISMATCH") return ".claude/settings.json";
  if (payload.template_id === "D10_CATALOG_FOOTPRINT") return "~/.claude/settings.json";
  return null;
}

/** Detectors whose contract-v1 evidence gets R2 facets synthesized at the query seam. */
const V1_R2_FACET_DETECTOR_IDS = new Set(["D7", "D8"]);

/**
 * P6b — synthesize the §6-checker R2 evidence pair (a metric map + a window) for
 * D7/D8. These are contract-v1 detectors: the v1 privacy contract forbids a nested
 * metric-map fact, so their flat `facts` carry no `metrics`/`window` and R2 reads
 * empty. Migrating them to the V2 envelope would satisfy R2 but drop the flat
 * `evidence.session_ids` array that PP1 retirement, the PP2 per-workspace rollup and
 * the PP3 recency tiebreak all read — a real regression. Instead, derive a metric
 * map from the numeric facts and attach the trailing-7d query window here, scoped to
 * D7/D8. Other golden lanes carry their own R2 evidence (v2 envelope or otherwise).
 */
export function withV1R2Facets(
  detectorId: string,
  facts: Record<string, unknown>,
  window: { from: string; to: string } | null,
): Record<string, unknown> {
  if (!V1_R2_FACET_DETECTOR_IDS.has(detectorId) || window === null) return facts;
  const metrics: Record<string, { kind: string; value: number }> = {};
  for (const [key, value] of Object.entries(facts)) {
    // P2H recency facts describe the anchor, not the finding: never metrics.
    if ((RECENCY_FACT_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[key.toUpperCase()] = { kind: Number.isInteger(value) ? "COUNT" : "NUMBER", value };
    }
  }
  if (Object.keys(metrics).length === 0) return facts;
  // P2H: evidence anchored in an older week describes that week, not the trailing 7d.
  const anchor = facts.last_seen_week_start;
  const anchorWindow =
    typeof anchor === "string" && typeof facts.weeks_ago === "number" && facts.weeks_ago > 0
      ? { from: anchor, to: new Date(Date.parse(anchor) + 7 * 24 * 60 * 60 * 1000).toISOString() }
      : { from: window.from, to: window.to };
  return { ...facts, metrics, window: anchorWindow };
}

/**
 * B5 — parse the persisted `modeled_formula_json` so its provenance (the labeled,
 * often UNVALIDATED avoidance/price/bytes-per-token inputs, the human-readable
 * `expression`, and the `result_usd_per_wk`) can be surfaced in the card/InfoTip.
 * Until B5 this column was SELECTed but discarded — toCard rebuilt a bare object.
 * Returns null on any malformed/non-object payload (the bare rebuild then stands).
 */
function parseStoredFormula(json: string): Partial<ModeledFormula> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Partial<ModeledFormula>;
  } catch {
    return null;
  }
}

export function validateCardActions(
  actions: CardActions | null | undefined,
  detectorId: string,
  sourceFile: string | null,
  scopeWorkspaceId: string | null,
  targetMetric: string,
): Exclude<RecommendationCard["action_validation"], undefined> {
  let baseDir: string | null = null;
  if (scopeWorkspaceId !== null) {
    const workspace = getQueryDb()
      .prepare("SELECT repo_path FROM workspaces WHERE workspace_id = ?")
      .get(scopeWorkspaceId) as { repo_path: string | null } | undefined;
    if (workspace?.repo_path && path.isAbsolute(workspace.repo_path)) {
      baseDir = workspace.repo_path;
    }
  } else if (sourceFile && path.isAbsolute(sourceFile)) {
    baseDir = path.dirname(sourceFile);
  }
  const validate = (action: CardActions["primary"]): ActionValidation => {
    if (detectorId === "D1" && sourceFile === null)
      return { ok: false, reason: "context source file unavailable" };
    if (
      baseDir === null &&
      ((action.file_ref !== null &&
        !path.isAbsolute(action.file_ref) &&
        !action.file_ref.startsWith("~")) ||
        action.hook)
    ) {
      return { ok: false, reason: "workspace base directory unavailable" };
    }
    return validateAction(action, targetMetric, EFFECT_HANDLERS, {
      detectorId,
      baseDir: baseDir ?? path.parse(process.cwd()).root,
    });
  };
  return actions
    ? {
        primary: validate(actions.primary),
        alternatives: Object.fromEntries(
          actions.alternatives.map((option) => [option.option_id, validate(option)]),
        ),
      }
    : null;
}

/**
 * Proposed cards kept off the action list until their fix lands (operator, P3.1 review 1).
 * Empty since U7: D5 now forecasts from the API's used_pct readings (the 1-day-burn-vs-weekly-cap
 * bug that hid it is fixed) and D4 was retargeted.
 */
const HIDDEN_UNTIL_FIXED = new Set<string>();

/**
 * Cards below their floor (operator, P3.1 review 2): kept off the active list (`belowFloor`).
 */
const BELOW_FLOOR = new WeakSet<RecommendationCard>();

/** Which side of a split cost a card is on; null for cards with no partner. */
function overlapKind(card: RecommendationCard): string | null {
  switch (card.detector_id) {
    case "D7":
      return "redundant_path_count" in card.evidence ? "D7_REREAD" : "D7_LOOP";
    case "C9":
      return stringMetric({ evidence: card.evidence }, "DENIAL_CLASS") === "HOOK_BLOCK"
        ? "C9_GUARD"
        : null;
    case "A1":
    case "C1":
    case "D2":
    case "D8":
    case "D11":
    case "H1":
      return card.detector_id;
    default:
      return null;
  }
}

/** For each kind, the partner kinds and what the partner card counts (P3.1-T9 S3). */
// Review 6 R6-03: A1 and D2 both count large results re-sent in long sessions, but only in the
// sessions they share, so this pair links only when their session ids intersect.
const A1_D2_WHY =
  "Large results re-sent in long sessions are also in that card's re-reads; don't add the two.";
const SHARED_SESSION_PAIRS = new Set(["A1:D2", "D2:A1"]);

const OVERLAP_PARTNERS: Record<string, Array<[string, string]>> = {
  // Review 5 M15: D2 <-> D7_REREAD is not an overlap to avoid double-counting (unlike the pairs
  // above and below); it is context, so the reads it names are re-reads worth keeping, not cutting.
  D2: [
    ["D8", "Cache writes after a break are counted there, not here."],
    [
      "D7_REREAD",
      "Read the part needed rather than avoiding the read; fresh sessions re-read on purpose.",
    ],
    ["A1", A1_D2_WHY],
  ],
  D8: [["D2", "Re-reads within long sessions are counted there, not here."]],
  C1: [["D11", "That shell's failed calls are counted there, not here."]],
  D11: [["C1", "Failed calls of the other tools are counted there."]],
  D7_LOOP: [
    ["D7_REREAD", "Files re-read in later sessions are counted there."],
    ["A1", "Results over 25 KB are counted there, not here."],
  ],
  D7_REREAD: [
    ["D7_LOOP", "Calls repeated within one session are counted there."],
    ["A1", "Single results over 25 KB are counted there."],
    [
      "D2",
      "Fresh sessions re-read on purpose; read the part needed rather than avoiding the read.",
    ],
  ],
  A1: [
    ["D7_LOOP", "Calls repeated within one session are on that card, not this one."],
    ["D7_REREAD", "Files re-read in later sessions are on that card, not this one."],
    ["D2", A1_D2_WHY],
  ],
  C9_GUARD: [["H1", "The rm -rf rule goes into this guard."]],
  H1: [["C9_GUARD", "This is the guard the rm -rf rule goes into."]],
};

/** Links each active card to its partners in the same workspace, or across when one is global. */
function linkRelated(active: RecommendationCard[]): void {
  const kinds = new Map(active.map((card) => [card, overlapKind(card)]));
  for (const card of active) {
    const partners = OVERLAP_PARTNERS[kinds.get(card) ?? ""] ?? [];
    const related = partners.flatMap(([kind, why]) =>
      active
        .filter(
          (other) =>
            other !== card &&
            kinds.get(other) === kind &&
            (card.scope_workspace_id === null ||
              other.scope_workspace_id === null ||
              card.scope_workspace_id === other.scope_workspace_id) &&
            (!SHARED_SESSION_PAIRS.has(`${kinds.get(card)}:${kind}`) ||
              recommendationSessionIds(card).some((id) =>
                recommendationSessionIds(other).includes(id),
              )),
        )
        .map((other) => ({ rec_id: other.rec_id, title: other.title ?? other.lever, why })),
    );
    if (related.length > 0) card.related = related;
  }
}

/** True when the workspace has a guard-block card: a PreToolUse guard runs there (P3.1-T9). */
function guardExists(workspaceId: string | null): boolean {
  if (workspaceId === null) return false;
  const rows = getQueryDb()
    .prepare(
      `SELECT evidence_json FROM recommendations
        WHERE detector_id = 'C9' AND state = 'PROPOSED' AND scope_workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ evidence_json: string }>;
  return rows.some((row) => {
    try {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      return stringMetric({ evidence }, "DENIAL_CLASS") === "HOOK_BLOCK";
    } catch {
      return false;
    }
  });
}

/** Cards whose evidence anchors point at the failed, blocked or risky calls themselves. */
/** A Read that failed on the output cap: its result is the error, which a loop card quotes. */
const READ_CAP_ERROR = /^(?:<tool_use_error>)?File content \([^)]*\) exceeds maximum allowed/i;

const ANCHORED_CALL_DETECTORS = new Set(["C1", "C4", "C5", "C7", "C9", "C11", "D14", "H1"]);

function isAnchor(value: unknown): value is EvidenceAnchor {
  const anchor = value as Partial<EvidenceAnchor> | null;
  return (
    typeof anchor?.event_id === "string" &&
    typeof anchor.session_id === "string" &&
    typeof anchor.timestamp === "string"
  );
}

/** The calls behind a card; empty for other cards or when none resolve. */
function toolCallsFor(
  detectorId: string,
  payload: Record<string, unknown>,
  workspaceId: string | null,
  cardWindow: { from: string; to: string } | null,
): CardToolCall[] {
  const window = payload.window as { from?: unknown; to?: unknown } | undefined;
  // Every rm -rf run, not the five anchors, so the card can tell whether any was risky.
  if (
    detectorId === "H1" &&
    workspaceId !== null &&
    typeof window?.from === "string" &&
    typeof window.to === "string" &&
    stringMetric({ evidence: payload }, "DESTRUCTIVE_OPERATION") === "RM_RF"
  ) {
    return destructiveToolCalls(getQueryDb(), {
      workspaceId,
      operation: "rm-rf",
      from: window.from,
      to: window.to,
    });
  }
  // Every guard block, not the five anchors, so each is classified by rule and guard version.
  if (
    detectorId === "C9" &&
    workspaceId !== null &&
    typeof window?.from === "string" &&
    typeof window.to === "string" &&
    stringMetric({ evidence: payload }, "DENIAL_CLASS") === "HOOK_BLOCK"
  ) {
    return guardBlockToolCalls(getQueryDb(), { workspaceId, from: window.from, to: window.to });
  }
  if (ANCHORED_CALL_DETECTORS.has(detectorId)) {
    const anchors = Array.isArray(payload.anchors) ? payload.anchors.filter(isAnchor) : [];
    return anchors.length === 0 ? [] : anchoredToolCalls(getQueryDb(), anchors);
  }
  if (detectorId === "D7") {
    const facts = (payload.facts ?? {}) as Record<string, unknown>;
    const ids = (key: string) =>
      Array.isArray(facts[key]) ? facts[key].filter((id) => typeof id === "string") : [];
    const loop = ids("loop_example_event_ids");
    if (loop.length > 0) {
      const repeats = facts.loop_example_call_count;
      const calls = eventToolCalls(getQueryDb(), loop).map(({ result, ...call }) =>
        // A Read returns file content, not a message worth quoting; its size-cap error is one.
        (call.tool === "Read" && !READ_CAP_ERROR.test(result ?? "")) || result === undefined
          ? call
          : { ...call, result },
      );
      // When each example call ran, so a pasted prompt can name the session and the times.
      const when = getQueryDb().prepare("SELECT ts FROM tool_events WHERE event_id = ?");
      const at = loop.flatMap((id) => {
        const row = when.get(id) as { ts: string } | undefined;
        return row === undefined ? [] : [row.ts];
      });
      // One call read back: it stands for the whole repeat, not just the calls kept.
      return calls.length === 1 && typeof repeats === "number"
        ? calls.map((call) => ({ ...call, calls: repeats, ...(at.length > 0 ? { at } : {}) }))
        : calls;
    }
    const reads = ids("top_read_event_ids");
    return workspaceId === null || cardWindow === null || reads.length === 0
      ? []
      : rereadToolCalls(getQueryDb(), reads, { workspaceId, ...cardWindow });
  }
  if (detectorId === "D11") {
    const tool = (payload.facts as Record<string, unknown> | undefined)?.higher_error_tool;
    return workspaceId === null || cardWindow === null || typeof tool !== "string"
      ? []
      : shellFailureToolCalls(getQueryDb(), { workspaceId, tool, ...cardWindow });
  }
  // D6 (U9 r3): the files and commands behind the largest sessions' mid-size results. Its payload
  // carries no window of its own (U9 r7), so the card's window is used.
  if (detectorId === "D6") {
    const labels = (payload.facts as Record<string, unknown> | undefined)?.top_sessions;
    const sessionIds = (Array.isArray(labels) ? labels : [])
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split("|")[0] ?? "");
    return workspaceId === null || cardWindow === null
      ? []
      : midSizeToolCalls(getQueryDb(), { sessionIds, ...cardWindow });
  }
  if (workspaceId === null || typeof window?.from !== "string" || typeof window.to !== "string") {
    return [];
  }
  // E1 (U8): the files the long-orientation sessions read before their first edit.
  if (detectorId === "E1") {
    const sessionIds = Array.isArray(payload.session_ids)
      ? payload.session_ids.filter((id): id is string => typeof id === "string")
      : [];
    return orientationToolCalls(getQueryDb(), { sessionIds, to: window.to });
  }
  // E2 (U10): the kinds of work in the listed sessions' mechanical runs.
  if (detectorId === "E2") {
    const sessionIds = Array.isArray(payload.session_ids)
      ? payload.session_ids.filter((id): id is string => typeof id === "string")
      : [];
    return mechanicalRunToolCalls(getQueryDb(), { sessionIds, from: window.from, to: window.to });
  }
  // Every missing-path lookup in the window, not the five anchors, so each cause is counted.
  if (detectorId === "C2") {
    return notFoundToolCalls(getQueryDb(), { workspaceId, from: window.from, to: window.to });
  }
  if (detectorId === "C3") {
    return notReadToolCalls(getQueryDb(), { workspaceId, from: window.from, to: window.to });
  }
  if (detectorId !== "A1") return [];
  return oversizedToolCalls(getQueryDb(), { workspaceId, from: window.from, to: window.to });
}

function toCard(
  r: RecRow,
  sessionsPerWeek: number | null,
  workspaceWeeklySpend: number | null,
  window: { from: string; to: string } | null = null,
  recEvidence: RecEvidenceContext | null = null,
  allocatedByRecId: ReadonlyMap<string, number> | null = null,
  reliabilityRecIds: ReadonlyMap<string, ReliabilitySplit> | null = null,
): RecommendationCard | null {
  const contract = trustedRecommendationContract(r);
  if (contract === null) return null;
  const { definition } = contract;
  const storedFormula = parseStoredFormula(r.modeled_formula_json);
  const evidence =
    contract.version === 1
      ? withV1R2Facets(
          definition.detector_id,
          contract.payload.facts as Record<string, unknown>,
          window,
        )
      : ({ ...contract.payload } as Record<string, unknown>);
  const payload = contract.payload as unknown as Record<string, unknown>;
  const facts =
    payload.facts !== null && typeof payload.facts === "object" && !Array.isArray(payload.facts)
      ? (payload.facts as Record<string, unknown>)
      : undefined;
  const sourceFile =
    contract.version === 1 ? trustedFileRef(contract.payload, r.scope_workspace_id) : null;
  const detectorId = r.detector_id ?? "";
  const toolCalls = toolCallsFor(detectorId, payload, r.scope_workspace_id, window);
  // Review 5 M11: D11 also offers to extend an existing guard.
  const guard = (detectorId === "H1" || detectorId === "D11") && guardExists(r.scope_workspace_id);
  const recency =
    facts ??
    (payload.recency !== null &&
    typeof payload.recency === "object" &&
    !Array.isArray(payload.recency)
      ? (payload.recency as Record<string, unknown>)
      : evidence);
  const lastSeenWeekStart =
    typeof recency.last_seen_week_start === "string" ? recency.last_seen_week_start : null;
  const storedIds = (payload.session_ids ?? facts?.session_ids) as unknown;
  const sessionRank = recEvidence?.sessionRank(
    {
      rec_id: r.rec_id,
      detector_id: detectorId,
      scope_workspace_id: r.scope_workspace_id,
      evidence,
      last_seen_week_start: lastSeenWeekStart,
      session_ids: Array.isArray(storedIds)
        ? storedIds.filter((id): id is string => typeof id === "string")
        : [],
    },
    window,
  );
  const estimate = storedFormula?.estimate ?? null;
  const assumed = detectorId in DETECTOR_CONTRACTS && hasAssumed(detectorId);
  const rankValue = estimate?.basis === "X" ? null : (estimate?.rank_value_u_per_wk ?? null);
  // F3: D2's saving is not linear in its assumptions, so the detector stores its own range.
  const low = facts?.savings_low_u_per_wk;
  const high = facts?.savings_high_u_per_wk;
  const storedRange: [number, number] | null =
    typeof low === "number" && typeof high === "number" ? [low, high] : null;
  const range_u_per_wk =
    assumed && rankValue !== null ? (storedRange ?? rangeFor(detectorId, rankValue)) : null;
  const actionRec = {
    detector_id: definition.detector_id,
    lever: definition.lever,
    evidence: payload,
    ...(facts === undefined
      ? {}
      : { facts: detectorId === "D1" ? { ...facts, source_file_ref: sourceFile } : facts }),
    window,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    ...(guard ? { guard_exists: true } : {}),
    ...(sessionRank === undefined ? {} : { session_rank: sessionRank }),
    ...(r.modeled_savings_u_per_wk === null
      ? {}
      : { savings_u_per_wk: r.modeled_savings_u_per_wk }),
    ...(range_u_per_wk === null ? {} : { savings_range_u_per_wk: range_u_per_wk }),
  };
  const certification =
    CERTIFICATION[detectorId]?.status === "CERTIFIED" ? "CERTIFIED" : "UNVERIFIED";
  const workspace_multiplier =
    typeof evidence.workspace_multiplier === "number" ? evidence.workspace_multiplier : null;
  // P3.L L6: the card headline. `null` = no spend-lane producer ("not estimated", never $0);
  // a producer with no claims for this rec in the window is a real $0.
  // No allocation map (actions-only path) → unset, so consumers fall back to the standalone figure.
  // U9 r7: D7's ledger producer claims only the cross-session re-reads; its loop card has no
  // producer, so its headline is "not estimated", never a $0 next to the body's own figure.
  const onLedger =
    SPEND_LANE_DETECTOR_IDS.has(detectorId) && payload.template_id !== "D7_RETRY_LOOP";
  const allocated_u_per_wk =
    allocatedByRecId === null
      ? undefined
      : onLedger
        ? Math.round(allocatedByRecId.get(r.rec_id) ?? 0)
        : null;
  // Reliability cards: the ledger's main-chain recovery-turn $ for this rec (an upper bound),
  // matching the cards' MAIN_ONLY contract; subagent failures ride alongside, never in the
  // headline (operator 2026-10-04). A separate lane from `allocated_u_per_wk`; never summed
  // into a headline, group or page total.
  const reliabilitySplit = reliabilityRecIds?.get(r.rec_id);
  // Safety lane (operator 2026-10-04): destructive runs and guard blocks show a count, not a $.
  const safety = isSafetyLane(detectorId, payload);
  const reliability_u_per_wk =
    reliabilityRecIds === null
      ? undefined
      : RELIABILITY_LANE_DETECTOR_IDS.has(detectorId) && !safety
        ? Math.round(reliabilitySplit?.main ?? 0)
        : null;
  const reliability_sidechain_u_per_wk =
    reliability_u_per_wk === undefined || reliability_u_per_wk === null
      ? undefined
      : Math.round(reliabilitySplit?.sidechain ?? 0);
  const pct_of_weekly_spend = pctOfSpend(allocated_u_per_wk, workspaceWeeklySpend);
  let actions: CardActions | null = null;
  if (definition.category !== "LIMIT") {
    try {
      actions = buildCardActions(actionRec);
    } catch {
      // A rejected action must not hide its recommendation from the single list.
      actions = null;
    }
  }
  const card: RecommendationCard = {
    rec_id: r.rec_id,
    detector_id: detectorId,
    category: definition.category,
    scope_workspace_id: r.scope_workspace_id,
    lever: definition.lever,
    title: cardTitle(actionRec),
    modeled_savings_u_per_wk: r.modeled_savings_u_per_wk,
    ...(allocated_u_per_wk === undefined ? {} : { allocated_u_per_wk }),
    ...(reliability_u_per_wk === undefined ? {} : { reliability_u_per_wk }),
    ...(reliability_sidechain_u_per_wk ? { reliability_sidechain_u_per_wk } : {}),
    ...(safety ? { safety_lane: true as const } : {}),
    pct_of_weekly_spend,
    run_cost_u: r.run_cost_u,
    modeled_formula: {
      model: definition.formula_id,
      // Merge the stored formula's labeled provenance inputs UNDER evidence: evidence
      // wins on shared keys (preserving cap_read_coefficient etc.), while formula-only
      // inputs (avoidance_fraction, prices, bytes_per_token) become visible.
      inputs: storedFormula === null ? evidence : { ...storedFormula.inputs, ...evidence },
      ...(typeof storedFormula?.expression === "string"
        ? { expression: storedFormula.expression }
        : {}),
      ...(typeof storedFormula?.result_usd_per_wk === "number"
        ? { result_usd_per_wk: storedFormula.result_usd_per_wk }
        : {}),
      ...(definition.detector_id === "D5"
        ? { kind: "WARNING" }
        : definition.detector_id === "D4"
          ? { kind: "ADVISORY" }
          : {}),
      ...(estimate === null ? {} : { estimate }),
    },
    estimate,
    certification,
    confidence_tier: confidenceTierFor(CERTIFICATION[detectorId], assumed),
    range_u_per_wk,
    actions,
    action_validation: validateCardActions(
      actions,
      detectorId,
      sourceFile,
      r.scope_workspace_id,
      definition.target_metric,
    ),
    trigger: buildTrigger(actionRec, {
      ...(allocated_u_per_wk === undefined ? {} : { allocated_u_per_wk }),
      ...(reliability_u_per_wk === undefined ? {} : { reliability_u_per_wk }),
    }),
    last_seen_week_start: lastSeenWeekStart,
    weeks_ago: typeof recency.weeks_ago === "number" ? recency.weeks_ago : null,
    weeks_fired: typeof recency.weeks_fired === "number" ? recency.weeks_fired : null,
    weeks_evaluated: typeof recency.weeks_evaluated === "number" ? recency.weeks_evaluated : null,
    evidence,
    target_metric: definition.target_metric,
    state: r.state,
    created_at: r.created_at,
    dismissed_until: r.dismissed_until,
    headroom: deriveHeadroom(definition.category, evidence, sessionsPerWeek),
    sessions_per_week: sessionsPerWeek,
    steps: contract.version === 1 ? trustedSteps(contract.payload) : [],
    actionability_ok: definition.actionable,
    cross_workspace: r.scope_workspace_id === null,
    workspace_multiplier,
    file_ref: sourceFile,
    effect_capability: capabilityForRecommendation(getQueryDb(), r.rec_id),
    effect_cycle: latestEffectCycle(getQueryDb(), r.rec_id),
    legacy_effect_verdict:
      (
        getQueryDb()
          .prepare(
            "SELECT verdict FROM recommendation_effects WHERE rec_id=? ORDER BY measured_at DESC LIMIT 1",
          )
          .get(r.rec_id) as { verdict: RecommendationCard["legacy_effect_verdict"] } | undefined
      )?.verdict ?? null,
  };
  if (belowFloor(actionRec)) BELOW_FLOOR.add(card);
  return card;
}

function isSafetyLane(detectorId: string, evidence: Record<string, unknown>): boolean {
  return (
    detectorId === "H1" ||
    (detectorId === "C9" && stringMetric({ evidence }, "DENIAL_CLASS") === "HOOK_BLOCK")
  );
}

/** Safety cards, most irreversible first; a guard block (it never ran) last. */
const SAFETY_ORDER = ["SQL_DROP", "RM_RF", "GIT_RESET_HARD", "GIT_CLEAN", "TRUNCATE"];

function safetyRank(card: RecommendationCard): [number, number] {
  const evidence = { evidence: card.evidence };
  if (card.detector_id === "C9") {
    return [SAFETY_ORDER.length, numberMetric(evidence, "DENIAL_COUNT") ?? 0];
  }
  const index = SAFETY_ORDER.indexOf(stringMetric(evidence, "DESTRUCTIVE_OPERATION") ?? "");
  return [
    index === -1 ? SAFETY_ORDER.length : index,
    numberMetric(evidence, "OPERATION_COUNT") ?? 0,
  ];
}

/** The $ the card headline shows (what `SavingsMeter` renders); null when it shows none. */
function shownU(card: RecommendationCard): number | null {
  if (card.allocated_u_per_wk === null) {
    if (typeof card.reliability_u_per_wk === "number") return card.reliability_u_per_wk;
    return isStandaloneShown(card) ? card.modeled_savings_u_per_wk : null;
  }
  return headlineSavings(card);
}

/** Standalone lane (E1/E2): the meter shows the modeled figure, kept out of the page total. */
function isStandaloneShown(card: RecommendationCard): boolean {
  return (
    card.allocated_u_per_wk === null &&
    typeof card.reliability_u_per_wk !== "number" &&
    typeof card.modeled_savings_u_per_wk === "number" &&
    card.modeled_savings_u_per_wk > 0 &&
    card.estimate?.summable === false
  );
}

/**
 * Active order (P3.L-F, amended 2026-10-13): cards that show a $ before those that don't, then
 * shown $ descending; certification does not rank. Ties fall back to the stored estimate rank
 * (X and missing last), then created_at, then rec_id.
 */
function byEstimateRank(a: RecommendationCard, b: RecommendationCard): number {
  const as = shownU(a);
  const bs = shownU(b);
  if (as === null && bs !== null) return 1;
  if (as !== null && bs === null) return -1;
  if (as !== null && bs !== null && as !== bs) return bs - as;
  // Safety cards: by irreversibility, then count; their $ estimate measures session size.
  if (a.safety_lane && b.safety_lane) {
    const [ao, an] = safetyRank(a);
    const [bo, bn] = safetyRank(b);
    if (ao !== bo) return ao - bo;
    if (an !== bn) return bn - an;
  }
  const rank = (card: RecommendationCard): number | null =>
    card.estimate?.basis === "X" ? null : (card.estimate?.rank_value_u_per_wk ?? null);
  const ar = rank(a);
  const br = rank(b);
  if (ar === null && br !== null) return 1;
  if (ar !== null && br === null) return -1;
  if (ar !== null && br !== null && ar !== br) return br - ar;
  const created = a.created_at.localeCompare(b.created_at);
  return created !== 0 ? created : a.rec_id.localeCompare(b.rec_id);
}

const ADOPTED_STATES = new Set([
  "ADOPTED",
  "MEASURING",
  "MEASURED_EFFECTIVE",
  "MEASURED_NO_EFFECT",
]);

const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Undo the recorded decision. An open measurement is stopped; files are untouched. */
function lifecycleReplay(
  db: ReturnType<typeof getQueryDb>,
  recId: string,
  action: string,
  key: string,
): boolean {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(key))
    throw new EffectRequestError(400, "Invalid idempotency key.");
  const previous = db
    .prepare("SELECT rec_id,action FROM recommendation_lifecycle_actions WHERE idempotency_key=?")
    .get(key) as { rec_id: string; action: string } | undefined;
  if (previous === undefined) return false;
  if (previous.rec_id !== recId || previous.action !== action)
    throw new EffectRequestError(409, "Idempotency key was reused for a different action.");
  return true;
}

export function undoAdoptRecommendation(
  rec_id: string,
  key: string,
  nowMs = Date.now(),
): ApiResponse<{ ok: true }> {
  const db = getQueryDb();
  db.transaction(() => {
    if (lifecycleReplay(db, rec_id, "UNDO_ADOPT", key)) return;
    const row = db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(rec_id) as
      | { state: string }
      | undefined;
    if (row?.state !== "ADOPTED" && row?.state !== "MEASURING")
      throw new EffectRequestError(409, "Only an adopted recommendation can be undone.");
    const cycle = latestEffectCycle(db, rec_id);
    if (cycle?.state === "OPEN_SETTLING" || cycle?.state === "OPEN_MEASURING") {
      effectEngineForDb(db).stop(cycle.cycleId, {
        idempotencyKey: `undo-adopt:${cycle.cycleId}`,
        reason: "ADOPTION_UNDONE",
        at: new Date(nowMs).toISOString(),
      });
    }
    db.prepare(
      "UPDATE recommendations SET state='PROPOSED', adopted_at=NULL WHERE rec_id=? AND state IN ('ADOPTED','MEASURING')",
    ).run(rec_id);
    db.prepare(
      "INSERT INTO recommendation_lifecycle_actions(idempotency_key,rec_id,action,recorded_at) VALUES (?,?,'UNDO_ADOPT',?)",
    ).run(key, rec_id, new Date(nowMs).toISOString());
  }).immediate();
  return buildResponse({ ok: true }, { claim_kind: "EXPERIMENTAL", n: 1, drilldown_ids: {} });
}

/** Restore an improved decision to the queue while retaining every effect cycle. */
export function reopenRecommendation(rec_id: string, key: string): ApiResponse<{ ok: true }> {
  const db = getQueryDb();
  db.transaction(() => {
    if (lifecycleReplay(db, rec_id, "REOPEN", key)) return;
    const row = db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(rec_id) as
      | { state: string }
      | undefined;
    if (row?.state !== "MEASURED_EFFECTIVE")
      throw new EffectRequestError(409, "Only an improved recommendation can be reopened.");
    const cycle = latestEffectCycle(db, rec_id);
    if (cycle !== null) {
      if (cycle.state !== "FINALIZED" || cycle.targetDirection !== "IMPROVED")
        throw new EffectRequestError(409, "A finalized improvement is required to reopen.");
    } else {
      const legacy = db
        .prepare(
          "SELECT verdict FROM recommendation_effects WHERE rec_id=? ORDER BY measured_at DESC LIMIT 1",
        )
        .get(rec_id) as { verdict: string | null } | undefined;
      if (legacy?.verdict !== "EFFECTIVE")
        throw new EffectRequestError(409, "A finalized improvement is required to reopen.");
    }
    db.prepare(
      "UPDATE recommendations SET state='PROPOSED', adopted_at=NULL WHERE rec_id=? AND state='MEASURED_EFFECTIVE'",
    ).run(rec_id);
    db.prepare(
      "INSERT INTO recommendation_lifecycle_actions(idempotency_key,rec_id,action,recorded_at) VALUES (?,?,'REOPEN',?)",
    ).run(key, rec_id, new Date().toISOString());
  }).immediate();
  return buildResponse({ ok: true }, { claim_kind: "EXPERIMENTAL", n: 1, drilldown_ids: {} });
}

/**
 * Dismiss a PROPOSED recommendation.
 * By default uses a 30-day cool-down. Pass `dismissedUntilOverride` (ISO string)
 * to set a custom wake date (e.g. for an explicit snooze duration from the UI).
 * When the `dismissed_until` date passes, the persisted state returns to PROPOSED.
 * nowMs is injectable for deterministic tests; defaults to Date.now().
 */
export function dismissRecommendation(
  rec_id: string,
  nowMs: number = Date.now(),
  dismissedUntilOverride?: string,
): ApiResponse<{ ok: true }> {
  const db = getQueryDb();
  const rec = db
    .prepare(
      `SELECT detector_id, category, lever, target_metric, evidence_json,
              contract_version, template_id, contract_status, rule_id
         FROM recommendations WHERE rec_id = ?`,
    )
    .get(rec_id) as Parameters<typeof trustedRecommendationContract>[0] | undefined;
  if (rec !== undefined && trustedRecommendationContract(rec) === null)
    throw new EffectRequestError(400, "Recommendation contract is not trusted.");
  db.prepare(
    `UPDATE recommendations SET state='PROPOSED', dismissed_until=NULL
       WHERE rec_id=? AND state='DISMISSED' AND dismissed_until <= ?`,
  ).run(rec_id, new Date(nowMs).toISOString());
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

/** Track refusals meaning "nothing can measure this rec" — adoption is still saved. */
const UNMEASURABLE_REASONS: ReadonlySet<string> = new Set([
  "HANDLER_UNAVAILABLE",
  "MEASUREMENT_UNAVAILABLE",
  "SOURCE_UNAVAILABLE",
]);

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
  options?: {
    completedChange?: boolean;
    machineConfirmed?: boolean;
    actionRevision?: string;
    optionId?: unknown;
    /** P0-U7: the displayed card (recs snapshot), so adopt skips the card build and its git probe. */
    cardFor?: CardLookup;
  },
): ApiResponse<{ ok: true; effect_measured?: false }> {
  const db = getQueryDb();
  const adoptedAt = new Date(nowMs).toISOString();
  const afterTo = new Date(nowMs + AFTER_WINDOW_DAYS * MS_PER_DAY).toISOString();

  // Read the rec BEFORE the transaction so snapshotBeforeValue sees stable input.
  const rec = db
    .prepare(
      `SELECT rec_id, detector_id, category, scope_workspace_id, lever, evidence_json, target_metric, state,
              contract_version, template_id, contract_status, rule_id
         FROM recommendations WHERE rec_id = ?`,
    )
    .get(rec_id) as
    | (MeasurementRecRow & {
        lever: string;
        state: RecommendationCard["state"];
        contract_version: number | null;
        template_id: string | null;
        contract_status: string;
        rule_id: string | null;
      })
    | undefined;

  if (rec !== undefined && trustedRecommendationContract(rec) === null)
    throw new EffectRequestError(400, "Recommendation contract is not trusted.");

  if (ESF_EFFECT_WRITER_ENABLED) {
    if (rec === undefined || rec.state !== "PROPOSED")
      throw new EffectRequestError(400, `rec ${rec_id} not found or not in PROPOSED state`);
    let optionId: string | undefined;
    if (!isWarningClass(rec) && !options?.machineConfirmed) {
      const actions = (options?.cardFor?.(rec_id) ?? getRecommendationCard(rec_id, true))?.actions;
      if (options?.optionId !== undefined) {
        const selected = actions
          ? [actions.primary, ...actions.alternatives].find(
              (action) => action.option_id === options.optionId,
            )
          : undefined;
        if (selected === undefined)
          throw new EffectRequestError(400, "option_id is not an available action.");
        optionId = selected.option_id;
      } else {
        optionId = actions?.primary.option_id;
      }
    }
    let effectMeasured = true;
    if (!isWarningClass(rec)) {
      if (!options?.completedChange && !options?.machineConfirmed)
        throw new EffectRequestError(400, "Confirm that the change is complete before tracking.");
      const nextCycleNo = (
        db
          .prepare("SELECT COALESCE(MAX(cycle_no),0)+1 AS next FROM effect_cycles WHERE rec_id=?")
          .get(rec_id) as { next: number }
      ).next;
      const result = options?.machineConfirmed
        ? trackMachineConfirmedChange(db, rec_id, new Date(nowMs), options.actionRevision)
        : trackCompletedChange(
            db,
            {
              rec_id,
              idempotency_key: `legacy-adopt:${rec_id}:${nextCycleNo}`,
              completed_change: true,
            },
            new Date(nowMs),
            optionId,
          );
      if (!result.supported && !options?.machineConfirmed) {
        // REL-FIX 2 (operator 2026-10-19): nothing can measure this rec, so save the
        // adoption without a cycle. Any other refusal is a real error and is reported.
        if (!UNMEASURABLE_REASONS.has(result.reason))
          throw new EffectRequestError(400, `Effect tracking refused: ${result.reason}.`);
        effectMeasured = false;
      }
    }
    // Compatibility state describes adoption only. Versioned cycles own measurement truth.
    db.prepare("UPDATE recommendations SET state='ADOPTED',adopted_at=? WHERE rec_id=?").run(
      adoptedAt,
      rec_id,
    );
    return buildResponse<{ ok: true; effect_measured?: false }>(
      effectMeasured ? { ok: true } : { ok: true, effect_measured: false },
      { claim_kind: "EXPERIMENTAL", n: 1, drilldown_ids: {} },
    );
  }

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

/** A no-build card source (the recs snapshot); null means "build it with getRecommendationCard". */
export type CardLookup = (rec_id: string) => RecommendationCard | null;

export function getRecommendationCard(
  rec_id: string,
  actionsOnly = false,
): RecommendationCard | null {
  const db = getQueryDb();
  const row = db
    .prepare(
      `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
              r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
              r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
              r.created_at, r.dismissed_until, r.contract_version, r.template_id, r.contract_status,
              r.rule_id
         FROM recommendations r
         LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
        WHERE r.rec_id = ?`,
    )
    .get(rec_id) as RecRow | undefined;
  if (row === undefined) return null;
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  const workspaceWeeklySpend = actionsOnly
    ? null
    : workspaceSpendU(
        db,
        row.scope_workspace_id,
        now.getTime() - 7 * 24 * 60 * 60 * 1000,
        now.getTime(),
      );
  const window = {
    from: cutoffIso,
    to: nowIso,
  };
  const recEvidence = new RecEvidenceContext(db);
  const card = toCard(
    row,
    null,
    workspaceWeeklySpend,
    window,
    recEvidence,
    // The actions path never shows the headline: skip the ledger build (and leave it unset).
    // The actions path never shows the headline: skip the ledger build (and leave it unset).
    actionsOnly ? null : allocatedByRecId(recEvidence, window),
    actionsOnly ? null : reliabilityByRecId(recEvidence, window),
  );
  if (card && !actionsOnly) recEvidence.enrich(card, window);
  return card;
}

// ---------------------------------------------------------------------------
// Detector-status strip (DR8)
// ---------------------------------------------------------------------------
// Primary path: read detector_status_live (persisted by runHistoryWalk after
// each W0 evaluation). The table holds the strip the walk already computed,
// so listRecommendations avoids re-evaluating every detector's evaluate()
// (~5s on a live DB). UNEVALUATED_DETECTORS are appended at read time.
// Fallback: fresh DB (no rows yet) or tests that do not run a walk fall
// through to cachedDetectorStatuses, which re-evaluates live and memoizes
// per ingest-generation marker (unchanged behaviour from before P4).
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
 * Read the persisted W0 strip from detector_status_live (written by runHistoryWalk).
 * Returns null when the table has no rows (fresh DB / no walk yet — callers fall
 * back to cachedDetectorStatuses). UNEVALUATED_DETECTORS are appended to match
 * the shape detectorStatuses() returns.
 */
function readLiveDetectorStatuses(db: ReturnType<typeof getQueryDb>): DetectorStatus[] | null {
  const rows = db
    .prepare("SELECT detector_id, name, status, note FROM detector_status_live ORDER BY ordinal")
    .all() as Array<{ detector_id: string; name: string; status: string; note: string | null }>;
  if (rows.length === 0) return null;
  // Drop rows for detectors no longer registered (the walk only replaces its own ids).
  const registered = new Set(DETECTORS.map((d) => d.id));
  const statuses: DetectorStatus[] = rows
    .filter((r) => registered.has(r.detector_id))
    .map((r) => ({
      detector_id: r.detector_id,
      name: r.name,
      status: r.status as DetectorStatus["status"],
      note: r.note ?? "",
    }));
  for (const d of UNEVALUATED_DETECTORS) {
    statuses.push({ detector_id: d.id, name: d.name, status: d.status, note: d.note });
  }
  return statuses;
}

const recommendationsCache = new WeakMap<
  object,
  Map<
    string,
    { key: string; ingestKey: string; builtAtMs: number; result: ApiResponse<RecommendationsView> }
  >
>();
// Live sessions append ingest rows every few seconds, and a cold build blocks the
// single-threaded daemon for ~5 s, so ingest-only changes may reuse a build this old.
// Lifecycle/config changes (the hashed tables) still invalidate immediately.
const INGEST_STALE_MS = 60_000;
let recommendationsBuildCount = 0;

/** Test-only: total number of successfully completed recommendation builds. */
export function __recommendationsBuildCount(): number {
  return recommendationsBuildCount;
}

// Lifecycle state (adopt/dismiss/track), config, and detector status change without
// ingest, often as UPDATEs, so these small tables are hashed row by row: every
// INSERT/UPDATE/DELETE invalidates the response.
const HASHED_TABLES = [
  "recommendations",
  "effect_cycles",
  "recommendation_effects",
  "recommendation_lifecycle_actions",
  "detector_status_live",
  "analysis_runs",
  "hre_effect_cycle_links",
  "hre_recommendation_revisions",
  "hre_artifact_revisions",
  "hre_artifact_applications",
  "hre_measurement_methods",
  "workspaces",
  "pricing_snapshots",
  "context_inventory",
  "work_items",
  "observed_outcomes",
  "session_work_links",
  "user_config",
];
// Ingest-written, append-only evidence tables are far too large to hash per request
// (ingest_metric_events alone took ~13 s on the live DB); count + max rowid marks them.
const APPENDED_TABLES = [
  "subagent_meta",
  "tool_events",
  "tool_event_metadata",
  "tool_event_content",
  "ingest_metric_events",
];

export function recommendationsStateKey(): string {
  return withSpan("recommendationsStateKey", () => recStateKey(getQueryDb()));
}

// Timer-rewritten columns that no recs/route code reads (verified by grep of src/query and
// src/daemon): a no-op probe, sync, derive or detector pass rewrites them without a content
// change, so hashing them rebuilt recs every probe. `INSERT OR REPLACE` also moves rowid, hence
// the stable `order`. user_config additionally drops the per_model_snapshot row that
// /api/burn-status rewrites on every poll (only D4's advisory cap text reads it).
/** user_config keys written by timers, polls or passes (not by a user action); they refresh recs via the 10-min ingest mark, not the immediate state key. */
export const RECS_BOOKKEEPING_CONFIG = {
  keys: [
    "per_model_snapshot", // burn-status poll
    "usage_last_good", // limits last-good store
    "detector_pass_marker", // boot-state, per detector pass
    "detector_pass_completed_at", // boot-state, per detector pass
    "last_measurement_run_at", // measurement pass
    "outcomes_last_pass_at", // outcomes pass
    "turns_agent_id_backfill_v1", // one-time ingest backfill marker
    "ledger_enrichment_epoch", // closed-window ledger cache epoch, bumped by ingest enrichment
  ],
  prefixes: [
    "gh_watermark:", // outcomes sync
    "gh_findings_seen:", // outcomes findings
    "gh_e1_check:", // outcomes findings
    "gh_e3_diff:", // outcomes findings
    "gh_pr_reads:", // outcomes linker
    "gh_commit_pulls:", // outcomes linker
  ],
};

/**
 * The bookkeeping keys a recs path actually reads, so the 10-min ingest mark still hashes them.
 * ledgerFingerprint reads ledger_enrichment_epoch (closed-window ledger edits). Only D4 reads
 * per_model_snapshot (and only seven_day_util + per_model; see recsIngestMark).
 * Every other RECS_BOOKKEEPING_CONFIG key is read by no recs path (guard: recs-ingest-mark-keys.test.ts)
 * and moves neither the state key nor the mark. A new reader of a dropped key must add it here.
 */
export const RECS_INGEST_MARK_KEYS: readonly string[] = [
  "ledger_enrichment_epoch",
  "per_model_snapshot",
];

/** SQL predicate (on `key`) true for bookkeeping rows; built from constants only. */
export const RECS_BOOKKEEPING_SQL = `(key IN (${RECS_BOOKKEEPING_CONFIG.keys
  .map((k) => `'${k}'`)
  .join(", ")}) OR ${RECS_BOOKKEEPING_CONFIG.prefixes
  .map((p) => `substr(key, 1, ${p.length}) = '${p}'`)
  .join(" OR ")})`;

const VOLATILE_HASH_SPEC: Record<string, { drop: string[]; order: string; where?: string }> = {
  context_inventory: { drop: ["probed_at"], order: "probe_id" },
  detector_status_live: { drop: ["evaluated_at"], order: "detector_id" },
  work_items: { drop: ["synced_at"], order: "work_item_id" },
  observed_outcomes: { drop: ["derived_at"], order: "work_item_id" },
  user_config: { drop: [], order: "rowid", where: `NOT ${RECS_BOOKKEEPING_SQL}` },
};

const hashSqlCache = new WeakMap<object, Map<string, string>>();

function hashSql(db: ReturnType<typeof getQueryDb>, table: string): string {
  let perDb = hashSqlCache.get(db);
  if (perDb === undefined) {
    perDb = new Map();
    hashSqlCache.set(db, perDb);
  }
  let sql = perDb.get(table);
  if (sql === undefined) {
    const spec = VOLATILE_HASH_SPEC[table];
    if (spec === undefined) sql = `SELECT * FROM ${table} ORDER BY rowid`;
    else {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((name) => !spec.drop.includes(name));
      sql = `SELECT ${cols.join(", ")} FROM ${table}${spec.where ? ` WHERE ${spec.where}` : ""} ORDER BY ${spec.order}`;
    }
    perDb.set(table, sql);
  }
  return sql;
}

function recStateKey(db: ReturnType<typeof getQueryDb>): string {
  const hash = createHash("sha1");
  for (const table of HASHED_TABLES) {
    for (const row of db.prepare(hashSql(db, table)).raw().iterate())
      hash.update(JSON.stringify(row));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function recIngestKey(db: ReturnType<typeof getQueryDb>): string {
  const marks = APPENDED_TABLES.map((table) => {
    const m = db
      .prepare(`SELECT COUNT(*) AS c, IFNULL(MAX(rowid), 0) AS m FROM ${table}`)
      .get() as { c: number; m: number };
    return `${m.c}:${m.m}`;
  });
  return `${ingestGenerationKey(db)}|${marks.join(",")}`;
}

function cachedActionsUnchanged(result: ApiResponse<RecommendationsView>): boolean {
  if (result.data === null) return false;
  const { active, limit_warnings, adopted, dismissed, history } = result.data;
  return [...active, ...limit_warnings, ...adopted, ...dismissed, ...history].every(
    (card) =>
      JSON.stringify(card.action_validation) ===
      JSON.stringify(
        validateCardActions(
          card.actions,
          card.detector_id,
          card.file_ref,
          card.scope_workspace_id,
          card.target_metric,
        ),
      ),
  );
}

/**
 * Read `recommendations` grouped by lifecycle plus the live per-detector status.
 * When `scope` is given, only that workspace's rows and global (NULL-scope) rows
 * are returned. Claim kind: EXPERIMENTAL.
 */
/** Verified only when certified with a C1 oracle and no ASSUMED constants (P3.F). */
export function confidenceTierFor(
  entry: CertEntry | undefined,
  assumed: boolean,
): "VERIFIED" | "ESTIMATED" | "UNVERIFIED" {
  if (entry?.status !== "CERTIFIED") return "UNVERIFIED";
  return assumed || entry.evidence.c1Estimated ? "ESTIMATED" : "VERIFIED";
}

export function listRecommendations(
  scope?: string,
  now = new Date(),
): ApiResponse<RecommendationsView> {
  const db = getQueryDb();
  expireRecommendationDismissals(now);
  const nowMs = now.getTime();
  const key = `${recStateKey(db)}|b${Math.floor(nowMs / 600_000)}`;
  const ingestKey = recIngestKey(db);
  const scopeKey = scope ?? "";
  const cache = recommendationsCache.get(db);
  const hit = cache?.get(scopeKey);
  if (
    !db.inTransaction &&
    hit?.key === key &&
    (hit.ingestKey === ingestKey || nowMs - hit.builtAtMs < INGEST_STALE_MS) &&
    cachedActionsUnchanged(hit.result)
  )
    return hit.result;

  const result = buildRecommendations(scope, now);
  const entries = cache ?? new Map();
  if (!db.inTransaction) {
    entries.set(scopeKey, { key, ingestKey, builtAtMs: nowMs, result });
    recommendationsCache.set(db, entries);
  } else {
    recommendationsCache.delete(db);
  }
  return result;
}

/** True when a dismissal has run out, so `expireRecommendationDismissals` would write (a read). */
export function recommendationDismissalsDue(now = new Date()): boolean {
  return (
    getQueryDb()
      .prepare(
        "SELECT 1 FROM recommendations WHERE state='DISMISSED' AND dismissed_until <= ? LIMIT 1",
      )
      .get(now.toISOString()) !== undefined
  );
}

/** Cheap lifecycle maintenance, run only on the main thread for HTTP requests. */
export function expireRecommendationDismissals(now = new Date()): number {
  return withSpan("expireRecommendationDismissals", () => {
    const db = getQueryDb();
    return db
      .prepare(
        `UPDATE recommendations SET state='PROPOSED', dismissed_until=NULL
         WHERE state='DISMISSED' AND dismissed_until <= ?`,
      )
      .run(now.toISOString()).changes;
  });
}

/** Build from DB reads only; safe for a dedicated worker connection. */
export function buildRecommendations(
  scope?: string,
  now = new Date(),
): ApiResponse<RecommendationsView> {
  const db = getQueryDb();
  const nowIso = now.toISOString();

  const rows = (
    scope !== undefined
      ? db
          .prepare(
            `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
                    r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
                    r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
                    r.created_at, r.dismissed_until, r.contract_version, r.template_id, r.contract_status,
                    r.rule_id
               FROM recommendations r
               LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
              WHERE (r.scope_workspace_id = ? OR r.scope_workspace_id IS NULL)
                AND r.rec_id NOT LIKE 'riq-%'
              ORDER BY r.created_at DESC, r.rec_id ASC`,
          )
          .all(scope)
      : db
          .prepare(
            `SELECT r.rec_id, r.detector_id, r.category, r.scope_workspace_id, r.lever,
                    r.modeled_savings_u_per_wk, ar.cost_equiv_u AS run_cost_u,
                    r.modeled_formula_json, r.evidence_json, r.target_metric, r.state,
                    r.created_at, r.dismissed_until, r.contract_version, r.template_id, r.contract_status,
                    r.rule_id
               FROM recommendations r
               LEFT JOIN analysis_runs ar ON ar.run_id = r.analysis_run_id
              WHERE r.rec_id NOT LIKE 'riq-%'
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
  const cutoffIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
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
  const weeklySpendByWorkspace = new Map<string, number>();
  let totalWeeklySpend = 0;
  for (const spend of spendByWorkspace(db, cutoffIso, nowIso)) {
    weeklySpendByWorkspace.set(spend.workspace_id, spend.cost_equiv_u);
    totalWeeklySpend += spend.cost_equiv_u;
  }

  // Preserve the most recent evidence session timestamp for existing card consumers.
  const sessionLastTurnMs = new Map<string, number>();
  for (const s of db.prepare("SELECT session_id, last_turn_at FROM sessions").all() as Array<{
    session_id: string;
    last_turn_at: string | null;
  }>) {
    const ms = s.last_turn_at !== null ? Date.parse(s.last_turn_at) : Number.NaN;
    if (!Number.isNaN(ms)) sessionLastTurnMs.set(s.session_id, ms);
  }
  // PP3 recency: the rec's most-recent evidence session (ms). null for zero-session recs
  // (D1/D4/D9/D5) — those live in different articlePriority buckets, so the recency tiebreak
  // (which only fires within one bucket, i.e. one detector family) never compares them here.
  const recRecencyMs = (card: RecommendationCard): number | null => {
    let max: number | null = null;
    for (const id of recommendationSessionIds(card)) {
      const ms = sessionLastTurnMs.get(id);
      if (ms !== undefined && (max === null || ms > max)) max = ms;
    }
    return max;
  };

  const active: RecommendationCard[] = [];
  const recEvidence = new RecEvidenceContext(db, now);
  const allocated = allocatedByRecId(recEvidence, { from: cutoffIso, to: nowIso });
  const reliability = reliabilityByRecId(recEvidence, { from: cutoffIso, to: nowIso });
  const limit_warnings: RecommendationCard[] = [];
  const adopted: RecommendationCard[] = [];
  const dismissed: RecommendationCard[] = [];
  const history: RecommendationCard[] = [];
  const below_floor: RecommendationCard[] = [];
  // LIMIT (D5) renders once, in the warning strip; every other proposed card joins active.
  const routeLiveCard = (card: RecommendationCard): void => {
    if (HIDDEN_UNTIL_FIXED.has(card.detector_id)) {
      return;
    }
    if (BELOW_FLOOR.has(card)) {
      below_floor.push(card);
      return;
    }
    if (card.category === "LIMIT") limit_warnings.push(card);
    else active.push(card);
  };
  for (const r of rows) {
    const sessionsPerWeek =
      r.scope_workspace_id === null
        ? totalSessions
        : (sessionsByWorkspace.get(r.scope_workspace_id) ?? 0);
    const workspaceWeeklySpend =
      r.scope_workspace_id === null
        ? totalWeeklySpend
        : (weeklySpendByWorkspace.get(r.scope_workspace_id) ?? 0);
    const card = toCard(
      r,
      sessionsPerWeek,
      workspaceWeeklySpend,
      { from: cutoffIso, to: nowIso },
      recEvidence,
      allocated,
      reliability,
    );
    if (card === null) continue;
    const cardHeadline = headlineSavings(card);
    card.pct_of_total_weekly_spend =
      cardHeadline === null || !Number.isFinite(cardHeadline) || !(totalWeeklySpend > 0)
        ? null
        : (cardHeadline / totalWeeklySpend) * 100;
    recEvidence.enrich(card, { from: cutoffIso, to: nowIso });
    card.session_recency_ms = recRecencyMs(card);
    if (card.state === "RETIRED" || (card.weeks_ago ?? 0) > 0 || card.weeks_fired === 0) {
      card.headroom = null;
      history.push(card);
      continue;
    }
    if (card.state === "PROPOSED") {
      routeLiveCard(card);
    } else if (card.state === "DISMISSED") {
      dismissed.push(card);
    } else if (ADOPTED_STATES.has(card.state)) adopted.push(card);
  }
  // F26 (operator 2026-10-14): B2 shows only where its workspace has no active D8 card; there the
  // D8 card already shows the same expired-cache resumes with their $.
  const d8Workspaces = new Set(
    active.filter((card) => card.detector_id === "D8").map((card) => card.scope_workspace_id),
  );
  for (let i = active.length - 1; i >= 0; i--) {
    const card = active[i] as RecommendationCard;
    if (card.detector_id === "B2" && d8Workspaces.has(card.scope_workspace_id)) active.splice(i, 1);
  }
  active.sort(byEstimateRank);
  linkRelated(active);

  const detectors = readLiveDetectorStatuses(db) ?? cachedDetectorStatuses(db);

  const data: RecommendationsView = {
    active,
    active_groups: deriveActiveGroups(active, {
      global: totalWeeklySpend,
      byWorkspace: weeklySpendByWorkspace,
    }),
    limit_warnings,
    adopted,
    dismissed,
    history,
    below_floor,
    detectors,
    rank_warnings: [],
    overflow_count: 0,
    excluded: [],
    ranking_goal: "REDUCE_RESOURCE_USE",
    packet_identity_hash: "",
  };

  const result = buildResponse<RecommendationsView>(data, {
    claim_kind: "EXPERIMENTAL",
    n: active.length,
    drilldown_ids: scope !== undefined ? { workspace_id: scope } : {},
  });
  recommendationsBuildCount += 1;
  return result;
}
