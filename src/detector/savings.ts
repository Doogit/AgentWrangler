/**
 * src/detector/savings.ts — modeled_formula_json builders + µUSD helpers.
 *
 * Units: prices are $/MTok, which is numerically µUSD/token (matches
 * ingest/pricing.ts). A token×price sum is therefore already in µUSD.
 */

import type { ReclaimableCeuWeights } from "../ingest/pricing.js";
import type { ModeledFormula } from "./types.js";

export type Estimate = {
  basis: "P" | "E" | "O" | "R" | "X";
  rank_value_u_per_wk: number | null;
  summable: boolean;
  label: string;
};

/** A1's large-result line. Lives here (no node deps) so the card copy the UI bundles can use it. */
export const A1_RESULT_BYTES_THRESHOLD = 25 * 1024;
/** Default measured characters per token for estimator rows without calibration. */
export const ESTIMATOR_BYTES_PER_TOKEN = 2.7;
/** The carry exposure is bounded even when no structural boundary is observed. */
export const CARRY_TURN_CAP = 75;
/** Token-weighted sidechain 5-minute cache-write price. */
export const SIDECHAIN_WRITE_PRICE_USD_PER_MTOK = 4.44;
/** Realizable share of the all-component D4 model differential. */
export const D4_REALIZABLE_AVOIDANCE_FRACTION = 0.5;
/**
 * Why D4's 0.5 stays (RR U12, one developer's 6 weeks of sessions, 2026-10-12): lookup subagents
 * already on current Sonnet (n=289) took 1.47x the turns of Opus ones (n=173) and made more tool
 * errors and repeat reads. Realized share of the price gap: 20%, 95% interval -48% to 76%, from
 * only 2 workspaces. The interval contains 0.5, so it cannot replace it.
 */
export const D4_AVOIDANCE_BASIS =
  "Measured once on one developer's sessions, the share was 20% (95% interval -48% to 76%): Sonnet lookup subagents (289) took 1.5x the turns of Opus ones (173), in only 2 workspaces. That is too imprecise to replace the assumption.";
/** Upper-bound disruption proxy for rm-rf operations. */
export const H1_RM_RF_HARM_PROBABILITY = 0.05;
/** Upper-bound disruption proxy for git-reset-hard operations. */
export const H1_GIT_RESET_HARD_HARM_PROBABILITY = 0.25;

export interface CarryTurn {
  sessionId: string;
  compacted?: boolean;
  contextCollapsed?: boolean;
}

/**
 * Count later turns carrying an earlier result. A carry ends before the first
 * session change, verified compaction, or context collapse, and is capped.
 */
