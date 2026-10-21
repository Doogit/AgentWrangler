import { createHash } from "node:crypto";
import type { HandlerRegistration } from "../../capabilities.js";
import type { EngineFinding } from "../../correlation.js";
import type {
  ArtifactContract,
  HandlerImplementation,
  MeasurementContract,
} from "../../registry.js";

export const H2_HANDLER_FAMILY = "h2-output-context";
export const H2_HANDLER_VERSION = "1.0.0";
export const H2_REGISTRY_VERSION = "recommendation-registry-1";
export const H2_GENERATOR_VERSION = "h2-bounded-output-rule-generator-1";
export const H2_VALIDATOR_VERSIONS = [
  "h2-structural-artifact-validator-1",
  "h2-privacy-validator-1",
  "h2-rollback-validator-1",
] as const;
export const H2_MEASUREMENT_FACTORY_VERSION = "h2-output-exposure-measurement-1";
export const H2_APPLICABILITY_ESTIMATOR_VERSION = "h2-output-exposure-applicability-1";
export const H2_CAPABILITY = "claude-md-project-rules";

const MAX_FINDINGS = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_ID = /^artifact:[a-f0-9]{64}$/;
const MEASUREMENT_ID = /^measurement:[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SUPPORTED_EVIDENCE = new Set(["A1@2", "A2@2"]);
const H2_GUARDRAIL_CODES = ["NO_ERROR_RATE_REGRESSION", "NO_TASK_SUCCESS_REGRESSION"] as const;

const canonicalArtifactDescriptor = {
  schemaVersion: 1,
  family: H2_HANDLER_FAMILY,
  generatorVersion: H2_GENERATOR_VERSION,
  artifactKind: "claude_md_rule",
  guidanceCodes: ["BOUND_VERBOSE_OUTPUT", "PREFER_RANGE_READS", "REFERENCE_FILES_WITHOUT_REPASTE"],
  excludedClaims: [
    "BASH_UPDATED_INPUT_RELIABLE",
    "BASH_UPDATED_TOOL_OUTPUT_RELIABLE",
    "CLAUDEIGNORE_SUPPORTED",
    "UNVERIFIED_MCP_SAVINGS",
  ],
} as const;

const canonicalRollbackDescriptor = {
  schemaVersion: 1,
  family: H2_HANDLER_FAMILY,
  generatorVersion: H2_GENERATOR_VERSION,
  rollbackCode: "REMOVE_GENERATED_CONTEXT_RULE_BLOCK",
} as const;

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const ARTIFACT_HASH = digest(canonicalArtifactDescriptor);
const ROLLBACK_HASH = digest(canonicalRollbackDescriptor);
const SCOPE_HASH = digest({ schemaVersion: 1, scopeCode: "WORKSPACE_RULE_SCOPE" });
const TARGET_HASH = digest({ schemaVersion: 1, targetCode: "CLAUDE_MD_CONTEXT_DISCIPLINE" });
const ROLLBACK_ARTIFACT_REVISION_ID = `artifact:${digest({
  ...canonicalRollbackDescriptor,
  rollbackHash: ROLLBACK_HASH,
})}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBoundedStructuralString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => character.charCodeAt(0) <= 31)
  );
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ceuPerWeek",
      "ceuPoolId",
      "confidence",
      "correlationKey",
      "detectorId",
      "id",
      "observedAt",
      "schemaVersion",
    ])
  ) {
    return false;
  }
  return (
    typeof value.detectorId === "string" &&
    typeof value.schemaVersion === "number" &&
    SUPPORTED_EVIDENCE.has(`${value.detectorId}@${value.schemaVersion}`) &&
    isBoundedStructuralString(value.id) &&
    isBoundedStructuralString(value.correlationKey) &&
    isBoundedStructuralString(value.ceuPoolId) &&
    isCanonicalTimestamp(value.observedAt) &&
    value.observedAt >= from &&
    value.observedAt < to &&
    isPrecisePositive(value.ceuPerWeek) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence > 0 &&
    value.confidence <= 1
  );
}

function validComposeInput(
  value: unknown,
): value is Parameters<HandlerImplementation["compose"]>[0] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["findings", "now", "window"]) ||
    !Array.isArray(value.findings) ||
    value.findings.length === 0 ||
    value.findings.length > MAX_FINDINGS ||
    !isCanonicalTimestamp(value.now) ||
    !isRecord(value.window) ||
    !hasExactKeys(value.window, ["from", "to"]) ||
    !isCanonicalTimestamp(value.window.from) ||
    !isCanonicalTimestamp(value.window.to) ||
    value.window.from >= value.window.to ||
    value.window.to > value.now
  ) {
    return false;
  }
  const windowFrom = value.window.from;
  const windowTo = value.window.to;
  return value.findings.every((finding) => validFinding(finding, windowFrom, windowTo));
}

function artifactRevisionId(createdAt: string): string {
  return `artifact:${digest({
    artifactHash: ARTIFACT_HASH,
    createdAt,
    generatorVersion: H2_GENERATOR_VERSION,
    rollbackHash: ROLLBACK_HASH,
    scopeHash: SCOPE_HASH,
    targetHash: TARGET_HASH,
  })}`;
}

function measurementMethodId(
  boundArtifactRevisionId: string,
  window: { readonly from: string; readonly to: string },
): string {
  return `measurement:${digest({
    artifactRevisionId: boundArtifactRevisionId,
    factoryVersion: H2_MEASUREMENT_FACTORY_VERSION,
    window: { from: window.from, to: window.to },
  })}`;
}

function createArtifact(createdAt: string): ArtifactContract {
  return {
    artifactRevisionId: artifactRevisionId(createdAt),
    kind: "claude_md_rule",
    validationStatus: "VALIDATED",
    validated: true,
    artifactHash: ARTIFACT_HASH,
    scopeHash: SCOPE_HASH,
    targetHash: TARGET_HASH,
    rollbackArtifactRevisionId: ROLLBACK_ARTIFACT_REVISION_ID,
    rollbackHash: ROLLBACK_HASH,
    supersedesArtifactRevisionId: null,
    createdAt,
    applyMechanismCode: "H2_RULE_BLOCK_REVIEW",
  };
}

function createMeasurement(
  artifactRevisionIdValue: string,
  createdAt: string,
  window: { readonly from: string; readonly to: string },
): MeasurementContract {
  return {
    verdict: "VALIDATED_PROXY",
    measurementMethodId: measurementMethodId(artifactRevisionIdValue, window),
    methodVersion: H2_MEASUREMENT_FACTORY_VERSION,
    artifactRevisionId: artifactRevisionIdValue,
    targetMetricCode: "OUTPUT_EXPOSURE_CEU_PER_WEEK",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "H2_BASELINE_WINDOW",
      afterCohortCode: "H2_AFTER_WINDOW",
      guardrailCodes: H2_GUARDRAIL_CODES,
      comparabilityCode: "H2_MATCHED_WORKSPACE_WINDOW",
    },
    createdAt,
  };
}

function validateH2ArtifactContractUnchecked(value: unknown): value is ArtifactContract {
  if (
    !isRecord(value) ||
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
    ]) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return false;
  }
  return (
    value.artifactRevisionId === artifactRevisionId(value.createdAt) &&
    ARTIFACT_ID.test(value.artifactRevisionId) &&
    value.kind === "claude_md_rule" &&
    value.validationStatus === "VALIDATED" &&
    value.validated === true &&
    value.artifactHash === ARTIFACT_HASH &&
    SHA256.test(value.artifactHash) &&
    value.scopeHash === SCOPE_HASH &&
    value.targetHash === TARGET_HASH &&
    value.rollbackArtifactRevisionId === ROLLBACK_ARTIFACT_REVISION_ID &&
    value.rollbackArtifactRevisionId !== value.artifactRevisionId &&
    value.rollbackHash === ROLLBACK_HASH &&
    value.supersedesArtifactRevisionId === null &&
    value.applyMechanismCode === "H2_RULE_BLOCK_REVIEW"
  );
}

export function validateH2ArtifactContract(value: unknown): value is ArtifactContract {
  try {
    return validateH2ArtifactContractUnchecked(value);
  } catch {
    return false;
  }
}

function validateH2MeasurementContractUnchecked(
  value: unknown,
  boundArtifactRevisionId: string,
  window: { readonly from: string; readonly to: string },
): value is MeasurementContract {
  if (
    !isRecord(window) ||
    !hasExactKeys(window, ["from", "to"]) ||
    !isCanonicalTimestamp(window.from) ||
    !isCanonicalTimestamp(window.to) ||
    window.from >= window.to ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "artifactRevisionId",
      "createdAt",
      "definition",
      "measurementMethodId",
      "methodVersion",
      "targetMetricCode",
      "verdict",
    ]) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isRecord(value.definition) ||
    !hasExactKeys(value.definition, [
      "afterCohortCode",
      "baselineCohortCode",
      "comparabilityCode",
      "guardrailCodes",
      "horizonDays",
      "targetDirection",
    ])
  ) {
    return false;
  }
  return (
    value.verdict === "VALIDATED_PROXY" &&
    value.artifactRevisionId === boundArtifactRevisionId &&
    ARTIFACT_ID.test(value.artifactRevisionId) &&
    value.artifactRevisionId === artifactRevisionId(value.createdAt) &&
    value.measurementMethodId === measurementMethodId(boundArtifactRevisionId, window) &&
    MEASUREMENT_ID.test(value.measurementMethodId) &&
    value.methodVersion === H2_MEASUREMENT_FACTORY_VERSION &&
    value.targetMetricCode === "OUTPUT_EXPOSURE_CEU_PER_WEEK" &&
    value.definition.targetDirection === "REDUCE" &&
    value.definition.horizonDays === 7 &&
    value.definition.baselineCohortCode === "H2_BASELINE_WINDOW" &&
    value.definition.afterCohortCode === "H2_AFTER_WINDOW" &&
    Array.isArray(value.definition.guardrailCodes) &&
    value.definition.guardrailCodes.length === H2_GUARDRAIL_CODES.length &&
    value.definition.guardrailCodes.every(
      (code, index) =>
        typeof code === "string" && SAFE_CODE.test(code) && code === H2_GUARDRAIL_CODES[index],
    ) &&
    value.definition.comparabilityCode === "H2_MATCHED_WORKSPACE_WINDOW"
  );
}

export function validateH2MeasurementContract(
  value: unknown,
  boundArtifactRevisionId: string,
  window: { readonly from: string; readonly to: string },
): value is MeasurementContract {
  try {
    return validateH2MeasurementContractUnchecked(value, boundArtifactRevisionId, window);
  } catch {
    return false;
  }
}

export const h2OutputContextRegistration: HandlerRegistration = {
  family: H2_HANDLER_FAMILY,
  version: H2_HANDLER_VERSION,
  registryVersion: H2_REGISTRY_VERSION,
  status: "ACTIVE",
  acceptedEvidence: [
    { detectorId: "A1", schemaVersion: 2 },
    { detectorId: "A2", schemaVersion: 2 },
  ],
  artifactKinds: ["claude_md_rule"],
  capabilityRequirements: [
    {
      capability: H2_CAPABILITY,
      allowedSources: ["VERSION_GATE"],
      allowedCanaryVersions: [],
    },
  ],
  correlationKeyVersion: "h2-output-scope-1",
  priorityClass: "VALUE",
  generatorVersion: H2_GENERATOR_VERSION,
  validatorVersions: H2_VALIDATOR_VERSIONS,
  measurementFactoryVersion: H2_MEASUREMENT_FACTORY_VERSION,
  applicabilityEstimatorVersion: H2_APPLICABILITY_ESTIMATOR_VERSION,
  supersededBy: null,
  historicalDecoderVersion: "h2-output-context-history-1",
};

export const h2OutputContextHandler: HandlerImplementation = {
  registration: h2OutputContextRegistration,
  compose(input) {
    try {
      if (!validComposeInput(input)) return { artifacts: [], measurement: null };
      const artifact = createArtifact(input.now);
      if (!validateH2ArtifactContract(artifact)) return { artifacts: [], measurement: null };
      const measurement = createMeasurement(artifact.artifactRevisionId, input.now, input.window);
      if (!validateH2MeasurementContract(measurement, artifact.artifactRevisionId, input.window)) {
        return { artifacts: [], measurement: null };
      }
      return { artifacts: [artifact], measurement };
    } catch {
      return { artifacts: [], measurement: null };
    }
  },
};
