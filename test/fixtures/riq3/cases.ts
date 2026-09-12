/**
 * Frozen RIQ3 ranking-policy-1 fixture cases. Pure synthetic value objects —
 * no DB, no operator telemetry, no ranker import. Expected orderings live in
 * expected-orders.ts and are hand-derived from docs/plans/spec-ranking-policy-1.md,
 * never from ranker output (fixture-before-code rule).
 *
 * EVIDENCE_PACKET_VERSION does not appear here by design: the ranker input is the
 * RIQ2 OpportunityComposition plus packet freshness/related-action inputs, not the
 * packet itself; COMPOSER_VERSION is imported, never hardcoded.
 */
import {
  COMPOSER_VERSION,
  DECOMPOSITION_VERSION,
  type FamilyId,
  type HealthyEntry,
  type InsufficientEvidenceEntry,
  type NextStepKind,
  type NoChangeEntry,
  type OpportunityComposition,
  type OpportunityEntry,
} from "../../../src/query/api/opportunity-composer-types.js";

// ---------------------------------------------------------------------------
// Ranker input option shapes (frozen by spec-ranking-policy-1 §1; the ranker's
// own types must remain structurally compatible with these fixtures).
// ---------------------------------------------------------------------------

export type RankingGoal = "PRESERVE_QUALITY" | "REDUCE_RESOURCE_USE" | "INVESTIGATE_FRICTION";

export type MaterialityBand = "SMALL" | "MODERATE" | "LARGE" | "UNKNOWN";

export interface CooldownInput {
  decision_identity: string;
  until_iso: string;
  dismissed_materiality_band: MaterialityBand;
}

export interface RankingOptionsFixture {
  goal: RankingGoal;
  freshness: { status: "CURRENT" | "EXPIRED"; reason: string | null };
  cooldowns: readonly CooldownInput[];
  active_conflicts: readonly string[];
  as_of_iso: string;
}

/** Closed "why this is here" vocabulary (spec-ranking-policy-1 §12). */
export const RIQ3_WHY_REASONS = [
  "GUARDRAIL_SAFE",
  "GUARDRAIL_CONFLICTED",
  "EVIDENCE_COMPARABLE_MEASURED",
  "EVIDENCE_MEASURED_SINGLE_WINDOW",
  "EVIDENCE_PARTIAL",
  "GOAL_PRIMARY",
  "GOAL_SECONDARY",
  "GOAL_NEUTRAL",
  "MATERIALITY_LARGE",
  "MATERIALITY_MODERATE",
  "MATERIALITY_SMALL",
  "MATERIALITY_UNKNOWN",
  "RECURRING_FAILURES",
  "EFFORT_INVESTIGATION",
  "EFFORT_MEASURED_TRIAL",
  "TIEBREAK_STABLE_IDENTITY",
  "RESURFACED_MATERIAL_CHANGE",
] as const;
export type Riq3WhyReason = (typeof RIQ3_WHY_REASONS)[number];

/** Warning codes (spec-ranking-policy-1 §11). */
export const RIQ3_WARNING_CODES = ["PACKET_EXPIRED", "MISSING_EVIDENCE"] as const;
export type Riq3WarningCode = (typeof RIQ3_WARNING_CODES)[number];

/** Exclusion reasons (spec-ranking-policy-1 §3). */
export const RIQ3_EXCLUSION_REASONS = [
  "HEALTHY",
  "NO_CHANGE",
  "PACKET_EXPIRED",
  "COOLDOWN_ACTIVE",
  "MALFORMED_CANDIDATE",
] as const;
export type Riq3ExclusionReason = (typeof RIQ3_EXCLUSION_REASONS)[number];

/** Stable decision identity (spec-ranking-policy-1 §2). */
export function deriveDecisionIdentity(family: FamilyId, evidenceIds: readonly string[]): string {
  return `${family}:${[...evidenceIds].sort().join(",")}`;
}

// ---------------------------------------------------------------------------
// Coverage tags
// ---------------------------------------------------------------------------