export function carryTurns(originSessionId: string, laterTurns: readonly CarryTurn[]): number {
  let count = 0;
  for (const turn of laterTurns) {
    if (
      turn.sessionId !== originSessionId ||
      turn.compacted === true ||
      turn.contextCollapsed === true ||
      count === CARRY_TURN_CAP
    ) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * $/MTok to carry one result token across `carry` later turns of its chain: the first later turn
 * writes it into the cache, each of the other `carry − 1` reads it back. No later turn, no cost.
 * Same model as the ledger's result claims (result-claims.ts).
 */
export function carryPriceUsdPerMtok(carry: number, writePrice: number, readPrice: number): number {
  return carry > 0 ? writePrice + readPrice * (carry - 1) : 0;
}

/** Provenance categories surfaced with every reclaimable-CEU estimate. */
export type CeuProvenanceLabel = "OFFICIAL" | "MEASURED" | "UNVERIFIED";

/**
 * Inputs whose provenance explains a CEU figure.
 *
 * Pricing weights are official only when a session matched a current pricing
 * snapshot. Reclaimable tokens are measured locally. N is measured only when
 * U7 found a structural compaction/end boundary.
 */
export interface CeuProvenance {
  weights: CeuProvenanceLabel;
  reclaimableTokens: CeuProvenanceLabel;
  downstreamTurns: CeuProvenanceLabel;
}

export interface CeuEstimate {
  ceu: number;
  multiplier: number;
  provenance: CeuProvenance;
}

export interface ReclaimableCeu {
  /** Always present: one cache write plus a single prevented re-read. */
  floor: CeuEstimate;
  /** Omitted when N lacks a verified structural boundary. */
  expected: CeuEstimate | null;
  /** Explicit range used by consumers instead of a bare point value. */
  band: { floorCeu: number; expectedCeu: number | null };
  deprioritized: boolean;
  formula: ModeledFormula;
}

/** Read recurrence overtakes the one-time cache write at roughly 12 turns. */
export const CEU_DEPRIORITIZE_BELOW_TURNS = 12;

export interface ReclaimableCeuOptions {
  nVerified?: boolean;
  writeTtl?: "5m" | "1h";
}

/** Config knobs (defaults; §1). Unvalidated where noted. */
export const D1_TARGET_ALWAYS_LOADED_TOKENS = 40_000;
export const D2_REDUCTION_FRACTION = 0.33; // UNVALIDATED assumption-default (§1 D2 (c) / Review F1)
export const D2_MIN_QUALIFYING_SESSIONS = 3;
export const D2_TURN_COUNT_THRESHOLD = 150;
export const D2_AVG_CONTEXT_THRESHOLD = 180_000;
/** One suggested split per this many model calls in a long session. ASSUMED (P3.1-T9 S6). */
export const D2_CALLS_PER_SPLIT = 150;
/** Size of the short summary a split carries over. ASSUMED (P3.1-T9 S6). */
export const D2_SUMMARY_TOKENS = 2_000;
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

function roundCeu(ceu: number): number {
  return Number(ceu.toFixed(6));
}

/**
 * Model reclaimable cache exposure for a measured token span.
 *
 * M(N) = w_write + w_read × N. The conservative floor uses one re-read,
 * keeping it useful when the compaction boundary needed to measure N is absent.
 */
export function reclaimableCeu(
  reclaimableTokens: number,
  downstreamTurns: number | null,
  weights: ReclaimableCeuWeights,
  options: ReclaimableCeuOptions = {},
): ReclaimableCeu {
  const nVerified = options.nVerified ?? downstreamTurns !== null;
  const safeTokens = Math.max(0, reclaimableTokens);
  const writeTtl = options.writeTtl ?? "5m";
  const writeWeight = writeTtl === "1h" ? weights.wWrite1h : weights.wWrite5m;
  const floorMultiplier = writeWeight + weights.wRead;
  const provenance: CeuProvenance = {
    weights: weights.provenance,
    reclaimableTokens: "MEASURED",
    downstreamTurns: nVerified ? "MEASURED" : "UNVERIFIED",
  };
  const floor: CeuEstimate = {
    ceu: roundCeu(safeTokens * floorMultiplier),
    multiplier: floorMultiplier,
    provenance,
  };
  const canEmitExpected = nVerified && downstreamTurns !== null && downstreamTurns >= 0;
  const expectedMultiplier = canEmitExpected ? writeWeight + weights.wRead * downstreamTurns : null;
  const expected =
    expectedMultiplier === null
      ? null
      : {
          ceu: roundCeu(safeTokens * expectedMultiplier),
          multiplier: expectedMultiplier,
          provenance,
        };
  const deprioritized =
    !nVerified || downstreamTurns === null || downstreamTurns < CEU_DEPRIORITIZE_BELOW_TURNS;
  const formulaInputs: Record<string, number> = {
    reclaimable_tokens: safeTokens,
    conservative_floor_reads: 1,
    w_read: weights.wRead,
    w_write: writeWeight,
    w_write_5m: weights.wWrite5m,
    w_write_1h: weights.wWrite1h,
    write_ttl_minutes: writeTtl === "1h" ? 60 : 5,
    conservative_floor_ceu: floor.ceu,
  };
  if (expected !== null && downstreamTurns !== null) {
    formulaInputs.downstream_turns = downstreamTurns;
    formulaInputs.expected_ceu = expected.ceu;
  }
  const formula: ModeledFormula = {
    model: "RECLAIMABLE_CEU_MN_V1",
    inputs: formulaInputs,
    expression:
      expected === null
        ? "conservative_floor_ceu = reclaimable_tokens * (w_write + w_read * conservative_floor_reads)"
        : "conservative_floor_ceu = reclaimable_tokens * (w_write + w_read * conservative_floor_reads); expected_ceu = reclaimable_tokens * (w_write + w_read * downstream_turns)",
    kind: expected === null ? "CEU_FLOOR_ONLY" : "CEU_BANDED",
  };

  return {
    floor,
    expected,
    band: { floorCeu: floor.ceu, expectedCeu: expected?.ceu ?? null },
    deprioritized,
    formula,
  };
}

/**
 * D1 always-loaded-trim savings.
 * Δcontext_tokens × turns_per_week / 1e6 × cache_read_price_usd_per_mtok (USD/wk),
 * returned as integer µUSD/wk.
 */
/**
 * Fraction of the D1/D10 always-loaded / catalog delta assumed reducible.
 * Added 2026-09-22 (operator overlap ruling): D1/D10 previously projected the full
 * delta at 100%, modeling more optimistically than every peer (B/C5/D6/D7 discount
 * by 0.5). 0.5 brings them into parity — some always-loaded context is genuinely
 * needed and won't be trimmed. UNVALIDATED default, surfaced as a labeled input.
 */
export const D1_D10_AVOIDANCE_FRACTION = 0.5;

/**
 * D1 only (RR U12; D10 keeps D1_D10_AVOIDANCE_FRACTION). A trim to the target would remove up to
 * all of the delta (range [0.5, 1]), but no trim is observed (0 of 10 probes) and moved text may
 * still be read on demand, so the point stays at the 0.5 assumption.
 */
export const D1_TRIM_TO_TARGET_FRACTION = 0.5;
export const D1_AVOIDANCE_BASIS =
  "A trim to the target would remove up to 100% of the excess, but no trim has been observed yet (0 of 10 probes) and moved text may still be read on demand, so 50% is assumed.";

export function d1Savings(
  deltaContextTokens: number,
  turnsPerWeek: number,
  cacheReadPriceUsdPerMtok: number,
  avoidanceFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(
    deltaContextTokens * avoidanceFraction * turnsPerWeek * cacheReadPriceUsdPerMtok,
  );
  const formula: ModeledFormula = {
    model: "D1_ALWAYS_LOADED_TRIM_V1",
    inputs: {
      delta_context_tokens: deltaContextTokens,
      avoidance_fraction: avoidanceFraction,
      turns_per_week: turnsPerWeek,
      cache_read_price_usd_per_mtok: cacheReadPriceUsdPerMtok,
    },
    expression:
      "delta_context_tokens * avoidance_fraction * turns_per_week / 1e6 * cache_read_price_usd_per_mtok",
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
 *
 * Netted (P3.1-T9 S6): each suggested split writes a base prompt plus a summary again, so
 * rebuild_u (µUSD/wk) is subtracted. The result never goes below zero.
 */
export function d2Savings(
  cacheReadTokensPerWeek: number,
  cacheReadSpendUPerWeek: number,
  reductionFraction: number,
  rebuildU = 0,
): { savingsU: number; grossU: number; formula: ModeledFormula } {
  const blendedPrice =
    cacheReadTokensPerWeek > 0 ? cacheReadSpendUPerWeek / cacheReadTokensPerWeek : 0;
  const grossU = roundU(cacheReadSpendUPerWeek * reductionFraction);
  const savingsU = Math.max(0, grossU - roundU(rebuildU));
  const formula: ModeledFormula = {
    model: "D2_LONG_CONTEXT_CACHE_READ_V1",
    inputs: {
      cache_read_tokens_per_week: cacheReadTokensPerWeek,
      cache_read_price_usd_per_mtok: Number(blendedPrice.toFixed(6)),
      reduction_fraction: reductionFraction,
      rebuild_usd_per_wk: Number((roundU(rebuildU) / 1e6).toFixed(2)),
    },
    expression:
      "cache_read_tokens_per_week / 1e6 * cache_read_price_usd_per_mtok * reduction_fraction - rebuild_usd_per_wk",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, grossU, formula };
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
/** Share of a subagent's turns that must be lookup-shaped (large context, short output). */
export const D4_LOOKUP_TURN_SHARE = 0.8;

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
/** A churn event's (write − read) cost is at least this % of its workspace's 7-day spend. */
export const D8_EVENT_FLOOR_PCT = 0.1;
/** …OR when churn-event creation tokens are ≥ this share of the scope's cap-weighted total. */
export const D8_CREATION_SHARE = 0.15;
/**
 * Fraction of churn creation assumed avoidable (some resumes are unavoidable).
 * ASSUMED, not measured. RQ4 (2026-09-25) measured an upper bound of 0.64–0.65 for the
 * fresh-start lever on main-thread idle events; operator set 0.64, at the measured
 * ceiling, on 2026-09-28 (P3.2-F4a).
 */
export const D8_AVOIDANCE_FRACTION = 0.64;
/** Annotate regime=5m when this share (or more) of creation is 5m-tier. */
export const D8_REGIME_5M_SHARE = 0.8;

/**
 * D8 cache-write-churn savings (cap-weighted; never a raw-token headline).
 * avoidable_cap_tokens/wk = total_churn_creation_tokens × avoidance_fraction,
 * translated to µUSD/wk via the (blended) net price: write − read, because a warm
 * cache would have read those tokens instead.
 */
export function d8Savings(
  totalChurnCreationTokens: number,
  blendedNetWritePriceUsdPerMtok: number,
  avoidanceFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableCapTokens = totalChurnCreationTokens * avoidanceFraction;
  const savingsU = roundU(avoidableCapTokens * blendedNetWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "D8_CACHE_WRITE_CHURN_V1",
    inputs: {
      total_churn_creation_tokens: totalChurnCreationTokens,
      avoidance_fraction: avoidanceFraction,
      net_write_price_usd_per_mtok: Number(blendedNetWritePriceUsdPerMtok.toFixed(6)),
      avoidable_cap_tokens_per_wk: Math.round(avoidableCapTokens),
    },
    expression:
      "total_churn_creation_tokens * avoidance_fraction / 1e6 * (write_price - read_price)",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── D6 TOOL_RESULT_BLOAT config (UNVALIDATED defaults) ───────────────────────

/** Fire only when ≥ this many sessions/wk carry D6-sized tool results (recurrence count). */
export const D6_MIN_SESSIONS = 3;
/**
 * Fraction of carry exposure assumed avoidable (UNVALIDATED — some carry is
 * unavoidable because the tool result must be in context at least once).
 * Surfaced as a labeled input in every rec.
 */
export const D6_AVOIDANCE_FRACTION = 0.5;

// ── B1/B2/B3/B4 cache family + C5 savings ─────────────────────────────────────

/**
 * Fraction of cache re-creation assumed avoidable for each cache-family detector.
 * UNVALIDATED defaults — surfaced as labeled formula inputs in every rec.
 * Deliberately 0.5 for all four (matches B4 wave; some cache re-creation is unavoidable).
 */
export const B1_AVOIDANCE_FRACTION = 0.5;
export const B3_AVOIDANCE_FRACTION = 0.5;
export const B4_AVOIDANCE_FRACTION = 0.5;

/**
 * B1 cache-read-collapse savings (unified write-price model).
 * avoidable_creation_tokens × avoidance_fraction × blended_write_price = µUSD/wk.
 * prior_reads / current_reads are surfaced as labeled formula inputs.
 */
export function b1Savings(
  avoidableCreationTokens: number,
  avoidanceFraction: number,
  blendedWritePriceUsdPerMtok: number,
  priorReads: number,
  currentReads: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableCapTokens = avoidableCreationTokens * avoidanceFraction;
  const savingsU = roundU(avoidableCapTokens * blendedWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "B1_CACHE_READ_COLLAPSE_SAVINGS_V1",
    inputs: {
      avoidable_creation_tokens: avoidableCreationTokens,
      avoidance_fraction: avoidanceFraction,
      blended_write_price_usd_per_mtok: Number(blendedWritePriceUsdPerMtok.toFixed(6)),
      avoidable_cap_tokens_per_wk: Math.round(avoidableCapTokens),
      prior_reads: priorReads,
      current_reads: currentReads,
    },
    expression:
      "avoidable_creation_tokens * avoidance_fraction / 1e6 * blended_write_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/**
 * B3 resume-cache-miss savings (unified write-price model).
 * avoidable_creation_tokens = creation(current) on the resume turn.
 */
export function b3Savings(
  avoidableCreationTokens: number,
  avoidanceFraction: number,
  blendedWritePriceUsdPerMtok: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableCapTokens = avoidableCreationTokens * avoidanceFraction;
  const savingsU = roundU(avoidableCapTokens * blendedWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "B3_RESUME_CACHE_MISS_SAVINGS_V1",
    inputs: {
      avoidable_creation_tokens: avoidableCreationTokens,
      avoidance_fraction: avoidanceFraction,
      blended_write_price_usd_per_mtok: Number(blendedWritePriceUsdPerMtok.toFixed(6)),
      avoidable_cap_tokens_per_wk: Math.round(avoidableCapTokens),
    },
    expression:
      "avoidable_creation_tokens * avoidance_fraction / 1e6 * blended_write_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── G11 / D7 / D10 savings (B2 sub-set 2) ────────────────────────────────────

/**
 * Avoidance fraction for G11 HIGH_SPEND_OBSERVED_FAILURE.
 * UNVALIDATED: some high-spend failures are unavoidable. 0.5 sits inside the
 * empirically-supported 0.40–0.55 band (operator-confirmed 2026-09-21).
 */
export const G11_AVOIDANCE_FRACTION = 0.5;

/**
 * Avoidance fraction for D7 LOOP_RETRY_WASTE loop rollup.
 * UNVALIDATED — labeled in every rec.
 */
export const D7_AVOIDANCE_FRACTION = 0.5;

/**
 * G11 high-spend-failure savings.
 * excess_tokens × avoidance_fraction × blended_cache_read_price = µUSD/wk.
 * Price basis: conservative floor — cache-read rate understates the true
 * blended rate for high-context work items.
 */
export function g11Savings(
  excessTokens: number,
  avoidanceFraction: number,
  blendedCacheReadPriceUsdPerMtok: number,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(excessTokens * avoidanceFraction * blendedCacheReadPriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "G11_HIGH_SPEND_FAILURE_SAVINGS_V1",
    inputs: {
      excess_tokens: excessTokens,
      avoidance_fraction: avoidanceFraction,
      blended_cache_read_price_usd_per_mtok: Number(blendedCacheReadPriceUsdPerMtok.toFixed(6)),
    },
    expression: "excess_tokens * avoidance_fraction / 1e6 * blended_cache_read_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/**
 * D7 loop-retry-waste savings (main D7|ws rollup), V2 (review 5 B1).
 * Σ stored `turns.cost_equiv_u` over the deduped repeat-excess turns (each priced by class at
 * ingest on its own model's snapshot) × avoidance_fraction = µUSD/wk. Unpriceable (NULL) turns
 * add 0. No second price path.
 */
export function d7LoopSavings(
  repeatExcessCostU: number,
  avoidanceFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(repeatExcessCostU * avoidanceFraction);
  const formula: ModeledFormula = {
    model: "D7_LOOP_RETRY_WASTE_SAVINGS_V2",
    inputs: {
      repeat_excess_cost_u: repeatExcessCostU,
      avoidance_fraction: avoidanceFraction,
    },
    expression: "repeat_excess_cost_u * avoidance_fraction",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/**
 * D10 catalog-footprint savings (global; mirrors d1Savings).
 * delta_context_tokens × avoidance_fraction × global_turns_per_week ×
 * blended_cache_read_price_global = µUSD/wk. The caller gates this to non-deferred
 * Tool-Search states (only upfront/alwaysLoad), since deferred/threshold loading
 * means the catalog delta is not in context every turn.
 */
export function d10Savings(
  deltaContextTokens: number,
  globalTurnsPerWeek: number,
  blendedCacheReadPriceUsdPerMtok: number,
  avoidanceFraction: number,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(
    deltaContextTokens * avoidanceFraction * globalTurnsPerWeek * blendedCacheReadPriceUsdPerMtok,
  );
  const formula: ModeledFormula = {
    model: "D10_CATALOG_FOOTPRINT_SAVINGS_V1",
    inputs: {
      delta_context_tokens: deltaContextTokens,
      avoidance_fraction: avoidanceFraction,
      global_turns_per_week: globalTurnsPerWeek,
      blended_cache_read_price_usd_per_mtok: Number(blendedCacheReadPriceUsdPerMtok.toFixed(6)),
    },
    expression:
      "delta_context_tokens * avoidance_fraction * global_turns_per_week / 1e6 * blended_cache_read_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── A1 / A2 / D12 one-time write savings (B4) ────────────────────────────────

/**
 * Fraction of avoidable A1 bytes assumed reducible.
 * UNVALIDATED default — surfaced as a labeled formula input in every rec.
 */
export const A1_AVOIDANCE_FRACTION = 0.5;

/**
 * Fraction of avoidable A2 bytes assumed reducible.
 * UNVALIDATED default — surfaced as a labeled formula input in every rec.
 */
export const A2_AVOIDANCE_FRACTION = 0.5;

/**
 * Fraction of avoidable D12 sidechain bytes assumed reducible.
 * UNVALIDATED default — surfaced as a labeled formula input in every rec.
 */
export const D12_AVOIDANCE_FRACTION = 0.5;

/**
 * Share of E1's excess pre-edit turn cost a "Start here" block is assumed to avoid.
 * UNVALIDATED (range 0.33–0.7) — surfaced as a labeled formula input in every rec.
 */
export const E1_AVOIDANCE_FRACTION = 0.5;
/**
 * Why E1's 0.5 stays (RR U12, one developer's 6 weeks, 426 editing sessions, 3 workspaces): only 3
 * sessions opened with a literal "Start here" block, too few to compare. The 92 sessions whose
 * first prompt pointed at a file (handoff/plan) had MORE pre-edit turns (19.2 vs 15.8 mean), a
 * confounded result (handoff sessions are bigger tasks), not evidence of a reduction.
 */
export const E1_AVOIDANCE_BASIS =
  'Not measured: of 426 editing sessions sampled from one developer, only 3 opened with a "Start here" block, too few to compare, and the 92 that opened with a pointer to a file did not start editing sooner (19.2 vs 15.8 turns on average, though those are bigger tasks).';

/**
 * Share of E2's modeled subagent saving assumed realized: not every run is known to be mechanical
 * before it starts. UNVALIDATED (range 0.33–0.7) — surfaced as a labeled formula input.
 */
export const E2_AVOIDANCE_FRACTION = 0.5;

/**
 * A1 one-time write savings (B4 model).
 *
 * avoidable_bytes / bytes_per_token × avoidance_fraction × blended_write_price = µUSD/wk.
 * The blended write price is derived at workspace grain.
 * deduped_session_count: unique sessions whose events were excluded because D6 already
 * claims their bytes (to avoid double-counting bloat cost).
 */
export function a1Savings(
  avoidableBytes: number,
  bytesPerToken: number,
  blendedWritePriceUsdPerMtok: number,
  dedupedSessionCount: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableTokens = avoidableBytes / bytesPerToken;
  const savingsU = roundU(avoidableTokens * A1_AVOIDANCE_FRACTION * blendedWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "A1_TOOL_RESULT_BLOAT_V2_SAVINGS_V1",
    inputs: {
      avoidable_bytes: avoidableBytes,
      bytes_per_token: bytesPerToken,
      avoidable_tokens: Math.round(avoidableTokens),
      avoidance_fraction: A1_AVOIDANCE_FRACTION,
      blended_write_price_usd_per_mtok: Number(blendedWritePriceUsdPerMtok.toFixed(6)),
      deduped_session_count: dedupedSessionCount,
    },
    expression:
      "avoidable_bytes / bytes_per_token * avoidance_fraction / 1e6 * blended_write_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

/**
 * A2 one-time write savings (B4 model).
 *
 * avoidable_bytes / bytes_per_token × avoidance_fraction × blended_write_price = µUSD/wk.
 * deduped_session_count: sessions excluded because D6 already claims their bytes.
 */
export function a2Savings(
  avoidableBytes: number,
  bytesPerToken: number,
  blendedWritePriceUsdPerMtok: number,
  dedupedSessionCount: number,
): { savingsU: number; formula: ModeledFormula } {
  const avoidableTokens = avoidableBytes / bytesPerToken;
  const savingsU = roundU(avoidableTokens * A2_AVOIDANCE_FRACTION * blendedWritePriceUsdPerMtok);
  const formula: ModeledFormula = {
    model: "A2_BACKGROUND_AGENT_TRANSCRIPT_BLOAT_V2_SAVINGS_V1",
    inputs: {
      avoidable_bytes: avoidableBytes,
      bytes_per_token: bytesPerToken,
      avoidable_tokens: Math.round(avoidableTokens),
      avoidance_fraction: A2_AVOIDANCE_FRACTION,
      blended_write_price_usd_per_mtok: Number(blendedWritePriceUsdPerMtok.toFixed(6)),
      deduped_session_count: dedupedSessionCount,
    },
    expression:
      "avoidable_bytes / bytes_per_token * avoidance_fraction / 1e6 * blended_write_price_usd_per_mtok",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

// ── B3 wasted-turn attribution (C7/C3/C4/C1 failure-retry families) ───────────

/**
 * Avoidance fraction for B3 wasted-turn attribution.
 * UNVALIDATED — a failed/retried turn also does real work, so only a fraction of
 * its cost is avoidable. 0.5 reuses the G11/D6/D7 convention (operator 2026-09-21),
 * inside the empirically-supported 0.40–0.55 band. Surfaced as a labeled input.
 */
export const CX_WASTED_TURN_AVOIDANCE_FRACTION = 0.5;

/**
 * B3 wasted-turn $ attribution.
 *
 * `dedupedTurnCostU` is the summed `turns.cost_equiv_u` (µUSD) of the turns this
 * family claims after the turn-grain dedup (see `turn-claim.ts`) — each turn
 * counted once even if it carries several failing events. No price term:
 * `cost_equiv_u` is already µUSD.
 *
 * savings_u_per_wk = round( Σ claimed turn.cost_equiv_u × avoidance_fraction )
 */
export function wastedTurnAttribution(
  dedupedTurnCostU: number,
  claimedTurnCount: number,
  avoidanceFraction: number = CX_WASTED_TURN_AVOIDANCE_FRACTION,
): { savingsU: number; formula: ModeledFormula } {
  const savingsU = roundU(dedupedTurnCostU * avoidanceFraction);
  const formula: ModeledFormula = {
    model: "CX_WASTED_TURN_ATTRIBUTION_V1",
    inputs: {
      claimed_turn_count: claimedTurnCount,
      summed_cost_equiv_u: dedupedTurnCostU,
      avoidance_fraction: avoidanceFraction,
    },
    expression: "summed_cost_equiv_u * avoidance_fraction / 1e6",
    result_usd_per_wk: Number((savingsU / 1e6).toFixed(2)),
  };
  return { savingsU, formula };
}

export interface EstimateInputs {
  avoidableBytes?: number;
  avoidableCreationTokens?: number;
  bytesPerToken?: number;
  cacheReadPriceUsdPerMtok?: number;
  cacheReadSpendUPerWeek?: number;
  cacheReadTokensPerWeek?: number;
  carryTurns?: number;
  carryExposureTokens?: number;
  conservativeFloorCeu?: number;
  costEquivU?: number;
  currentReads?: number;
  deltaContextTokens?: number;
  excessErrors?: number;
  excessTokens?: number;
  higherErrorCount?: number;
  inputPriceUsdPerMtok?: number;
  idleSidechainCapTokens?: number;
  mismatchTurnsPerWeek?: number;
  opusCacheReadPriceUsdPerMtok?: number;
  opusCacheWrite1hPriceUsdPerMtok?: number;
  opusCacheWrite5mPriceUsdPerMtok?: number;
  opusInputPriceUsdPerMtok?: number;
  opusOutputPriceUsdPerMtok?: number;
  operationClass?: "rm-rf" | "git-reset-hard" | string;
  originSessionId?: string;
  previousCacheReadTokens?: number;
  priorReads?: number;
  rankValueU?: number;
  reductionFraction?: number;
  repeatExcessTokens?: number;
  resultBytes?: number;
  redundantPathCount?: number;
  sidechainResultBytes?: number;
  sonnetCacheReadPriceUsdPerMtok?: number;
  sonnetCacheWrite1hPriceUsdPerMtok?: number;
  sonnetCacheWrite5mPriceUsdPerMtok?: number;
  sonnetInputPriceUsdPerMtok?: number;
  sonnetOutputPriceUsdPerMtok?: number;
  totalCacheReadTokens?: number;
  totalCacheWrite1hTokens?: number;
  totalCacheWrite5mTokens?: number;
  totalChurnCreationTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalRedundantReadCount?: number;
  totalRedundantResultBytes?: number;
  turnsPerWeek?: number;
  writePriceUsdPerMtok?: number;
  xread?: boolean;
  laterTurns?: readonly CarryTurn[];
}

export type EstimateBuilder = (inputs: EstimateInputs) => Estimate;

function ranked(
  basis: Estimate["basis"],
  rankValueU: number,
  label: string,
  summable: boolean = basis === "P" || basis === "E",
): Estimate {
  return { basis, rank_value_u_per_wk: roundU(rankValueU), summable, label };
}

function unranked(label: string): Estimate {
  return { basis: "X", rank_value_u_per_wk: null, summable: false, label };
}

export function a1Estimate(inputs: EstimateInputs): Estimate {
  const resultBytes = inputs.resultBytes ?? inputs.avoidableBytes ?? 0;
  const tokens =
    Math.max(0, resultBytes - 25_600) / (inputs.bytesPerToken ?? ESTIMATOR_BYTES_PER_TOKEN);
  const carry =
    inputs.originSessionId !== undefined && inputs.laterTurns !== undefined
      ? carryTurns(inputs.originSessionId, inputs.laterTurns)
      : Math.min(Math.max(0, inputs.carryTurns ?? 0), CARRY_TURN_CAP);
  return ranked(
    "E",
    tokens *
      A1_AVOIDANCE_FRACTION *
      carryPriceUsdPerMtok(
        carry,
        inputs.writePriceUsdPerMtok ?? 0,
        inputs.cacheReadPriceUsdPerMtok ?? 0,
      ),
    "tool-result carry estimate",
  );
}

export function a2Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    ((inputs.avoidableBytes ?? 0) / (inputs.bytesPerToken ?? ESTIMATOR_BYTES_PER_TOKEN)) *
      A2_AVOIDANCE_FRACTION *
      // U7: carried like A1 (one write + carry − 1 reads); no carry given = the write only.
      carryPriceUsdPerMtok(
        inputs.carryTurns ?? 1,
        inputs.writePriceUsdPerMtok ?? 0,
        inputs.cacheReadPriceUsdPerMtok ?? 0,
      ),
    "task-output bloat savings",
  );
}

export function b1Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.avoidableCreationTokens ?? 0) *
      (inputs.reductionFraction ?? B1_AVOIDANCE_FRACTION) *
      (inputs.writePriceUsdPerMtok ?? 0),
    "cache-read-collapse savings",
  );
}

export function b2Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "O",
    (inputs.previousCacheReadTokens ?? 0) *
      ((inputs.writePriceUsdPerMtok ?? 0) - (inputs.cacheReadPriceUsdPerMtok ?? 0)) *
      (inputs.reductionFraction ?? B1_AVOIDANCE_FRACTION),
    "TTL-gap overlap estimate",
    false,
  );
}

export function b3Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.avoidableCreationTokens ?? 0) *
      (inputs.reductionFraction ?? B3_AVOIDANCE_FRACTION) *
      (inputs.writePriceUsdPerMtok ?? 0),
    "resume-cache-miss savings",
  );
}

export function b4Estimate(inputs: EstimateInputs): Estimate {
  // Basis O: B4 is folded into B1, which prices the same collapse turn.
  return ranked(
    "O",
    (inputs.avoidableCreationTokens ?? 0) *
      (inputs.reductionFraction ?? B4_AVOIDANCE_FRACTION) *
      (inputs.writePriceUsdPerMtok ?? 0),
    "mid-session-prefix-break overlap estimate",
    false,
  );
}

export function c1Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "tool-error recovery savings",
  );
}

export function c2Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "not-found retry estimate",
  );
}

export function c3Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "edit-before-read savings",
  );
}

export function c4Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "failed-edit recovery savings",
  );
}

export function c5Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "O",
    (inputs.conservativeFloorCeu ?? 0) * (inputs.inputPriceUsdPerMtok ?? 0),
    "same-error-loop overlap estimate",
    false,
  );
}

export function c6Estimate(inputs: EstimateInputs): Estimate {
  // No priced redo turn (unpriceable or none in the window): never a $0 estimate.
  if ((inputs.costEquivU ?? 0) <= 0) return unranked("edit flip-flop is not priced");
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "edit flip-flop redo estimate",
  );
}

export function c7Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "bash failure recovery savings",
  );
}

