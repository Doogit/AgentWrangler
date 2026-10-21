import type Database from "better-sqlite3";
import {
  type RecommendationPayloadV1,
  type RecommendationTemplateId,
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";

const FACTS: Partial<Record<RecommendationTemplateId, Record<string, unknown>>> = {
  D1_CONTEXT_ALWAYS_LOADED: {
    component: "CLAUDE_MD",
    source_tokens: 10_000,
    source_target: 5_000,
    delta_context_tokens: 5_000,
    turns_per_week: 100,
    scope: "workspace",
    workspace_multiplier: 1,
  },
  D2_LONG_FULL_CONTEXT: {
    session_ids: [],
    qualifying_session_count: 0,
    qualifying_turn_count: 0,
    raw_context_average_tokens_per_turn: 0,
    cap_weighted_burn_tokens_per_week: 0,
    cache_read_tokens_per_week: 0,
    cap_read_coefficient: 0.1,
  },
  D4_MODEL_MISMATCH: {
    workspace_id: "ws-alpha",
    total_opus_turns_per_week: 1,
    mismatch_turns_per_week: 1,
    sidechain_premium_turns: 0,
    mismatch_fraction: 1,
    avg_input_tokens: 1_000,
    avg_output_tokens: 100,
  },
  D5_LIMIT_BURN_WARNING: {
    forecast_state: "WARNING",
    tokens_used: 1,
    limit_tokens: 10,
    projected_exhaustion_jd: null,
    limit_scale_legacy: false,
  },
  D6_TOOL_RESULT_BLOAT: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    tool_result_bytes: 0,
    session_cap_weighted_tokens: 0,
    bloat_share: 0,
    turn_count: 0,
    bytes_per_token: 4,
  },
  D7_RETRY_LOOP: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    loop_flagged_event_count: 0,
    loop_flagged_turn_count: 0,
    repeat_excess_event_count: 0,
    repeat_excess_turn_count: 0,
    total_turn_count: 0,
    loop_flagged_turn_share: 0,
    owner_turn_metadata_coverage: 1,
    owner_turn_metadata_covered_event_count: 0,
    owner_turn_metadata_denominator_event_count: 0,
    identical_call_event_count: 0,
    test_fail_event_count: 0,
    redundant_read_event_count: 0,
    three_gram_loop_event_count: 0,
    error_loop_event_count: 0,
    edit_without_prior_read_event_count: 0,
    owner_turn_metadata_coverage_floor: 0.8,
    friction_signals_suppressed_below_coverage_floor: false,
    repeat_excess_turn_cap_weighted_tokens: 0,
  },
  D8_CACHE_WRITE_CHURN: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    churn_event_count: 0,
    total_churn_creation_tokens: 0,
    session_cap_weighted_tokens: 0,
    creation_share: 0,
    cache_read_to_creation_ratio: null,
    regime: "5m",
  },
};

export function seedValidatedRecommendation(
  db: Database.Database,
  options: {
    recId: string;
    templateId?: RecommendationTemplateId;
    scope?: string | null;
    savings?: number | null;
    state?: string;
    createdAt?: string;
    facts?: Record<string, unknown>;
  },
): void {
  const templateId = options.templateId ?? "D1_CONTEXT_ALWAYS_LOADED";
  const baseFacts = FACTS[templateId];
  if (baseFacts === undefined) throw new Error(`No recommendation fixture for ${templateId}`);
  const payload = {
    version: 1,
    template_id: templateId,
    facts: { ...baseFacts, ...options.facts },
  } as RecommendationPayloadV1;
  const definition = recommendationTemplate(templateId);
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at, dismissed_until, contract_version, template_id, contract_status)
     VALUES (?, 'RULE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, 'V1_VALIDATED')`,
  ).run(
    options.recId,
    definition.detector_id,
    definition.category,
    options.scope === undefined ? "ws-alpha" : options.scope,
    definition.lever,
    options.savings === undefined ? 1_000 : options.savings,
    serializeModeledFormulaV1(payload),
    serializeRecommendationPayloadV1(payload),
    definition.target_metric,
    options.state ?? "PROPOSED",
    options.createdAt ?? "2026-08-25T00:00:00.000Z",
    templateId,
  );
}
