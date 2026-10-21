import { createHash } from "node:crypto";
import type { EngineFinding } from "../../correlation.js";
import type {
  ArtifactContract,
  HandlerImplementation,
  MeasurementContract,
} from "../../registry.js";

export const H5_HANDLER_FAMILY = "h5-permission-friction" as const;
export const H5_HANDLER_VERSION = "h5-permission-friction-1" as const;
export const H5_REGISTRY_VERSION = "recommendation-registry-1" as const;
export const H5_GENERATOR_VERSION = "h5-permission-config-diff-1" as const;
export const H5_VALIDATOR_VERSION = "h5-permission-validator-1" as const;
export const H5_MEASUREMENT_VERSION = "h5-permission-measurement-1" as const;
export const H5_MIN_OCCURRENCES = 2;

export const H5_SCOPE_PRECEDENCE = [
  "MANAGED",
  "CLI",
  "PROJECT_LOCAL",
  "PROJECT_SHARED",
  "USER",
] as const;
export type H5PermissionScope = (typeof H5_SCOPE_PRECEDENCE)[number];

const PERMISSIONS = ["Read", "Grep", "Glob"] as const;
const DETECTORS = ["C9", "D14", "H9"] as const;
const EVENT_CLASSES = [
  "REPEATED_APPROVAL",
  "DENY_RULE",
  "USER_REJECTED",
  "HOOK_BLOCK",
  "INTERRUPTED",
  "H9_EVASION",
] as const;
const OPERATION_RISKS = [
  "READ_ONLY",
  "WRITE",
  "BASH",
  "NETWORK",
  "DESTRUCTIVE",
  "UNKNOWN",
] as const;
const ACCEPTED_EVIDENCE = [
  { detectorId: "C9", schemaVersion: 2 },
  { detectorId: "D14", schemaVersion: 2 },
  { detectorId: "H9", schemaVersion: 1 },
] as const;

export type H5Permission = (typeof PERMISSIONS)[number];
export type H5DetectorId = (typeof DETECTORS)[number];
export type H5EventClass = (typeof EVENT_CLASSES)[number];
export type H5OperationRisk = (typeof OPERATION_RISKS)[number];

export interface H5PermissionRules {
  readonly allow: readonly H5Permission[];
  readonly ask: readonly H5Permission[];
  readonly deny: readonly H5Permission[];
}

export type H5ScopedRules = Readonly<Record<H5PermissionScope, H5PermissionRules>>;

/** Closed structural evidence only. Raw commands, paths, prompts and denial text are not accepted. */
export interface H5PermissionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly detectorId: H5DetectorId;
  readonly eventClass: H5EventClass;
  readonly permission: H5Permission;
  readonly targetClass: "PROJECT_FILES";
  readonly operationRisk: H5OperationRisk;
  readonly occurrenceCount: number;
  readonly inProject: boolean;
  readonly readOnly: boolean;
  readonly sideEffectFree: boolean;
  readonly broadWildcard: boolean;
  readonly h9Evasion: boolean;
  readonly interrupted: boolean;
  readonly promptShown: boolean;
  readonly settings: H5ScopedRules;
}

export type H5ReasonCode =
  | "H5_ALREADY_ALLOWED"
  | "H5_ASK_PRECEDENCE"
  | "H5_BARE_REJECTION"
  | "H5_BROAD_WILDCARD"
  | "H5_DENY_PRECEDENCE"
  | "H5_EVIDENCE_INVALID"
  | "H5_EVIDENCE_SPARSE"
  | "H5_H9_EVASION"
  | "H5_INTERRUPT_AMBIGUITY"
  | "H5_NO_CHANGE"
  | "H5_UNSAFE_OPERATION";

export interface H5EffectivePermission {
  readonly effect: "DENY" | "ASK" | "ALLOW" | "DEFAULT";
  readonly controllingScope: H5PermissionScope | null;
}

