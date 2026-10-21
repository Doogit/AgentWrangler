import { createHash } from "node:crypto";
import type { HandlerRegistration } from "../../capabilities.js";
import type { EngineFinding } from "../../correlation.js";
import type {
  ArtifactContract,
  HandlerImplementation,
  MeasurementContract,
} from "../../registry.js";

export const H4_HANDLER_FAMILY = "H4_ERROR_LOOP_RECOVERY";
export const H4_HANDLER_VERSION = "h4-handler-1";
export const H4_GENERATOR_ID = "h4-error-loop-prompt-generator-1";
export const H4_PROMPT_VALIDATOR_ID = "h4-error-loop-prompt-validator-1";
export const H4_MEASUREMENT_VALIDATOR_ID = "h4-error-loop-measurement-validator-1";
export const H4_MEASUREMENT_FACTORY_ID = "h4-error-loop-measurement-factory-1";
export const H4_APPLICABILITY_ESTIMATOR_ID = "h4-repeat-signal-applicability-1";
export const H4_HOOK_POSTURE = "NOT_APPLICABLE_UNVERIFIED_CAPABILITY" as const;

export const H4_SUPPORTED_DETECTORS = [
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "C7",
  "C8",
  "C10",
  "C11",
] as const;

type H4DetectorId = (typeof H4_SUPPORTED_DETECTORS)[number];
type H4EffectVerdict = "IMPROVED" | "NO_EFFECT" | "INCONCLUSIVE" | "WORSE";

const REPEAT_SIGNAL_DETECTORS = new Set<H4DetectorId>(["C4", "C5", "C6"]);
const SUPPORTED_DETECTORS = new Set<string>(H4_SUPPORTED_DETECTORS);
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
const MAX_FINDINGS = 16;
const MAX_COUNT = 1_000_000_000;
const MIN_COMPARABLE_SESSIONS = 20;
const ARTIFACT_REVISION_ID_PATTERN = /^artifact:[a-f0-9]{64}$/;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const artifactId = (value: string): string => `artifact:${sha256(value)}`;
const measurementId = (value: string): string => `measurement:${sha256(value)}`;
const canonicalJson = (value: unknown): string => JSON.stringify(value);

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isArtifactRevisionId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_REVISION_ID_PATTERN.test(value);
}

function isSafeFinding(value: unknown): value is EngineFinding {
  if (!hasExactKeys(value, FINDING_KEYS)) return false;
  const finding = value as unknown as EngineFinding;
  return (
    typeof finding.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finding.id) &&
    typeof finding.detectorId === "string" &&
    SUPPORTED_DETECTORS.has(finding.detectorId) &&
    finding.schemaVersion === 2 &&
    isCanonicalTime(finding.observedAt) &&
    typeof finding.correlationKey === "string" &&
    finding.correlationKey.length > 0 &&
    finding.correlationKey.length <= 256 &&
    typeof finding.ceuPoolId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finding.ceuPoolId) &&
    typeof finding.ceuPerWeek === "number" &&
    Number.isFinite(finding.ceuPerWeek) &&
    finding.ceuPerWeek >= 0 &&
    Number.isSafeInteger(finding.ceuPerWeek * 1_000_000) &&
    typeof finding.confidence === "number" &&
    Number.isFinite(finding.confidence) &&
    finding.confidence >= 0 &&
    finding.confidence <= 1
  );
}

function canonicalFindings(findings: readonly EngineFinding[]): readonly EngineFinding[] | null {
  if (!Array.isArray(findings) || findings.length === 0 || findings.length > MAX_FINDINGS)
    return null;
  if (!findings.every(isSafeFinding)) return null;
  const sorted = [...findings].sort(
    (a, b) => a.detectorId.localeCompare(b.detectorId) || a.id.localeCompare(b.id),
  );
  if (new Set(sorted.map((finding) => finding.id)).size !== sorted.length) return null;
  if (new Set(sorted.map((finding) => finding.correlationKey)).size !== 1) return null;
  if (new Set(sorted.map((finding) => finding.ceuPoolId)).size !== 1) return null;
  return sorted;
}

