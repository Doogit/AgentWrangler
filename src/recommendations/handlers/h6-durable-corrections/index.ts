import { createHash } from "node:crypto";
import type { HandlerRegistration } from "../../capabilities.js";
import type { EngineFinding } from "../../correlation.js";
import type {
  ArtifactContract,
  HandlerImplementation,
  MeasurementContract,
} from "../../registry.js";

export const H6_HANDLER_FAMILY = "h6-durable-corrections";
export const H6_HANDLER_VERSION = "1.0.0";
export const H6_REGISTRY_VERSION = "recommendation-registry-1";
export const H6_GENERATOR_VERSION = "h6-durable-correction-rule-generator-1";
export const H6_VALIDATOR_VERSIONS = [
  "h6-structural-artifact-validator-1",
  "h6-instruction-precedence-validator-1",
  "h6-rollback-validator-1",
] as const;
export const H6_MEASUREMENT_FACTORY_VERSION = "h6-repeat-correction-measurement-1";
export const H6_APPLICABILITY_ESTIMATOR_VERSION = "h6-classified-correction-signal-1";
export const H6_CAPABILITY = "claude-md-project-rules";

/**
 * Spec family map: H6 durable corrections <- D1, D3-D5. Spec-D3 is retired and its
 * id must not be reused (`src/detector/registry.ts`), leaving the shipped D1, D4, D5.
 */
export const H6_SUPPORTED_DETECTORS = ["D1", "D4", "D5"] as const;
type H6DetectorId = (typeof H6_SUPPORTED_DETECTORS)[number];

export const H6_CORRECTION_CLASSES = [
  "BROAD_INSTRUCTION_TRIM",
  "MODEL_SELECTION_RULE",
  "BUDGET_GUARDRAIL_RULE",
] as const;
export type H6CorrectionClass = (typeof H6_CORRECTION_CLASSES)[number];

const CLASS_BY_DETECTOR = {
  D1: "BROAD_INSTRUCTION_TRIM",
  D4: "MODEL_SELECTION_RULE",
  D5: "BUDGET_GUARDRAIL_RULE",
} as const;

/**
 * Instruction precedence: a specific rule (D4/D5) outranks the broad instruction trim
 * (D1), so a broad and a narrow correction cannot both claim the same opportunity.
 */
const PRECEDENCE_RANK: Record<H6CorrectionClass, number> = {
  BROAD_INSTRUCTION_TRIM: 1,
  MODEL_SELECTION_RULE: 2,
  BUDGET_GUARDRAIL_RULE: 2,
};

const guidanceByClass: Record<H6CorrectionClass, readonly string[]> = {
  BROAD_INSTRUCTION_TRIM: [
    "TRIM_ALWAYS_LOADED_INSTRUCTIONS_TO_RECOMMENDED_CAP",
    "KEEP_ONLY_CURRENT_RULES_AND_LINKS",
  ],
  MODEL_SELECTION_RULE: ["PIN_MODEL_PER_TASK_CLASS", "RECORD_MODEL_CHOICE_RATIONALE"],
  BUDGET_GUARDRAIL_RULE: ["SET_BUDGET_GUARDRAIL_BEFORE_LONG_RUN", "STOP_AT_DEFINED_LIMIT"],
};

const SUPPORTED = new Set<string>(H6_SUPPORTED_DETECTORS);
const MAX_FINDINGS = 3;
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