export function c9Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "denial re-plan estimate",
  );
}

export function c11Estimate(inputs: EstimateInputs): Estimate {
  if ((inputs.costEquivU ?? 0) <= 0) return unranked("output cap is not priced");
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "output-cap retry estimate",
  );
}

export function d1Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.deltaContextTokens ?? 0) *
      (inputs.turnsPerWeek ?? 0) *
      (inputs.cacheReadPriceUsdPerMtok ?? 0) *
      (inputs.reductionFraction ?? D1_TRIM_TO_TARGET_FRACTION),
    "always-loaded context savings",
  );
}

export function d2Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.cacheReadSpendUPerWeek ?? 0) * (inputs.reductionFraction ?? D2_REDUCTION_FRACTION),
    "long-context cache-read savings",
  );
}

export function d4Estimate(inputs: EstimateInputs): Estimate {
  const differential =
    (inputs.totalInputTokens ?? 0) *
      ((inputs.opusInputPriceUsdPerMtok ?? 0) - (inputs.sonnetInputPriceUsdPerMtok ?? 0)) +
    (inputs.totalOutputTokens ?? 0) *
      ((inputs.opusOutputPriceUsdPerMtok ?? 0) - (inputs.sonnetOutputPriceUsdPerMtok ?? 0)) +
    (inputs.totalCacheReadTokens ?? 0) *
      ((inputs.opusCacheReadPriceUsdPerMtok ?? 0) - (inputs.sonnetCacheReadPriceUsdPerMtok ?? 0)) +
    (inputs.totalCacheWrite5mTokens ?? 0) *
      ((inputs.opusCacheWrite5mPriceUsdPerMtok ?? 0) -
        (inputs.sonnetCacheWrite5mPriceUsdPerMtok ?? 0)) +
    (inputs.totalCacheWrite1hTokens ?? 0) *
      ((inputs.opusCacheWrite1hPriceUsdPerMtok ?? 0) -
        (inputs.sonnetCacheWrite1hPriceUsdPerMtok ?? 0));
  return ranked(
    "E",
    differential * D4_REALIZABLE_AVOIDANCE_FRACTION,
    "realizable subagent model-routing estimate",
  );
}

