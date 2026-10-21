import * as crypto from "node:crypto";

/**
 * Versioned privacy contracts for persisted detector output.
 *
 * This module is the sole authority for recommendation template metadata and
 * serialization. Detector code supplies only bounded structural facts; copy
 * and action rendering constants live in the trusted registry below.
 */

export const RECOMMENDATION_CONTRACT_VERSION = 1 as const;
export const DIAGNOSTIC_CONTRACT_VERSION = 1 as const;
export const FINDING_CONTRACT_VERSION = 2 as const;

export type RecommendationCategory =
  | "CONTEXT"
  | "LIMIT"
  | "CACHE"
  | "TOOLING"
  | "SESSION_HYGIENE"
  | "MODEL";

export type RecommendationTemplateId =
  | "D1_CONTEXT_ALWAYS_LOADED"
  | "D2_LONG_FULL_CONTEXT"
  | "D4_MODEL_MISMATCH"
  | "D5_LIMIT_BURN_DEGRADED"
  | "D5_LIMIT_BURN_WARNING"
  | "D6_TOOL_RESULT_BLOAT"
  | "D7_CROSS_SESSION_REREAD"
  | "D7_RETRY_LOOP"
  | "D8_CACHE_WRITE_CHURN"
  | "D9_BACKGROUND_SESSION"
  | "D10_CATALOG_FOOTPRINT"
  | "D11_TOOL_ERROR_RATE"
  | "D12_SUBAGENT_OVERSPAWN";

export type DetectorId =
  | "D1"
  | "D2"
  | "D4"
  | "D5"
  | "D6"
  | "D7"
  | "D8"
  | "D9"
  | "D10"
  | "D11"
  | "D12";

export type SafeFactScalar = string | number | boolean | null;
export type SafeFactValue = SafeFactScalar | readonly string[];
export type RecommendationFacts = Readonly<Record<string, SafeFactValue>>;

export type DiagnosticCategory = "INGEST" | "DETECTOR" | "PRIVACY";
export type DiagnosticLabel = "CLASSIFIER_BOUNDARY" | "DETECTOR_BLOCKED" | "PRIVACY_REJECTED";
export type DiagnosticCeuBand = "LOW" | "MEDIUM" | "HIGH";
export type DiagnosticCeuProvenance = "MEASURED" | "ESTIMATED";

export interface DiagnosticFindingV1 {
  readonly version: typeof DIAGNOSTIC_CONTRACT_VERSION;
  readonly category: DiagnosticCategory;
  readonly label: DiagnosticLabel;
  readonly anchor: Readonly<{
    session_id: string;
    message_id?: string;
    turn_index?: number;
    timestamp: string;
  }>;
  readonly ceu: Readonly<{
    value: number;
    band: DiagnosticCeuBand;
    provenance: DiagnosticCeuProvenance;
  }>;
}

type FactRule =
  | Readonly<{ kind: "boolean" }>
  | Readonly<{ kind: "enum"; values: readonly string[] }>
  | Readonly<{ kind: "finite"; min: number; max: number; optional?: true }>
  | Readonly<{ kind: "nullable-finite"; min: number; max: number }>
  | Readonly<{ kind: "integer"; min: number; max: number; optional?: true }>
  | Readonly<{ kind: "opaque-id" }>
  | Readonly<{ kind: "opaque-id-array"; maxItems: number; optional?: true }>
  | Readonly<{ kind: "label-array"; maxItems: number; optional?: true }>;

export interface RecommendationTemplateDefinition {
  readonly detector_id: DetectorId;
  readonly category: RecommendationCategory;
  readonly lever: string;
  readonly target_metric: string;
  readonly formula_id: string;
  readonly title_id: string;
  readonly action_id: string;
  readonly actionable: boolean;
  readonly facts: Readonly<Record<string, FactRule>>;
}

const count = (max = Number.MAX_SAFE_INTEGER) => ({ kind: "integer" as const, min: 0, max });
const optionalCount = () => ({ ...count(), optional: true as const });
const finite = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ kind: "finite" as const, min, max });
/** A finite number or absent: facts added after a template shipped, so older rows still validate. */
const optionalFinite = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({
  ...finite(min, max),
  optional: true as const,
});
const nullableFinite = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({
  kind: "nullable-finite" as const,
  min,
  max,
});
const ratio = () => ({ kind: "finite" as const, min: 0, max: 1 });
const opaqueId = () => ({ kind: "opaque-id" as const });
const optionalOpaqueId = () => ({ kind: "opaque-id" as const, optional: true as const });
const opaqueIds = (maxItems = 512) => ({ kind: "opaque-id-array" as const, maxItems });
/** P2 WIRE: session_ids added to pre-existing templates stay optional so older payloads still validate. */
const optionalOpaqueIds = (maxItems = 512) => ({
  kind: "opaque-id-array" as const,
  maxItems,
  optional: true as const,
});
/** U7 D10: bounded one-line catalog labels (names of local skills/plugins/MCP servers). */
const optionalLabels = (maxItems: number) => ({
  kind: "label-array" as const,
  maxItems,
  optional: true as const,
});
const bool = () => ({ kind: "boolean" as const });
const oneOf = <const V extends readonly string[]>(...values: V) => ({
  kind: "enum" as const,
  values,
});
const optionalOneOf = <const V extends readonly string[]>(...values: V) => ({
  kind: "enum" as const,
  values,
  optional: true as const,
});