function classFor(detectorId: H6DetectorId): H6CorrectionClass {
  return CLASS_BY_DETECTOR[detectorId];
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
  readonly classes: readonly H6CorrectionClass[];
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
  const highestRank = Math.max(
    ...sorted.map((finding) => PRECEDENCE_RANK[classFor(finding.detectorId as H6DetectorId)]),
  );
  const winners = sorted.filter(
    (finding) => PRECEDENCE_RANK[classFor(finding.detectorId as H6DetectorId)] === highestRank,
  );
  const classes = H6_CORRECTION_CLASSES.filter((correctionClass) =>
    winners.some((finding) => classFor(finding.detectorId as H6DetectorId) === correctionClass),
  );
  return { findings: winners, classes };
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

function buildContracts(
  findings: readonly EngineFinding[],
  now: string,
  window: { readonly from: string; readonly to: string },
): { readonly artifact: ArtifactContract; readonly measurement: MeasurementContract } | null {
  const canonical = canonicalFindings(findings, window.from, window.to);
  if (canonical === null) return null;
  const descriptor = {
    schemaVersion: 1,
    family: H6_HANDLER_FAMILY,
    generatorVersion: H6_GENERATOR_VERSION,
    artifactKind: "claude_md_rule",
    postureCode: "DURABLE_GUIDANCE_NOT_ENFORCEMENT",
    correctionClasses: canonical.classes,
    guidanceCodes: canonical.classes.flatMap((correctionClass) => guidanceByClass[correctionClass]),
    excludedClaims: [
      "CLAUDE_MD_IS_ENFORCED_CONFIGURATION",
      "GUARANTEED_INSTRUCTION_COMPLIANCE",
      "AUTOMATIC_DEDUPLICATION_BY_CLAUDE_CODE",
      "HOOK_ENFORCEMENT_WITHOUT_VERIFIED_CAPABILITY",
    ],
  } as const;
  const rollbackDescriptor = {
    schemaVersion: 1,
    strategyCode: "REMOVE_GENERATED_DURABLE_CORRECTION_RULE_BLOCK",
    noOpCode: "NO_CHANGE_IF_RULE_NOT_APPLIED",
  } as const;
  const scopeIdentity = {
    correctionClasses: canonical.classes,
    findingIds: canonical.findings.map((finding) => finding.id),
    window: { from: window.from, to: window.to },
  };
  const artifactHash = sha256(canonicalJson(descriptor));
  const rollbackHash = sha256(canonicalJson(rollbackDescriptor));
  const scopeHash = sha256(canonicalJson(scopeIdentity));
  const targetHash = sha256("CLAUDE_MD_DURABLE_CORRECTION_RULE");
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
    applyMechanismCode: "H6_CLAUDE_MD_RULE_REVIEW",
  };
  const measurement: MeasurementContract = {
    verdict: "VALIDATED_PROXY",
    measurementMethodId: measurementId({
      artifactRevisionId,
      factoryVersion: H6_MEASUREMENT_FACTORY_VERSION,
      window,
    }),
    methodVersion: H6_MEASUREMENT_FACTORY_VERSION,
    artifactRevisionId,
    targetMetricCode: "REPEAT_CORRECTION_RATE",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 14,
      baselineCohortCode: "H6_BASELINE_CORRECTION_WINDOW",
      afterCohortCode: "H6_AFTER_RULE_CORRECTION_WINDOW",
      guardrailCodes: ["TASK_SUCCESS_RATE_NOT_REDUCED", "INSTRUCTION_CONFLICT_RATE_NOT_INCREASED"],
      comparabilityCode: "H6_MATCHED_WORKSPACE_INSTRUCTION_WINDOW",
    },
    createdAt: now,
  };
  return { artifact, measurement };
}

export function validateH6ArtifactContract(
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

export function validateH6MeasurementContract(
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

export const h6DurableCorrectionsRegistration: HandlerRegistration = {
  family: H6_HANDLER_FAMILY,
  version: H6_HANDLER_VERSION,
  registryVersion: H6_REGISTRY_VERSION,
  status: "ACTIVE",
  acceptedEvidence: H6_SUPPORTED_DETECTORS.map((detectorId) => ({ detectorId, schemaVersion: 2 })),
  artifactKinds: ["claude_md_rule"],
  capabilityRequirements: [
    {
      capability: H6_CAPABILITY,
      allowedSources: ["VERSION_GATE"],
      allowedCanaryVersions: [],
    },
  ],
  correlationKeyVersion: "h6-durable-correction-1",
  priorityClass: "VALUE",
  generatorVersion: H6_GENERATOR_VERSION,
  validatorVersions: H6_VALIDATOR_VERSIONS,
  measurementFactoryVersion: H6_MEASUREMENT_FACTORY_VERSION,
  applicabilityEstimatorVersion: H6_APPLICABILITY_ESTIMATOR_VERSION,
  supersededBy: null,
  historicalDecoderVersion: "h6-durable-corrections-history-1",
};

export const h6DurableCorrectionsHandler: HandlerImplementation = {
  registration: h6DurableCorrectionsRegistration,
  compose(input) {
    try {
      if (!validInput(input)) return { artifacts: [], measurement: null };
      const contracts = buildContracts(input.findings, input.now, input.window);
      if (contracts === null) return { artifacts: [], measurement: null };
      if (
        !validateH6ArtifactContract(contracts.artifact, input.findings, input.now, input.window)
      ) {
        return { artifacts: [], measurement: null };
      }
      if (
        !validateH6MeasurementContract(
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