export function d5Estimate(_inputs: EstimateInputs): Estimate {
  return unranked("limit-burn warning is not ranked");
}

export function d6Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.carryExposureTokens ?? 0) *
      (inputs.reductionFraction ?? D6_AVOIDANCE_FRACTION) *
      (inputs.cacheReadPriceUsdPerMtok ?? 0),
    "recurring tool-result bloat savings",
  );
}

export function d7Estimate(inputs: EstimateInputs): Estimate {
  if (inputs.xread === true) {
    const reads = inputs.totalRedundantReadCount ?? 0;
    const fraction = reads > 0 ? (reads - (inputs.redundantPathCount ?? 0)) / reads : 0;
    return ranked(
      "E",
      (((inputs.totalRedundantResultBytes ?? 0) * fraction) /
        (inputs.bytesPerToken ?? ESTIMATOR_BYTES_PER_TOKEN)) *
        (inputs.cacheReadPriceUsdPerMtok ?? 0),
      "cross-session reread estimate",
    );
  }
  // Non-summable (F5): loop turns are also C-family wasted turns; no ledger producer, so the
  // card shows this as a standalone figure.
  return ranked(
    "P",
    (inputs.repeatExcessTokens ?? 0) *
      (inputs.reductionFraction ?? D7_AVOIDANCE_FRACTION) *
      (inputs.cacheReadPriceUsdPerMtok ?? 0),
    "loop-retry-waste savings",
    false,
  );
}