export const RECOMMENDATION_TEMPLATES = {
  D1_CONTEXT_ALWAYS_LOADED: {
    detector_id: "D1",
    category: "CONTEXT",
    lever: "Remove or scope always-loaded context that is not needed for most turns.",
    target_metric: "avg_context_per_turn",
    formula_id: "D1_ALWAYS_LOADED_TRIM_V1",
    title_id: "D1_CONTEXT_ALWAYS_LOADED_TITLE_V1",
    action_id: "TRIM_ALWAYS_LOADED_CONTEXT_V1",
    actionable: true,
    facts: {
      component: oneOf("CLAUDE_MD", "MEMORY", "MCP_SCHEMAS"),
      probe_id: optionalOpaqueId(),
      attribution_method: optionalOneOf("MEASURED_CONTENT", "CHARS4_ESTIMATE"),
      session_ids: optionalOpaqueIds(20),
      source_tokens: finite(),
      source_target: finite(),
      delta_context_tokens: finite(),
      turns_per_week: finite(),
      scope: oneOf("global", "workspace"),
      workspace_multiplier: count(),
      top_workspace_turns: optionalCount(),
    },
  },
  D2_LONG_FULL_CONTEXT: {
    detector_id: "D2",
    category: "CONTEXT",
    lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
    target_metric: "avg_context_per_turn",
    formula_id: "D2_LONG_CONTEXT_CACHE_READ_V1",
    title_id: "D2_LONG_FULL_CONTEXT_TITLE_V1",
    action_id: "SPLIT_LONG_SESSIONS_V1",
    actionable: true,
    facts: {
      session_ids: opaqueIds(),
      qualifying_session_count: count(),
      qualifying_turn_count: count(),
      raw_context_average_tokens_per_turn: finite(),
      cap_weighted_burn_tokens_per_week: finite(),
      cache_read_tokens_per_week: finite(),
      cap_read_coefficient: finite(0, 1),
      // S6 netting (P3.1-T9): optional so rows written before it keep validating.
      suggested_split_count: optionalCount(),
      // U7: commit events in the qualifying sessions, and the splits placed on one of them.
      commit_boundary_count: optionalCount(),
      commit_anchored_splits: optionalCount(),
      // U9 r4: git commands run in those sessions, whether or not a commit sha was harvested.
      git_command_count: optionalCount(),
      /** U9 r6: `<session id>|<calls>|<avg context>|<peak context>|<call context first passed 180K>`. */
      session_stats: optionalLabels(5),
      base_prefix_tokens: optionalCount(),
      summary_tokens: optionalCount(),
      gross_savings_u_per_wk: optionalCount(),
      rebuild_u_per_wk: optionalCount(),
      // Review 3 B5: the derived reduction and the spend it applies to, shown on the card.
      cache_read_spend_u_per_wk: optionalCount(),
      reduction_fraction: { ...ratio(), optional: true as const },
      // F3: the saving at the bounds of the split cadence and summary size (ASSUMED).
      savings_low_u_per_wk: optionalCount(),
      savings_high_u_per_wk: optionalCount(),
    },
  },
  D4_MODEL_MISMATCH: {
    detector_id: "D4",
    category: "MODEL",
    lever: "Route eligible large-context low-output turns to the suitable model.",
    target_metric: "model_mix_opus_fraction",
    formula_id: "D4_MODEL_MISMATCH_V1",
    title_id: "D4_MODEL_MISMATCH_TITLE_V1",
    action_id: "REVIEW_MODEL_ROUTE_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      session_ids: optionalOpaqueIds(20),
      total_opus_turns_per_week: count(),
      mismatch_turns_per_week: count(),
      // Rows from before R2.14 (review 1) carry this; newer rows carry the subagent counts.
      sidechain_premium_turns: optionalCount(),
      opus_subagent_count: optionalCount(),
      lookup_subagent_count: optionalCount(),
      mismatch_fraction: ratio(),
      avg_input_tokens: finite(),
      avg_output_tokens: finite(),
      // U7: main-thread lookup turns, the top subagent types, and the per-model cap read.
      main_thread_turns: optionalCount(),
      top_agent_types: optionalOpaqueIds(3),
      /** U9 r8: `<agent id>|<session id>|<type>|<turns>|<avg output>|<cost µ$ at Opus prices>`, costliest first. */
      top_agents: optionalLabels(20),
      cap_attribution: optionalOneOf("sonnet_binds", "all_models_or_opus_binds"),
      /** U9 r7: the lookup turns' cost at Opus and at Sonnet prices (µ$), the gap behind the $. */
      lookup_opus_cost_u: optionalCount(),
      lookup_sonnet_cost_u: optionalCount(),
    },
  },
  D5_LIMIT_BURN_DEGRADED: {
    detector_id: "D5",
    category: "LIMIT",
    lever: "Calibrate the weekly token limit, then use the measured burn trend to guide workload.",
    target_metric: "burn_trend",
    formula_id: "D5_LIMIT_BURN_FORECAST_V1",
    title_id: "D5_LIMIT_BURN_DEGRADED_TITLE_V1",
    action_id: "CALIBRATE_LIMIT_V1",
    actionable: true,
    facts: {
      forecast_state: oneOf("OFF"),
      session_ids: optionalOpaqueIds(20),
      tokens_used: finite(),
      burn_trend: oneOf("RISING", "FALLING", "FLAT"),
      recent_cap_weighted_tokens: finite(),
      recent_cap_weighted_tokens_per_day: finite(),
      baseline_cap_weighted_tokens: finite(),
      baseline_cap_weighted_tokens_per_day: finite(),
      baseline_window_days: finite(0, 365),
    },
  },
  D5_LIMIT_BURN_WARNING: {
    detector_id: "D5",
    category: "LIMIT",
    lever: "Reduce burn in the highest-use workspace before the weekly reset.",
    target_metric: "forecast_margin",
    formula_id: "D5_LIMIT_BURN_FORECAST_V1",
    title_id: "D5_LIMIT_BURN_WARNING_TITLE_V1",
    action_id: "REDUCE_LIMIT_BURN_V1",
    actionable: true,
    facts: {
      forecast_state: oneOf("WARNING", "EXCEEDED"),
      session_ids: optionalOpaqueIds(20),
      tokens_used: finite(),
      limit_tokens: nullableFinite(),
      projected_exhaustion_jd: nullableFinite(0, 10_000_000),
      limit_scale_legacy: bool(),
      // U7: forecast from the API's used_pct readings (percentages and ISO times only).
      severity: optionalOneOf("high", "medium"),
      used_pct: optionalFinite(0, 1000),
      projected_pct: optionalFinite(0, 100_000),
      pace_pct_per_day: optionalFinite(0, 100_000),
      pace_window_hours: optionalFinite(0, 24),
      hours_to_reset: optionalFinite(0, 200),
      resets_at: optionalOpaqueId(),
      projected_limit_hit_at: optionalOpaqueId(),
      required_cut_pct: optionalFinite(0, 100),
      top_workspace_id: optionalOpaqueId(),
      top_workspace_share: optionalFinite(0, 1),
      top_model: optionalOpaqueId(),
    },
  },
  D6_TOOL_RESULT_BLOAT: {
    detector_id: "D6",
    category: "TOOLING",
    lever: "Use scoped reads and filters, and summarize verbose tool output.",
    target_metric: "tool_result_byte_share",
    formula_id: "D6_TOOL_RESULT_BLOAT_V1",
    title_id: "D6_TOOL_RESULT_BLOAT_TITLE_V1",
    action_id: "SCOPE_TOOL_OUTPUT_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      session_ids: opaqueIds(),
      session_count: count(),
      tool_result_bytes: finite(),
      session_cap_weighted_tokens: finite(),
      bloat_share: ratio(),
      turn_count: count(),
      bytes_per_token: finite(0, 1024),
      /** U9: the Read tool's part of tool_result_bytes, and the largest sessions. */
      read_result_bytes: optionalFinite(),
      read_call_count: optionalCount(),
      top_sessions: optionalLabels(5),
      /** U9 r3: the tools behind the bytes, `<tool>|<bytes>|<calls>`, largest first. */
      top_tools: optionalLabels(4),
      /** RR U13: uncalibrated bytes/token spans 2.7 (high) to 4 (low); absent when calibrated. */
      savings_low_u_per_wk: optionalCount(),
      savings_high_u_per_wk: optionalCount(),
    },
  },
  D7_CROSS_SESSION_REREAD: {
    detector_id: "D7",
    category: "TOOLING",
    lever: "Point sessions at the part they need of the files they re-read every session.",
    target_metric: "cross_session_redundant_reads",
    formula_id: "D7_CROSS_SESSION_REDUNDANT_READ_V1",
    title_id: "D7_CROSS_SESSION_REREAD_TITLE_V1",
    action_id: "REDUCE_REDUNDANT_READS_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      redundant_path_count: count(),
      total_redundant_read_count: count(),
      total_redundant_result_bytes: finite(),
      max_path_read_count: count(),
      max_path_session_count: count(),
      session_ids: optionalOpaqueIds(20),
      /** Every session with a counted re-read; `session_ids` lists at most 20 (review 2 D7b3). */
      session_count: optionalCount(),
      /** One read call of each top file, most-read first; the card reads the path back. */
      top_read_event_ids: optionalOpaqueIds(5),
    },
  },
  D7_RETRY_LOOP: {
    detector_id: "D7",
    category: "TOOLING",
    lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
    target_metric: "loop_flagged_turn_share",
    formula_id: "D7_LOOP_RETRY_WASTE_V1",
    title_id: "D7_RETRY_LOOP_TITLE_V1",
    action_id: "BOUND_RETRIES_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      session_ids: opaqueIds(),
      session_count: count(),
      loop_flagged_event_count: count(),
      loop_flagged_turn_count: count(),
      repeat_excess_event_count: count(),
      repeat_excess_turn_count: count(),
      total_turn_count: count(),
      loop_flagged_turn_share: ratio(),
      owner_turn_metadata_coverage: ratio(),
      owner_turn_metadata_covered_event_count: count(),
      owner_turn_metadata_denominator_event_count: count(),
      identical_call_event_count: count(),
      test_fail_event_count: count(),
      redundant_read_event_count: count(),
      three_gram_loop_event_count: count(),
      error_loop_event_count: count(),
      edit_without_prior_read_event_count: count(),
      owner_turn_metadata_coverage_floor: ratio(),
      friction_signals_suppressed_below_coverage_floor: bool(),
      repeat_excess_turn_cap_weighted_tokens: finite(),
      // Review 5 B1: the repeat turns' stored cost and its display components (optional: rows
      // written before it keep validating).
      repeat_excess_read_tokens: optionalFinite(),
      repeat_excess_write_tokens: optionalFinite(),
      repeat_excess_io_tokens: optionalFinite(),
      repeat_excess_read_u: optionalFinite(),
      repeat_excess_write_u: optionalFinite(),
      repeat_excess_io_u: optionalFinite(),
      repeat_excess_cost_u: optionalFinite(),
      /** The first calls of the most-repeated call; the card reads them back as an example. */
      loop_example_event_ids: optionalOpaqueIds(5),
      loop_example_call_count: optionalCount(),
    },
  },
  D8_CACHE_WRITE_CHURN: {
    detector_id: "D8",
    category: "CACHE",
    lever: "Run /clear or /compact before a break longer than the cache lifetime.",
    target_metric: "cache_read_to_creation_ratio",
    formula_id: "D8_CACHE_WRITE_CHURN_V1",
    title_id: "D8_CACHE_WRITE_CHURN_TITLE_V1",
    action_id: "REDUCE_CACHE_REBUILDS_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      session_ids: opaqueIds(),
      session_count: count(),
      churn_event_count: count(),
      total_churn_creation_tokens: finite(),
      session_cap_weighted_tokens: finite(),
      creation_share: ratio(),
      cache_read_to_creation_ratio: nullableFinite(),
      regime: oneOf("5m", "mixed"),
      // U9 r5: tokens the resume turns wrote to each cache tier.
      churn_write_5m_tokens: optionalCount(),
      churn_write_1h_tokens: optionalCount(),
      // S6 netting (P3.1-T9): what a fresh start writes anyway, subtracted per resume.
      base_prefix_tokens: optionalCount(),
      net_churn_creation_tokens: optionalCount(),
      // The longest idle gap before one of these resumes, in minutes (P3.1 review 3 B6).
      longest_gap_min: optionalCount(),
      // U7: how long the breaks were (resume count by idle gap, minutes).
      gap_5_15_min_count: optionalCount(),
      gap_15_60_min_count: optionalCount(),
      gap_60_240_min_count: optionalCount(),
      gap_240_plus_min_count: optionalCount(),
      // U9: the biggest resumes as "session_id|at|gap_min|written_tokens|net_tokens" labels.
      top_resumes: optionalLabels(8),
    },
  },
  D9_BACKGROUND_SESSION: {
    detector_id: "D9",
    category: "SESSION_HYGIENE",
    lever: "Use fresh subagents with only the relevant brief instead of forked context.",
    target_metric: "fork_subagent_count",
    formula_id: "D9_IDLE_BACKGROUND_SESSION_V1",
    title_id: "D9_BACKGROUND_SESSION_TITLE_V1",
    action_id: "REDUCE_BACKGROUND_FANOUT_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      fork_count: count(),
      session_ids: opaqueIds(20),
      // U7: cache reads on the fork turns in the window, and whether any were priced.
      fork_cache_read_tokens: optionalCount(),
      cost_basis: optionalOneOf("measured", "not_measured"),
    },
  },
  D10_CATALOG_FOOTPRINT: {
    detector_id: "D10",
    category: "CONTEXT",
    lever: "Disable or scope catalog entries that are not used in this workspace.",
    target_metric: "catalog_context_tokens",
    formula_id: "D10_CATALOG_FOOTPRINT_V1",
    title_id: "D10_CATALOG_FOOTPRINT_TITLE_V1",
    action_id: "SCOPE_CATALOG_V1",
    actionable: true,
    facts: {
      session_ids: optionalOpaqueIds(20),
      catalog_item_count: count(),
      always_load_count: count(),
      catalog_tokens: finite(),
      catalog_target_tokens: finite(),
      delta_context_tokens: finite(),
      // U7: per-item disable-list facts (absent on rows written before u7-1).
      removable_tokens: optionalFinite(),
      mean_context_tokens: optionalFinite(),
      pct_of_spend: optionalFinite(0, 100),
      disable_list: optionalLabels(30),
      unmeasured_mcp_server_count: optionalCount(),
      skill_use_untracked_count: optionalCount(),
    },
  },
  D11_TOOL_ERROR_RATE: {
    detector_id: "D11",
    category: "TOOLING",
    lever: "Prefer the measured lower-error shell for repository and file operations.",
    target_metric: "shell_error_rate",
    formula_id: "D11_TOOL_ERROR_RATE_V1",
    title_id: "D11_TOOL_ERROR_RATE_TITLE_V1",
    action_id: "ROUTE_SHELL_TOOL_V1",
    actionable: true,
    facts: {
      session_ids: optionalOpaqueIds(20),
      bash_error_ratio: ratio(),
      powershell_error_ratio: ratio(),
      bash_call_count: count(),
      powershell_call_count: count(),
      bash_error_count: count(),
      powershell_error_count: count(),
      preferred_tool: oneOf("Bash", "PowerShell"),
      higher_error_tool: oneOf("Bash", "PowerShell"),
    },
  },
  D12_SUBAGENT_OVERSPAWN: {
    detector_id: "D12",
    category: "SESSION_HYGIENE",
    lever: "Request compact subagent returns scoped to the parent decision.",
    target_metric: "sidechain_result_bytes",
    formula_id: "D12_SUBAGENT_OVERSPAWN_V1",
    title_id: "D12_SUBAGENT_OVERSPAWN_TITLE_V1",
    action_id: "COMPACT_SUBAGENT_RETURNS_V1",
    actionable: true,
    facts: {
      workspace_id: opaqueId(),
      sidechain_result_bytes: finite(),
      sidechain_turn_count: count(),
      sidechain_session_count: count(),
      session_ids: opaqueIds(20),
    },
  },
} as const satisfies Record<RecommendationTemplateId, RecommendationTemplateDefinition>;