export const RIQ3_COVERAGE_TAGS = [
  "GOAL_PRESERVE_QUALITY",
  "GOAL_REDUCE_RESOURCE_USE",
  "GOAL_INVESTIGATE_FRICTION",
  "GOAL_SWITCH_RANK_CHANGE",
  "MISSING_EVIDENCE",
  "WARNINGS_OUTSIDE_BUDGET",
  "OVERFLOW_BUDGET",
  "MATERIALITY_SAME_UNIT",
  "OVERLAP_COLLAPSE",
  "OVERLAP_CHAIN",
  "OVERLAP_COOLDOWN_NO_TRANSFER",
  "USAGE_DECREASE_BAND",
  "COOLDOWN_ACTIVE",
  "COOLDOWN_GOAL_INDEPENDENT",
  "COOLDOWN_EXPIRED",
  "RESURFACE_MATERIAL_CHANGE",
  "RESURFACE_DENIED",
  "TIE_STABLE_IDENTITY",
  "EFFORT_ORDER",
  "ZERO_ELIGIBLE_EXPIRED",
  "ZERO_ELIGIBLE_NO_CANDIDATES",
  "UNKNOWN_VS_SUPPORTED",
  "GUARDRAIL_CONFLICT",
] as const;
export type Riq3CoverageTag = (typeof RIQ3_COVERAGE_TAGS)[number];

export interface Riq3Case {
  case_id: string;
  title: string;
  coverage_tags: readonly Riq3CoverageTag[];
  composition: OpportunityComposition;
  options: RankingOptionsFixture;
}

// ---------------------------------------------------------------------------
// Shared synthetic constants
// ---------------------------------------------------------------------------

const AS_OF = "2026-04-20T00:00:00.000Z";
const CURRENT = { from: "2026-04-08T00:00:00.000Z", to: "2026-04-15T00:00:00.000Z" };
const PRIOR = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-08T00:00:00.000Z" };
const FRESH_CURRENT = { status: "CURRENT", reason: null } as const;

// ---------------------------------------------------------------------------
// Entry builders (all values synthetic, composer-plausible)
// ---------------------------------------------------------------------------

function usageOpportunity(opts: {
  evidenceIds: readonly string[];
  /** μUSD delta; prior baseline is n_prior × mean_prior_u = 1,000,000 μUSD. */
  deltaU: number;
  nextStepKind?: NextStepKind;
}): OpportunityEntry {
  const nPrior = 10;
  const meanPriorU = 100_000;
  const nCur = 10;
  const meanCurU = meanPriorU + opts.deltaU / nCur;
  return {
    outcome: "OPPORTUNITY",
    family: "EXPLAIN_USAGE_CHANGE",
    evidence_ids: [...opts.evidenceIds],
    alternative_explanations: ["More work in the current window, not higher intensity (synthetic)"],
    required_caveats: ["Decomposition is arithmetic, not causal attribution (synthetic)"],
    next_step: {
      kind: opts.nextStepKind ?? "INVESTIGATION",
      description: "Inspect the volume/intensity split for the current window (synthetic)",
    },
    detail: {
      kind: "USAGE_CHANGE",
      direction: opts.deltaU >= 0 ? "INCREASE" : "DECREASE",
      decomposition: {
        decomposition_version: DECOMPOSITION_VERSION,
        volume_term: (nCur - nPrior) * meanPriorU,
        intensity_term: nCur * (meanCurU - meanPriorU),
        UNATTRIBUTED_RESIDUAL: 0,
        observed_delta_u: opts.deltaU,
        n_cur: nCur,
        n_prior: nPrior,
        mean_cur_u: meanCurU,
        mean_prior_u: meanPriorU,
        model_mix_note: "single synthetic model in current window",
      },
    },
  };
}

