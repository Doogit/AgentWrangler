/**
 * HRE-0 logical contracts. These types deliberately describe identities and
 * invariants, not tables, transport payloads, or persisted column names.
 */

declare const brand: unique symbol;
type OpaqueId<T extends string> = string & { readonly [brand]: T };
export type SafeCode = OpaqueId<"SafeCode">;

export type RecommendationId = OpaqueId<"RecommendationId">;
export type RecommendationRevisionId = OpaqueId<"RecommendationRevisionId">;
export type FindingId = OpaqueId<"FindingId">;
export type RemediationArtifactRevisionId = OpaqueId<"RemediationArtifactRevisionId">;
export type ArtifactApplicationId = OpaqueId<"ArtifactApplicationId">;
export type MeasurementMethodId = OpaqueId<"MeasurementMethodId">;
export type EffectCycleId = OpaqueId<"EffectCycleId">;
export type CeuPoolId = OpaqueId<"CeuPoolId">;

export type RecommendationLifecycle =
  | "ACTIONABLE"
  | "INVESTIGATE"
  | "PARTIALLY_ACTIONED"
  | "ACTIONED"
  | "MEASURING"
  | "MEASURED_IMPROVED"
  | "MEASURED_NO_EFFECT"
  | "MEASURED_INCONCLUSIVE"
  | "MEASURED_WORSE"
  | "MEASUREMENT_UNSUPPORTED"
  | "DISMISSED"
  | "SNOOZED"
  | "STALE";

export type MeasurementVerdict = "AUTOMATIC" | "VALIDATED_PROXY" | "MANUAL" | "UNMEASURABLE";
export type EffectVerdict = "IMPROVED" | "NO_EFFECT" | "INCONCLUSIVE" | "WORSE" | "UNSUPPORTED";

/** Only opaque references, codes, hashes, counts, and aggregates belong here. */
export interface PrivacySafeValue {
  readonly value: number | null;
  readonly unit: "CEU_PER_WEEK" | "USD_PER_WEEK" | "FRACTION";
  readonly methodId: MeasurementMethodId;
  readonly methodVersion: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly uncertainty: { readonly lower: number | null; readonly upper: number | null };
}

export interface Recommendation {
  readonly id: RecommendationId;
  readonly activeRevisionId: RecommendationRevisionId;
}

export interface RecommendationRevision {
  readonly id: RecommendationRevisionId;
  readonly recommendationId: RecommendationId;
  readonly supersedesRevisionId: RecommendationRevisionId | null;
  readonly handlerVersion: string;
  readonly registryVersion: string;
  readonly rankingPolicyVersion: string;
  readonly findingIds: readonly FindingId[];
  readonly expectedSavings: PrivacySafeValue;
  readonly reasonCodes: readonly SafeCode[];
}

export interface ActiveRevisionCompareAndSet {
  readonly recommendationId: RecommendationId;
  readonly expectedActiveRevisionId: RecommendationRevisionId;
  readonly nextRevisionId: RecommendationRevisionId;
}

export type ActiveRevisionCasResult =
  | { readonly kind: "APPLIED"; readonly recommendation: Recommendation }
  | { readonly kind: "CONFLICT"; readonly actualActiveRevisionId: RecommendationRevisionId }
  | { readonly kind: "INVALID_SUPERSESSION" }
  | { readonly kind: "IDENTITY_MISMATCH" };

export function compareAndSetActiveRevision(
  recommendation: Recommendation,
  revision: RecommendationRevision,
  change: ActiveRevisionCompareAndSet,
): ActiveRevisionCasResult {
  if (
    recommendation.id !== change.recommendationId ||
    revision.recommendationId !== recommendation.id
  ) {
    return { kind: "IDENTITY_MISMATCH" };
  }
  if (recommendation.activeRevisionId !== change.expectedActiveRevisionId) {
    return { kind: "CONFLICT", actualActiveRevisionId: recommendation.activeRevisionId };
  }
  if (revision.id !== change.nextRevisionId) return { kind: "IDENTITY_MISMATCH" };
  if (revision.supersedesRevisionId !== recommendation.activeRevisionId) {
    return { kind: "INVALID_SUPERSESSION" };
  }
  return { kind: "APPLIED", recommendation: { ...recommendation, activeRevisionId: revision.id } };
}

export interface RemediationArtifactRevision {
  readonly id: RemediationArtifactRevisionId;
  readonly recommendationRevisionId: RecommendationRevisionId;
  readonly artifactHash: string;
  readonly capabilityProfileVersion: string;
  readonly rollbackAvailable: boolean;
}

export interface ArtifactApplication {
  readonly id: ArtifactApplicationId;
  readonly artifactRevisionId: RemediationArtifactRevisionId;
  readonly observedRecommendationRevisionId: RecommendationRevisionId;
  readonly result: "APPLIED" | "FAILED" | "ROLLED_BACK";
}

export interface MeasurementMethod {
  readonly id: MeasurementMethodId;
  readonly artifactRevisionId: RemediationArtifactRevisionId;
  readonly methodVersion: string;
}

