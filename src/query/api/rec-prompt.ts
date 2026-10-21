/** Browser-safe adapter from recommendation cards to the canonical prompt. */

import {
  type InvestigationAlternativeCode,
  type InvestigationAnchor,
  type InvestigationMetric,
  type InvestigationMetricCode,
  type InvestigationPromptArtifact,
  type InvestigationUnknownCode,
  buildInvestigationPrompt,
} from "../../recommendations/investigation-prompt.js";
import type { RecommendationCard } from "./recommendations.js";

interface MetricSpec {
  key: string;
  code: InvestigationMetricCode;
  denominatorKey?: string;
  denominatorUnit?: "sessions" | "turns" | "tokens";
}

const METRICS: Record<string, MetricSpec[]> = {
  D1: [
    { key: "source_tokens", code: "SOURCE_TOKENS" },
    { key: "source_target", code: "SOURCE_TARGET_TOKENS" },
    { key: "delta_context_tokens", code: "CONTEXT_REDUCTION_TOKENS" },
  ],
  D2: [
    { key: "qualifying_session_count", code: "QUALIFYING_SESSIONS" },
    {
      key: "raw_context_average_tokens_per_turn",
      code: "CONTEXT_TOKENS_PER_TURN",
      denominatorKey: "qualifying_session_count",
      denominatorUnit: "sessions",
    },
    { key: "cap_weighted_burn_tokens_per_week", code: "CAP_WEIGHTED_TOKENS_PER_WEEK" },
    { key: "cache_read_tokens_per_week", code: "CACHE_READ_TOKENS_PER_WEEK" },
    { key: "cache_read_exposure_spend_u_per_week", code: "CACHE_READ_EXPOSURE_PER_WEEK" },
  ],
  D4: [
    { key: "mismatch_turns_per_week", code: "MISMATCH_TURNS_PER_WEEK" },
    { key: "total_opus_turns_per_week", code: "OPUS_TURNS_PER_WEEK" },
    {
      key: "mismatch_fraction",
      code: "MISMATCH_FRACTION",
      denominatorKey: "total_opus_turns_per_week",
      denominatorUnit: "turns",
    },
  ],
  D6: [
    { key: "tool_result_bytes", code: "TOOL_RESULT_BYTES" },
    {
      key: "bloat_share",
      code: "BLOAT_FRACTION",
      denominatorKey: "session_cap_weighted_tokens",
      denominatorUnit: "tokens",
    },
    { key: "session_cap_weighted_tokens", code: "SESSION_CAP_WEIGHTED_TOKENS" },
  ],
  D8: [
    { key: "churn_event_count", code: "CHURN_EVENTS" },
    { key: "total_churn_creation_tokens", code: "CHURN_CREATION_TOKENS" },
    { key: "session_cap_weighted_tokens", code: "SESSION_CAP_WEIGHTED_TOKENS" },
  ],
  D10: [
    { key: "catalog_tokens", code: "CATALOG_TOKENS" },
    { key: "catalog_target_tokens", code: "CATALOG_TARGET_TOKENS" },
    { key: "delta_context_tokens", code: "CONTEXT_REDUCTION_TOKENS" },
    { key: "source_count", code: "SOURCE_COUNT" },
    { key: "turns_per_week", code: "TURNS_PER_WEEK" },
  ],
};

const ALTERNATIVES: Record<string, InvestigationAlternativeCode[]> = {
  D1: ["REDUCE_ALWAYS_LOADED_CONTEXT", "ADD_TASK_BOUNDARIES"],
  D2: ["ADD_TASK_BOUNDARIES", "REDUCE_ALWAYS_LOADED_CONTEXT"],
  D4: ["VERIFY_MODEL_CAP", "MANUAL_READ_ONLY_REVIEW"],
  D6: ["NARROW_TOOL_RESULTS", "MANUAL_READ_ONLY_REVIEW"],
  D8: ["BATCH_PREFIX_EDITS", "ADD_TASK_BOUNDARIES"],
  D10: ["LAZY_LOAD_TOOL_CATALOGS", "MANUAL_READ_ONLY_REVIEW"],
};