function toolOpportunity(opts: {
  evidenceIds: readonly string[];
  toolId: string;
  byteShare: number;
  failureCount: number;
  recoveredCount: number;
  nextStepKind?: NextStepKind;
}): OpportunityEntry {
  const totalBytes = 1_000_000;
  return {
    outcome: "OPPORTUNITY",
    family: "TOOL_OUTPUT_RETRY_CONCENTRATION",
    evidence_ids: [...opts.evidenceIds],
    alternative_explanations: ["A legitimate test-fix loop, not waste (synthetic)"],
    required_caveats: ["Bytes are not billable tokens (synthetic)"],
    next_step: {
      kind: opts.nextStepKind ?? "INVESTIGATION",
      description: "Inspect the named tool's bounded output and prerequisites (synthetic)",
    },
    detail: {
      kind: "TOOL_CONCENTRATION",
      candidates: [
        {
          tool_id: opts.toolId,
          tool_class: "EXEC",
          result_bytes_total: Math.round(opts.byteShare * totalBytes),
          byte_share: opts.byteShare,
          failure_event_count: opts.failureCount,
          recovered_after_failure_count: opts.recoveredCount,
        },
      ],
      total_result_bytes: totalBytes,
      concentration_threshold_version: "riq2-byte-conc-v1",
    },
  };
}

function cacheOpportunity(opts: {
  evidenceIds: readonly string[];
  /** null → PARTIAL evidence (ratio not denominable). */
  hitRatio: number | null;
  missCause: "UNKNOWN" | "WRITE_HEAVY";
  nextStepKind?: NextStepKind;
}): OpportunityEntry {
  const denominable = opts.hitRatio !== null;
  const read = denominable ? Math.round((opts.hitRatio as number) * 1_000_000) : 0;
  const input = denominable ? 1_000_000 - read : 0;
  return {
    outcome: "OPPORTUNITY",
    family: "CONTEXT_CACHE_BEHAVIOR",
    evidence_ids: [...opts.evidenceIds],
    alternative_explanations: ["Compaction may be legitimate (synthetic)"],
    required_caveats: ["Unknown miss cause stays unknown (synthetic)"],
    next_step: {
      kind: opts.nextStepKind ?? "MEASURED_TRIAL",
      description: "Try one scoped source relocation and compare (synthetic)",
    },
    detail: {
      kind: "CACHE_BEHAVIOR",
      cache_read_tokens: read,
      cache_write_tokens: 900_000,
      input_tokens: input,
      cache_hit_ratio: opts.hitRatio,
      miss_cause: opts.missCause,
    },
  };
}

function healthy(family: FamilyId): HealthyEntry {
  return { outcome: "HEALTHY", family, reason: "Within expected behaviour (synthetic)" };
}

function noChange(family: FamilyId): NoChangeEntry {
  return { outcome: "NO_CHANGE", family, reason: "Direction UNCHANGED (synthetic)" };
}

function insufficient(family: FamilyId): InsufficientEvidenceEntry {
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    family,
    unavailable_reason: "Required aggregates unavailable in this window (synthetic)",
  };
}

function composition(families: OpportunityComposition["families"]): OpportunityComposition {
  return {
    composer_version: COMPOSER_VERSION,
    packet_identity_hash: "synthetic-packet-hash-riq3",
    scope: {
      workspace_id: "ws-riq3-synthetic",
      current_window: { ...CURRENT },
      prior_window: { ...PRIOR },
    },
    families,
  };
}

