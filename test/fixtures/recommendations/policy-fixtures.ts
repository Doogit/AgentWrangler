import type {
  CapabilityProfile,
  HandlerRegistration,
} from "../../../src/recommendations/capabilities.js";
import type {
  ExpectedSavingsInput,
  RankableRecommendation,
} from "../../../src/recommendations/ranking-policy.js";
import type { RecommendationId, SafeCode } from "../../../src/recommendations/types.js";

const window = { from: "2026-09-09T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z" };
const factor = (value: number | null, methodId: string) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: window,
  uncertainty: { lower: value, upper: value },
});

export const valueFixture: ExpectedSavingsInput = {
  exclusivePoolCeuPerWeek: factor(100, "exclusive-ceu"),
  listPriceUsdPerCeu: factor(0.1, "price-2026-09-16"),
  detectorConfidence: factor(0.8, "detector-confidence"),
  handlerApplicability: factor(0.5, "handler-applicability"),
  expectedEffectFraction: factor(0.25, "family-prior"),
};

const candidate = (
  stableId: string,
  expectedSavingsUsdPerWeek: number | null,
  options: Partial<RankableRecommendation> = {},
): RankableRecommendation => ({
  stableId: stableId as RecommendationId,
  expectedSavingsUsdPerWeek,
  confidence: 0.8,
  applicability: 0.7,
  evidenceNewestAt: "2026-09-16T00:00:00.000Z",
  safetyPin: null,
  ...options,
});

export const rankingFixtures = {
  valueHigh: candidate("recommendation:value-high", 20),
  valueLow: candidate("recommendation:value-low", 5),
  valueUnknown: candidate("recommendation:value-unknown", null),
  safetyOne: candidate("recommendation:safety-one", null, {
    safetyPin: {
      reviewed: true,
      safetyClass: "SECRET",
      priority: 1,
      reasonCode: "SECRET_EXPOSURE_RISK" as SafeCode,
    },
  }),
  safetyTwo: candidate("recommendation:safety-two", 1, {
    safetyPin: {
      reviewed: true,
      safetyClass: "DESTRUCTIVE_ACTION",
      priority: 2,
      reasonCode: "DESTRUCTIVE_ACTION_RISK" as SafeCode,
    },
  }),
  safetyOverflow: candidate("recommendation:safety-overflow", 30, {
    safetyPin: {
      reviewed: true,
      safetyClass: "PROTECTED_PATH",
      priority: 3,
      reasonCode: "PROTECTED_PATH_RISK" as SafeCode,
    },
  }),
  safetyFour: candidate("recommendation:safety-four", 2, {
    safetyPin: {
      reviewed: true,
      safetyClass: "HIGH_INTEGRITY",
      priority: 4,
      reasonCode: "HIGH_INTEGRITY_RISK" as SafeCode,
    },
  }),
  unreviewedSafety: candidate("recommendation:unreviewed", 40, {
    safetyPin: {
      reviewed: false,
      safetyClass: "HIGH_INTEGRITY",
      priority: 0,
      reasonCode: "UNREVIEWED" as SafeCode,
    },
  }),
} as const;

export const capabilityProfile: CapabilityProfile = {
  id: "capability-profile:fixture",
  version: "capability-profile-1",
  claudeCodeVersion: "2.1.0",
  platform: "WINDOWS",
  workspaceScope: "workspace:fixture",
  createdAt: "2026-09-16T00:00:00.000Z",
  expiresAt: "2026-09-18T00:00:00.000Z",
  observations: [
    {
      capability: "settings.permissions.allow",
      verdict: "SUPPORTED",
      source: "LOCAL_CANARY",
      canaryVersion: "permission-canary-1",
      observedAt: "2026-09-16T00:00:00.000Z",
    },
  ],
};

export const handlerRegistration: HandlerRegistration = {
  family: "permission-friction",
  version: "handler-1",
  registryVersion: "handler-registry-1",
  status: "ACTIVE",
  acceptedEvidence: [{ detectorId: "C9", schemaVersion: 2 }],
  artifactKinds: ["config_diff"],
  capabilityRequirements: [
    {
      capability: "settings.permissions.allow",
      allowedSources: ["LOCAL_CANARY"],
      allowedCanaryVersions: ["permission-canary-1"],
    },
  ],
  correlationKeyVersion: "permission-scope-1",
  priorityClass: "VALUE",
  generatorVersion: "permission-generator-1",
  validatorVersions: ["permission-validator-1"],
  measurementFactoryVersion: "permission-measurement-1",
  applicabilityEstimatorVersion: "permission-applicability-1",
  supersededBy: null,
  historicalDecoderVersion: "handler-history-1",
};
