import type { RecommendationId, SafeCode } from "./types.js";

export const RANKING_POLICY_VERSION = "ranking-policy-2" as const;
export const DEFAULT_SAFETY_PIN_LIMIT = 3;

export type ReviewedSafetyClass =
  | "HIGH_INTEGRITY"
  | "SECRET"
  | "PROTECTED_PATH"
  | "DESTRUCTIVE_ACTION";

export interface ValueFactor {
  readonly value: number | null;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly evidenceWindow: { readonly from: string; readonly to: string };
  readonly uncertainty: { readonly lower: number | null; readonly upper: number | null };
}

export interface ExpectedSavingsInput {
  readonly exclusivePoolCeuPerWeek: ValueFactor;
  readonly listPriceUsdPerCeu: ValueFactor;
  readonly detectorConfidence: ValueFactor;
  readonly handlerApplicability: ValueFactor;
  readonly expectedEffectFraction: ValueFactor;
}

/** ranking-policy-2 value estimate. Unknown or invalid factors fail closed to null. */
export function estimateSavingsUsdPerWeek(input: ExpectedSavingsInput): number | null {
  const ceu = input.exclusivePoolCeuPerWeek.value;
  const price = input.listPriceUsdPerCeu.value;
  const confidence = input.detectorConfidence.value;
  const applicability = input.handlerApplicability.value;
  const effect = input.expectedEffectFraction.value;
  const values = [ceu, price, confidence, applicability, effect];
  if (values.some((value) => value === null || !Number.isFinite(value) || value < 0)) return null;
  if (
    ceu === null ||
    price === null ||
    confidence === null ||
    applicability === null ||
    effect === null
  ) {
    return null;
  }
  if (confidence > 1 || applicability > 1 || effect > 1) return null;
  const estimate = ceu * price * confidence * applicability * effect;
  return Number.isFinite(estimate) ? estimate : null;
}

export interface SafetyPin {
  readonly reviewed: boolean;
  readonly safetyClass: ReviewedSafetyClass;
  readonly priority: number;
  readonly reasonCode: SafeCode;
}

export interface RankableRecommendation {
  readonly stableId: RecommendationId;
  readonly expectedSavingsUsdPerWeek: number | null;
  /** Unknown HRE confidence stays null at the read boundary and ranks as zero. */
  readonly confidence: number | null;
  /** Applicability is unavailable until its HRE provenance is persisted. */
  readonly applicability: number | null;
  readonly evidenceNewestAt: string;
  readonly safetyPin: SafetyPin | null;
}

/** Complete server-side rank tuple. Cursor contracts persist every field. */
export interface QueueRankKey {
  readonly safetyPinOrdinal: number | null;
  readonly expectedSavingsUsdPerWeek: number | null;
  readonly confidence: number;
  readonly applicability: number;
  readonly evidenceNewestAt: string;
  readonly stableId: RecommendationId;
}

export interface RankedRecommendation {
  readonly candidate: RankableRecommendation;
  readonly rankKey: QueueRankKey;
  readonly reasonCodes: readonly SafeCode[];
}

function compareValueOrder(a: RankableRecommendation, b: RankableRecommendation): number {
  const aRank = normalizedRankKey(a, null);
  const bRank = normalizedRankKey(b, null);
  if (aRank.expectedSavingsUsdPerWeek === null && bRank.expectedSavingsUsdPerWeek !== null)
    return 1;
  if (aRank.expectedSavingsUsdPerWeek !== null && bRank.expectedSavingsUsdPerWeek === null)
    return -1;
  if (
    aRank.expectedSavingsUsdPerWeek !== null &&
    bRank.expectedSavingsUsdPerWeek !== null &&
    aRank.expectedSavingsUsdPerWeek !== bRank.expectedSavingsUsdPerWeek
  ) {
    return bRank.expectedSavingsUsdPerWeek - aRank.expectedSavingsUsdPerWeek;
  }
  if (aRank.confidence !== bRank.confidence) return bRank.confidence - aRank.confidence;
  if (aRank.applicability !== bRank.applicability) return bRank.applicability - aRank.applicability;
  const recencyOrder = bRank.evidenceNewestAt.localeCompare(aRank.evidenceNewestAt);
  return recencyOrder || a.stableId.localeCompare(b.stableId);
}

function normalizedUnitInterval(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}

function normalizedRankKey(
  candidate: RankableRecommendation,
  safetyPinOrdinal: number | null,
): QueueRankKey {
  const evidenceTime = Date.parse(candidate.evidenceNewestAt);
  return {
    safetyPinOrdinal,
    expectedSavingsUsdPerWeek:
      candidate.expectedSavingsUsdPerWeek !== null &&
      Number.isFinite(candidate.expectedSavingsUsdPerWeek) &&
      candidate.expectedSavingsUsdPerWeek >= 0
        ? candidate.expectedSavingsUsdPerWeek
        : null,
    confidence: normalizedUnitInterval(candidate.confidence),
    applicability: normalizedUnitInterval(candidate.applicability),
    evidenceNewestAt: Number.isFinite(evidenceTime) ? new Date(evidenceTime).toISOString() : "",
    stableId: candidate.stableId,
  };
}

function isReviewedSafetyPin(
  candidate: RankableRecommendation,
): candidate is RankableRecommendation & {
  readonly safetyPin: SafetyPin;
} {
  return (
    candidate.safetyPin?.reviewed === true &&
    Number.isSafeInteger(candidate.safetyPin.priority) &&
    candidate.safetyPin.priority >= 0
  );
}

/**
 * Applies the bounded safety block, then dollars/week and the complete deterministic tie tuple.
 * Eligible pins beyond the bound return to ordinary value order so safety records cannot starve it.
 */
export function rankRecommendations(
  candidates: readonly RankableRecommendation[],
  safetyPinLimit = DEFAULT_SAFETY_PIN_LIMIT,
): readonly RankedRecommendation[] {
  const boundedLimit = Number.isSafeInteger(safetyPinLimit)
    ? Math.min(DEFAULT_SAFETY_PIN_LIMIT, Math.max(0, safetyPinLimit))
    : 0;
  const safetyPins = candidates
    .filter(isReviewedSafetyPin)
    .sort(
      (a, b) => a.safetyPin.priority - b.safetyPin.priority || a.stableId.localeCompare(b.stableId),
    )
    .slice(0, boundedLimit);
  const pinnedIds = new Set(safetyPins.map((candidate) => candidate.stableId));
  const valueRanked = candidates
    .filter((candidate) => !pinnedIds.has(candidate.stableId))
    .sort(compareValueOrder);

  return [...safetyPins, ...valueRanked].map((candidate, index) => {
    const safetyPinOrdinal = pinnedIds.has(candidate.stableId) ? index : null;
    return {
      candidate,
      rankKey: normalizedRankKey(candidate, safetyPinOrdinal),
      reasonCodes:
        safetyPinOrdinal === null
          ? (["EXPECTED_VALUE_ORDER"] as unknown as readonly SafeCode[])
          : ([
              "REVIEWED_SAFETY_PIN" as SafeCode,
              (candidate.safetyPin as SafetyPin).reasonCode,
            ] as readonly SafeCode[]),
    };
  });
}