type FactValueForRule<R> = R extends { readonly kind: "boolean" }
  ? boolean
  : R extends { readonly kind: "finite" | "integer" }
    ? number
    : R extends { readonly kind: "nullable-finite" }
      ? number | null
      : R extends { readonly kind: "opaque-id-array" | "label-array" }
        ? readonly string[]
        : R extends { readonly kind: "enum" }
          ? R extends { readonly values: readonly (infer V extends string)[] }
            ? V
            : never
          : string;

type OptionalFactKeys<F> = {
  [P in keyof F]: F[P] extends { readonly optional: true } ? P : never;
}[keyof F];

type FactsFor<F> = Readonly<
  { [P in Exclude<keyof F, OptionalFactKeys<F>>]: FactValueForRule<F[P]> } & {
    [P in OptionalFactKeys<F>]?: FactValueForRule<F[P]>;
  }
>;

type RecommendationPayloadFor<K extends RecommendationTemplateId> = Readonly<{
  version: typeof RECOMMENDATION_CONTRACT_VERSION;
  template_id: K;
  facts: FactsFor<(typeof RECOMMENDATION_TEMPLATES)[K]["facts"]>;
}>;

/** Closed discriminated union: each template has its own exact fact object. */
export type RecommendationPayloadV1 = {
  [K in RecommendationTemplateId]: RecommendationPayloadFor<K>;
}[RecommendationTemplateId];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Printable ASCII, no backtick (labels are quoted in card prompts), at most 200 chars. */
const CATALOG_LABEL = /^[\x20-\x5F\x61-\x7E]{1,200}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function assertOpaqueId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${name} must be a bounded opaque identifier`);
  }
}

function assertFact(name: string, value: unknown, rule: FactRule): void {
  switch (rule.kind) {
    case "boolean":
      if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !rule.values.includes(value)) {
        throw new TypeError(`${name} must be a closed enum value`);
      }
      return;
    case "finite":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < rule.min ||
        value > rule.max
      ) {
        throw new TypeError(`${name} must be a bounded finite number`);
      }
      return;
    case "nullable-finite":
      if (
        value !== null &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < rule.min ||
          value > rule.max)
      ) {
        throw new TypeError(`${name} must be null or a bounded finite number`);
      }
      return;
    case "integer":
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < rule.min ||
        (value as number) > rule.max
      ) {
        throw new TypeError(`${name} must be a bounded safe integer`);
      }
      return;
    case "opaque-id":
      assertOpaqueId(value, name);
      return;
    case "opaque-id-array":
      if (!Array.isArray(value) || value.length > rule.maxItems) {
        throw new TypeError(`${name} must be a bounded opaque-id array`);
      }
      for (const [index, item] of value.entries()) assertOpaqueId(item, `${name}[${index}]`);
      return;
    case "label-array":
      if (!Array.isArray(value) || value.length > rule.maxItems) {
        throw new TypeError(`${name} must be a bounded label array`);
      }
      for (const [index, item] of value.entries()) {
        if (typeof item !== "string" || !CATALOG_LABEL.test(item)) {
          throw new TypeError(`${name}[${index}] must be a bounded one-line label`);
        }
      }
  }
}

/**
 * P2H history-walk recency facts (spec-rec-page-history-walk.md): the anchor week's
 * start (ISO) plus three counts. SEC-101: an ISO timestamp and integers only.
 */
export interface RecencyFacts {
  readonly last_seen_week_start: string;
  readonly weeks_ago: number;
  readonly weeks_fired: number;
  readonly weeks_evaluated: number;
}

export const RECENCY_FACT_KEYS = [
  "last_seen_week_start",
  "weeks_ago",
  "weeks_fired",
  "weeks_evaluated",
] as const;

/** Validate the four recency facts on `value` (extra keys are the caller's concern). */
export function assertRecencyFacts(
  value: Record<string, unknown>,
  name = "recency facts",
): asserts value is Record<string, unknown> & RecencyFacts {
  assertStrictUtc(value.last_seen_week_start, `${name} last_seen_week_start`);
  for (const key of ["weeks_ago", "weeks_fired", "weeks_evaluated"] as const) {
    assertFact(`${name} ${key}`, value[key], count());
  }
}

export function assertRecommendationPayloadV1(
  value: unknown,
  detectorId?: string,
): asserts value is RecommendationPayloadV1 {
  if (!isPlainObject(value)) throw new TypeError("recommendation payload must be an object");
  assertExactKeys(value, ["version", "template_id", "facts"], "recommendation payload");
  if (value.version !== RECOMMENDATION_CONTRACT_VERSION) {
    throw new TypeError("recommendation payload version must be 1");
  }
  if (typeof value.template_id !== "string" || !(value.template_id in RECOMMENDATION_TEMPLATES)) {
    throw new TypeError("recommendation payload template_id is not registered");
  }
  const templateId = value.template_id as RecommendationTemplateId;
  const definition = RECOMMENDATION_TEMPLATES[templateId];
  if (detectorId !== undefined && definition.detector_id !== detectorId) {
    throw new TypeError(`detector ${detectorId} cannot emit template ${templateId}`);
  }
  if (!isPlainObject(value.facts))
    throw new TypeError("recommendation payload facts must be an object");
  const facts = value.facts;
  const rules = Object.entries(definition.facts) as [string, FactRule][];
  const absentOptional = (name: string, rule: FactRule) =>
    "optional" in rule && rule.optional === true && !(name in facts);
  // P2H: the history walk stamps the four recency facts (all or none) on every template.
  const hasRecency = RECENCY_FACT_KEYS.some((key) => key in facts);
  if (hasRecency) assertRecencyFacts(facts, `${templateId} recency facts`);
  assertExactKeys(
    facts,
    [
      ...rules.filter(([name, rule]) => !absentOptional(name, rule)).map(([name]) => name),
      ...(hasRecency ? RECENCY_FACT_KEYS : []),
    ],
    `${templateId} facts`,
  );
  for (const [name, rule] of rules) {
    if (!absentOptional(name, rule)) assertFact(name, facts[name], rule);
  }
}

export function assertDiagnosticFindingV1(value: unknown): asserts value is DiagnosticFindingV1 {
  if (!isPlainObject(value)) throw new TypeError("diagnostic finding must be an object");
  assertExactKeys(value, ["version", "category", "label", "anchor", "ceu"], "diagnostic finding");
  if (value.version !== DIAGNOSTIC_CONTRACT_VERSION)
    throw new TypeError("diagnostic version must be 1");
  if (!["INGEST", "DETECTOR", "PRIVACY"].includes(value.category as string)) {
    throw new TypeError("diagnostic category must be a closed enum value");
  }
  if (
    !["CLASSIFIER_BOUNDARY", "DETECTOR_BLOCKED", "PRIVACY_REJECTED"].includes(value.label as string)
  ) {
    throw new TypeError("diagnostic label must be a closed enum value");
  }
  if (!isPlainObject(value.anchor)) throw new TypeError("diagnostic anchor must be an object");
  const anchorKeys = Object.keys(value.anchor);
  const allowedAnchorKeys = ["message_id", "session_id", "timestamp", "turn_index"];
  if (anchorKeys.some((key) => !allowedAnchorKeys.includes(key))) {
    throw new TypeError("diagnostic anchor contains an unknown key");
  }
  if (!anchorKeys.includes("session_id") || !anchorKeys.includes("timestamp")) {
    throw new TypeError("diagnostic anchor requires session_id and timestamp");
  }
  assertOpaqueId(value.anchor.session_id, "diagnostic anchor session_id");
  if (value.anchor.message_id !== undefined)
    assertOpaqueId(value.anchor.message_id, "diagnostic anchor message_id");
  const turnIndex = value.anchor.turn_index;
  if (
    turnIndex !== undefined &&
    (typeof turnIndex !== "number" || !Number.isSafeInteger(turnIndex) || turnIndex < 0)
  ) {
    throw new TypeError("diagnostic anchor turn_index must be a non-negative safe integer");
  }
  const timestamp = value.anchor.timestamp;
  if (
    typeof timestamp !== "string" ||
    !ISO_UTC.test(timestamp) ||
    Number.isNaN(new Date(timestamp).getTime()) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new TypeError("diagnostic anchor timestamp must be a valid strict UTC timestamp");
  }
  if (!isPlainObject(value.ceu)) throw new TypeError("diagnostic ceu must be an object");
  assertExactKeys(value.ceu, ["value", "band", "provenance"], "diagnostic ceu");
  if (
    typeof value.ceu.value !== "number" ||
    !Number.isFinite(value.ceu.value) ||
    value.ceu.value < 0 ||
    value.ceu.value > 1_000_000_000
  ) {
    throw new TypeError("diagnostic ceu value must be bounded and finite");
  }
  if (!["LOW", "MEDIUM", "HIGH"].includes(value.ceu.band as string))
    throw new TypeError("diagnostic ceu band must be closed");
  if (!["MEASURED", "ESTIMATED"].includes(value.ceu.provenance as string))
    throw new TypeError("diagnostic ceu provenance must be closed");
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  );
}

export function serializeRecommendationPayloadV1(value: unknown, detectorId?: string): string {
  assertRecommendationPayloadV1(value, detectorId);
  return JSON.stringify(sortForCanonicalJson(value));
}

export function serializeModeledFormulaV1(
  value: unknown,
  detectorId?: string,
  additions?: Readonly<{ estimate: unknown }>,
): string {
  assertRecommendationPayloadV1(value, detectorId);
  if (additions !== undefined) assertEstimateBlock(additions.estimate);
  const definition = RECOMMENDATION_TEMPLATES[value.template_id];
  return JSON.stringify(
    sortForCanonicalJson({
      version: RECOMMENDATION_CONTRACT_VERSION,
      formula_id: definition.formula_id,
      inputs: value.facts,
      ...(additions === undefined ? {} : { estimate: additions.estimate }),
    }),
  );
}

function assertEstimateBlock(value: unknown): void {
  if (!isPlainObject(value)) throw new TypeError("formula estimate must be an object");
  if (!(["P", "E", "O", "R", "X"] as const).includes(value.basis as never)) {
    throw new TypeError("formula estimate basis must be closed");
  }
  if (
    value.rank_value_u_per_wk !== null &&
    (typeof value.rank_value_u_per_wk !== "number" || !Number.isFinite(value.rank_value_u_per_wk))
  ) {
    throw new TypeError("formula estimate rank value must be finite or null");
  }
  if (typeof value.summable !== "boolean" || typeof value.label !== "string") {
    throw new TypeError("formula estimate fields must be structural");
  }
}

export function serializeDiagnosticFindingV1(value: unknown): string {
  assertDiagnosticFindingV1(value);
  return JSON.stringify(sortForCanonicalJson(value));
}

export function recommendationTemplate(
  templateId: RecommendationTemplateId,
): RecommendationTemplateDefinition {
  return RECOMMENDATION_TEMPLATES[templateId];
}

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type FindingSessionId = Brand<string, "FindingSessionId">;
export type FindingMessageId = Brand<string, "FindingMessageId">;
export type FindingEventId = Brand<string, "FindingEventId">;
export type FindingArtifactId = Brand<string, "FindingArtifactId">;
export type FindingWorkItemId = Brand<string, "FindingWorkItemId">;

const CODE_ID = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_ID = {
  SESSION: /^sid_[0-9a-f]{64}$/,
  MESSAGE: /^mid_[0-9a-f]{64}$/,
  EVENT: /^eid_[0-9a-f]{64}$/,
  ARTIFACT: /^aid_[0-9a-f]{64}$/,
  WORK_ITEM: /^wid_[0-9a-f]{64}$/,
} as const;

function sourceId<Name extends string>(
  value: string,
  source: string,
  prefix: string,
): Brand<string, Name> {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${source} must be a bounded source identifier`);
  }
  const digest = crypto
    .createHash("sha256")
    .update(source)
    .update("\0")
    .update(value)
    .digest("hex");
  return `${prefix}_${digest}` as Brand<string, Name>;
}

