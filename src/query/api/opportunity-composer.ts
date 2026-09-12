/**
 * RIQ2 opportunity composer — pure function over EvidencePacket facts.
 * No DB handle; no provider/API calls; no DB writes; no new SQL.
 * SEC-101: no raw tool names, no raw content, no savings/benefit estimates.
 */

import type { EvidencePacket, MeasuredFact } from "./evidence-packet-types.js";
import {
  COMPOSER_VERSION,
  type CacheBehaviorDetail,
  type CacheMissCause,
  DECOMPOSITION_VERSION,
  type FamilyEntry,
  type InsufficientEvidenceEntry,
  type OpportunityComposition,
  type ToolConcentrationCandidate,
  type ToolConcentrationDetail,
  type UsageChangeDecomposition,
  type UsageChangeDetail,
} from "./opportunity-composer-types.js";

// ---------------------------------------------------------------------------
// Named threshold — versioned so future calibration carries a stable label.
// ---------------------------------------------------------------------------

const BYTE_CONCENTRATION_THRESHOLD_VERSION = "riq2-byte-conc-v1";
/** A single tool_id accounting for this share or more of total bytes triggers a candidate. */
const BYTE_CONCENTRATION_THRESHOLD = 0.5;
const FAILURE_COUNT_THRESHOLD_VERSION = "riq2-fail-count-v1";
/** Minimum failures to surface as a concentration candidate. */
const FAILURE_COUNT_THRESHOLD = 2;
const CACHE_HIT_HEALTHY_THRESHOLD_VERSION = "riq2-cache-hit-v1";
/** Cache-read share of bucketed tokens at or above this reads as efficient reuse. */
const CACHE_HIT_HEALTHY_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMeasured<T>(fact: { state?: string } | MeasuredFact<T>): fact is MeasuredFact<T> {
  return !("state" in fact);
}

// ---------------------------------------------------------------------------
// Family 1 — Explain a usage change
// ---------------------------------------------------------------------------

function composeUsageChange(packet: EvidencePacket): FamilyEntry {
  const { comparison, current_list_price_equivalent_u, prior_list_price_equivalent_u, model_mix } =
    packet.facts;

  // Require a compatible prior window.
  if (!isMeasured(comparison)) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "EXPLAIN_USAGE_CHANGE",
      unavailable_reason:
        "state" in comparison
          ? ((comparison as { state: string; reason?: string }).reason ?? "UNSUPPORTED")
          : "UNSUPPORTED",
    } satisfies InsufficientEvidenceEntry;
  }

  // Require measured cost facts on both windows.
  if (!isMeasured(current_list_price_equivalent_u) || !isMeasured(prior_list_price_equivalent_u)) {
    const reason = !isMeasured(current_list_price_equivalent_u)
      ? (current_list_price_equivalent_u as { reason: string }).reason
      : (prior_list_price_equivalent_u as { reason: string }).reason;
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "EXPLAIN_USAGE_CHANGE",
      unavailable_reason: reason ?? "NO_ELIGIBLE_DATA",
    } satisfies InsufficientEvidenceEntry;
  }

  const { direction, delta } = comparison.value;

  if (direction === "UNCHANGED") {
    return {
      outcome: "NO_CHANGE",
      family: "EXPLAIN_USAGE_CHANGE",
      reason:
        "Current and prior period list-price equivalent spend are equal; no change to explain.",
    };
  }

  // Additive decomposition.
  const n_cur = current_list_price_equivalent_u.denominator;
  const n_prior = prior_list_price_equivalent_u.denominator;

  // Guard against zero denominators (should not occur for measured facts, but be explicit).
  if (n_cur === 0 || n_prior === 0) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "EXPLAIN_USAGE_CHANGE",
      unavailable_reason: "NO_ELIGIBLE_DATA",
    } satisfies InsufficientEvidenceEntry;
  }

  const total_cur = current_list_price_equivalent_u.value;
  const total_prior = prior_list_price_equivalent_u.value;
  const mean_cur_u = total_cur / n_cur;
  const mean_prior_u = total_prior / n_prior;

  const volume_term = (n_cur - n_prior) * mean_prior_u;
  const intensity_term = n_cur * (mean_cur_u - mean_prior_u);
  const UNATTRIBUTED_RESIDUAL = delta - volume_term - intensity_term;

  // Qualitative model-mix note — from current window only.
  let model_mix_note: string;
  if (isMeasured(model_mix) && model_mix.value.length > 0) {
    // .reduce without initial value is safe: we've confirmed model_mix.value.length > 0 above.
    const topModel = model_mix.value.reduce((best, row) =>
      row.turn_count > best.turn_count ? row : best,
    );
    model_mix_note = `Current window: ${model_mix.value.length} model class(es) observed; dominant opaque id ${topModel.model_id} (${topModel.turn_count} turns). Cross-window model-mix alignment is impossible by packet design — per-model deltas cannot be separated without a compatible prior mix record.`;
  } else {
    model_mix_note =
      "Model mix is unavailable for the current window; per-model decomposition not possible.";
  }

  const decomposition: UsageChangeDecomposition = {
    decomposition_version: DECOMPOSITION_VERSION,
    volume_term,
    intensity_term,
    UNATTRIBUTED_RESIDUAL,
    observed_delta_u: delta,
    n_cur,
    n_prior,
    mean_cur_u,
    mean_prior_u,
    model_mix_note,
  };

  const detail: UsageChangeDetail = {
    kind: "USAGE_CHANGE",
    direction,
    decomposition,
  };

  const evidence_ids = [
    ...current_list_price_equivalent_u.evidence_ids,
    ...prior_list_price_equivalent_u.evidence_ids,
    ...comparison.evidence_ids,
  ].filter((id, i, arr) => arr.indexOf(id) === i);

  return {
    outcome: "OPPORTUNITY",
    family: "EXPLAIN_USAGE_CHANGE",
    evidence_ids,
    alternative_explanations: [
      "A natural shift in task mix (more or fewer large tasks) may account for the change without any resource-use change per comparable task.",
      "Model version updates between windows may alter per-turn token counts independently of operator behavior.",
      "Seasonal or project-phase variation in session volume may explain volume-term movement.",
    ],
    required_caveats: [
      "Task-normalised claims require eligible explicit ESF work records, which are not available in this packet.",
      "Cross-window model-mix alignment is impossible by packet design; per-model cost attribution is qualitative only.",
      "The decomposition uses list-price equivalents, not actual subscription spend.",
    ],
    next_step: {
      kind: "INVESTIGATION",
      description:
        "Inspect the sessions linked by the current and prior evidence IDs to determine whether volume change, intensity change, or both are driving the delta before taking any action.",
    },
    detail,
  };
}