function promptText(detectors: readonly H4DetectorId[], evidenceCount: number): string {
  return [
    "# Error-loop recovery",
    "",
    `Structural signals: ${detectors.join(", ")} (${evidenceCount} findings).`,
    "",
    "Stop repeating the failing action. Do not change permissions, environment values, or safety controls.",
    "",
    "1. Re-establish ground truth with read-only inspection of the current target and repository state.",
    "2. Classify the root cause using one closed category: TARGET_MISSING, STALE_STATE, AMBIGUOUS_MATCH, WRONG_SCOPE, VERIFICATION_MISMATCH, or UNKNOWN.",
    "3. State the smallest recovery action and its stop condition before making any change.",
    "4. Apply at most one bounded change, then verify it independently. If verification disagrees, stop instead of retrying.",
    "5. Return only the root-cause category, whether recovery succeeded, and the next safe action. Do not copy raw errors, commands, paths, prompts, environment values, or transcript content.",
  ].join("\n");
}

export interface H4PromptArtifactV1 {
  readonly schemaVersion: 1;
  readonly artifactKind: "cc_prompt";
  readonly templateId: "H4_LOOP_RECOVERY_PROMPT_V1";
  readonly generatorId: typeof H4_GENERATOR_ID;
  readonly detectorCodes: readonly H4DetectorId[];
  readonly evidenceCount: number;
  readonly prompt: string;
  readonly apply: {
    readonly mechanismCode: "COPY_PROMPT";
    readonly authorizationCode: "EXPLICIT_USER_ACTION";
    readonly targetCode: "USER_SELECTED_NEW_SESSION_OR_SUBAGENT";
  };
}

export interface H4RollbackContractV1 {
  readonly schemaVersion: 1;
  readonly strategyCode: "NO_PERSISTED_CHANGE";
  readonly actionCode: "DISCARD_UNAPPLIED_PROMPT";
  readonly artifactRevisionId: string;
  readonly rollbackArtifactRevisionId: string;
}

export interface H4GeneratedPackV1 {
  readonly schemaVersion: 1;
  readonly hookPosture: typeof H4_HOOK_POSTURE;
  readonly artifact: H4PromptArtifactV1;
  readonly rollback: H4RollbackContractV1;
  readonly artifactContract: ArtifactContract;
  readonly measurementContract: MeasurementContract;
}

