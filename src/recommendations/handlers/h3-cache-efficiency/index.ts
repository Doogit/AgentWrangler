import { createHash } from "node:crypto";
import type { HandlerRegistration } from "../../capabilities.js";
import type { EngineFinding } from "../../correlation.js";
import type {
  ArtifactContract,
  HandlerImplementation,
  MeasurementContract,
} from "../../registry.js";

export const H3_HANDLER_FAMILY = "h3-cache-efficiency";
export const H3_HANDLER_VERSION = "1.0.0";
export const H3_REGISTRY_VERSION = "recommendation-registry-1";
export const H3_GENERATOR_VERSION = "h3-cache-behavior-rule-generator-1";
export const H3_VALIDATOR_VERSIONS = [
  "h3-structural-artifact-validator-1",
  "h3-provider-claim-validator-1",
  "h3-rollback-validator-1",
] as const;
export const H3_MEASUREMENT_FACTORY_VERSION = "h3-cache-creation-measurement-1";
export const H3_APPLICABILITY_ESTIMATOR_VERSION = "h3-classified-cache-signal-1";
export const H3_CAPABILITY = "claude-md-project-rules";

export const H3_SUPPORTED_DETECTORS = ["B1", "B2", "B3", "B4"] as const;
type H3DetectorId = (typeof H3_SUPPORTED_DETECTORS)[number];
type H3ClassifiedDetector = Exclude<H3DetectorId, "B1">;

