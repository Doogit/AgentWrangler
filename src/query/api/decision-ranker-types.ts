/**
 * RIQ3 decision ranker output types — ranking-policy-1.
 * Pure value types; no DB handles, no savings/score/estimate fields.
 * SEC-101: enum labels, ids, counts only — no raw content.
 */

import type { FamilyId, NextStep } from "./opportunity-composer-types.js";

export const RANKING_POLICY_VERSION = "ranking-policy-1" as const;

/** Operator goal hint — preference, not a claim about outcomes. */
export type RankingGoal = "PRESERVE_QUALITY" | "REDUCE_RESOURCE_USE" | "INVESTIGATE_FRICTION";

/** Materiality band (spec-ranking-policy-1 §8). */
export type MaterialityBand = "SMALL" | "MODERATE" | "LARGE" | "UNKNOWN";

/** Caller-supplied dismissal state for one decision identity (§9). */
export interface CooldownInput {
  decision_identity: string;
  until_iso: string;
  dismissed_materiality_band: MaterialityBand;
}

/** Full ranker input options (§1). */
export interface RankingOptions {
  goal: RankingGoal;
  freshness: { status: "CURRENT" | "EXPIRED"; reason: string | null };
  cooldowns: readonly CooldownInput[];
  /** Decision identities already covered by an active related action (§5). */
  active_conflicts: readonly string[];
  /** Evaluation instant for cooldown expiry — deterministic, never Date.now(). */
  as_of_iso: string;
}

/** Closed "why this is here" vocabulary (spec-ranking-policy-1 §12). */
export type WhyReason =
  | "GUARDRAIL_SAFE"
  | "GUARDRAIL_CONFLICTED"
  | "EVIDENCE_COMPARABLE_MEASURED"
  | "EVIDENCE_MEASURED_SINGLE_WINDOW"
  | "EVIDENCE_PARTIAL"
  | "GOAL_PRIMARY"
  | "GOAL_SECONDARY"
  | "GOAL_NEUTRAL"
  | "MATERIALITY_LARGE"
  | "MATERIALITY_MODERATE"
  | "MATERIALITY_SMALL"
  | "MATERIALITY_UNKNOWN"
  | "RECURRING_FAILURES"
  | "EFFORT_INVESTIGATION"
  | "EFFORT_MEASURED_TRIAL"
  | "TIEBREAK_STABLE_IDENTITY"
  | "RESURFACED_MATERIAL_CHANGE";

/** An observation linked via evidence overlap (§10). */
export interface LinkedObservation {
  family: FamilyId;
  evidence_ids: string[];
}

/** A ranked decision slot (≤3, 1-based). */
export interface RankedDecision {
  rank: number;
  decision_identity: string;
  family: FamilyId;
  /** All class values in class order — exhaustive, not decisive-only (§12). */
  why_ranked: WhyReason[];
  /** Collapsed overlapping observations; no signal summing (§10). */
  linked_observations: LinkedObservation[];
  /** Verbatim from the composer entry — never dropped or rewritten. */
  required_caveats: string[];
  /** Verbatim from the composer entry — never dropped or rewritten. */
  alternative_explanations: string[];
  /** Verbatim from the composer entry. */
  next_step: NextStep;
}

/** A warning emitted outside the slot budget (§11). */
export interface Warning {
  code: "PACKET_EXPIRED" | "MISSING_EVIDENCE";
  /** Echo of unavailable_reason for MISSING_EVIDENCE entries. */
  detail?: string;
}

/** A non-candidate or gate failure with its reason (§3, §11). */
export interface Exclusion {
  /**
   * Decision identity for OPPORTUNITY entries (contains ':').
   * Family id for HEALTHY / NO_CHANGE entries (no ':').
   */
  subject: string;
  reason: "HEALTHY" | "NO_CHANGE" | "PACKET_EXPIRED" | "COOLDOWN_ACTIVE" | "MALFORMED_CANDIDATE";
}

/** The full ranker output (spec-ranking-policy-1 §13). */
export interface RankingResult {
  ranking_policy_version: typeof RANKING_POLICY_VERSION;
  goal: RankingGoal;
  /** Echo of the source composition's packet_identity_hash. */
  packet_identity_hash: string;
  /** Ranked decisions — at most 3, in policy order. */
  next_decisions: RankedDecision[];
  /** Eligible candidates beyond three. */
  overflow_count: number;
  /** Emitted outside the slot budget; never truncated by it. */
  warnings: Warning[];
  /** Non-candidates and gate failures. */
  excluded: Exclusion[];
}