function buildPack(
  findings: readonly EngineFinding[],
  now: string,
  window: { readonly from: string; readonly to: string },
): H4GeneratedPackV1 | null {
  const sorted = canonicalFindings(findings);
  if (
    sorted === null ||
    !isCanonicalTime(now) ||
    !hasExactKeys(window, ["from", "to"]) ||
    !isCanonicalTime(window.from) ||
    !isCanonicalTime(window.to) ||
    window.from >= window.to ||
    window.to > now ||
    sorted.some((finding) => finding.observedAt < window.from || finding.observedAt > window.to)
  )
    return null;
  const presentDetectors = new Set(sorted.map((finding) => finding.detectorId));
  const detectorCodes = H4_SUPPORTED_DETECTORS.filter((detector) => presentDetectors.has(detector));
  if (!detectorCodes.some((detector) => REPEAT_SIGNAL_DETECTORS.has(detector))) return null;

  const artifact: H4PromptArtifactV1 = {
    schemaVersion: 1,
    artifactKind: "cc_prompt",
    templateId: "H4_LOOP_RECOVERY_PROMPT_V1",
    generatorId: H4_GENERATOR_ID,
    detectorCodes,
    evidenceCount: sorted.length,
    prompt: promptText(detectorCodes, sorted.length),
    apply: {
      mechanismCode: "COPY_PROMPT",
      authorizationCode: "EXPLICIT_USER_ACTION",
      targetCode: "USER_SELECTED_NEW_SESSION_OR_SUBAGENT",
    },
  };
  const scopeIdentity = canonicalJson({
    findingIds: sorted.map((finding) => finding.id),
    detectorCodes,
    window: { from: window.from, to: window.to },
  });
  const artifactHash = sha256(canonicalJson(artifact));
  const artifactRevisionId = artifactId(
    canonicalJson({ generator: H4_GENERATOR_ID, artifactHash, scopeIdentity, createdAt: now }),
  );
  const rollbackArtifactRevisionId = artifactId(
    canonicalJson({ artifactRevisionId, actionCode: "DISCARD_UNAPPLIED_PROMPT" }),
  );
  const rollback: H4RollbackContractV1 = {
    schemaVersion: 1,
    strategyCode: "NO_PERSISTED_CHANGE",
    actionCode: "DISCARD_UNAPPLIED_PROMPT",
    artifactRevisionId,
    rollbackArtifactRevisionId,
  };
  const artifactContract: ArtifactContract = {
    artifactRevisionId,
    kind: "cc_prompt",
    validationStatus: "VALIDATED",
    validated: true,
    artifactHash,
    scopeHash: sha256(scopeIdentity),
    targetHash: sha256("USER_SELECTED_NEW_SESSION_OR_SUBAGENT"),
    rollbackArtifactRevisionId,
    rollbackHash: sha256(canonicalJson(rollback)),
    supersedesArtifactRevisionId: null,
    createdAt: now,
    applyMechanismCode: "COPY_PROMPT",
  };
  const measurementContract: MeasurementContract = {
    verdict: "VALIDATED_PROXY",
    measurementMethodId: measurementId(
      canonicalJson({ artifactRevisionId, factory: H4_MEASUREMENT_FACTORY_ID, createdAt: now }),
    ),
    methodVersion: H4_MEASUREMENT_FACTORY_ID,
    artifactRevisionId,
    targetMetricCode: "REPEATED_FAILURE_SESSION_RATE",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "PRE_PROMPT_ELIGIBLE_SESSIONS",
      afterCohortCode: "POST_PROMPT_ELIGIBLE_SESSIONS",
      guardrailCodes: ["TOTAL_FAILURE_RATE_NOT_INCREASED", "RECOVERY_LOOP_RATE_NOT_INCREASED"],
      comparabilityCode: "MATCHED_H4_ELIGIBLE_SESSIONS",
    },
    createdAt: now,
  };
  return {
    schemaVersion: 1,
    hookPosture: H4_HOOK_POSTURE,
    artifact,
    rollback,
    artifactContract,
    measurementContract,
  };
}

export function validateH4GeneratedPack(
  value: unknown,
  input: {
    readonly findings: readonly EngineFinding[];
    readonly now: string;
    readonly window: { readonly from: string; readonly to: string };
  },
): value is H4GeneratedPackV1 {
  try {
    const expected = buildPack(input.findings, input.now, input.window);
    return expected !== null && canonicalJson(value) === canonicalJson(expected);
  } catch {
    return false;
  }
}

export function generateH4ErrorLoopPack(input: {
  readonly findings: readonly EngineFinding[];
  readonly now: string;
  readonly window: { readonly from: string; readonly to: string };
}): H4GeneratedPackV1 | null {
  try {
    const candidate = buildPack(input.findings, input.now, input.window);
    return candidate !== null && validateH4GeneratedPack(candidate, input) ? candidate : null;
  } catch {
    return null;
  }
}

export interface H4MeasurementAggregateV1 {
  readonly eligibleSessions: number;
  readonly repeatedFailureSessions: number;
  /** Failed actions across eligible sessions, including every action in each repeated-failure run. */
  readonly totalFailures: number;
  readonly recoveryLoopSessions: number;
}

