/**
 * src/detector/savings.ts — modeled_formula_json builders + µUSD helpers.
 *
 * Units: prices are $/MTok, which is numerically µUSD/token (matches
 * ingest/pricing.ts). A token×price sum is therefore already in µUSD.
 */

import type { ModeledFormula } from "./types.js";

/** Config knobs (defaults; §1). Unvalidated where noted. */
export const D1_TARGET_ALWAYS_LOADED_TOKENS = 40_000;
export const D2_REDUCTION_FRACTION = 0.33; // UNVALIDATED assumption-default (§1 D2 (c) / Review F1)
export const D2_MIN_QUALIFYING_SESSIONS = 3;
export const D2_TURN_COUNT_THRESHOLD = 150;
export const D2_AVG_CONTEXT_THRESHOLD = 180_000;
export const D1_ALWAYS_LOADED_OVERSIZE_TOKENS = 40_000;
export const D1_ALWAYS_LOADED_OVERSIZE_FRACTION = 0.25;

/**
 * Per-source token targets (UNVALIDATED defaults — labeled as such in every rec).
 * Surfaced as visible formula inputs (mirrors D2's reduction_fraction treatment).
 *
 * | component   | target  | rationale                                              |
 * |-------------|---------|--------------------------------------------------------|
 * | CLAUDE_MD   | 2,000   | keep current-state + pointers; move changelog/history  |
 * | MEMORY      | 1,000   | keep active facts; prune stale/duplicate memories      |
 * | MCP_SCHEMAS | 3,000   | keep actively-used skills; disable rarely-used plugins |
 */
export const D1_SOURCE_TARGETS: Record<string, number> = {
  CLAUDE_MD: 2_000,
  MEMORY: 1_000,
  MCP_SCHEMAS: 3_000,
};

/** Round a micro-USD figure to an integer (INTEGER column). */
export function roundU(u: number): number {
  return Math.round(u);
}

/**
 * D1 always-loaded-trim savings.
 * Δcontext_tokens × turns_per_week / 1e6 × cache_read_price_usd_per_mtok (USD/wk),
 * returned as integer µUSD/wk.
 */
