import type { SafeCode } from "./types.js";

export type CapabilitySource = "LOCAL_CANARY" | "VERSION_GATE" | "SETTING" | "RESEARCH_ONLY";
export type CapabilityVerdict = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN" | "CONTRADICTED";
export type ArtifactKind =
  | "installable_hook"
  | "config_diff"
  | "claude_md_rule"
  | "skill"
  | "subagent_def"
  | "cc_prompt"
  | "advice";

export interface CapabilityObservation {
  readonly capability: string;
  readonly verdict: CapabilityVerdict;
  readonly source: CapabilitySource;
  readonly canaryVersion: string | null;
  readonly observedAt: string;
}

export interface CapabilityProfile {
  readonly id: string;
  readonly version: string;
  readonly claudeCodeVersion: string;
  readonly platform: "WINDOWS" | "MACOS" | "LINUX" | "UNKNOWN";
  readonly workspaceScope: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly observations: readonly CapabilityObservation[];
}

export interface CapabilityRequirement {
  readonly capability: string;
  readonly allowedSources: readonly Exclude<CapabilitySource, "RESEARCH_ONLY">[];
  readonly allowedCanaryVersions: readonly string[];
}

export type CapabilityDecision =
  | { readonly kind: "SUPPORTED" }
  | { readonly kind: "INVESTIGATE"; readonly reasonCode: SafeCode };

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Documentation/research alone never authorizes an apply-capable handler. */
export function evaluateCapabilityProfile(
  profile: CapabilityProfile,
  requirements: readonly CapabilityRequirement[],
  now: string,
): CapabilityDecision {
  if (
    !isCanonicalIsoTimestamp(now) ||
    !isCanonicalIsoTimestamp(profile.createdAt) ||
    !isCanonicalIsoTimestamp(profile.expiresAt) ||
    profile.createdAt > now ||
    profile.expiresAt <= now ||
    profile.version.length === 0 ||
    profile.claudeCodeVersion.length === 0
  ) {
    return { kind: "INVESTIGATE", reasonCode: "CAPABILITY_PROFILE_EXPIRED" as SafeCode };
  }
  for (const requirement of requirements) {
    const matches = profile.observations.filter(
      (observation) => observation.capability === requirement.capability,
    );
    if (
      matches.some(
        (observation) =>
          !isCanonicalIsoTimestamp(observation.observedAt) ||
          observation.observedAt < profile.createdAt ||
          observation.observedAt > now ||
          (observation.source === "LOCAL_CANARY" &&
            (observation.canaryVersion === null || observation.canaryVersion.length === 0)),
      )
    ) {
      return {
        kind: "INVESTIGATE",
        reasonCode: "CAPABILITY_OBSERVATION_INVALID" as SafeCode,
      };
    }
    if (matches.some((observation) => observation.verdict === "CONTRADICTED")) {
      return { kind: "INVESTIGATE", reasonCode: "CAPABILITY_CONTRADICTED" as SafeCode };
    }
    const supported = matches.some(
      (observation) =>
        observation.verdict === "SUPPORTED" &&
        observation.source !== "RESEARCH_ONLY" &&
        requirement.allowedSources.includes(observation.source) &&
        (observation.source !== "LOCAL_CANARY" ||
          (observation.canaryVersion !== null &&
            requirement.allowedCanaryVersions.includes(observation.canaryVersion))),
    );
    if (!supported) {
      return { kind: "INVESTIGATE", reasonCode: "CAPABILITY_UNVERIFIED" as SafeCode };
    }
  }
  return { kind: "SUPPORTED" };
}

export interface HandlerRegistration {
  readonly family: string;
  readonly version: string;
  readonly registryVersion: string;
  readonly status: "ACTIVE" | "RETIRED";
  readonly acceptedEvidence: readonly {
    readonly detectorId: string;
    readonly schemaVersion: number;
  }[];
  readonly artifactKinds: readonly ArtifactKind[];
  readonly capabilityRequirements: readonly CapabilityRequirement[];
  readonly correlationKeyVersion: string;
  readonly priorityClass: "VALUE" | "REVIEWED_SAFETY";
  readonly generatorVersion: string;
  readonly validatorVersions: readonly string[];
  readonly measurementFactoryVersion: string;
  readonly applicabilityEstimatorVersion: string;
  readonly supersededBy: string | null;
  readonly historicalDecoderVersion: string;
}

export interface HandlerCompatibilityInput {
  readonly detectorId: string;
  readonly evidenceSchemaVersion: number;
  readonly artifactKind: ArtifactKind;
}

export function evaluateHandlerCompatibility(
  handler: HandlerRegistration,
  input: HandlerCompatibilityInput,
  profile: CapabilityProfile,
  now: string,
): CapabilityDecision {
  if (handler.status !== "ACTIVE") {
    return { kind: "INVESTIGATE", reasonCode: "HANDLER_RETIRED" as SafeCode };
  }
  if (
    !handler.acceptedEvidence.some(
      (evidence) =>
        evidence.detectorId === input.detectorId &&
        evidence.schemaVersion === input.evidenceSchemaVersion,
    )
  ) {
    return { kind: "INVESTIGATE", reasonCode: "EVIDENCE_SCHEMA_UNSUPPORTED" as SafeCode };
  }
  if (!handler.artifactKinds.includes(input.artifactKind)) {
    return { kind: "INVESTIGATE", reasonCode: "ARTIFACT_KIND_UNSUPPORTED" as SafeCode };
  }
  return evaluateCapabilityProfile(profile, handler.capabilityRequirements, now);
}