const SUPPORTED = new Set<string>(H3_SUPPORTED_DETECTORS);
const CLASSIFIED = new Set<string>(["B2", "B3", "B4"]);
const MAX_FINDINGS = 2;
const FINDING_KEYS = [
  "ceuPerWeek",
  "ceuPoolId",
  "confidence",
  "correlationKey",
  "detectorId",
  "id",
  "observedAt",
  "schemaVersion",
] as const;
const ARTIFACT_ID = /^artifact:[a-f0-9]{64}$/;
const MEASUREMENT_ID = /^measurement:[a-f0-9]{64}$/;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => JSON.stringify(value);
const artifactId = (value: unknown): string => `artifact:${sha256(canonicalJson(value))}`;
const measurementId = (value: unknown): string => `measurement:${sha256(canonicalJson(value))}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBoundedStructuralString(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isPrecisePositive(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isSafeInteger(value * 1_000_000)
  );
}

function validFinding(value: unknown, from: string, to: string): value is EngineFinding {
  if (!hasExactKeys(value, FINDING_KEYS)) return false;
  return (
    typeof value.detectorId === "string" &&
    SUPPORTED.has(value.detectorId) &&
    value.schemaVersion === 2 &&
    isBoundedStructuralString(value.id) &&
    isCanonicalTime(value.observedAt) &&
    value.observedAt >= from &&
    value.observedAt < to &&
    isBoundedStructuralString(value.correlationKey) &&
    isBoundedStructuralString(value.ceuPoolId) &&
    isPrecisePositive(value.ceuPerWeek) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence > 0 &&
    value.confidence <= 1
  );
}

function canonicalFindings(
  findings: readonly EngineFinding[],
  from: string,
  to: string,
): {
  readonly findings: readonly EngineFinding[];
  readonly classifier: H3ClassifiedDetector;
} | null {
  if (!Array.isArray(findings) || findings.length === 0 || findings.length > MAX_FINDINGS)
    return null;
  if (!findings.every((finding) => validFinding(finding, from, to))) return null;
  const sorted = [...findings].sort(
    (a, b) => a.detectorId.localeCompare(b.detectorId) || a.id.localeCompare(b.id),
  );
  if (new Set(sorted.map((finding) => finding.id)).size !== sorted.length) return null;
  if (new Set(sorted.map((finding) => finding.detectorId)).size !== sorted.length) return null;
  if (new Set(sorted.map((finding) => finding.correlationKey)).size !== 1) return null;
  if (new Set(sorted.map((finding) => finding.ceuPoolId)).size !== 1) return null;
  if (new Set(sorted.map((finding) => finding.ceuPerWeek)).size !== 1) return null;
  const classifiers = sorted.filter((finding) => CLASSIFIED.has(finding.detectorId));
  if (classifiers.length !== 1) return null;
  if (sorted.some((finding) => finding.detectorId !== "B1" && finding !== classifiers[0]))
    return null;
  return { findings: sorted, classifier: classifiers[0]?.detectorId as H3ClassifiedDetector };
}

function validInput(value: unknown): value is Parameters<HandlerImplementation["compose"]>[0] {
  if (
    !hasExactKeys(value, ["findings", "now", "window"]) ||
    !Array.isArray(value.findings) ||
    !isCanonicalTime(value.now) ||
    !hasExactKeys(value.window, ["from", "to"]) ||
    !isCanonicalTime(value.window.from) ||
    !isCanonicalTime(value.window.to) ||
    value.window.from >= value.window.to ||
    value.window.to > value.now
  ) {
    return false;
  }
  return canonicalFindings(value.findings, value.window.from, value.window.to) !== null;
}

const guidanceByClassifier = {
  B2: ["PLAN_AROUND_OBSERVED_TTL_BOUNDARY", "DO_NOT_PROMISE_CACHE_RETENTION"],
  B3: ["PREFER_CONTINUITY_FOR_IMMEDIATE_RESUME", "ACCEPT_COLD_REBUILD_OUTSIDE_TTL"],
  B4: ["KEEP_MODEL_EFFORT_AND_TOOL_PREFIX_STABLE", "INSPECT_USAGE_CAUSE_BEFORE_CHANGING_CONFIG"],
} as const;

function buildContracts(
  findings: readonly EngineFinding[],
  now: string,
  window: { readonly from: string; readonly to: string },
): { readonly artifact: ArtifactContract; readonly measurement: MeasurementContract } | null {
  const canonical = canonicalFindings(findings, window.from, window.to);
  if (canonical === null) return null;
  const descriptor = {
    schemaVersion: 1,
    family: H3_HANDLER_FAMILY,
    generatorVersion: H3_GENERATOR_VERSION,
    artifactKind: "claude_md_rule",
    postureCode: "BEHAVIORAL_GUIDANCE_NOT_CACHE_ENFORCEMENT",
    classifier: canonical.classifier,
    guidanceCodes: guidanceByClassifier[canonical.classifier],
    excludedClaims: [
      "GUARANTEED_CACHE_REUSE",
      "USER_CONTROLLED_BREAKPOINT_PLACEMENT",
      "HOOK_CAN_STABILIZE_PROVIDER_PREFIX",
      "KEEPALIVE_WITHOUT_QUOTA_COST",
    ],
  } as const;
  const rollbackDescriptor = {
    schemaVersion: 1,
    strategyCode: "REMOVE_GENERATED_CACHE_GUIDANCE_RULE_BLOCK",
    noOpCode: "NO_CHANGE_IF_RULE_NOT_APPLIED",
  } as const;
  const scopeIdentity = {
    classifier: canonical.classifier,
    findingIds: canonical.findings.map((finding) => finding.id),
    window: { from: window.from, to: window.to },
  };
  const artifactHash = sha256(canonicalJson(descriptor));
  const rollbackHash = sha256(canonicalJson(rollbackDescriptor));
  const scopeHash = sha256(canonicalJson(scopeIdentity));
  const targetHash = sha256("CLAUDE_MD_CACHE_BEHAVIOR_GUIDANCE");
  const artifactRevisionId = artifactId({
    artifactHash,
    createdAt: now,
    rollbackHash,
    scopeHash,
    targetHash,
  });
  const rollbackArtifactRevisionId = artifactId({ artifactRevisionId, rollbackHash });
  const artifact: ArtifactContract = {
    artifactRevisionId,
    kind: "claude_md_rule",
    validationStatus: "VALIDATED",
    validated: true,
    artifactHash,
    scopeHash,
    targetHash,
    rollbackArtifactRevisionId,
    rollbackHash,
    supersedesArtifactRevisionId: null,
    createdAt: now,
    applyMechanismCode: "H3_RULE_BLOCK_REVIEW",
  };
  const measurement: MeasurementContract = {
    verdict: "VALIDATED_PROXY",
    measurementMethodId: measurementId({
      artifactRevisionId,
      factoryVersion: H3_MEASUREMENT_FACTORY_VERSION,
      window,
    }),
    methodVersion: H3_MEASUREMENT_FACTORY_VERSION,
    artifactRevisionId,
    targetMetricCode: "CACHE_CREATION_CEU_PER_WEEK",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "H3_BASELINE_CACHE_WINDOW",
      afterCohortCode: "H3_AFTER_RULE_CACHE_WINDOW",
      guardrailCodes: ["TASK_SUCCESS_RATE_NOT_REDUCED", "SESSION_FAILURE_RATE_NOT_INCREASED"],
      comparabilityCode: "H3_MATCHED_WORKSPACE_CACHE_WINDOW",
    },
    createdAt: now,
  };
  return { artifact, measurement };
}

export function validateH3ArtifactContract(
  value: unknown,
  findings: readonly EngineFinding[],
  now: string,
  window: { readonly from: string; readonly to: string },
): value is ArtifactContract {
  try {
    const expected = buildContracts(findings, now, window)?.artifact;
    return expected !== undefined && canonicalJson(value) === canonicalJson(expected);
  } catch {
    return false;
  }
}

export function validateH3MeasurementContract(
  value: unknown,
  findings: readonly EngineFinding[],
  now: string,
  window: { readonly from: string; readonly to: string },
): value is MeasurementContract {
  try {
    const expected = buildContracts(findings, now, window)?.measurement;
    return (
      expected !== undefined &&
      ARTIFACT_ID.test(expected.artifactRevisionId) &&
      MEASUREMENT_ID.test(expected.measurementMethodId) &&
      canonicalJson(value) === canonicalJson(expected)
    );
  } catch {
    return false;
  }
}

export const h3CacheEfficiencyRegistration: HandlerRegistration = {
  family: H3_HANDLER_FAMILY,
  version: H3_HANDLER_VERSION,
  registryVersion: H3_REGISTRY_VERSION,
  status: "ACTIVE",
  acceptedEvidence: H3_SUPPORTED_DETECTORS.map((detectorId) => ({ detectorId, schemaVersion: 2 })),
  artifactKinds: ["claude_md_rule"],
  capabilityRequirements: [
    {
      capability: H3_CAPABILITY,
      allowedSources: ["VERSION_GATE"],
      allowedCanaryVersions: [],
    },
  ],
  correlationKeyVersion: "h3-cache-event-1",
  priorityClass: "VALUE",
  generatorVersion: H3_GENERATOR_VERSION,
  validatorVersions: H3_VALIDATOR_VERSIONS,
  measurementFactoryVersion: H3_MEASUREMENT_FACTORY_VERSION,
  applicabilityEstimatorVersion: H3_APPLICABILITY_ESTIMATOR_VERSION,
  supersededBy: null,
  historicalDecoderVersion: "h3-cache-efficiency-history-1",
};

export const h3CacheEfficiencyHandler: HandlerImplementation = {
  registration: h3CacheEfficiencyRegistration,
  compose(input) {
    try {
      if (!validInput(input)) return { artifacts: [], measurement: null };
      const contracts = buildContracts(input.findings, input.now, input.window);
      if (contracts === null) return { artifacts: [], measurement: null };
      if (
        !validateH3ArtifactContract(contracts.artifact, input.findings, input.now, input.window)
      ) {
        return { artifacts: [], measurement: null };
      }
      if (
        !validateH3MeasurementContract(
          contracts.measurement,
          input.findings,
          input.now,
          input.window,
        )
      ) {
        return { artifacts: [], measurement: null };
      }
      return { artifacts: [contracts.artifact], measurement: contracts.measurement };
    } catch {
      return { artifacts: [], measurement: null };
    }
  },
};
