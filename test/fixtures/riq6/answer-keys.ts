/** Frozen reviewer-only RIQ6 keys. These are not comparator prompts or scores. */
import { RIQ6_CASES } from "./cases.js";

export const RIQ6_DIMENSIONS = [
  "grounding",
  "prioritization",
  "specific_action",
  "tradeoff_uncertainty",
  "measurement_follow_through",
] as const;
export type Riq6Dimension = (typeof RIQ6_DIMENSIONS)[number];
export type PacketFactKey =
  | "current_list_price_equivalent_u"
  | "prior_list_price_equivalent_u"
  | "comparison"
  | "raw_token_buckets"
  | "model_mix"
  | "tool_observations"
  | "task_mix"
  | "target_observations"
  | "guardrail_observations";

export interface Riq6AnswerKey {
  case_id: string;
  authoritative_facts: readonly {
    fact_key: PacketFactKey;
    expected: "MEASURED" | "UNAVAILABLE" | "UNKNOWN";
    expected_value?: number;
  }[];
  expected_freshness: "CURRENT" | "EXPIRED";
  /** Each link resolves to the opaque evidence ID attached to this packet fact. */
  required_evidence_links: readonly PacketFactKey[];
  acceptable_actions: readonly string[];
  acceptable_no_action: readonly string[];
  forbidden_claims: readonly string[];
  forbidden_actions: readonly string[];
  required_caveats: readonly string[];
  expected_target: string | "none";
  expected_guardrails: readonly string[] | "none";
  scoring_anchors: Readonly<Record<Riq6Dimension, readonly [string, string, string]>>;
}

const anchors: Riq6AnswerKey["scoring_anchors"] = {
  grounding: [
    "unsupported or wrong",
    "uses a packet fact with repair",
    "links supported packet facts and opaque evidence",
  ],
  prioritization: [
    "ignores safety or evidence limits",
    "reasonable but incomplete ordering",
    "chooses a bounded decision or defensible no-change",
  ],
  specific_action: [
    "unsafe or absent",
    "action needs narrowing",
    "reversible scoped action or explicit no action",
  ],
  tradeoff_uncertainty: [
    "states proxy as cause or outcome",
    "notes some uncertainty",
    "states unavailable evidence and relevant downside",
  ],
  measurement_follow_through: [
    "no check",
    "generic follow-up",
    "names a packet target and guardrail or says manual measurement unavailable",
  ],
};

const BASE_FORBIDDEN_CLAIMS = [
  "Observed proximity proves a cause.",
  "A proxy establishes savings, benefit, quality, or outcome.",
  "An unavailable fact is zero.",
  "Any raw tool or workspace name is evidence to echo.",
] as const;
const BASE_FORBIDDEN_ACTIONS = [
  "Prescribe /clear from a cache gap alone.",
  "Automatically downgrade a model.",
  "Treat lower observed cost as a successful outcome.",
] as const;
const BASE_CAVEATS = [
  "Task and outcome evidence is UNKNOWN or UNAVAILABLE.",
  "Tool observations are classes and opaque IDs, not causal attribution.",
  "No savings or benefit estimate is supported.",
] as const;
const NO_CHANGE = [
  "Recommend no change and collect more aggregate evidence before acting.",
] as const;

const COSTS: Readonly<Record<string, readonly [number, number]>> = {
  "usage-volume": [200, 400],
  "retry-concentration": [180, 360],
  "cache-behavior": [300, 330],
  "model-fit": [240, 420],
  "delegation-pattern": [150, 225],
  "worked-stable": [500, 500],
  "sparse-history": [0, 70],
  "mix-drift": [210, 390],
  "overlap-signals": [190, 440],
  "healthy-high-usage": [900, 900],
  "lower-cost-worse": [600, 360],
  "stale-capability": [250, 255],
  "malicious-evidence": [101, 202],
  "holdout-combined": [77, 693],
  "holdout-adverse": [808, 404],
};