/** Privacy-safe persisted decoder input retained after handler retirement. */
export interface HistoricalHandlerSnapshotV1 {
  readonly schemaVersion: 1;
  readonly handlerFamily: string;
  readonly handlerVersion: string;
  readonly registryVersion: string;
  readonly reasonCodes: readonly SafeCode[];
  readonly aggregateEvidence: readonly {
    readonly code: SafeCode;
    readonly value: number | boolean | null;
  }[];
  readonly guardrailResults: readonly {
    readonly code: SafeCode;
    readonly passed: boolean;
  }[];
}

export interface HistoricalSnapshotAllowlist {
  readonly handlerIdentities: ReadonlySet<string>;
  readonly registryVersions: ReadonlySet<string>;
  readonly reasonCodes: ReadonlySet<string>;
  readonly aggregateRules: ReadonlyMap<
    string,
    | {
        readonly kind: "NUMBER";
        readonly minimum: number;
        readonly maximum: number;
        readonly maximumDecimalPlaces: number;
        readonly nullable: boolean;
      }
    | { readonly kind: "BOOLEAN"; readonly nullable: boolean }
  >;
  readonly guardrailCodes: ReadonlySet<string>;
  readonly maxReasonCodes: number;
  readonly maxAggregateEntries: number;
  readonly maxGuardrailResults: number;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedCount(value: number, hardMaximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= hardMaximum;
}

function hasUniqueCodes(entries: readonly unknown[]): boolean {
  const codes = entries
    .filter(isRecord)
    .map((entry) => entry.code)
    .filter((code): code is string => typeof code === "string");
  return codes.length === entries.length && new Set(codes).size === codes.length;
}

type HistoricalAggregateRule = HistoricalSnapshotAllowlist["aggregateRules"] extends ReadonlyMap<
  string,
  infer Rule
>
  ? Rule
  : never;

function matchesAggregateRule(value: unknown, rule: HistoricalAggregateRule): boolean {
  if (value === null) return rule.nullable;
  if (rule.kind === "BOOLEAN") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (
    !Number.isFinite(rule.minimum) ||
    !Number.isFinite(rule.maximum) ||
    rule.minimum > rule.maximum
  ) {
    return false;
  }
  if (value < rule.minimum || value > rule.maximum) return false;
  if (
    !Number.isSafeInteger(rule.maximumDecimalPlaces) ||
    rule.maximumDecimalPlaces < 0 ||
    rule.maximumDecimalPlaces > 6
  ) {
    return false;
  }
  const scaled = value * 10 ** rule.maximumDecimalPlaces;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) <= 1e-9;
}

/** Versioned, closed-label decoder used after a handler is retired. */
export function decodeHistoricalHandlerSnapshotV1(
  value: unknown,
  allowlist: HistoricalSnapshotAllowlist,
): HistoricalHandlerSnapshotV1 | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "handlerFamily",
      "handlerVersion",
      "registryVersion",
      "reasonCodes",
      "aggregateEvidence",
      "guardrailResults",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.handlerFamily !== "string" ||
    typeof value.handlerVersion !== "string" ||
    typeof value.registryVersion !== "string" ||
    !allowlist.handlerIdentities.has(`${value.handlerFamily}@${value.handlerVersion}`) ||
    !allowlist.registryVersions.has(value.registryVersion) ||
    !Array.isArray(value.reasonCodes) ||
    !isBoundedCount(allowlist.maxReasonCodes, 32) ||
    value.reasonCodes.length > allowlist.maxReasonCodes ||
    new Set(value.reasonCodes).size !== value.reasonCodes.length ||
    !value.reasonCodes.every(
      (code) => typeof code === "string" && allowlist.reasonCodes.has(code),
    ) ||
    !Array.isArray(value.aggregateEvidence) ||
    !isBoundedCount(allowlist.maxAggregateEntries, 64) ||
    value.aggregateEvidence.length > allowlist.maxAggregateEntries ||
    !hasUniqueCodes(value.aggregateEvidence) ||
    !Array.isArray(value.guardrailResults) ||
    !isBoundedCount(allowlist.maxGuardrailResults, 64) ||
    value.guardrailResults.length > allowlist.maxGuardrailResults ||
    !hasUniqueCodes(value.guardrailResults)
  ) {
    return null;
  }
  const aggregateEvidenceValid = value.aggregateEvidence.every((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["code", "value"])) return false;
    if (typeof entry.code !== "string") return false;
    const rule = allowlist.aggregateRules.get(entry.code);
    return rule !== undefined && matchesAggregateRule(entry.value, rule);
  });
  const guardrailsValid = value.guardrailResults.every(
    (entry) =>
      isRecord(entry) &&
      hasExactKeys(entry, ["code", "passed"]) &&
      typeof entry.code === "string" &&
      allowlist.guardrailCodes.has(entry.code) &&
      typeof entry.passed === "boolean",
  );
  return aggregateEvidenceValid && guardrailsValid
    ? (value as unknown as HistoricalHandlerSnapshotV1)
    : null;
}