export interface H4MeasurementObservationV1 {
  readonly schemaVersion: 1;
  readonly artifactRevisionId: string;
  readonly baseline: H4MeasurementAggregateV1;
  readonly after: H4MeasurementAggregateV1;
}

export interface H4MeasurementResultV1 {
  readonly schemaVersion: 1;
  readonly artifactRevisionId: string;
  readonly verdict: H4EffectVerdict;
  readonly reasonCodes: readonly string[];
  readonly rates: {
    readonly baselineRepeatedFailureRate: number;
    readonly afterRepeatedFailureRate: number;
    readonly baselineTotalFailureRate: number;
    readonly afterTotalFailureRate: number;
    readonly baselineRecoveryLoopRate: number;
    readonly afterRecoveryLoopRate: number;
  };
}

function validAggregate(value: unknown): value is H4MeasurementAggregateV1 {
  if (
    !hasExactKeys(value, [
      "eligibleSessions",
      "recoveryLoopSessions",
      "repeatedFailureSessions",
      "totalFailures",
    ])
  )
    return false;
  const aggregate = value as unknown as H4MeasurementAggregateV1;
  const counts = [
    aggregate.eligibleSessions,
    aggregate.repeatedFailureSessions,
    aggregate.totalFailures,
    aggregate.recoveryLoopSessions,
  ];
  return (
    counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= MAX_COUNT) &&
    aggregate.eligibleSessions > 0 &&
    aggregate.repeatedFailureSessions <= aggregate.eligibleSessions &&
    aggregate.totalFailures >= aggregate.repeatedFailureSessions * 2 &&
    aggregate.recoveryLoopSessions <= aggregate.eligibleSessions
  );
}

function roundRate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function rateIncreased(
  baselineCount: number,
  baselineSessions: number,
  afterCount: number,
  afterSessions: number,
): boolean {
  return (
    BigInt(afterCount) * BigInt(baselineSessions) > BigInt(baselineCount) * BigInt(afterSessions)
  );
}

function materiallyReduced(
  baselineCount: number,
  baselineSessions: number,
  afterCount: number,
  afterSessions: number,
): boolean {
  const baseline = BigInt(baselineCount);
  const baselineN = BigInt(baselineSessions);
  const after = BigInt(afterCount);
  const afterN = BigInt(afterSessions);
  const reductionNumerator = baseline * afterN - after * baselineN;
  const commonDenominator = baselineN * afterN;
  const meetsAbsoluteFloor = reductionNumerator * 50n >= commonDenominator;
  const meetsRelativeFloor = after * baselineN * 5n <= baseline * afterN * 4n;
  return meetsAbsoluteFloor && meetsRelativeFloor;
}