export interface H5ConfigDiffV1 {
  readonly schemaVersion: 1;
  readonly operation: "ADD_PERMISSION_ALLOW";
  readonly targetScope: "PROJECT_LOCAL";
  readonly permission: H5Permission;
  readonly targetClass: "PROJECT_FILES";
  readonly workspaceBoundary: "CURRENT_PROJECT_ONLY";
  readonly preserveDeny: true;
  readonly preserveAsk: true;
}

export interface H5RollbackV1 {
  readonly schemaVersion: 1;
  readonly operation: "REMOVE_OWNED_PERMISSION_ALLOW";
  readonly targetScope: "PROJECT_LOCAL";
  readonly permission: H5Permission;
  readonly targetClass: "PROJECT_FILES";
  readonly workspaceBoundary: "CURRENT_PROJECT_ONLY";
  readonly ownedArtifactHash: string;
  readonly preserveUnrelatedRules: true;
}

export interface H5ActionableDecision {
  readonly kind: "ACTIONABLE";
  readonly artifact: H5ConfigDiffV1;
  readonly artifactHash: string;
  readonly rollback: H5RollbackV1;
  readonly rollbackHash: string;
  readonly measurement: MeasurementContract;
}

export type H5PermissionDecision =
  | H5ActionableDecision
  | { readonly kind: "NO_CHANGE"; readonly reasonCode: H5ReasonCode }
  | { readonly kind: "INVESTIGATE"; readonly reasonCode: H5ReasonCode };

const EXACT_EVIDENCE_KEYS = [
  "schemaVersion",
  "findingId",
  "detectorId",
  "eventClass",
  "permission",
  "targetClass",
  "operationRisk",
  "occurrenceCount",
  "inProject",
  "readOnly",
  "sideEffectFree",
  "broadWildcard",
  "h9Evasion",
  "interrupted",
  "promptShown",
  "settings",
] as const;
const EXACT_RULE_KEYS = ["allow", "ask", "deny"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function decodePermissionList(value: unknown): readonly H5Permission[] | null {
  if (!Array.isArray(value) || !value.every((entry) => isOneOf(entry, PERMISSIONS))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value].sort((a, b) => a.localeCompare(b));
}

function decodeRules(value: unknown): H5PermissionRules | null {
  if (!isRecord(value) || !hasExactKeys(value, EXACT_RULE_KEYS)) return null;
  const allow = decodePermissionList(value.allow);
  const ask = decodePermissionList(value.ask);
  const deny = decodePermissionList(value.deny);
  return allow !== null && ask !== null && deny !== null ? { allow, ask, deny } : null;
}

function decodeScopedRules(value: unknown): H5ScopedRules | null {
  if (!isRecord(value) || !hasExactKeys(value, H5_SCOPE_PRECEDENCE)) return null;
  const entries = H5_SCOPE_PRECEDENCE.map((scope) => [scope, decodeRules(value[scope])] as const);
  if (entries.some(([, rules]) => rules === null)) return null;
  return Object.fromEntries(entries) as unknown as H5ScopedRules;
}

export function decodeH5PermissionEvidence(value: unknown): H5PermissionEvidenceV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, EXACT_EVIDENCE_KEYS)) return null;
  const settings = decodeScopedRules(value.settings);
  if (
    value.schemaVersion !== 1 ||
    typeof value.findingId !== "string" ||
    !/^finding:[a-f0-9]{64}$/.test(value.findingId) ||
    !isOneOf(value.detectorId, DETECTORS) ||
    !isOneOf(value.eventClass, EVENT_CLASSES) ||
    !isOneOf(value.permission, PERMISSIONS) ||
    value.targetClass !== "PROJECT_FILES" ||
    !isOneOf(value.operationRisk, OPERATION_RISKS) ||
    !Number.isSafeInteger(value.occurrenceCount) ||
    (value.occurrenceCount as number) < 0 ||
    typeof value.inProject !== "boolean" ||
    typeof value.readOnly !== "boolean" ||
    typeof value.sideEffectFree !== "boolean" ||
    typeof value.broadWildcard !== "boolean" ||
    typeof value.h9Evasion !== "boolean" ||
    typeof value.interrupted !== "boolean" ||
    typeof value.promptShown !== "boolean" ||
    settings === null
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    findingId: value.findingId,
    detectorId: value.detectorId,
    eventClass: value.eventClass,
    permission: value.permission,
    targetClass: "PROJECT_FILES",
    operationRisk: value.operationRisk,
    occurrenceCount: value.occurrenceCount as number,
    inProject: value.inProject,
    readOnly: value.readOnly,
    sideEffectFree: value.sideEffectFree,
    broadWildcard: value.broadWildcard,
    h9Evasion: value.h9Evasion,
    interrupted: value.interrupted,
    promptShown: value.promptShown,
    settings,
  };
}