export function d8Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.totalChurnCreationTokens ?? 0) *
      (inputs.writePriceUsdPerMtok ?? 0) *
      (inputs.reductionFraction ?? D8_AVOIDANCE_FRACTION),
    "cache-write-churn savings",
  );
}

/** Non-summable (card; F6): the fork's reads have no ledger producer; shown as a standalone $. */
export function d9Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    (inputs.idleSidechainCapTokens ?? 0) * (inputs.cacheReadPriceUsdPerMtok ?? 0),
    "idle sidechain estimate",
    false,
  );
}

export function d10Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.deltaContextTokens ?? 0) *
      (inputs.turnsPerWeek ?? 0) *
      (inputs.cacheReadPriceUsdPerMtok ?? 0) *
      (inputs.reductionFraction ?? D1_D10_AVOIDANCE_FRACTION),
    "catalog-footprint savings",
  );
}

export function d11Estimate(inputs: EstimateInputs): Estimate {
  const fraction =
    (inputs.higherErrorCount ?? 0) > 0
      ? (inputs.excessErrors ?? 0) / (inputs.higherErrorCount ?? 0)
      : 0;
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * fraction * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    "higher-error shell estimate",
  );
}

/** Non-summable (F5): the returned results are also tool results A1/D6 price; no ledger producer. */
export function d12Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    ((inputs.sidechainResultBytes ?? 0) / (inputs.bytesPerToken ?? ESTIMATOR_BYTES_PER_TOKEN)) *
      D12_AVOIDANCE_FRACTION *
      (inputs.writePriceUsdPerMtok ?? SIDECHAIN_WRITE_PRICE_USD_PER_MTOK),
    "sidechain return-volume estimate",
    false,
  );
}