function evaluateH4MeasurementUnchecked(
  observation: unknown,
  expectedArtifactRevisionId: string,
): H4MeasurementResultV1 | null {
  if (
    !hasExactKeys(observation, ["after", "artifactRevisionId", "baseline", "schemaVersion"]) ||
    observation.schemaVersion !== 1 ||
    !isArtifactRevisionId(expectedArtifactRevisionId) ||
    !isArtifactRevisionId(observation.artifactRevisionId) ||
    observation.artifactRevisionId !== expectedArtifactRevisionId ||
    !validAggregate(observation.baseline) ||
    !validAggregate(observation.after)
  )
    return null;
  const baseline = observation.baseline;
  const after = observation.after;
  const rates = {
    baselineRepeatedFailureRate: roundRate(
      baseline.repeatedFailureSessions / baseline.eligibleSessions,
    ),
    afterRepeatedFailureRate: roundRate(after.repeatedFailureSessions / after.eligibleSessions),
    baselineTotalFailureRate: roundRate(baseline.totalFailures / baseline.eligibleSessions),
    afterTotalFailureRate: roundRate(after.totalFailures / after.eligibleSessions),
    baselineRecoveryLoopRate: roundRate(baseline.recoveryLoopSessions / baseline.eligibleSessions),
    afterRecoveryLoopRate: roundRate(after.recoveryLoopSessions / after.eligibleSessions),
  };
  const sampleRatio = after.eligibleSessions / baseline.eligibleSessions;
  if (
    baseline.eligibleSessions < MIN_COMPARABLE_SESSIONS ||
    after.eligibleSessions < MIN_COMPARABLE_SESSIONS ||
    sampleRatio < 0.5 ||
    sampleRatio > 2
  ) {
    return {
      schemaVersion: 1,
      artifactRevisionId: observation.artifactRevisionId,
      verdict: "INCONCLUSIVE",
      reasonCodes: ["COHORT_NOT_COMPARABLE"],
      rates,
    };
  }
  const totalFailureRateIncreased = rateIncreased(
    baseline.totalFailures,
    baseline.eligibleSessions,
    after.totalFailures,
    after.eligibleSessions,
  );
  const recoveryLoopRateIncreased = rateIncreased(
    baseline.recoveryLoopSessions,
    baseline.eligibleSessions,
    after.recoveryLoopSessions,
    after.eligibleSessions,
  );
  if (totalFailureRateIncreased || recoveryLoopRateIncreased) {
    return {
      schemaVersion: 1,
      artifactRevisionId: observation.artifactRevisionId,
      verdict: "WORSE",
      reasonCodes: [
        ...(totalFailureRateIncreased ? ["TOTAL_FAILURE_RATE_INCREASED"] : []),
        ...(recoveryLoopRateIncreased ? ["RECOVERY_LOOP_RATE_INCREASED"] : []),
      ],
      rates,
    };
  }
  const improved = materiallyReduced(
    baseline.repeatedFailureSessions,
    baseline.eligibleSessions,
    after.repeatedFailureSessions,
    after.eligibleSessions,
  );
  return {
    schemaVersion: 1,
    artifactRevisionId: observation.artifactRevisionId,
    verdict: improved ? "IMPROVED" : "NO_EFFECT",
    reasonCodes: [improved ? "REPEATED_FAILURE_RATE_REDUCED" : "MATERIAL_REDUCTION_NOT_OBSERVED"],
    rates,
  };
}

export function evaluateH4Measurement(
  observation: unknown,
  expectedArtifactRevisionId: string,
): H4MeasurementResultV1 | null {
  try {
    return evaluateH4MeasurementUnchecked(observation, expectedArtifactRevisionId);
  } catch {
    return null;
  }
}

export function createH4ErrorLoopHandler(
  registryVersion = "handler-registry-1",
): HandlerImplementation {
  const registration: HandlerRegistration = {
    family: H4_HANDLER_FAMILY,
    version: H4_HANDLER_VERSION,
    registryVersion,
    status: "ACTIVE",
    acceptedEvidence: H4_SUPPORTED_DETECTORS.map((detectorId) => ({
      detectorId,
      schemaVersion: 2,
    })),
    artifactKinds: ["cc_prompt"],
    capabilityRequirements: [],
    correlationKeyVersion: "h4-session-error-loop-1",
    priorityClass: "VALUE",
    generatorVersion: H4_GENERATOR_ID,
    validatorVersions: [H4_PROMPT_VALIDATOR_ID, H4_MEASUREMENT_VALIDATOR_ID],
    measurementFactoryVersion: H4_MEASUREMENT_FACTORY_ID,
    applicabilityEstimatorVersion: H4_APPLICABILITY_ESTIMATOR_ID,
    supersededBy: null,
    historicalDecoderVersion: "h4-history-decoder-1",
  };
  return {
    registration,
    compose: (input) => {
      const pack = generateH4ErrorLoopPack(input);
      return pack === null
        ? { artifacts: [], measurement: null }
        : {
            artifacts: [pack.artifactContract],
            measurement: pack.measurementContract,
          };
    },
  };
}