function options(overrides?: Partial<RankingOptionsFixture>): RankingOptionsFixture {
  return {
    goal: "PRESERVE_QUALITY",
    freshness: FRESH_CURRENT,
    cooldowns: [],
    active_conflicts: [],
    as_of_iso: AS_OF,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical entries (bands per spec-ranking-policy-1 §8; identities via §2)
// ---------------------------------------------------------------------------

/** COMPARABLE_MEASURED, delta ratio 0.6 → LARGE. */
const U_LARGE = usageOpportunity({ evidenceIds: ["ev-usage-01"], deltaU: 600_000 });
/** COMPARABLE_MEASURED, DECREASE, |delta| ratio 0.1 → SMALL (band uses absolute value, §8). */
const U_SMALL = usageOpportunity({ evidenceIds: ["ev-usage-02"], deltaU: -100_000 });
/** MEASURED_SINGLE_WINDOW, byte_share 0.6 → LARGE, failures 4 → RECURRING. */
const T_MAIN = toolOpportunity({
  evidenceIds: ["ev-tool-01"],
  toolId: "tool-a1",
  byteShare: 0.6,
  failureCount: 4,
  recoveredCount: 1,
});
/** MEASURED_SINGLE_WINDOW, byte_share 0.1 → SMALL, failures 2 → non-recurring. */
const T_SMALL = toolOpportunity({
  evidenceIds: ["ev-tool-02"],
  toolId: "tool-a2",
  byteShare: 0.1,
  failureCount: 2,
  recoveredCount: 1,
});
/** MEASURED_SINGLE_WINDOW, hit ratio 0.2 → LARGE materiality (low hit). */
const C_MEAS = cacheOpportunity({
  evidenceIds: ["ev-cache-01"],
  hitRatio: 0.2,
  missCause: "WRITE_HEAVY",
});
/** PARTIAL: ratio null + UNKNOWN cause → band UNKNOWN. */
const C_PART = cacheOpportunity({
  evidenceIds: ["ev-cache-02"],
  hitRatio: null,
  missCause: "UNKNOWN",
  nextStepKind: "INVESTIGATION",
});

export const ID_U_LARGE = deriveDecisionIdentity("EXPLAIN_USAGE_CHANGE", ["ev-usage-01"]);
export const ID_U_SMALL = deriveDecisionIdentity("EXPLAIN_USAGE_CHANGE", ["ev-usage-02"]);
export const ID_T_MAIN = deriveDecisionIdentity("TOOL_OUTPUT_RETRY_CONCENTRATION", ["ev-tool-01"]);
export const ID_T_SMALL = deriveDecisionIdentity("TOOL_OUTPUT_RETRY_CONCENTRATION", ["ev-tool-02"]);
export const ID_C_MEAS = deriveDecisionIdentity("CONTEXT_CACHE_BEHAVIOR", ["ev-cache-01"]);
export const ID_C_PART = deriveDecisionIdentity("CONTEXT_CACHE_BEHAVIOR", ["ev-cache-02"]);

// Overlap variants: usage and tool share ev-shared-01.
const U_OVERLAP = usageOpportunity({
  evidenceIds: ["ev-shared-01", "ev-usage-01"],
  deltaU: 600_000,
});
const T_OVERLAP = toolOpportunity({
  evidenceIds: ["ev-shared-01", "ev-tool-01"],
  toolId: "tool-a1",
  byteShare: 0.6,
  failureCount: 4,
  recoveredCount: 1,
});
export const ID_U_OVERLAP = deriveDecisionIdentity("EXPLAIN_USAGE_CHANGE", [
  "ev-shared-01",
  "ev-usage-01",
]);
export const ID_T_OVERLAP = deriveDecisionIdentity("TOOL_OUTPUT_RETRY_CONCENTRATION", [
  "ev-shared-01",
  "ev-tool-01",
]);

// Three-way partial chain (§10 sweep): U∩T = {ev-shared-ab}, T∩C = {ev-shared-bc}, U∩C = ∅.
const U_CHAIN = usageOpportunity({
  evidenceIds: ["ev-shared-ab", "ev-usage-01"],
  deltaU: 600_000,
});
const T_CHAIN = toolOpportunity({
  evidenceIds: ["ev-shared-ab", "ev-shared-bc", "ev-tool-01"],
  toolId: "tool-a1",
  byteShare: 0.6,
  failureCount: 4,
  recoveredCount: 1,
});
const C_CHAIN = cacheOpportunity({
  evidenceIds: ["ev-shared-bc", "ev-cache-01"],
  hitRatio: 0.2,
  missCause: "WRITE_HEAVY",
});
export const ID_U_CHAIN = deriveDecisionIdentity("EXPLAIN_USAGE_CHANGE", [
  "ev-shared-ab",
  "ev-usage-01",
]);
export const ID_C_CHAIN = deriveDecisionIdentity("CONTEXT_CACHE_BEHAVIOR", [
  "ev-cache-01",
  "ev-shared-bc",
]);

// Tie/effort variants: same LARGE band, same recurrence (3 failures each).
const T_TIE_A = toolOpportunity({
  evidenceIds: ["ev-tool-01"],
  toolId: "tool-a1",
  byteShare: 0.55,
  failureCount: 3,
  recoveredCount: 1,
});
const T_TIE_B = toolOpportunity({
  evidenceIds: ["ev-tool-02"],
  toolId: "tool-a2",
  byteShare: 0.65,
  failureCount: 3,
  recoveredCount: 1,
});
const T_TRIAL_B = toolOpportunity({
  evidenceIds: ["ev-tool-02"],
  toolId: "tool-a2",
  byteShare: 0.65,
  failureCount: 3,
  recoveredCount: 1,
  nextStepKind: "MEASURED_TRIAL",
});

// ---------------------------------------------------------------------------
// Frozen cases
// ---------------------------------------------------------------------------

export const RIQ3_CASES: readonly Riq3Case[] = [
  {
    case_id: "goal-preserve-quality",
    title: "Baseline three-family composition under the default goal",
    coverage_tags: ["GOAL_PRESERVE_QUALITY", "GOAL_SWITCH_RANK_CHANGE"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({ goal: "PRESERVE_QUALITY" }),
  },
  {
    case_id: "goal-reduce-resource-use",
    title: "Same composition, resource goal flips tool vs cache",
    coverage_tags: ["GOAL_REDUCE_RESOURCE_USE", "GOAL_SWITCH_RANK_CHANGE"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({ goal: "REDUCE_RESOURCE_USE" }),
  },
  {
    case_id: "goal-investigate-friction",
    title: "Same composition, friction goal keeps tool above cache",
    coverage_tags: ["GOAL_INVESTIGATE_FRICTION", "GOAL_SWITCH_RANK_CHANGE"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({ goal: "INVESTIGATE_FRICTION" }),
  },
  {
    case_id: "missing-evidence",
    title: "Insufficient evidence warns outside the budget; healthy is excluded",
    coverage_tags: ["MISSING_EVIDENCE"],
    composition: composition([
      U_LARGE,
      insufficient("TOOL_OUTPUT_RETRY_CONCENTRATION"),
      healthy("CONTEXT_CACHE_BEHAVIOR"),
    ]),
    options: options(),
  },
  {
    case_id: "warnings-with-full-budget",
    title: "Four eligible candidates + a warning: 3 slots, overflow 1, warning intact",
    coverage_tags: [
      "WARNINGS_OUTSIDE_BUDGET",
      "OVERFLOW_BUDGET",
      "MATERIALITY_SAME_UNIT",
      "USAGE_DECREASE_BAND",
      "MISSING_EVIDENCE",
    ],
    // Duplicate-family entries are synthetic ranking inputs, not real composer
    // output (the composer emits one entry per family); the policy is defined
    // over FamilyEntry[] and same-unit materiality needs a same-group pair.
    composition: composition([
      U_LARGE,
      U_SMALL,
      T_MAIN,
      C_MEAS,
      insufficient("CONTEXT_CACHE_BEHAVIOR"),
    ]),
    options: options(),
  },
  {
    case_id: "overlap-collapse",
    title: "Intersecting evidence collapses usage+tool into one linked decision",
    coverage_tags: ["OVERLAP_COLLAPSE"],
    composition: composition([U_OVERLAP, T_OVERLAP, C_MEAS]),
    options: options(),
  },
  {
    case_id: "overlap-three-chain",
    title: "Partial overlap chain: primary links direct intersections only",
    coverage_tags: ["OVERLAP_CHAIN"],
    // U∩T and T∩C intersect but U∩C = ∅: the §10 sweep makes U primary (best
    // with a partner), links T (direct intersection), and leaves C standalone
    // (linking never extends through a linked candidate's evidence).
    composition: composition([U_CHAIN, T_CHAIN, C_CHAIN]),
    options: options(),
  },
  {
    case_id: "overlap-cooldown-no-transfer",
    title: "Cooldown on a linked candidate's identity has no effect after collapse",
    coverage_tags: ["OVERLAP_COOLDOWN_NO_TRANSFER"],
    composition: composition([U_OVERLAP, T_OVERLAP, C_MEAS]),
    options: options({
      cooldowns: [
        {
          decision_identity: ID_T_OVERLAP,
          until_iso: "2026-05-01T00:00:00.000Z",
          dismissed_materiality_band: "LARGE",
        },
      ],
    }),
  },
  {
    case_id: "cooldown-active",
    title: "Active cooldown suppresses; equal band does not re-surface",
    coverage_tags: ["COOLDOWN_ACTIVE", "RESURFACE_DENIED"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({
      cooldowns: [
        {
          decision_identity: ID_U_LARGE,
          until_iso: "2026-05-01T00:00:00.000Z",
          dismissed_materiality_band: "LARGE",
        },
      ],
    }),
  },
  {
    case_id: "cooldown-goal-switch",
    title: "Switching goals does not re-surface a cooled-down decision",
    coverage_tags: ["COOLDOWN_GOAL_INDEPENDENT"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({
      goal: "REDUCE_RESOURCE_USE",
      cooldowns: [
        {
          decision_identity: ID_U_LARGE,
          until_iso: "2026-05-01T00:00:00.000Z",
          dismissed_materiality_band: "LARGE",
        },
      ],
    }),
  },
  {
    case_id: "cooldown-expired",
    title: "Expired cooldown readmits the candidate",
    coverage_tags: ["COOLDOWN_EXPIRED"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({
      cooldowns: [
        {
          decision_identity: ID_U_LARGE,
          until_iso: "2026-04-10T00:00:00.000Z",
          dismissed_materiality_band: "LARGE",
        },
      ],
    }),
  },
  {
    case_id: "resurface-material-change",
    title: "Strictly higher current band overrides an active cooldown",
    coverage_tags: ["RESURFACE_MATERIAL_CHANGE"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({
      cooldowns: [
        {
          decision_identity: ID_U_LARGE,
          until_iso: "2026-05-01T00:00:00.000Z",
          dismissed_materiality_band: "MODERATE",
        },
      ],
    }),
  },
  {
    case_id: "tie-stable-identity",
    title: "Identical classes 1-5 fall to the stable identity tiebreak",
    coverage_tags: ["TIE_STABLE_IDENTITY"],
    composition: composition([T_TIE_B, T_TIE_A]),
    options: options(),
  },
  {
    case_id: "effort-order",
    title: "Investigation outranks measured trial when classes 1-4 tie",
    coverage_tags: ["EFFORT_ORDER"],
    composition: composition([T_TRIAL_B, T_TIE_A]),
    options: options(),
  },
  {
    case_id: "zero-eligible-expired",
    title: "Expired packet yields zero decisions and a packet warning",
    coverage_tags: ["ZERO_ELIGIBLE_EXPIRED"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({
      freshness: { status: "EXPIRED", reason: "packet expired (synthetic)" },
    }),
  },
  {
    case_id: "zero-eligible-no-candidates",
    title: "All healthy/no-change/insufficient: zero decisions is valid",
    coverage_tags: ["ZERO_ELIGIBLE_NO_CANDIDATES", "MISSING_EVIDENCE"],
    composition: composition([
      healthy("TOOL_OUTPUT_RETRY_CONCENTRATION"),
      noChange("EXPLAIN_USAGE_CHANGE"),
      insufficient("CONTEXT_CACHE_BEHAVIOR"),
    ]),
    options: options(),
  },
  {
    case_id: "unknown-vs-supported",
    title: "Partial evidence never outranks measured evidence, even goal-favored",
    coverage_tags: ["UNKNOWN_VS_SUPPORTED"],
    composition: composition([C_PART, T_SMALL]),
    options: options({ goal: "REDUCE_RESOURCE_USE" }),
  },
  {
    case_id: "guardrail-conflict",
    title: "Active related action deprioritizes but does not hide the candidate",
    coverage_tags: ["GUARDRAIL_CONFLICT"],
    composition: composition([U_LARGE, T_MAIN, C_MEAS]),
    options: options({ active_conflicts: [ID_U_LARGE] }),
  },
];