export function d14Estimate(inputs: EstimateInputs): Estimate {
  const basis = inputs.operationClass === "human-deny" ? "O" : "E";
  return ranked(
    basis,
    (inputs.costEquivU ?? 0) * CX_WASTED_TURN_AVOIDANCE_FRACTION,
    basis === "O" ? "human-deny overlap estimate" : "interrupt restart estimate",
    basis !== "O",
  );
}

/**
 * Non-summable: run turns can also be E1 pre-edit turns, and their results are carry-priced by
 * D6/A1. A negative net saving ranks at 0.
 */
export function e2Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    Math.max(0, inputs.costEquivU ?? 0) * E2_AVOIDANCE_FRACTION,
    "main-thread mechanical runs to a Sonnet subagent estimate",
    false,
  );
}

/**
 * Non-summable: the pre-edit reads are also tool results D6/A1 carry-price on later turns. E1
 * claims only the excess turns' own cost.
 */
export function e1Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "E",
    (inputs.costEquivU ?? 0) * E1_AVOIDANCE_FRACTION,
    "excess pre-edit orientation estimate",
    false,
  );
}

/** Non-summable (F5): the excess reads overlap other detectors' claims; no ledger producer. */
export function g11Estimate(inputs: EstimateInputs): Estimate {
  return ranked(
    "P",
    (inputs.excessTokens ?? 0) *
      (inputs.cacheReadPriceUsdPerMtok ?? 0) *
      (inputs.reductionFraction ?? G11_AVOIDANCE_FRACTION),
    "high-spend failure savings",
    false,
  );
}