/** Constructors prevent detector code from treating arbitrary strings as structural identities. */
export const findingIds = {
  session: (value: string): FindingSessionId => sourceId(value, "session_id", "sid"),
  message: (value: string): FindingMessageId => sourceId(value, "message_id", "mid"),
  event: (value: string): FindingEventId => sourceId(value, "event_id", "eid"),
  artifact: (value: string): FindingArtifactId => sourceId(value, "artifact_id", "aid"),
  workItem: (value: string): FindingWorkItemId => sourceId(value, "work_item_id", "wid"),
} as const;

export type FindingIdSource = "SESSION" | "MESSAGE" | "EVENT" | "ARTIFACT" | "WORK_ITEM";

function assertSourceId(value: unknown, source: FindingIdSource, name: string): void {
  if (typeof value !== "string" || !SOURCE_ID[source].test(value)) {
    throw new TypeError(`${name} is not a recognized ${source} identifier`);
  }
}

export type FindingAssessmentKind = "DETERMINISTIC" | "CORRELATIONAL" | "LLM_JUDGED";
export type FindingPosture = "ASSERTED" | "REVIEW" | "REPORT_ONLY";
export type FindingRouteTier = "T1" | "T2" | "T3" | "INVESTIGATE";
export type FindingFacetName = "impact" | "ceu" | "verdict" | "metrics";
export type FindingMetricKind =
  | "COUNT"
  | "INTEGER"
  | "NUMBER"
  | "RATIO"
  | "BYTES"
  | "TOKENS"
  | "DURATION_MS"
  | "TIMESTAMP"
  | "BOOLEAN"
  | "ENUM"
  | "OPAQUE_ID"
  | "HASH"
  /** Free text for in-app use (ADR-112 amendment 2026-09-25); `max` bounds its length. */
  | "TEXT";