export function d1Savings(
  deltaContextTokens: number,
  turnsPerWeek: number,
  cacheReadPriceUsdPerMtok: number,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(deltaContextTokens * turnsPerWeek * cacheReadPriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "D1_ALWAYS_LOADED_TRIM_V1",
    inputs: {
      delta_context_tokens: deltaContextTokens,
      turns_per_week: turnsPerWeek,
      cache_read_price_usd_per_mtok: cacheReadPriceUsdPerMtok,
    },
    expression: "delta_context_tokens * turns_per_week / 1e6 * cache_read_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/**
 * D2 long-context cache-read savings.
 * cache_read_tokens_per_week / 1e6 × blended_cache_read_price × reduction_fraction (USD/wk),
 * returned as integer µUSD/wk. The blended price is derived per-model from the
 * turns' own pricing snapshots (§1 D2 (b)); reduction_fraction is surfaced as a
 * visible, labeled input (§1 D2 (c) / Review F1).
 */
export function d2Savings(
  cacheReadTokensPerWeek: number,
  cacheReadSpendUPerWeek: number,
  reductionFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const blendedPrice =
    cacheReadTokensPerWeek > 0 ? cacheReadSpendUPerWeek / cacheReadTokensPerWeek : 0;
  const savingsU = roundU(cacheReadSpendUPerWeek * reductionFraction);
  const formula: ModeledFormula = {
    model: "D2_LONG_CONTEXT_CACHE_READ_V1",
    inputs: {
      cache_read_tokens_per_week: cacheReadTokensPerWeek,
      cache_read_price_usd_per_mtok: Number(blendedPrice.toFixed(6)),
      reduction_fraction: reductionFraction,
    },
    expression:
      "cache_read_tokens_per_week / 1e6 * cache_read_price_usd_per_mtok * reduction_fraction",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/** D5 warning-class formula (no savings model). */
export function d5Formula(): ModeledFormula {
  return { model: "none", inputs: {}, kind: "WARNING" };
}

// ── D4 MODEL_MISMATCH config ──────────────────────────────────────────────────

/**
 * Minimum Opus turns in the trailing window before D4 evaluates.
 * Prevents false positives from sparse/cold data.
 */
export const D4_OPUS_MIN_TURNS = 5;

/**
 * Fraction of Opus turns that must match the "high-context, low-output" pattern
 * before a rec fires. 40% means the pattern is sustained, not incidental.
 * CONSERVATIVE: some Opus use is legitimately complex even when output is brief.
 */
export const D4_MISMATCH_MIN_FRACTION = 0.4;

/**
 * Minimum context_tokens (input + cache_read + cache_write) on a qualifying Opus
 * turn. 50 K is well below Opus-4-8's 155 K observed average but excludes trivially
 * small turns. UNVALIDATED default — labeled in every rec.
 */
export const D4_MISMATCH_MIN_CONTEXT_TOKENS = 50_000;

/**
 * Maximum output_tokens on a qualifying Opus turn. ≤500 tokens is "lookup-style"
 * output — suggests the Opus model produced a short answer from a large context.
 * UNVALIDATED default — labeled in every rec.
 */
export const D4_MISMATCH_MAX_OUTPUT_TOKENS = 500;

/**
 * Fraction of flagged mismatch turns assumed movable to Sonnet.
 * 0.5 is deliberately conservative — the high-context-low-output filter already
 * narrows to likely-transferable turns, but some may carry genuine reasoning needs
 * not visible from token counts alone.
 * UNVALIDATED — surfaced as a visible, labeled formula input.
 */
export const D4_REDUCTION_FRACTION = 0.5;

/**
 * D4 model-mismatch savings.
 *
 * Models the per-turn cost differential between Opus and Sonnet for qualifying
 * "high context, low output" turns, then scales by mismatch_turns_per_week and
 * the conservative reduction_fraction.
 *
 * Formula:
 *   per_turn_savings_u =
 *     avg_input_tokens  × (opus_input_price  − sonnet_input_price)
 *   + avg_output_tokens × (opus_output_price − sonnet_output_price)
 *   savings_u_per_wk = per_turn_savings_u × mismatch_turns_per_week × reduction_fraction
 *
 * All prices are $/MTok = µUSD/token (matches pricing.ts conventions).
 * reduction_fraction is UNVALIDATED; surfaced as a labeled input (mirrors D2 treatment).
 */
export function d4Savings(
  avgInputTokens: number,
  avgOutputTokens: number,
  mismatchTurnsPerWeek: number,
  opusInputPriceUsdPerMtok: number,
  opusOutputPriceUsdPerMtok: number,
  sonnetInputPriceUsdPerMtok: number,
  sonnetOutputPriceUsdPerMtok: number,
  reductionFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const perTurnSavingsU =
    avgInputTokens * (opusInputPriceUsdPerMtok - sonnetInputPriceUsdPerMtok) +
    avgOutputTokens * (opusOutputPriceUsdPerMtok - sonnetOutputPriceUsdPerMtok);
  const savingsU = roundU(perTurnSavingsU * mismatchTurnsPerWeek * reductionFraction);
  const formula: ModeledFormula = {
    model: "D4_MODEL_MISMATCH_V1",
    inputs: {
      avg_input_tokens: avgInputTokens,
      avg_output_tokens: avgOutputTokens,
      mismatch_turns_per_week: mismatchTurnsPerWeek,
      opus_input_price_usd_per_mtok: opusInputPriceUsdPerMtok,
      opus_output_price_usd_per_mtok: opusOutputPriceUsdPerMtok,
      sonnet_input_price_usd_per_mtok: sonnetInputPriceUsdPerMtok,
      sonnet_output_price_usd_per_mtok: sonnetOutputPriceUsdPerMtok,
      reduction_fraction: reductionFraction,
    },
    expression:
      "(avg_input_tokens * (opus_input_price - sonnet_input_price) + avg_output_tokens * (opus_output_price - sonnet_output_price)) * mismatch_turns_per_week * reduction_fraction",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── D8 CACHE_WRITE_CHURN config (flagship; all UNVALIDATED defaults) ───────────

/** Cache-creation spike floor on a resume turn (cw5m + cw1h + cw_other). */
export const D8_CREATION_SPIKE_TOKENS = 50_000;
/** Idle-gap threshold (minutes) when the 5m tier dominates the creation. */
export const D8_TTL_5M_GAP_MIN = 5;
/** Idle-gap threshold (minutes) when the 1h tier dominates the creation. */
export const D8_TTL_1H_GAP_MIN = 60;
/** A resume turn is a full re-write (not a warm read) when cache_read < ratio × creation. */
export const D8_LOW_READ_RATIO = 0.2;
/** Fire the scope rec at ≥ this many churn events per week. */
export const D8_MIN_EVENTS = 3;
/** …OR when churn-event creation tokens are ≥ this share of the scope's cap-weighted total. */
export const D8_CREATION_SHARE = 0.15;
/** Fraction of churn creation assumed avoidable (some resumes are unavoidable). */
export const D8_AVOIDANCE_FRACTION = 0.7;
/** Annotate regime=5m when this share (or more) of creation is 5m-tier. */
export const D8_REGIME_5M_SHARE = 0.8;

/**
 * D8 cache-write-churn savings (cap-weighted; never a raw-token headline).
 * avoidable_cap_tokens/wk = total_churn_creation_tokens × avoidance_fraction,
 * translated to µUSD/wk via the (blended) cache-write price.
 */
export function d8Savings(
  totalChurnCreationTokens: number,
  blendedWritePriceUsdPerMtok: number,
  avoidanceFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableCapTokens = totalChurnCreationTokens * avoidanceFraction;
  const savingsU = roundU(avoidableCapTokens * blendedWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "D8_CACHE_WRITE_CHURN_V1",
    inputs: {
      total_churn_creation_tokens: totalChurnCreationTokens,
      avoidance_fraction: avoidanceFraction,
      cache_write_price_usd_per_mtok: Number(blendedWritePriceUsdPerMtok.toFixed(6)),
      avoidable_cap_tokens_per_wk: Math.round(avoidableCapTokens),
    },
    expression:
      "total_churn_creation_tokens * avoidance_fraction / 1e6 * cache_write_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── D6 TOOL_RESULT_BLOAT config (turn/session grain; all UNVALIDATED defaults) ─

/** Fire only when ≥ this many sessions/wk meet the per-session bloat criteria. */
export const D6_MIN_SESSIONS = 3;
/** tool_result_bytes must be ≥ this share of the session's cap-weighted total. */
export const D6_BLOAT_SHARE = 0.3;
/** …AND exceed this absolute floor, so tiny sessions never fire (200 KB). */
export const D6_ABS_FLOOR_BYTES = 200 * 1024;
/**
 * Fraction of carry exposure assumed avoidable (UNVALIDATED — some carry is
 * unavoidable because the tool result must be in context at least once).
 * Surfaced as a labeled input in every rec.
 */
export const D6_AVOIDANCE_FRACTION = 0.5;

/**
 * D6 tool-result-bloat savings (gated on calibration — only emitted when a
 * calibrated bytes_per_token is present; otherwise modeled_savings stays null).
 *
 * carry_exposure_tokens × avoidance_fraction = avoidable carry tokens/wk.
 * avoidable × blended_cache_read_price = µUSD/wk saved by trimming bloat.
 *
 * The blended cache-read price is derived from the session's own pricing
 * snapshots (same approach as D8's write price), never a global average.
 */
export function d6Savings(
  carryExposureTokensDirectional: number,
  avoidanceFraction: number,
  cacheReadPriceUsdPerMtok: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableTokens = carryExposureTokensDirectional * avoidanceFraction;
  const savingsU = roundU(avoidableTokens * cacheReadPriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "D6_TOOL_RESULT_BLOAT_V1",
    inputs: {
      carry_exposure_tokens_directional: Math.round(carryExposureTokensDirectional),
      avoidance_fraction: avoidanceFraction,
      cache_read_price_usd_per_mtok: Number(cacheReadPriceUsdPerMtok.toFixed(6)),
      avoidable_carry_tokens: Math.round(avoidableTokens),
    },
    expression:
      "carry_exposure_tokens_directional * avoidance_fraction / 1e6 * cache_read_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── D9 IDLE_BACKGROUND_SESSION config (directional; all UNVALIDATED defaults) ──

/** Sidechain turns must contribute ≥ this share of the scope's cap-weighted tokens. */
export const D9_SIDECHAIN_SHARE = 0.25;
/** …AND absolute sidechain cap-weighted tokens must be ≥ this floor (per wk). */
export const D9_SIDECHAIN_ABS_CAP_TOKENS = 100_000;
/** Fraction of sidechain volume assumed unproductive (directional — fan-out is often justified). */
export const D9_UNPRODUCTIVE_FRACTION = 0.5;

/**
 * D9 idle/background savings — DIRECTIONAL, cap-weighted, no crisp $ headline
 * (research B: fan-out is a real quality/throughput tradeoff, not pure waste).
 * The surfaced modeled_savings_u_per_wk is NULL; this formula records the
 * directional cap-weighted estimate as a labeled input only.
 */
export function d9Formula(
  sidechainCapWeightedTokens: number,
  unproductiveFraction: number,
): ModeledFormula {
  return {
    model: "D9_IDLE_BACKGROUND_SESSION_V1",
    kind: "DIRECTIONAL",
    inputs: {
      sidechain_cap_weighted_tokens: Math.round(sidechainCapWeightedTokens),
      unproductive_fraction: unproductiveFraction,
      directional_avoidable_cap_tokens: Math.round(
        sidechainCapWeightedTokens * unproductiveFraction,
      ),
    },
    expression:
      "sidechain_cap_weighted_tokens * unproductive_fraction (directional; no $ headline)",
  };
}