export interface EffectCycleLink {
  readonly id: EffectCycleId;
  readonly recommendationId: RecommendationId;
  readonly recommendationRevisionId: RecommendationRevisionId;
  readonly artifactApplicationId: ArtifactApplicationId;
  readonly artifactRevisionId: RemediationArtifactRevisionId;
  readonly measurementMethodId: MeasurementMethodId;
  readonly verdict: EffectVerdict | null;
}

/** Prevents a new cycle from being bound to a different artifact or revision. */
export function hasExactEffectBinding(
  cycle: EffectCycleLink,
  revision: RecommendationRevision,
  application: ArtifactApplication,
  artifact: RemediationArtifactRevision,
  method: MeasurementMethod,
): boolean {
  return (
    cycle.recommendationId === revision.recommendationId &&
    cycle.recommendationRevisionId === revision.id &&
    cycle.artifactApplicationId === application.id &&
    cycle.artifactRevisionId === application.artifactRevisionId &&
    cycle.artifactRevisionId === artifact.id &&
    cycle.measurementMethodId === method.id &&
    method.artifactRevisionId === artifact.id &&
    application.result === "APPLIED" &&
    revision.id === application.observedRecommendationRevisionId &&
    artifact.recommendationRevisionId === revision.id
  );
}

export interface AdmissionInput {
  readonly deterministicHandler: boolean;
  readonly artifactValidated: boolean;
  readonly rollbackAvailable: boolean;
  readonly expectedSavingsUsdPerWeek: number | null;
  readonly exclusiveCeuPool: boolean;
  readonly measurementVerdict: MeasurementVerdict;
  readonly hasFailedGate: boolean;
  readonly safetyException: { readonly eligible: boolean; readonly reasonCode: SafeCode } | null;
}

export type AdmissionDecision =
  | { readonly lifecycle: "ACTIONABLE"; readonly reasonCodes: readonly string[] }
  | { readonly lifecycle: "INVESTIGATE"; readonly reasonCodes: readonly string[] };

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  if (input.hasFailedGate)
    return { lifecycle: "INVESTIGATE", reasonCodes: ["FAILED_GATE" as SafeCode] };
  const hasActionableArtifact =
    input.deterministicHandler && input.artifactValidated && input.rollbackAvailable;
  if (input.safetyException?.eligible && hasActionableArtifact) {
    return {
      lifecycle: "ACTIONABLE",
      reasonCodes: ["SAFETY_EXCEPTION" as SafeCode, input.safetyException.reasonCode],
    };
  }
  const admitted =
    hasActionableArtifact &&
    input.expectedSavingsUsdPerWeek !== null &&
    input.expectedSavingsUsdPerWeek > 0 &&
    input.exclusiveCeuPool &&
    (input.measurementVerdict === "AUTOMATIC" || input.measurementVerdict === "VALIDATED_PROXY");
  return admitted
    ? { lifecycle: "ACTIONABLE", reasonCodes: ["PRIMARY_ADMISSION" as SafeCode] }
    : { lifecycle: "INVESTIGATE", reasonCodes: ["MANUAL_OR_UNMEASURABLE" as SafeCode] };
}

export interface CeuClaim {
  readonly poolId: CeuPoolId;
  readonly recommendationRevisionId: RecommendationRevisionId;
  readonly contributionCeuPerWeek: number;
  readonly ownsValue: boolean;
}

export function hasConservedExclusiveCeu(
  poolTotals: ReadonlyMap<CeuPoolId, number>,
  claims: readonly CeuClaim[],
): boolean {
  for (const [poolId, total] of poolTotals) {
    const matching = claims.filter((claim) => claim.poolId === poolId);
    if (matching.filter((claim) => claim.ownsValue).length !== 1) return false;
    if (matching.reduce((sum, claim) => sum + claim.contributionCeuPerWeek, 0) !== total)
      return false;
  }
  return claims.every((claim) => poolTotals.has(claim.poolId) && claim.contributionCeuPerWeek >= 0);
}

export interface LifecycleProjectionInput {
  readonly dismissed: boolean;
  readonly snoozed: boolean;
  readonly stale: boolean;
  readonly admission: AdmissionDecision;
  readonly requiredApplicationCount: number;
  readonly appliedApplicationCount: number;
  readonly measurementStarted: boolean;
  readonly effectVerdict: EffectVerdict | null;
}

export function projectLifecycle(input: LifecycleProjectionInput): RecommendationLifecycle {
  if (input.dismissed) return "DISMISSED";
  if (input.snoozed) return "SNOOZED";
  if (input.stale) return "STALE";
  if (input.effectVerdict === "IMPROVED") return "MEASURED_IMPROVED";
  if (input.effectVerdict === "NO_EFFECT") return "MEASURED_NO_EFFECT";
  if (input.effectVerdict === "INCONCLUSIVE") return "MEASURED_INCONCLUSIVE";
  if (input.effectVerdict === "WORSE") return "MEASURED_WORSE";
  if (input.effectVerdict === "UNSUPPORTED") return "MEASUREMENT_UNSUPPORTED";
  if (input.measurementStarted) return "MEASURING";
  if (
    input.appliedApplicationCount >= input.requiredApplicationCount &&
    input.requiredApplicationCount > 0
  ) {
    return "ACTIONED";
  }
  if (input.appliedApplicationCount > 0) return "PARTIALLY_ACTIONED";
  return input.admission.lifecycle;
}
