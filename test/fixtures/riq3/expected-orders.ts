/**
 * Frozen expected orderings for the RIQ3 fixture cases — hand-derived from
 * docs/plans/spec-ranking-policy-1.md (class order §4, bands §8, goal map §7),
 * BEFORE any ranker code exists. The ranker must reproduce these unmodified.
 *
 * `subject` in exclusions is a decision identity for OPPORTUNITY entries and a
 * family id for non-candidates (HEALTHY / NO_CHANGE), per spec §3.
 */
import type { FamilyId } from "../../../src/query/api/opportunity-composer-types.js";
import {
  ID_C_CHAIN,
  ID_C_MEAS,
  ID_C_PART,
  ID_T_MAIN,
  ID_T_SMALL,
  ID_U_CHAIN,
  ID_U_LARGE,
  ID_U_OVERLAP,
  ID_U_SMALL,
  type Riq3ExclusionReason,
  type Riq3WarningCode,
  type Riq3WhyReason,
} from "./cases.js";

export interface ExpectedDecision {
  decision_identity: string;
  family: FamilyId;
  must_include_reasons: readonly Riq3WhyReason[];
  linked_observation_families?: readonly FamilyId[];
}

export interface ExpectedRanking {
  next_decisions: readonly ExpectedDecision[];
  overflow_count: number;
  warning_codes: readonly Riq3WarningCode[];
  excluded: readonly { subject: string; reason: Riq3ExclusionReason }[];
}

const USAGE: FamilyId = "EXPLAIN_USAGE_CHANGE";
const TOOL: FamilyId = "TOOL_OUTPUT_RETRY_CONCENTRATION";
const CACHE: FamilyId = "CONTEXT_CACHE_BEHAVIOR";