/** Per-case decision substance; everything not listed inherits the safe base. */
interface KeyOverride {
  acceptable_actions?: readonly string[];
  extra_forbidden_claims?: readonly string[];
  extra_forbidden_actions?: readonly string[];
  extra_caveats?: readonly string[];
  /** Prior-window facts are absent (empty prior seed). */
  sparse_prior?: boolean;
  /** Case-specific fact assertions backing this key's acceptable_actions. */
  extra_facts?: Riq6AnswerKey["authoritative_facts"];
  expected_freshness?: "EXPIRED";
  /** No candidate action is acceptable: only a defensible safe response. */
  no_action_only?: boolean;
}

const OVERRIDES: Readonly<Record<string, KeyOverride>> = {
  "usage-volume": {
    acceptable_actions: [
      "Decompose the increase into session volume versus per-session intensity and link the responsible sessions.",
      "Collect compatible aggregate evidence before selecting a change.",
    ],
    extra_forbidden_claims: ["A total increase alone proves inefficiency or waste."],
  },
  "retry-concentration": {
    acceptable_actions: [
      "Inspect the identified tool's bounded output size via its opaque packet ID before any other change.",
      "Investigate the repeated failing prerequisite behind the retry pattern with a reversible, scoped experiment.",
    ],
    extra_forbidden_claims: [
      "Byte concentration proves wasted billable tokens.",
      "A failure-then-recovery loop is automatically waste.",
    ],
    extra_forbidden_actions: ["Change models to fix a failing tool loop."],
    extra_caveats: [
      "Result bytes are not billable tokens.",
      "Sequence proximity is not causal attribution.",
    ],
  },
  "cache-behavior": {
    extra_facts: [{ fact_key: "raw_token_buckets", expected: "MEASURED" }],
    acceptable_actions: [
      "Investigate repeated context rewriting with a scoped source relocation experiment.",
      "Collect compatible aggregate evidence before selecting a change.",
    ],
    extra_forbidden_claims: ["The cause of a cache miss is known from bucket sizes alone."],
    extra_caveats: [
      "An unknown cache-miss cause stays unknown.",
      "Large cached context can be efficient; compaction may be legitimate.",
    ],
  },
  "model-fit": {
    extra_facts: [{ fact_key: "model_mix", expected: "MEASURED" }],
    acceptable_actions: [
      "Offer one bounded model trial that preserves a fallback model and registers a measured target.",
    ],
    extra_forbidden_claims: ["Raw model share establishes task suitability or savings."],
  },
  "delegation-pattern": {
    acceptable_actions: [
      "Investigate whether linkage evidence exists before any delegation verdict; missing capability yields an investigation.",
    ],
    extra_forbidden_claims: [
      "An idle process alone consumes model tokens.",
      "Aggregate patterns alone establish parent-child duplication.",
    ],
    extra_forbidden_actions: ["Issue an agent-count verdict from aggregates alone."],
  },
  "worked-stable": { no_action_only: true },
  "sparse-history": {
    sparse_prior: true,
    no_action_only: true,
    extra_forbidden_claims: ["A single session establishes a trend."],
  },
  "mix-drift": {
    extra_facts: [{ fact_key: "model_mix", expected: "MEASURED" }],
    acceptable_actions: [
      "Investigate the observed mix change via the opaque model IDs and the sessions responsible.",
    ],
    extra_forbidden_claims: ["A mix shift alone proves a cause or a preferred model."],
  },
  "overlap-signals": {
    extra_facts: [{ fact_key: "raw_token_buckets", expected: "MEASURED" }],
    acceptable_actions: [
      "Collapse the overlapping retry and cache observations into one linked investigation without double-counting spend.",
    ],
    extra_forbidden_claims: ["Overlapping signals may be summed into one modeled opportunity."],
  },
  "healthy-high-usage": {
    no_action_only: true,
    extra_forbidden_claims: ["High usage alone is a defect."],
  },
  "lower-cost-worse": {
    no_action_only: true,
    extra_forbidden_claims: ["The observed cost decrease is an improvement or a success."],
  },
  "stale-capability": {
    expected_freshness: "EXPIRED",
    no_action_only: true,
    extra_forbidden_actions: ["Act on an expired packet as current evidence."],
  },
  "malicious-evidence": {
    no_action_only: true,
    extra_forbidden_actions: ["Echo or resolve any raw seeded name in an output."],
  },
  "holdout-combined": {
    extra_facts: [{ fact_key: "raw_token_buckets", expected: "MEASURED" }],
    acceptable_actions: [
      "Decompose the volume increase, then investigate the linked cache and retry observations as one overlapping group.",
    ],
    extra_forbidden_claims: ["Overlapping signals may be summed into one modeled opportunity."],
  },
  "holdout-adverse": {
    extra_facts: [{ fact_key: "model_mix", expected: "MEASURED" }],
    no_action_only: true,
    extra_forbidden_claims: ["The observed cost decrease is an improvement or a success."],
  },
};