// ---------------------------------------------------------------------------
// Family 2 — Tool-output + retry concentration
// ---------------------------------------------------------------------------

function composeToolConcentration(packet: EvidencePacket): FamilyEntry {
  const { tool_observations } = packet.facts;

  if (!isMeasured(tool_observations)) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "TOOL_OUTPUT_RETRY_CONCENTRATION",
      unavailable_reason:
        "reason" in tool_observations
          ? (tool_observations as { reason: string }).reason
          : "NO_ELIGIBLE_DATA",
    } satisfies InsufficientEvidenceEntry;
  }

  const tools = tool_observations.value;
  const total_result_bytes = tools.reduce((s, t) => s + t.result_bytes_total, 0);

  // Identify concentration candidates: any tool_id over the byte threshold OR with repeat failures.
  const candidates: ToolConcentrationCandidate[] = tools
    .filter((t) => {
      const byte_share = total_result_bytes > 0 ? t.result_bytes_total / total_result_bytes : 0;
      return (
        byte_share >= BYTE_CONCENTRATION_THRESHOLD ||
        t.failure_event_count >= FAILURE_COUNT_THRESHOLD
      );
    })
    .map((t) => ({
      tool_id: t.tool_id,
      tool_class: t.tool_class,
      result_bytes_total: t.result_bytes_total,
      byte_share: total_result_bytes > 0 ? t.result_bytes_total / total_result_bytes : 0,
      failure_event_count: t.failure_event_count,
      recovered_after_failure_count: t.recovered_after_failure_count,
    }));

  if (candidates.length === 0) {
    return {
      outcome: "HEALTHY",
      family: "TOOL_OUTPUT_RETRY_CONCENTRATION",
      reason: `No tool_id exceeds the byte-concentration threshold (${BYTE_CONCENTRATION_THRESHOLD_VERSION}) and no tool has ${FAILURE_COUNT_THRESHOLD}+ repeated failures (${FAILURE_COUNT_THRESHOLD_VERSION}) in this window.`,
    };
  }

  const detail: ToolConcentrationDetail = {
    kind: "TOOL_CONCENTRATION",
    candidates,
    total_result_bytes,
    concentration_threshold_version: BYTE_CONCENTRATION_THRESHOLD_VERSION,
  };

  return {
    outcome: "OPPORTUNITY",
    family: "TOOL_OUTPUT_RETRY_CONCENTRATION",
    evidence_ids: tool_observations.evidence_ids,
    alternative_explanations: [
      "A successful test-fix-retry loop is normal verification behavior and should be preserved, not reduced.",
      "Large result bytes may reflect legitimate large file reads required by the task, not inefficiency.",
      "Byte volume does not map directly to billable tokens; impact on model spend requires separate analysis.",
    ],
    required_caveats: [
      "Result bytes are not billable tokens; byte concentration does not directly imply model cost impact.",
      "Sequence proximity of failure and recovery events is not causal attribution — the failure may not cause the cost.",
      "Bounding tool output may break verification or repair workflows; preserve error/recovery guardrails.",
    ],
    next_step: {
      kind: "INVESTIGATION",
      description:
        "Investigate the concentrated tool_id's output prerequisites and failure-recovery pattern in a bounded trial before changing any tool configuration.",
    },
    detail,
  };
}

// ---------------------------------------------------------------------------
// Family 3 — Context / cache behaviour
// ---------------------------------------------------------------------------

