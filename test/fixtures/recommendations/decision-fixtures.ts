import type {
  AdmissionInput,
  ArtifactApplication,
  EffectCycleLink,
  MeasurementMethod,
  Recommendation,
  RecommendationRevision,
  RemediationArtifactRevision,
} from "../../../src/recommendations/types.js";

const ids = {
  recommendation: "recommendation:context" as Recommendation["id"],
  revisionOne: "recommendation-revision:context:1" as RecommendationRevision["id"],
  revisionTwo: "recommendation-revision:context:2" as RecommendationRevision["id"],
  artifact: "artifact-revision:context:2" as RemediationArtifactRevision["id"],
  application: "artifact-application:context:2" as ArtifactApplication["id"],
  method: "measurement-method:context:2" as MeasurementMethod["id"],
  cycle: "effect-cycle:context:2" as EffectCycleLink["id"],
  finding: "finding:context" as RecommendationRevision["findingIds"][number],
  valueMethod: "measurement-method:value" as RecommendationRevision["expectedSavings"]["methodId"],
};

export const recommendation: Recommendation = {
  id: ids.recommendation,
  activeRevisionId: ids.revisionOne,
};
export const revisionOne: RecommendationRevision = {
  id: ids.revisionOne,
  recommendationId: ids.recommendation,
  supersedesRevisionId: null,
  handlerVersion: "handler-1",
  registryVersion: "registry-1",
  rankingPolicyVersion: "ranking-1",
  findingIds: [ids.finding],
  expectedSavings: {
    value: 12,
    unit: "USD_PER_WEEK",
    methodId: ids.valueMethod,
    methodVersion: "value-1",
    window: { from: "2026-01-01", to: "2026-01-07" },
    uncertainty: { lower: 8, upper: 16 },
  },
  reasonCodes: ["FIXTURE" as RecommendationRevision["reasonCodes"][number]],
};
export const revisionTwo: RecommendationRevision = {
  ...revisionOne,
  id: ids.revisionTwo,
  supersedesRevisionId: ids.revisionOne,
};
export const artifact: RemediationArtifactRevision = {
  id: ids.artifact,
  recommendationRevisionId: ids.revisionTwo,
  artifactHash: "sha256:fixture",
  capabilityProfileVersion: "capability-1",
  rollbackAvailable: true,
};
export const application: ArtifactApplication = {
  id: ids.application,
  artifactRevisionId: ids.artifact,
  observedRecommendationRevisionId: ids.revisionTwo,
  result: "APPLIED",
};
export const method: MeasurementMethod = {
  id: ids.method,
  artifactRevisionId: ids.artifact,
  methodVersion: "method-1",
};
export const effectCycle: EffectCycleLink = {
  id: ids.cycle,
  recommendationId: ids.recommendation,
  recommendationRevisionId: ids.revisionTwo,
  artifactApplicationId: ids.application,
  artifactRevisionId: ids.artifact,
  measurementMethodId: ids.method,
  verdict: "IMPROVED",
};

export const primaryAdmission: AdmissionInput = {
  deterministicHandler: true,
  artifactValidated: true,
  rollbackAvailable: true,
  expectedSavingsUsdPerWeek: 12,
  exclusiveCeuPool: true,
  measurementVerdict: "AUTOMATIC",
  hasFailedGate: false,
  safetyException: null,
};