function finiteEvidenceNumber(rec: RecommendationCard, key: string): number | null {
  const value = rec.evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceStrings(rec: RecommendationCard, singular: string, plural: string): string[] {
  const values: string[] = [];
  const one = rec.evidence[singular];
  const many = rec.evidence[plural];
  if (typeof one === "string") values.push(one);
  if (Array.isArray(many)) {
    values.push(...many.filter((value): value is string => typeof value === "string"));
  }
  return values;
}

function evidenceWindow(rec: RecommendationCard): { from: string; to: string } | null {
  const from = rec.evidence.window_from ?? rec.evidence.value_window_from;
  const to = rec.evidence.window_to ?? rec.evidence.value_window_to;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

function evidenceIsStale(rec: RecommendationCard): boolean {
  const freshness = rec.evidence.evidence_freshness;
  return rec.evidence.evidence_stale === true || freshness === "STALE" || freshness === "EXPIRED";
}

function metricsFor(rec: RecommendationCard): InvestigationMetric[] {
  const metrics: InvestigationMetric[] = [];
  for (const spec of METRICS[rec.detector_id] ?? []) {
    const value = finiteEvidenceNumber(rec, spec.key);
    if (value === null) continue;
    const denominatorValue =
      spec.denominatorKey === undefined ? null : finiteEvidenceNumber(rec, spec.denominatorKey);
    metrics.push({
      code: spec.code,
      value,
      ...(denominatorValue !== null && spec.denominatorUnit !== undefined
        ? { denominator: { value: denominatorValue, unit: spec.denominatorUnit } }
        : {}),
    });
  }
  if (rec.modeled_savings_u_per_wk !== null && Number.isFinite(rec.modeled_savings_u_per_wk)) {
    metrics.push({ code: "MODELED_SAVINGS", value: rec.modeled_savings_u_per_wk });
  }
  return metrics;
}

function anchorsFor(rec: RecommendationCard): InvestigationAnchor[] {
  return [
    ...evidenceStrings(rec, "finding_id", "finding_ids").map(
      (id): InvestigationAnchor => ({ kind: "FINDING", id }),
    ),
    ...evidenceStrings(rec, "session_id", "session_ids").map(
      (id): InvestigationAnchor => ({ kind: "SESSION", id }),
    ),
  ];
}

/** Build the sole prompt artifact used by server and dashboard. */
export function buildRecommendationInvestigationPrompt(
  rec: RecommendationCard,
): InvestigationPromptArtifact {
  const specs = METRICS[rec.detector_id];
  const metrics = metricsFor(rec);
  const anchors = anchorsFor(rec);
  const supported = specs !== undefined;
  const unknowns: InvestigationUnknownCode[] = [];
  if (!supported) unknowns.push("AUTOMATIC_HANDLER");
  if (supported && specs.some((spec) => finiteEvidenceNumber(rec, spec.key) === null)) {
    unknowns.push("REQUIRED_AGGREGATES");
  }
  if (evidenceIsStale(rec)) unknowns.push("STALE_MEASUREMENT");
  if (rec.detector_id === "D4") unknowns.push("BINDING_USAGE_CAP");

  return buildInvestigationPrompt({
    scope: rec.scope_workspace_id === null ? "GLOBAL" : "WORKSPACE",
    window: evidenceWindow(rec),
    recommendationId: rec.rec_id,
    detectorIds: [rec.detector_id],
    findingIds: evidenceStrings(rec, "finding_id", "finding_ids"),
    reasonCode: supported ? "REVIEW_REQUIRED" : "HANDLER_UNAVAILABLE",
    flavor:
      rec.detector_id === "D1" || rec.detector_id === "D4" || rec.detector_id === "D10"
        ? "TURNKEY"
        : "GUIDED",
    metrics,
    anchors,
    alternatives: ALTERNATIVES[rec.detector_id] ?? ["MANUAL_READ_ONLY_REVIEW"],
    unknowns,
  });
}

export function buildSeededPrompt(rec: RecommendationCard): string {
  return buildRecommendationInvestigationPrompt(rec).text;
}
