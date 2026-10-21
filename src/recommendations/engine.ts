import { createHash } from "node:crypto";
import type { CapabilityProfile } from "./capabilities.js";
import { type EngineFinding, correlateFindings } from "./correlation.js";
import {
  type ArtifactContract,
  type HandlerRegistry,
  type MeasurementContract,
  selectHandler,
} from "./registry.js";
import type { RecommendationLifecycle, SafeCode } from "./types.js";
import { type ValueContext, composeExpectedValue } from "./value.js";

export interface EngineContext {
  readonly registry: HandlerRegistry;
  readonly profile: CapabilityProfile;
  readonly now: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly compositionVersion: string;
  readonly rankingPolicyVersion: string;
  readonly value: ValueContext;
}
export interface ImmutableArtifact extends ArtifactContract {
  readonly capabilityProfileVersion: string;
}
export interface ImmutableMeasurement extends MeasurementContract {}
export interface CompositionMetadata {
  readonly handlerFamily: string;
  readonly handlerVersion: string;
  readonly registryVersion: string;
  readonly rankingPolicyVersion: string;
  readonly valueMethodId: string;
  readonly valueMethodVersion: string;
  readonly valueWindowFrom: string;
  readonly valueWindowTo: string;
  readonly createdAt: string;
}
export interface ComposedRecommendation {
  readonly immutableId: string;
  readonly lifecycle: RecommendationLifecycle;
  readonly findingIds: readonly string[];
  readonly links: readonly {
    readonly findingId: string;
    readonly ceuPoolId: string;
    readonly role: "PRIMARY" | "SUPPORTING";
    readonly contributionCeuPerWeek: number;
    readonly ownsValue: boolean;
  }[];
  readonly expectedSavingsUsdPerWeek: number | null;
  readonly artifacts: readonly ImmutableArtifact[];
  /** Never emitted unless valid and exactly bound to an admitted artifact. */ readonly measurement: ImmutableMeasurement | null;
  readonly composition: CompositionMetadata | null;
  readonly reasonCodes: readonly SafeCode[];
}
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_ID = /^artifact:[a-f0-9]{64}$/;
const MEASUREMENT_ID = /^measurement:[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const canonicalTime = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const hasExactKeys = (value: unknown, expected: readonly string[]): value is object => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
};
const validDefinition = (value: unknown): value is MeasurementContract["definition"] => {
  if (
    !hasExactKeys(value, [
      "afterCohortCode",
      "baselineCohortCode",
      "comparabilityCode",
      "guardrailCodes",
      "horizonDays",
      "targetDirection",
    ])
  )
    return false;
  const d = value as MeasurementContract["definition"];
  return (
    (d.targetDirection === "REDUCE" ||
      d.targetDirection === "INCREASE" ||
      d.targetDirection === "HOLD") &&
    Number.isSafeInteger(d.horizonDays) &&
    d.horizonDays >= 1 &&
    d.horizonDays <= 365 &&
    typeof d.baselineCohortCode === "string" &&
    SAFE_CODE.test(d.baselineCohortCode) &&
    typeof d.afterCohortCode === "string" &&
    SAFE_CODE.test(d.afterCohortCode) &&
    typeof d.comparabilityCode === "string" &&
    SAFE_CODE.test(d.comparabilityCode) &&
    Array.isArray(d.guardrailCodes) &&
    d.guardrailCodes.length > 0 &&
    d.guardrailCodes.length <= 8 &&
    d.guardrailCodes.every((code) => typeof code === "string" && SAFE_CODE.test(code))
  );
};
const validArtifact = (value: unknown, profile: CapabilityProfile): value is ArtifactContract => {
  if (
    !hasExactKeys(value, [
      "applyMechanismCode",
      "artifactHash",
      "artifactRevisionId",
      "createdAt",
      "kind",
      "rollbackArtifactRevisionId",
      "rollbackHash",
      "scopeHash",
      "supersedesArtifactRevisionId",
      "targetHash",
      "validated",
      "validationStatus",
    ])
  )
    return false;
  const a = value as ArtifactContract;
  return (
    typeof a.artifactRevisionId === "string" &&
    ARTIFACT_ID.test(a.artifactRevisionId) &&
    typeof a.artifactHash === "string" &&
    SHA256.test(a.artifactHash) &&
    typeof a.scopeHash === "string" &&
    SHA256.test(a.scopeHash) &&
    typeof a.targetHash === "string" &&
    SHA256.test(a.targetHash) &&
    typeof a.rollbackArtifactRevisionId === "string" &&
    ARTIFACT_ID.test(a.rollbackArtifactRevisionId) &&
    typeof a.rollbackHash === "string" &&
    SHA256.test(a.rollbackHash) &&
    a.validationStatus === "VALIDATED" &&
    a.validated === true &&
    (a.supersedesArtifactRevisionId === null ||
      (typeof a.supersedesArtifactRevisionId === "string" &&
        ARTIFACT_ID.test(a.supersedesArtifactRevisionId))) &&
    canonicalTime(a.createdAt) &&
    typeof a.applyMechanismCode === "string" &&
    SAFE_CODE.test(a.applyMechanismCode) &&
    OPAQUE.test(profile.version)
  );
};
const validMeasurement = (value: unknown): value is MeasurementContract => {
  if (
    !hasExactKeys(value, [
      "artifactRevisionId",
      "createdAt",
      "definition",
      "measurementMethodId",
      "methodVersion",
      "targetMetricCode",
      "verdict",
    ])
  )
    return false;
  const m = value as MeasurementContract;
  return (
    typeof m.measurementMethodId === "string" &&
    MEASUREMENT_ID.test(m.measurementMethodId) &&
    typeof m.artifactRevisionId === "string" &&
    ARTIFACT_ID.test(m.artifactRevisionId) &&
    typeof m.methodVersion === "string" &&
    OPAQUE.test(m.methodVersion) &&
    typeof m.targetMetricCode === "string" &&
    SAFE_CODE.test(m.targetMetricCode) &&
    canonicalTime(m.createdAt) &&
    validDefinition(m.definition)
  );
};