function composeCacheBehavior(packet: EvidencePacket): FamilyEntry {
  const { raw_token_buckets, session_cost_distribution_u } = packet.facts;

  if (!isMeasured(raw_token_buckets)) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "CONTEXT_CACHE_BEHAVIOR",
      unavailable_reason:
        "reason" in raw_token_buckets
          ? (raw_token_buckets as { reason: string }).reason
          : "NO_ELIGIBLE_DATA",
    } satisfies InsufficientEvidenceEntry;
  }

  const buckets = raw_token_buckets.value;
  const cache_read_tokens: number = (buckets.cache_read_tokens as number | undefined) ?? 0;
  const cache_write_tokens: number =
    ((buckets.cache_write_5m as number | undefined) ?? 0) +
    ((buckets.cache_write_1h as number | undefined) ?? 0) +
    ((buckets.cache_write_other as number | undefined) ?? 0);
  const input_tokens: number = (buckets.input_tokens as number | undefined) ?? 0;

  const denom = cache_read_tokens + input_tokens;
  const cache_hit_ratio: number | null = denom > 0 ? cache_read_tokens / denom : null;

  // Determine miss_cause as best-effort from proxy signals only; unknown stays UNKNOWN.
  let miss_cause: CacheMissCause = "UNKNOWN";
  if (cache_hit_ratio !== null) {
    if (cache_write_tokens > 0 && cache_read_tokens === 0) {
      // Only writes, no reads — context is being written but not reused in this window.
      miss_cause = "WRITE_HEAVY";
    } else if (input_tokens > 0 && cache_read_tokens === 0 && cache_write_tokens === 0) {
      // No cache activity at all; could be short sessions or large non-cacheable inputs.
      miss_cause = "UNKNOWN";
    }
  }

  // Check for session depth proxy: if distribution is available, high spread may indicate
  // context depth variation, but this is proxy-only — do not prescribe /clear.
  const sessionDepthNote = isMeasured(session_cost_distribution_u)
    ? `Session cost distribution: min=${session_cost_distribution_u.value.min} median=${session_cost_distribution_u.value.median} max=${session_cost_distribution_u.value.max} (micro_usd_list_equiv).`
    : null;

  // HEALTHY case: meaningful cache hits present — large efficient cached context.
  if (cache_hit_ratio !== null && cache_hit_ratio >= CACHE_HIT_HEALTHY_THRESHOLD) {
    return {
      outcome: "HEALTHY",
      family: "CONTEXT_CACHE_BEHAVIOR",
      reason: `Cache hit ratio is ${(cache_hit_ratio * 100).toFixed(1)}% (at or above the healthy threshold, ${CACHE_HIT_HEALTHY_THRESHOLD_VERSION}) — indicates large, efficiently cached context. No change warranted.${sessionDepthNote ? ` ${sessionDepthNote}` : ""}`,
    };
  }

  // INSUFFICIENT_EVIDENCE: no token data to distinguish patterns.
  if (denom === 0 && cache_write_tokens === 0) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      family: "CONTEXT_CACHE_BEHAVIOR",
      unavailable_reason: "NO_ELIGIBLE_DATA",
    } satisfies InsufficientEvidenceEntry;
  }

  const detail: CacheBehaviorDetail = {
    kind: "CACHE_BEHAVIOR",
    cache_read_tokens,
    cache_write_tokens,
    input_tokens,
    cache_hit_ratio,
    miss_cause,
  };

  return {
    outcome: "OPPORTUNITY",
    family: "CONTEXT_CACHE_BEHAVIOR",
    evidence_ids: raw_token_buckets.evidence_ids,
    alternative_explanations: [
      "Short sessions naturally produce low cache hit ratios without any inefficiency — this is expected behavior.",
      "Compaction events may be legitimate task management rather than wasted context.",
      "Cache miss cause is UNKNOWN from packet signals alone; the actual cause may differ from proxy inference.",
    ],
    required_caveats: [
      "Cache miss cause stays UNKNOWN where the packet's bucket signals do not support a specific diagnosis.",
      "Do not prescribe /clear based on a cache gap alone — compaction may be legitimate and task continuity must be preserved.",
      "Cache ratio optimisation at the expense of task continuity is not warranted by this signal.",
    ],
    next_step: {
      kind: "INVESTIGATION",
      description:
        "Investigate whether session length or input patterns explain the low cache hit ratio before considering any context management change.",
    },
    detail,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose the first three RIQ2 opportunity families from a single EvidencePacket.
 * Pure function: identical input → deep-equal output. No DB, no API calls.
 */
export function composeOpportunities(packet: EvidencePacket): OpportunityComposition {
  const families: FamilyEntry[] = [
    composeUsageChange(packet),
    composeToolConcentration(packet),
    composeCacheBehavior(packet),
  ];

  return {
    composer_version: COMPOSER_VERSION,
    packet_identity_hash: packet.packet_identity_hash,
    scope: {
      workspace_id: packet.scope.workspace_id,
      current_window: packet.scope.current_window,
      prior_window: packet.scope.prior_window,
    },
    families,
  };
}