/** Default length bound for TEXT metrics (matches the tool_event_content slice bound). */
const TEXT_METRIC_MAX_LENGTH = 4_000;

export type FindingMetricValue = Readonly<{
  kind: FindingMetricKind;
  value: number | boolean | string;
}>;

export interface FindingAnchorV2 {
  readonly session_id: FindingSessionId;
  readonly timestamp: string;
  readonly message_id?: FindingMessageId;
  readonly turn_index?: number;
  readonly event_id?: FindingEventId;
  readonly byte_offset?: number;
}

export interface FindingEnvelopeV2 {
  readonly version: typeof FINDING_CONTRACT_VERSION;
  readonly rule_id: string;
  readonly label: string;
  readonly assessment: Readonly<{
    kind: FindingAssessmentKind;
    posture: FindingPosture;
    provenance: Readonly<{
      source: "RULE" | "CLASSIFIER" | "OUTCOME_LINK" | "LLM";
      version: string;
    }>;
  }>;
  readonly routing: Readonly<{
    tier: FindingRouteTier;
    artifact_id?: FindingArtifactId;
    escalation?: "W3_CONFIRMATION";
  }>;
  readonly window: Readonly<{ from: string; to: string }>;
  readonly anchors: readonly FindingAnchorV2[];
  readonly evidence_digest: string;
  /** Workspace-rollup: sorted raw session ids contributing to this finding. */
  readonly session_ids?: readonly string[];
  /** Pricing result retained in modeled_formula_json, separate from evidence metrics. */
  readonly estimate?: Readonly<{
    basis: "P" | "E" | "O" | "R" | "X";
    rank_value_u_per_wk: number | null;
    summable: boolean;
    label: string;
  }>;
  readonly impact?: Readonly<{
    kind: "COST" | "TOKEN_WASTE" | "FRICTION" | "RISK";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    direction: "REDUCE" | "INCREASE" | "NONE";
  }>;
  readonly ceu?: Readonly<{
    value: number;
    band: "LOW" | "MEDIUM" | "HIGH";
    provenance: "MEASURED" | "ESTIMATED" | "FLOOR";
  }>;
  readonly verdict?: Readonly<{
    value: "CONFIRMED" | "SUPPORTED" | "INCONCLUSIVE" | "REJECTED";
    method: "RULE" | "CORRELATION" | "LLM";
  }>;
  readonly metrics?: Readonly<Record<string, FindingMetricValue>>;
  /** P2H history-walk recency facts; stamped after digesting, so outside evidence_digest. */
  readonly recency?: RecencyFacts;
}