/** deny > ask > allow across every scope; scope precedence breaks ties within an effect. */
export function resolveH5EffectivePermission(
  settings: H5ScopedRules,
  permission: H5Permission,
): H5EffectivePermission {
  for (const effect of ["deny", "ask", "allow"] as const) {
    for (const scope of H5_SCOPE_PRECEDENCE) {
      if (settings[scope][effect].includes(permission)) {
        return {
          effect: effect.toUpperCase() as "DENY" | "ASK" | "ALLOW",
          controllingScope: scope,
        };
      }
    }
  }
  return { effect: "DEFAULT", controllingScope: null };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function buildActionableDecision(
  evidence: H5PermissionEvidenceV1,
  now: string,
  lineageFindingIds: readonly string[],
): H5ActionableDecision {
  const artifact: H5ConfigDiffV1 = {
    schemaVersion: 1,
    operation: "ADD_PERMISSION_ALLOW",
    targetScope: "PROJECT_LOCAL",
    permission: evidence.permission,
    targetClass: evidence.targetClass,
    workspaceBoundary: "CURRENT_PROJECT_ONLY",
    preserveDeny: true,
    preserveAsk: true,
  };
  const artifactHash = hash({ generatorVersion: H5_GENERATOR_VERSION, artifact });
  const artifactRevisionId = `artifact:${hash({
    artifactHash,
    createdAt: now,
    generatorVersion: H5_GENERATOR_VERSION,
    lineageFindingIds: [...lineageFindingIds].sort(),
  })}`;
  const rollback: H5RollbackV1 = {
    schemaVersion: 1,
    operation: "REMOVE_OWNED_PERMISSION_ALLOW",
    targetScope: "PROJECT_LOCAL",
    permission: evidence.permission,
    targetClass: evidence.targetClass,
    workspaceBoundary: "CURRENT_PROJECT_ONLY",
    ownedArtifactHash: artifactHash,
    preserveUnrelatedRules: true,
  };
  const rollbackHash = hash({ validatorVersion: H5_VALIDATOR_VERSION, rollback });
  const measurement: MeasurementContract = {
    verdict: "VALIDATED_PROXY",
    measurementMethodId: `measurement:${hash({
      artifactRevisionId,
      measurementVersion: H5_MEASUREMENT_VERSION,
    })}`,
    methodVersion: H5_MEASUREMENT_VERSION,
    artifactRevisionId,
    targetMetricCode: "PERMISSION_PROMPTS_PER_100_TOOL_USES",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "SAME_WORKSPACE_PERMISSION_BASELINE",
      afterCohortCode: "SAME_WORKSPACE_PERMISSION_AFTER",
      guardrailCodes: [
        "DENY_PRESERVED",
        "ASK_PRESERVED",
        "NO_H9_EVASION",
        "NO_OUT_OF_PROJECT_ACCESS",
      ],
      comparabilityCode: "SAME_WORKSPACE_TOOL_CLASS",
    },
    createdAt: now,
  };
  return { kind: "ACTIONABLE", artifact, artifactHash, rollback, rollbackHash, measurement };
}