export function composeRecommendation(
  inputFindings: readonly EngineFinding[],
  context: EngineContext,
): ComposedRecommendation {
  const correlation = correlateFindings(inputFindings);
  const findings = correlation.canonicalFindings;
  const selection = selectHandler(context.registry, findings, context.profile, context.now);
  const contracts =
    correlation.valid && selection.kind === "SELECTED"
      ? selection.implementation.compose({ findings, now: context.now, window: context.window })
      : { artifacts: [], measurement: null };
  const rawArtifacts: readonly unknown[] = Array.isArray(contracts.artifacts)
    ? contracts.artifacts
    : [];
  const artifactsValid =
    Array.isArray(contracts.artifacts) &&
    rawArtifacts.every(
      (artifact) =>
        validArtifact(artifact, context.profile) &&
        selection.kind === "SELECTED" &&
        selection.implementation.registration.artifactKinds.includes(artifact.kind as never),
    );
  const validatedArtifacts = artifactsValid ? (rawArtifacts as readonly ArtifactContract[]) : [];
  const duplicateIds = new Set(
    validatedArtifacts
      .map((a) => a.artifactRevisionId)
      .filter((id, i, ids) => ids.indexOf(id) !== i),
  );
  const invalidArtifact = selection.kind !== "SELECTED" || duplicateIds.size > 0 || !artifactsValid;
  const artifacts: ImmutableArtifact[] = invalidArtifact
    ? []
    : validatedArtifacts
        .map((a) => ({
          artifactRevisionId: a.artifactRevisionId,
          kind: a.kind,
          validationStatus: a.validationStatus,
          validated: a.validated,
          artifactHash: a.artifactHash,
          scopeHash: a.scopeHash,
          targetHash: a.targetHash,
          rollbackArtifactRevisionId: a.rollbackArtifactRevisionId,
          rollbackHash: a.rollbackHash,
          supersedesArtifactRevisionId: a.supersedesArtifactRevisionId,
          createdAt: a.createdAt,
          applyMechanismCode: a.applyMechanismCode,
          capabilityProfileVersion: context.profile.version,
        }))
        .sort(
          (a, b) =>
            a.artifactRevisionId.localeCompare(b.artifactRevisionId) ||
            a.artifactHash.localeCompare(b.artifactHash),
        );
  const rawMeasurement = contracts.measurement;
  const measurement: ImmutableMeasurement | null =
    rawMeasurement !== null &&
    rawMeasurement !== undefined &&
    validMeasurement(rawMeasurement) &&
    (rawMeasurement.verdict === "AUTOMATIC" || rawMeasurement.verdict === "VALIDATED_PROXY") &&
    artifacts.some((a) => a.artifactRevisionId === rawMeasurement.artifactRevisionId)
      ? {
          measurementMethodId: rawMeasurement.measurementMethodId,
          artifactRevisionId: rawMeasurement.artifactRevisionId,
          methodVersion: rawMeasurement.methodVersion,
          targetMetricCode: rawMeasurement.targetMetricCode,
          verdict: rawMeasurement.verdict,
          definition: {
            targetDirection: rawMeasurement.definition.targetDirection,
            horizonDays: rawMeasurement.definition.horizonDays,
            baselineCohortCode: rawMeasurement.definition.baselineCohortCode,
            afterCohortCode: rawMeasurement.definition.afterCohortCode,
            guardrailCodes: [...rawMeasurement.definition.guardrailCodes],
            comparabilityCode: rawMeasurement.definition.comparabilityCode,
          },
          createdAt: rawMeasurement.createdAt,
        }
      : null;
  const value = correlation.valid
    ? composeExpectedValue(findings, correlation.links, context.value)
    : null;
  const actionable =
    selection.kind === "SELECTED" &&
    correlation.valid &&
    value !== null &&
    value > 0 &&
    artifacts.length > 0 &&
    measurement !== null;
  const reasonCodes = [
    ...correlation.reasonCodes,
    ...(selection.kind === "INVESTIGATE" ? selection.reasonCodes : []),
    ...(value === null ? (["VALUE_UNAVAILABLE" as SafeCode] as const) : []),
    ...(value !== null && value <= 0 ? (["VALUE_NOT_POSITIVE" as SafeCode] as const) : []),
    ...(artifacts.length === 0 ? (["ARTIFACT_UNAVAILABLE" as SafeCode] as const) : []),
    ...(measurement === null ? (["MEASUREMENT_UNAVAILABLE" as SafeCode] as const) : []),
    ...(actionable ? (["PRIMARY_ADMISSION" as SafeCode] as const) : []),
  ].sort() as unknown as readonly SafeCode[];
  const composition: CompositionMetadata | null =
    selection.kind === "SELECTED"
      ? {
          handlerFamily: selection.implementation.registration.family,
          handlerVersion: selection.implementation.registration.version,
          registryVersion: context.registry.version,
          rankingPolicyVersion: context.rankingPolicyVersion,
          valueMethodId: context.value.price.methodId,
          valueMethodVersion: context.value.price.methodVersion,
          valueWindowFrom: context.window.from,
          valueWindowTo: context.window.to,
          createdAt: context.now,
        }
      : null;
  const identity = {
    evaluatedAt: context.now,
    compositionVersion: context.compositionVersion,
    registryVersion: context.registry.version,
    rankingPolicyVersion: context.rankingPolicyVersion,
    value: context.value,
    profile: { id: context.profile.id, version: context.profile.version },
    window: context.window,
    handler:
      selection.kind === "SELECTED"
        ? {
            family: selection.implementation.registration.family,
            version: selection.implementation.registration.version,
            generator: selection.implementation.registration.generatorVersion,
            validators: [...selection.implementation.registration.validatorVersions].sort(),
            measurement: selection.implementation.registration.measurementFactoryVersion,
            applicability: selection.implementation.registration.applicabilityEstimatorVersion,
          }
        : null,
    findings,
    links: correlation.links,
    artifacts,
    measurement,
    expectedSavingsUsdPerWeek: value,
  };
  return {
    immutableId: `hre:${digest(identity)}`,
    lifecycle: actionable ? "ACTIONABLE" : "INVESTIGATE",
    findingIds: findings.map((f) => f.id),
    links: correlation.links.map((link) => ({
      findingId: link.findingId,
      ceuPoolId: link.ceuPoolId,
      role: link.role,
      contributionCeuPerWeek: link.contributionCeuPerWeek,
      ownsValue: link.role === "PRIMARY",
    })),
    expectedSavingsUsdPerWeek: value,
    artifacts,
    measurement,
    composition,
    reasonCodes,
  };
}