export type FindingMetricDefinition = Readonly<{
  kind: FindingMetricKind;
  min?: number;
  max?: number;
  values?: readonly string[];
  source?: FindingIdSource;
  /** Added after findings were persisted: an envelope may lack it and still validate. */
  optional?: true;
}>;

export interface FindingDescriptorV2 {
  readonly owner_detector_id: string;
  readonly rule_id: string;
  readonly labels: readonly string[];
  readonly metrics: Readonly<Record<string, FindingMetricDefinition>>;
  readonly facets: readonly FindingFacetName[];
  readonly defaults: Readonly<{
    assessment: Readonly<{
      kind: FindingAssessmentKind;
      posture: FindingPosture;
      provenance: Readonly<{
        source: "RULE" | "CLASSIFIER" | "OUTCOME_LINK" | "LLM";
        version: string;
      }>;
    }>;
    routing: Readonly<{ tier: FindingRouteTier }>;
  }>;
  /** Trusted presentation metadata. This is never copied into evidence_json. */
  readonly presentation: Readonly<{
    category: RecommendationCategory;
    lever: string;
    target_metric: string;
    title: string;
  }>;
}

type FindingEnvelopeWithoutDigest = Omit<FindingEnvelopeV2, "evidence_digest" | "recency">;

function assertStrictUtc(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_UTC.test(value) ||
    Number.isNaN(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${name} must be a valid strict UTC timestamp`);
  }
}

function assertCodeId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !CODE_ID.test(value)) {
    throw new TypeError(`${name} must be a bounded code identifier`);
  }
}

function assertFiniteRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
  integer = false,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`${name} must be a bounded ${integer ? "safe integer" : "finite number"}`);
  }
}

export function assertFindingDescriptorV2(value: unknown): asserts value is FindingDescriptorV2 {
  if (!isPlainObject(value)) throw new TypeError("finding descriptor must be an object");
  assertExactKeys(
    value,
    ["owner_detector_id", "rule_id", "labels", "metrics", "facets", "defaults", "presentation"],
    "finding descriptor",
  );
  assertCodeId(value.owner_detector_id, "descriptor owner_detector_id");
  assertCodeId(value.rule_id, "descriptor rule_id");
  if (!Array.isArray(value.labels) || value.labels.length === 0 || value.labels.length > 32) {
    throw new TypeError("descriptor labels must contain one to 32 values");
  }
  const labelSet = new Set<string>();
  for (const label of value.labels) {
    assertCodeId(label, "descriptor label");
    if (labelSet.has(label)) throw new TypeError("descriptor labels must be unique");
    labelSet.add(label);
  }
  if (!isPlainObject(value.metrics)) throw new TypeError("descriptor metrics must be an object");
  if (Object.keys(value.metrics).length > 64) throw new TypeError("descriptor metrics are bounded");
  for (const [metricId, definition] of Object.entries(value.metrics)) {
    assertCodeId(metricId, "descriptor metric id");
    if (!isPlainObject(definition)) throw new TypeError(`${metricId} definition must be an object`);
    const allowedDefinitionKeys = ["kind", "min", "max", "values", "source", "optional"];
    if (Object.keys(definition).some((key) => !allowedDefinitionKeys.includes(key))) {
      throw new TypeError(`${metricId} definition contains an unknown key`);
    }
    if (definition.optional !== undefined && definition.optional !== true)
      throw new TypeError(`${metricId} optional must be true when set`);
    if (
      ![
        "COUNT",
        "INTEGER",
        "NUMBER",
        "RATIO",
        "BYTES",
        "TOKENS",
        "DURATION_MS",
        "TIMESTAMP",
        "BOOLEAN",
        "ENUM",
        "OPAQUE_ID",
        "HASH",
        "TEXT",
      ].includes(definition.kind as string)
    )
      throw new TypeError(`${metricId} has an invalid metric kind`);
    if (definition.min !== undefined)
      assertFiniteRange(definition.min, `${metricId} min`, -Number.MAX_VALUE, Number.MAX_VALUE);
    if (definition.max !== undefined)
      assertFiniteRange(definition.max, `${metricId} max`, -Number.MAX_VALUE, Number.MAX_VALUE);
    if (
      definition.min !== undefined &&
      definition.max !== undefined &&
      definition.min > definition.max
    ) {
      throw new TypeError(`${metricId} min cannot exceed max`);
    }
    if (definition.kind === "ENUM") {
      if (
        !Array.isArray(definition.values) ||
        definition.values.length === 0 ||
        definition.values.length > 32
      ) {
        throw new TypeError(`${metricId} enum values must be bounded and non-empty`);
      }
      for (const item of definition.values) assertCodeId(item, `${metricId} enum value`);
    } else if (definition.values !== undefined) {
      throw new TypeError(`${metricId} values are allowed only for ENUM metrics`);
    }
    if (definition.kind === "OPAQUE_ID") {
      if (
        !["SESSION", "MESSAGE", "EVENT", "ARTIFACT", "WORK_ITEM"].includes(
          definition.source as string,
        )
      ) {
        throw new TypeError(`${metricId} OPAQUE_ID requires a source`);
      }
    } else if (definition.source !== undefined) {
      throw new TypeError(`${metricId} source is allowed only for OPAQUE_ID metrics`);
    }
  }
  if (!Array.isArray(value.facets) || value.facets.length > 4) {
    throw new TypeError("descriptor facets must be a bounded array");
  }
  const facetSet = new Set<string>();
  for (const facet of value.facets) {
    if (
      !["impact", "ceu", "verdict", "metrics"].includes(facet as string) ||
      facetSet.has(facet as string)
    ) {
      throw new TypeError("descriptor facets must be unique known values");
    }
    facetSet.add(facet as string);
  }
  if (Object.keys(value.metrics).length > 0 && !facetSet.has("metrics")) {
    throw new TypeError("descriptor metrics require the metrics facet");
  }
  if (!isPlainObject(value.defaults)) throw new TypeError("descriptor defaults must be an object");
  assertExactKeys(value.defaults, ["assessment", "routing"], "descriptor defaults");
  assertAssessment(value.defaults.assessment, "descriptor assessment");
  assertRouting(value.defaults.routing, "descriptor routing", true);
  if (!isPlainObject(value.presentation))
    throw new TypeError("descriptor presentation must be an object");
  assertExactKeys(
    value.presentation,
    ["category", "lever", "target_metric", "title"],
    "descriptor presentation",
  );
  if (
    !["CONTEXT", "LIMIT", "CACHE", "TOOLING", "SESSION_HYGIENE", "MODEL"].includes(
      value.presentation.category as string,
    )
  ) {
    throw new TypeError("descriptor presentation category must be closed");
  }
  for (const key of ["lever", "target_metric", "title"] as const) {
    if (typeof value.presentation[key] !== "string" || value.presentation[key].length === 0) {
      throw new TypeError(`descriptor presentation ${key} must be non-empty`);
    }
  }
}

export function defineFindingDescriptorV2<const T extends FindingDescriptorV2>(descriptor: T): T {
  assertFindingDescriptorV2(descriptor);
  return descriptor;
}

function assertAssessment(value: unknown, name: string): void {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  assertExactKeys(value, ["kind", "posture", "provenance"], name);
  if (!["DETERMINISTIC", "CORRELATIONAL", "LLM_JUDGED"].includes(value.kind as string)) {
    throw new TypeError(`${name} kind must be closed`);
  }
  if (!["ASSERTED", "REVIEW", "REPORT_ONLY"].includes(value.posture as string)) {
    throw new TypeError(`${name} posture must be closed`);
  }
  if (!isPlainObject(value.provenance)) throw new TypeError(`${name} provenance must be an object`);
  assertExactKeys(value.provenance, ["source", "version"], `${name} provenance`);
  if (!["RULE", "CLASSIFIER", "OUTCOME_LINK", "LLM"].includes(value.provenance.source as string)) {
    throw new TypeError(`${name} provenance source must be closed`);
  }
  if (
    typeof value.provenance.version !== "string" ||
    !SAFE_VERSION.test(value.provenance.version)
  ) {
    throw new TypeError(`${name} provenance version must be bounded`);
  }
}

function assertRouting(value: unknown, name: string, defaults = false): void {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value);
  const allowed = defaults ? ["tier"] : ["tier", "artifact_id", "escalation"];
  if (keys.some((key) => !allowed.includes(key)) || !keys.includes("tier")) {
    throw new TypeError(`${name} contains unknown or missing keys`);
  }
  if (!["T1", "T2", "T3", "INVESTIGATE"].includes(value.tier as string)) {
    throw new TypeError(`${name} tier must be closed`);
  }
  if (value.artifact_id !== undefined)
    assertSourceId(value.artifact_id, "ARTIFACT", `${name} artifact_id`);
  if (value.escalation !== undefined && value.escalation !== "W3_CONFIRMATION") {
    throw new TypeError(`${name} escalation must be W3_CONFIRMATION`);
  }
  if (value.artifact_id !== undefined && value.escalation !== undefined) {
    throw new TypeError(`${name} may reference an artifact or escalation, not both`);
  }
}

function assertMetricValue(
  metricId: string,
  value: unknown,
  definition: FindingMetricDefinition,
): void {
  if (!isPlainObject(value)) throw new TypeError(`${metricId} metric must be an object`);
  assertExactKeys(value, ["kind", "value"], `${metricId} metric`);
  if (value.kind !== definition.kind) throw new TypeError(`${metricId} metric kind mismatch`);
  const min = definition.min ?? 0;
  const max = definition.max ?? Number.MAX_SAFE_INTEGER;
  switch (definition.kind) {
    case "COUNT":
    case "INTEGER":
    case "BYTES":
    case "TOKENS":
    case "DURATION_MS":
      assertFiniteRange(value.value, metricId, min, max, true);
      return;
    case "NUMBER":
      assertFiniteRange(
        value.value,
        metricId,
        definition.min ?? -Number.MAX_VALUE,
        definition.max ?? Number.MAX_VALUE,
      );
      return;
    case "RATIO":
      assertFiniteRange(value.value, metricId, definition.min ?? 0, definition.max ?? 1);
      return;
    case "TIMESTAMP":
      assertStrictUtc(value.value, metricId);
      return;
    case "BOOLEAN":
      if (typeof value.value !== "boolean") throw new TypeError(`${metricId} must be boolean`);
      return;
    case "ENUM":
      if (typeof value.value !== "string" || !definition.values?.includes(value.value)) {
        throw new TypeError(`${metricId} must be a descriptor enum value`);
      }
      return;
    case "OPAQUE_ID":
      if (definition.source === undefined) throw new TypeError(`${metricId} source is required`);
      assertSourceId(value.value, definition.source, metricId);
      return;
    case "HASH":
      if (typeof value.value !== "string" || !SHA256.test(value.value)) {
        throw new TypeError(`${metricId} must be a sha256 digest`);
      }
      return;
    case "TEXT":
      if (
        typeof value.value !== "string" ||
        value.value.length > (definition.max ?? TEXT_METRIC_MAX_LENGTH)
      ) {
        throw new TypeError(`${metricId} must be bounded text`);
      }
  }
}

function assertFindingBodyV2(
  value: unknown,
  descriptor: FindingDescriptorV2,
  includeDigest: boolean,
): asserts value is FindingEnvelopeV2 {
  assertFindingDescriptorV2(descriptor);
  if (!isPlainObject(value)) throw new TypeError("finding envelope must be an object");
  const required = ["version", "rule_id", "label", "assessment", "routing", "window", "anchors"];
  const allowed = [
    ...required,
    "evidence_digest",
    "session_ids",
    "estimate",
    ...descriptor.facets,
    // Recency is stamped after digesting, so only a digested envelope may carry it.
    ...(includeDigest ? ["recency"] : []),
  ];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new TypeError("finding envelope contains unknown or missing keys");
  }
  if (value.recency !== undefined) {
    if (!isPlainObject(value.recency)) throw new TypeError("finding recency must be an object");
    assertExactKeys(value.recency, RECENCY_FACT_KEYS, "finding recency");
    assertRecencyFacts(value.recency, "finding recency");
  }
  if (includeDigest !== keys.includes("evidence_digest")) {
    throw new TypeError(
      includeDigest
        ? "finding envelope requires evidence_digest"
        : "digest input must omit evidence_digest",
    );
  }
  if (value.version !== FINDING_CONTRACT_VERSION) throw new TypeError("finding version must be 2");
  if (value.rule_id !== descriptor.rule_id)
    throw new TypeError("finding rule_id does not match descriptor");
  if (typeof value.label !== "string" || !descriptor.labels.includes(value.label)) {
    throw new TypeError("finding label is not declared by its descriptor");
  }
  assertAssessment(value.assessment, "finding assessment");
  assertRouting(value.routing, "finding routing");
  const assessment = value.assessment as FindingEnvelopeV2["assessment"];
  if (
    assessment.kind !== descriptor.defaults.assessment.kind ||
    assessment.posture !== descriptor.defaults.assessment.posture ||
    assessment.provenance.source !== descriptor.defaults.assessment.provenance.source ||
    assessment.provenance.version !== descriptor.defaults.assessment.provenance.version
  ) {
    throw new TypeError("finding assessment must match descriptor defaults");
  }
  const routing = value.routing as FindingEnvelopeV2["routing"];
  if (routing.tier !== descriptor.defaults.routing.tier) {
    throw new TypeError("finding routing tier must match descriptor defaults");
  }
  if (!isPlainObject(value.window)) throw new TypeError("finding window must be an object");
  assertExactKeys(value.window, ["from", "to"], "finding window");
  assertStrictUtc(value.window.from, "finding window from");
  assertStrictUtc(value.window.to, "finding window to");
  if (value.window.from >= value.window.to)
    throw new TypeError("finding window must be increasing");
  if (!Array.isArray(value.anchors) || value.anchors.length < 1 || value.anchors.length > 5) {
    throw new TypeError("finding anchors must contain one to five anchors");
  }
  for (const [index, anchor] of value.anchors.entries()) {
    if (!isPlainObject(anchor)) throw new TypeError(`finding anchor ${index} must be an object`);
    const anchorKeys = Object.keys(anchor);
    const allowedAnchorKeys = [
      "session_id",
      "timestamp",
      "message_id",
      "turn_index",
      "event_id",
      "byte_offset",
    ];
    if (
      anchorKeys.some((key) => !allowedAnchorKeys.includes(key)) ||
      !anchorKeys.includes("session_id") ||
      !anchorKeys.includes("timestamp")
    ) {
      throw new TypeError(`finding anchor ${index} contains unknown or missing keys`);
    }
    assertSourceId(anchor.session_id, "SESSION", `finding anchor ${index} session_id`);
    assertStrictUtc(anchor.timestamp, `finding anchor ${index} timestamp`);
    if (anchor.message_id !== undefined)
      assertSourceId(anchor.message_id, "MESSAGE", `finding anchor ${index} message_id`);
    if (anchor.event_id !== undefined)
      assertSourceId(anchor.event_id, "EVENT", `finding anchor ${index} event_id`);
    if (anchor.turn_index !== undefined)
      assertFiniteRange(
        anchor.turn_index,
        `finding anchor ${index} turn_index`,
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
    if (anchor.byte_offset !== undefined)
      assertFiniteRange(
        anchor.byte_offset,
        `finding anchor ${index} byte_offset`,
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
  }
  if (value.impact !== undefined) {
    if (!isPlainObject(value.impact)) throw new TypeError("finding impact must be an object");
    assertExactKeys(value.impact, ["kind", "severity", "direction"], "finding impact");
    if (
      !["COST", "TOKEN_WASTE", "FRICTION", "RISK"].includes(value.impact.kind as string) ||
      !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value.impact.severity as string) ||
      !["REDUCE", "INCREASE", "NONE"].includes(value.impact.direction as string)
    ) {
      throw new TypeError("finding impact values must be closed");
    }
  }
  if (value.ceu !== undefined) {
    if (!isPlainObject(value.ceu)) throw new TypeError("finding ceu must be an object");
    assertExactKeys(value.ceu, ["value", "band", "provenance"], "finding ceu");
    assertFiniteRange(value.ceu.value, "finding ceu value", 0, 1_000_000_000);
    if (
      !["LOW", "MEDIUM", "HIGH"].includes(value.ceu.band as string) ||
      !["MEASURED", "ESTIMATED", "FLOOR"].includes(value.ceu.provenance as string)
    ) {
      throw new TypeError("finding ceu values must be closed");
    }
  }
  if (value.verdict !== undefined) {
    if (!isPlainObject(value.verdict)) throw new TypeError("finding verdict must be an object");
    assertExactKeys(value.verdict, ["value", "method"], "finding verdict");
    if (
      !["CONFIRMED", "SUPPORTED", "INCONCLUSIVE", "REJECTED"].includes(
        value.verdict.value as string,
      ) ||
      !["RULE", "CORRELATION", "LLM"].includes(value.verdict.method as string)
    ) {
      throw new TypeError("finding verdict values must be closed");
    }
  }
  if (value.metrics !== undefined) {
    if (!isPlainObject(value.metrics)) throw new TypeError("finding metrics must be an object");
    // TEXT metrics, and any marked optional, may be absent so findings persisted before a detector
    // added one still load.
    const metrics = value.metrics;
    const present = Object.entries(descriptor.metrics).filter(
      ([metricId, definition]) =>
        (definition.kind !== "TEXT" && definition.optional !== true) || metricId in metrics,
    );
    assertExactKeys(
      metrics,
      present.map(([metricId]) => metricId),
      "finding metrics",
    );
    for (const [metricId, definition] of present) {
      assertMetricValue(metricId, metrics[metricId], definition);
    }
  }
  if (value.estimate !== undefined) {
    if (!isPlainObject(value.estimate)) throw new TypeError("finding estimate must be an object");
    assertExactKeys(
      value.estimate,
      ["basis", "rank_value_u_per_wk", "summable", "label"],
      "finding estimate",
    );
    if (!["P", "E", "O", "R", "X"].includes(value.estimate.basis as string)) {
      throw new TypeError("finding estimate basis must be closed");
    }
    if (value.estimate.rank_value_u_per_wk !== null) {
      assertFiniteRange(
        value.estimate.rank_value_u_per_wk,
        "finding estimate rank value",
        0,
        Number.MAX_SAFE_INTEGER,
        true,
      );
    }
    if (typeof value.estimate.summable !== "boolean" || typeof value.estimate.label !== "string") {
      throw new TypeError("finding estimate fields must be structural");
    }
  }
}

function digestFindingBody(value: FindingEnvelopeWithoutDigest): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortForCanonicalJson(value)))
    .digest("hex");
}

export function createFindingEnvelopeV2(
  value: FindingEnvelopeWithoutDigest,
  descriptor: FindingDescriptorV2,
): FindingEnvelopeV2 {
  assertFindingBodyV2(value, descriptor, false);
  return { ...value, evidence_digest: digestFindingBody(value) };
}

export function assertFindingEnvelopeV2(
  value: unknown,
  descriptor: FindingDescriptorV2,
): asserts value is FindingEnvelopeV2 {
  assertFindingBodyV2(value, descriptor, true);
  if (!SHA256.test(value.evidence_digest))
    throw new TypeError("finding evidence_digest must be sha256");
  const { evidence_digest: digest, recency: _recency, ...body } = value;
  if (digestFindingBody(body) !== digest) throw new TypeError("finding evidence_digest mismatch");
}

export function serializeFindingEnvelopeV2(
  value: unknown,
  descriptor: FindingDescriptorV2,
): string {
  assertFindingEnvelopeV2(value, descriptor);
  return JSON.stringify(sortForCanonicalJson(value));
}

export function serializeModeledFormulaV2(value: unknown, descriptor: FindingDescriptorV2): string {
  assertFindingEnvelopeV2(value, descriptor);
  return JSON.stringify(
    sortForCanonicalJson({
      version: FINDING_CONTRACT_VERSION,
      rule_id: value.rule_id,
      metrics: value.metrics ?? {},
      ...(value.estimate === undefined ? {} : { estimate: value.estimate }),
    }),
  );
}