export function evaluateH5PermissionEvidence(
  value: unknown,
  now: string,
  lineageFindingIds?: readonly string[],
): H5PermissionDecision {
  const evidence = decodeH5PermissionEvidence(value);
  if (
    evidence === null ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    return { kind: "INVESTIGATE", reasonCode: "H5_EVIDENCE_INVALID" };
  }
  if (evidence.h9Evasion || evidence.eventClass === "H9_EVASION" || evidence.detectorId === "H9") {
    return { kind: "INVESTIGATE", reasonCode: "H5_H9_EVASION" };
  }
  if (
    evidence.interrupted ||
    evidence.eventClass === "INTERRUPTED" ||
    evidence.detectorId === "D14"
  ) {
    return { kind: "INVESTIGATE", reasonCode: "H5_INTERRUPT_AMBIGUITY" };
  }
  if (evidence.eventClass === "USER_REJECTED") {
    return { kind: "INVESTIGATE", reasonCode: "H5_BARE_REJECTION" };
  }
  if (evidence.broadWildcard) {
    return { kind: "INVESTIGATE", reasonCode: "H5_BROAD_WILDCARD" };
  }
  if (
    evidence.operationRisk !== "READ_ONLY" ||
    !evidence.inProject ||
    !evidence.readOnly ||
    !evidence.sideEffectFree
  ) {
    return { kind: "INVESTIGATE", reasonCode: "H5_UNSAFE_OPERATION" };
  }
  const effective = resolveH5EffectivePermission(evidence.settings, evidence.permission);
  if (effective.effect === "DENY") {
    return { kind: "INVESTIGATE", reasonCode: "H5_DENY_PRECEDENCE" };
  }
  if (effective.effect === "ASK") {
    return { kind: "INVESTIGATE", reasonCode: "H5_ASK_PRECEDENCE" };
  }
  if (effective.effect === "ALLOW") {
    return { kind: "NO_CHANGE", reasonCode: "H5_ALREADY_ALLOWED" };
  }
  if (evidence.occurrenceCount < H5_MIN_OCCURRENCES) {
    return { kind: "NO_CHANGE", reasonCode: "H5_EVIDENCE_SPARSE" };
  }
  if (evidence.eventClass !== "REPEATED_APPROVAL" || !evidence.promptShown) {
    return { kind: "NO_CHANGE", reasonCode: "H5_NO_CHANGE" };
  }
  return buildActionableDecision(evidence, now, lineageFindingIds ?? [evidence.findingId]);
}

function artifactContract(decision: H5ActionableDecision, now: string): ArtifactContract {
  const artifactRevisionId = decision.measurement.artifactRevisionId;
  return {
    artifactRevisionId,
    kind: "config_diff",
    validationStatus: "VALIDATED",
    validated: true,
    artifactHash: decision.artifactHash,
    scopeHash: hash({ scope: decision.artifact.targetScope }),
    targetHash: hash({ target: "CLAUDE_PERMISSION_SETTINGS" }),
    rollbackArtifactRevisionId: `artifact:${hash({
      artifactRevisionId,
      rollbackHash: decision.rollbackHash,
    })}`,
    rollbackHash: decision.rollbackHash,
    supersedesArtifactRevisionId: null,
    createdAt: now,
    applyMechanismCode: "MERGE_PERMISSION_ALLOW_ENTRY",
  };
}

export function validateH5ArtifactContract(
  value: unknown,
  evidenceValue: unknown,
  now: string,
  lineageFindingIds?: readonly string[],
): value is ArtifactContract {
  try {
    const decision = evaluateH5PermissionEvidence(evidenceValue, now, lineageFindingIds);
    return (
      decision.kind === "ACTIONABLE" &&
      canonical(value) === canonical(artifactContract(decision, now))
    );
  } catch {
    return false;
  }
}

export function validateH5MeasurementContract(
  value: unknown,
  evidenceValue: unknown,
  now: string,
  lineageFindingIds?: readonly string[],
): value is MeasurementContract {
  try {
    const decision = evaluateH5PermissionEvidence(evidenceValue, now, lineageFindingIds);
    return decision.kind === "ACTIONABLE" && canonical(value) === canonical(decision.measurement);
  } catch {
    return false;
  }
}