export function h1Estimate(inputs: EstimateInputs): Estimate {
  const probability =
    inputs.operationClass === "git-reset-hard"
      ? H1_GIT_RESET_HARD_HARM_PROBABILITY
      : H1_RM_RF_HARM_PROBABILITY;
  return ranked("R", (inputs.costEquivU ?? 0) * probability, "work at risk upper bound", false);
}

export const ESTIMATE_BUILDERS: Record<string, EstimateBuilder> = {
  A1: a1Estimate,
  A2: a2Estimate,
  B1: b1Estimate,
  B2: b2Estimate,
  B3: b3Estimate,
  B4: b4Estimate,
  C1: c1Estimate,
  C2: c2Estimate,
  C3: c3Estimate,
  C4: c4Estimate,
  C5: c5Estimate,
  C6: c6Estimate,
  C7: c7Estimate,
  C9: c9Estimate,
  C11: c11Estimate,
  D1: d1Estimate,
  D2: d2Estimate,
  D4: d4Estimate,
  D5: d5Estimate,
  D6: d6Estimate,
  D7: d7Estimate,
  D8: d8Estimate,
  D9: d9Estimate,
  D10: d10Estimate,
  D11: d11Estimate,
  D12: d12Estimate,
  D14: d14Estimate,
  E1: e1Estimate,
  E2: e2Estimate,
  G11: g11Estimate,
  H1: h1Estimate,
};