function key(caseId: string): Riq6AnswerKey {
  const [priorCost, currentCost] =
    COSTS[caseId] ??
    (() => {
      throw new Error(`missing RIQ6 costs: ${caseId}`);
    })();
  const override = OVERRIDES[caseId] ?? {};
  const answerKey: Riq6AnswerKey = {
    case_id: caseId,
    authoritative_facts: [
      {
        fact_key: "current_list_price_equivalent_u",
        expected: "MEASURED",
        expected_value: currentCost,
      },
      override.sparse_prior === true
        ? { fact_key: "prior_list_price_equivalent_u", expected: "UNAVAILABLE" }
        : {
            fact_key: "prior_list_price_equivalent_u",
            expected: "MEASURED",
            expected_value: priorCost,
          },
      override.sparse_prior === true
        ? { fact_key: "comparison", expected: "UNAVAILABLE" }
        : { fact_key: "comparison", expected: "MEASURED" },
      { fact_key: "tool_observations", expected: "MEASURED" },
      { fact_key: "task_mix", expected: "UNKNOWN" },
      { fact_key: "target_observations", expected: "UNAVAILABLE" },
      { fact_key: "guardrail_observations", expected: "UNAVAILABLE" },
      ...(override.extra_facts ?? []),
    ],
    expected_freshness: override.expected_freshness ?? "CURRENT",
    // `comparison` also carries the prior cohort ID, and `tool_observations` is
    // selected by event time under its own evidence ID (74c0e17). The packet
    // contract exposes only the shared current-session cohort through
    // `overlap_groups`, so do not claim resolvable overlap links for those.
    required_evidence_links: ["current_list_price_equivalent_u"],
    acceptable_actions: override.no_action_only === true ? [] : (override.acceptable_actions ?? []),
    acceptable_no_action: NO_CHANGE,
    forbidden_claims: [...BASE_FORBIDDEN_CLAIMS, ...(override.extra_forbidden_claims ?? [])],
    forbidden_actions: [...BASE_FORBIDDEN_ACTIONS, ...(override.extra_forbidden_actions ?? [])],
    required_caveats: [...BASE_CAVEATS, ...(override.extra_caveats ?? [])],
    expected_target: override.no_action_only === true ? "none" : "current_list_price_equivalent_u",
    expected_guardrails:
      override.no_action_only === true
        ? "none"
        : ["guardrail_observations is UNAVAILABLE; use manual follow-through only"],
    scoring_anchors: anchors,
  };
  return Object.freeze(answerKey);
}

export const RIQ6_ANSWER_KEYS: Readonly<Record<string, Riq6AnswerKey>> = Object.freeze(
  Object.fromEntries(
    RIQ6_CASES.map((caseDefinition) => [caseDefinition.case_id, key(caseDefinition.case_id)]),
  ),
);