/**
 * The frozen engine finding omits family evidence, so the adapter supplies a closed sidecar.
 * The sidecar is decoded and snapshotted here to keep compose deterministic and fail closed.
 */
export function createH5PermissionFrictionHandler(
  evidenceByFindingId: ReadonlyMap<string, unknown>,
): HandlerImplementation {
  const snapshot = new Map<string, H5PermissionEvidenceV1>();
  for (const [findingId, value] of evidenceByFindingId) {
    const decoded = decodeH5PermissionEvidence(value);
    if (decoded !== null && decoded.findingId === findingId) snapshot.set(findingId, decoded);
  }
  return {
    registration: {
      family: H5_HANDLER_FAMILY,
      version: H5_HANDLER_VERSION,
      registryVersion: H5_REGISTRY_VERSION,
      status: "ACTIVE",
      acceptedEvidence: ACCEPTED_EVIDENCE,
      artifactKinds: ["config_diff"],
      capabilityRequirements: [
        {
          capability: "permission-config-diff-v1",
          allowedSources: ["LOCAL_CANARY", "VERSION_GATE"],
          allowedCanaryVersions: ["permission-config-canary-1"],
        },
      ],
      correlationKeyVersion: "h5-permission-correlation-1",
      priorityClass: "VALUE",
      generatorVersion: H5_GENERATOR_VERSION,
      validatorVersions: [H5_VALIDATOR_VERSION],
      measurementFactoryVersion: H5_MEASUREMENT_VERSION,
      applicabilityEstimatorVersion: "h5-permission-applicability-1",
      supersededBy: null,
      historicalDecoderVersion: "h5-permission-history-1",
    },
    compose: ({ findings, now }) => composeH5PermissionFriction(findings, snapshot, now),
  };
}

export function composeH5PermissionFriction(
  findings: readonly EngineFinding[],
  evidenceByFindingId: ReadonlyMap<string, unknown>,
  now: string,
): {
  readonly artifacts: readonly ArtifactContract[];
  readonly measurement: MeasurementContract | null;
} {
  if (findings.length === 0) return { artifacts: [], measurement: null };
  const sortedFindings = [...findings].sort((a, b) => a.id.localeCompare(b.id));
  const lineageFindingIds = sortedFindings.map((finding) => finding.id);
  const decisions = sortedFindings.map((finding) => {
    const raw = evidenceByFindingId.get(finding.id);
    const decoded = decodeH5PermissionEvidence(raw);
    if (
      decoded === null ||
      decoded.findingId !== finding.id ||
      decoded.detectorId !== finding.detectorId ||
      !ACCEPTED_EVIDENCE.some(
        (accepted) =>
          accepted.detectorId === finding.detectorId &&
          accepted.schemaVersion === finding.schemaVersion,
      )
    ) {
      return { kind: "INVESTIGATE", reasonCode: "H5_EVIDENCE_INVALID" } as const;
    }
    return evaluateH5PermissionEvidence(decoded, now, lineageFindingIds);
  });
  if (!decisions.every((decision) => decision.kind === "ACTIONABLE")) {
    return { artifacts: [], measurement: null };
  }
  const actionable = decisions as readonly H5ActionableDecision[];
  const first = actionable[0];
  if (
    first === undefined ||
    actionable.some(
      (decision) =>
        decision.artifactHash !== first.artifactHash ||
        decision.measurement.artifactRevisionId !== first.measurement.artifactRevisionId,
    )
  ) {
    return { artifacts: [], measurement: null };
  }
  const firstEvidence = evidenceByFindingId.get(sortedFindings[0]?.id ?? "");
  const artifact = artifactContract(first, now);
  if (
    !validateH5ArtifactContract(artifact, firstEvidence, now, lineageFindingIds) ||
    !validateH5MeasurementContract(first.measurement, firstEvidence, now, lineageFindingIds)
  ) {
    return { artifacts: [], measurement: null };
  }
  return { artifacts: [artifact], measurement: first.measurement };
}
