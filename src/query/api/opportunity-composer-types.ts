/** RIQ2 opportunity composer output types. Pure value types; no DB handles. */

export const COMPOSER_VERSION = "riq2-composer-1" as const;
export const DECOMPOSITION_VERSION = "riq2-decomp-1" as const;

// ---------------------------------------------------------------------------
// Family IDs
// ---------------------------------------------------------------------------

export type FamilyId =
  | "EXPLAIN_USAGE_CHANGE"
  | "TOOL_OUTPUT_RETRY_CONCENTRATION"
  | "CONTEXT_CACHE_BEHAVIOR";

// ---------------------------------------------------------------------------
// Shared outcome shapes
// ---------------------------------------------------------------------------

/**
 * Next-step classification. INVESTIGATION or bounded MEASURED_TRIAL only —
 * never an automatic change. No savings/benefit estimate field exists.
 */
export type NextStepKind = "INVESTIGATION" | "MEASURED_TRIAL";

export interface NextStep {
  kind: NextStepKind;
  description: string;
}

/** An evidence-backed opportunity candidate. */
export interface OpportunityEntry {
  outcome: "OPPORTUNITY";
  family: FamilyId;
  evidence_ids: string[];
  /** Non-empty list of plausible competing explanations. */
  alternative_explanations: string[];
  /** Non-empty list of required caveats the consumer must surface. */
  required_caveats: string[];
  next_step: NextStep;
  detail: UsageChangeDetail | ToolConcentrationDetail | CacheBehaviorDetail;
}

/** Family is within expected behaviour — no action warranted. */
export interface HealthyEntry {
  outcome: "HEALTHY";
  family: FamilyId;
  reason: string;
}

/** Direction UNCHANGED — valid outcome, not a missing-data state. */
export interface NoChangeEntry {
  outcome: "NO_CHANGE";
  family: FamilyId;
  reason: string;
}

/** Insufficient evidence to form a candidate. Missing evidence is explicit. */
export interface InsufficientEvidenceEntry {
  outcome: "INSUFFICIENT_EVIDENCE";
  family: FamilyId;
  /** Echo of the packet's UnavailableFact reason or an incompatibility description. */
  unavailable_reason: string;
}

export type FamilyEntry =
  | OpportunityEntry
  | HealthyEntry
  | NoChangeEntry
  | InsufficientEvidenceEntry;

// ---------------------------------------------------------------------------
// Family 1 — Explain a usage change
// ---------------------------------------------------------------------------

/**
 * Exact additive decomposition: delta = volume_term + intensity_term + residual.
 * residual is labelled UNATTRIBUTED_RESIDUAL and may be 0.
 * All values are in the same unit as the packet cost facts (micro_usd_list_equivalent).
 */
export interface UsageChangeDecomposition {
  decomposition_version: typeof DECOMPOSITION_VERSION;
  /**
   * (n_cur − n_prior) × prior_per_turn_mean_u
   * Effect of doing more/fewer priced turns at the prior per-turn rate.
   */
  volume_term: number;
  /**
   * n_cur × (mean_cur − mean_prior)
   * Effect of changed resource use per turn, holding current turn count fixed.
   */
  intensity_term: number;
  /**
   * delta − volume_term − intensity_term, labelled UNATTRIBUTED_RESIDUAL.
   * Represents arithmetic rounding and any cross-term not captured above.
   * May be 0.
   */
  UNATTRIBUTED_RESIDUAL: number;
  /** The observed delta this decomposition was built from. */
  observed_delta_u: number;
  /** Current window: priced turn count. */
  n_cur: number;
  /** Prior window: priced turn count. */
  n_prior: number;
  /** Current window: total cost / n_cur (μUSD). */
  mean_cur_u: number;
  /** Prior window: total cost / n_prior (μUSD). */
  mean_prior_u: number;
  /**
   * Qualitative model-mix note from the current window's packet model_mix only.
   * Cross-window mix alignment is impossible by packet design.
   */
  model_mix_note: string;
}

export interface UsageChangeDetail {
  kind: "USAGE_CHANGE";
  direction: "INCREASE" | "DECREASE";
  decomposition: UsageChangeDecomposition;
}

// ---------------------------------------------------------------------------
// Family 2 — Tool-output + retry concentration
// ---------------------------------------------------------------------------

export interface ToolConcentrationCandidate {
  /** Opaque packet-local tool ID — never a raw tool name. */
  tool_id: string;
  /** Closed tool class enum. */
  tool_class: string;
  result_bytes_total: number;
  /** Fraction of all bytes attributable to this tool_id (0–1). */
  byte_share: number;
  failure_event_count: number;
  recovered_after_failure_count: number;
}

export interface ToolConcentrationDetail {
  kind: "TOOL_CONCENTRATION";
  candidates: ToolConcentrationCandidate[];
  total_result_bytes: number;
  /** Named versioned threshold that was exceeded. */
  concentration_threshold_version: string;
}

// ---------------------------------------------------------------------------
// Family 3 — Context / cache behaviour
// ---------------------------------------------------------------------------

/** Only causes the packet's buckets can actually support; an undiagnosable miss stays UNKNOWN. */
export type CacheMissCause = "UNKNOWN" | "WRITE_HEAVY";

export interface CacheBehaviorDetail {
  kind: "CACHE_BEHAVIOR";
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_tokens: number;
  /** cache_read / (cache_read + input) if denominable, else null. */
  cache_hit_ratio: number | null;
  miss_cause: CacheMissCause;
}

// ---------------------------------------------------------------------------
// Top-level composition
// ---------------------------------------------------------------------------

export interface OpportunityComposition {
  composer_version: typeof COMPOSER_VERSION;
  /** Echo of the source packet's identity hash. */
  packet_identity_hash: string;
  /** Echo of the source packet's scope for correlation. */
  scope: {
    workspace_id: string | null;
    current_window: { from: string; to: string };
    prior_window: { from: string; to: string } | null;
  };
  families: FamilyEntry[];
}