export const RIQ3_EXPECTED_ORDERS: Record<string, ExpectedRanking> = {
  // Class 2 puts the comparable-measured usage entry first under every goal;
  // the goal only reorders tool vs cache (both MEASURED_SINGLE_WINDOW).
  "goal-preserve-quality": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        must_include_reasons: [
          "GUARDRAIL_SAFE",
          "EVIDENCE_COMPARABLE_MEASURED",
          "GOAL_SECONDARY",
          "MATERIALITY_LARGE",
        ],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        // §12 is exhaustive: effort is emitted even though class 3 decided.
        must_include_reasons: [
          "EVIDENCE_MEASURED_SINGLE_WINDOW",
          "GOAL_PRIMARY",
          "RECURRING_FAILURES",
          "EFFORT_INVESTIGATION",
        ],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_NEUTRAL", "EFFORT_MEASURED_TRIAL"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "goal-reduce-resource-use": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED", "GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_PRIMARY", "MATERIALITY_LARGE"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_SECONDARY"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "goal-investigate-friction": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        // Honest display: usage is goal-NEUTRAL under friction yet still ranks
        // first because evidence class (class 2) precedes goal relevance.
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED", "GOAL_NEUTRAL"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_PRIMARY", "RECURRING_FAILURES"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_SECONDARY"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "missing-evidence": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED"],
      },
    ],
    overflow_count: 0,
    warning_codes: ["MISSING_EVIDENCE"],
    excluded: [{ subject: CACHE, reason: "HEALTHY" }],
  },
  "warnings-with-full-budget": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        must_include_reasons: ["MATERIALITY_LARGE"],
      },
      {
        decision_identity: ID_U_SMALL,
        family: USAGE,
        // Same unit group as U_LARGE: class 4 (LARGE > SMALL) decided.
        must_include_reasons: ["MATERIALITY_SMALL"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_PRIMARY"],
      },
    ],
    overflow_count: 1,
    warning_codes: ["MISSING_EVIDENCE"],
    excluded: [],
  },
  "overlap-collapse": {
    next_decisions: [
      {
        decision_identity: ID_U_OVERLAP,
        family: USAGE,
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED", "MATERIALITY_LARGE"],
        linked_observation_families: [TOOL],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["EVIDENCE_MEASURED_SINGLE_WINDOW"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "overlap-three-chain": {
    next_decisions: [
      {
        decision_identity: ID_U_CHAIN,
        family: USAGE,
        // §10 sweep: U is the §4-best candidate with an overlap partner →
        // primary; T directly intersects U → linked; C intersects only T,
        // never U → stays a separate decision.
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED", "MATERIALITY_LARGE"],
        linked_observation_families: [TOOL],
      },
      {
        decision_identity: ID_C_CHAIN,
        family: CACHE,
        must_include_reasons: ["EVIDENCE_MEASURED_SINGLE_WINDOW"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "overlap-cooldown-no-transfer": {
    next_decisions: [
      {
        decision_identity: ID_U_OVERLAP,
        family: USAGE,
        // Cooldowns evaluate after collapse against primary identities (§3.2):
        // the cooldown on the linked tool candidate's identity has no effect —
        // the collapsed decision and its evidence links render unchanged.
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED"],
        linked_observation_families: [TOOL],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["EVIDENCE_MEASURED_SINGLE_WINDOW"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "cooldown-goal-switch": {
    next_decisions: [
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_SECONDARY"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    // Same dismissal as cooldown-active under a different goal: still
    // suppressed — dismissal is goal-independent (§9).
    excluded: [{ subject: ID_U_LARGE, reason: "COOLDOWN_ACTIVE" }],
  },
  "cooldown-active": {
    next_decisions: [
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_NEUTRAL"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    // Dismissed at LARGE, currently LARGE: not strictly higher → stays suppressed.
    excluded: [{ subject: ID_U_LARGE, reason: "COOLDOWN_ACTIVE" }],
  },
  "cooldown-expired": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        must_include_reasons: ["EVIDENCE_COMPARABLE_MEASURED"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_NEUTRAL"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "resurface-material-change": {
    next_decisions: [
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        // Dismissed at MODERATE, currently LARGE: strictly higher → re-surfaces.
        must_include_reasons: ["RESURFACED_MATERIAL_CHANGE", "MATERIALITY_LARGE"],
      },
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GOAL_NEUTRAL"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "tie-stable-identity": {
    next_decisions: [
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["TIEBREAK_STABLE_IDENTITY"],
      },
      {
        decision_identity: ID_T_SMALL,
        family: TOOL,
        must_include_reasons: ["TIEBREAK_STABLE_IDENTITY"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "effort-order": {
    next_decisions: [
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["EFFORT_INVESTIGATION"],
      },
      {
        decision_identity: ID_T_SMALL,
        family: TOOL,
        must_include_reasons: ["EFFORT_MEASURED_TRIAL"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "zero-eligible-expired": {
    next_decisions: [],
    overflow_count: 0,
    warning_codes: ["PACKET_EXPIRED"],
    excluded: [
      { subject: ID_U_LARGE, reason: "PACKET_EXPIRED" },
      { subject: ID_T_MAIN, reason: "PACKET_EXPIRED" },
      { subject: ID_C_MEAS, reason: "PACKET_EXPIRED" },
    ],
  },
  "zero-eligible-no-candidates": {
    next_decisions: [],
    overflow_count: 0,
    warning_codes: ["MISSING_EVIDENCE"],
    excluded: [
      { subject: TOOL, reason: "HEALTHY" },
      { subject: USAGE, reason: "NO_CHANGE" },
    ],
  },
  "unknown-vs-supported": {
    next_decisions: [
      {
        decision_identity: ID_T_SMALL,
        family: TOOL,
        // Goal favors cache (PRIMARY) but evidence class precedes goal:
        // measured single-window beats partial. Unknown never wins by drama.
        must_include_reasons: ["EVIDENCE_MEASURED_SINGLE_WINDOW", "GOAL_SECONDARY"],
      },
      {
        decision_identity: ID_C_PART,
        family: CACHE,
        must_include_reasons: ["EVIDENCE_PARTIAL", "GOAL_PRIMARY", "MATERIALITY_UNKNOWN"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
  "guardrail-conflict": {
    next_decisions: [
      {
        decision_identity: ID_T_MAIN,
        family: TOOL,
        must_include_reasons: ["GUARDRAIL_SAFE", "GOAL_PRIMARY"],
      },
      {
        decision_identity: ID_C_MEAS,
        family: CACHE,
        must_include_reasons: ["GUARDRAIL_SAFE"],
      },
      {
        decision_identity: ID_U_LARGE,
        family: USAGE,
        // Best evidence class, but class 1 (guardrail) precedes everything.
        must_include_reasons: ["GUARDRAIL_CONFLICTED"],
      },
    ],
    overflow_count: 0,
    warning_codes: [],
    excluded: [],
  },
};
