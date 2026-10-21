import crypto from "node:crypto";

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SESSION_ID = /^sid_[0-9a-f]{64}$/u;
const MESSAGE_ID = /^mid_[0-9a-f]{64}$/u;
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const U12_PRECISION_THRESHOLD = 0.9;
export const U12_MINIMUM_DISTINCT_SESSIONS = 35;
export const U12_PRELABEL_VERSION = "u12-prelabel-v2" as const;
export const U12_AUDIT_ALGORITHM_VERSION = "u12-audit-sha256-v2" as const;
export const U12_POPULATION_COMMITMENT_VERSION = "u12-population-sha256-v2" as const;

export type PrelabelVerdict = "SUPPORTED" | "UNSUPPORTED";
export type OperatorAdjudication = "TRUE_POSITIVE" | "FALSE_POSITIVE";

export interface PrelabelVocabulary {
  readonly detectorIds: readonly string[];
  readonly ruleVersions: readonly string[];
  readonly parserVersions: readonly string[];
  readonly claudeCodeVersions: readonly string[];
  readonly criteriaLabels: readonly string[];
  readonly featureNames: readonly string[];
  readonly featureEnums?: Readonly<Record<string, readonly string[]>>;
}

export type PrelabelFeatureValue = number | boolean | Readonly<{ kind: "ENUM"; value: string }>;

export interface PrelabelPayload {
  readonly version: typeof U12_PRELABEL_VERSION;
  readonly detector_id: string;
  readonly rule_version: string;
  readonly parser_version: string;
  readonly claude_code_version: string;
  readonly certification_session_id: string;
  readonly criteria_label: string;
  readonly anchors: readonly Readonly<{
    session_id: string;
    message_id: string;
    timestamp: string;
  }>[];
  readonly features: Readonly<Record<string, PrelabelFeatureValue>>;
}

export interface PrecisionCandidate {
  readonly payload: PrelabelPayload;
  readonly prelabel: PrelabelVerdict;
  readonly operatorAdjudication?: OperatorAdjudication;
}

export interface PrecisionGateConfig {
  readonly detectorId: string;
  readonly ruleVersion: string;
  readonly parserVersion: string;
  readonly claudeCodeVersion: string;
  /** May be more conservative, but never lower than the resolved U12 floor. */
  readonly minimumFirings: number;
  readonly agreementAuditRate: number;
  readonly lowPrevalence: boolean;
  /** Commitment returned by preparePrecisionPopulation and approved before labeling. */
  readonly expectedPopulationCommitment: string;
}

export interface PreparedPrecisionPopulation {
  readonly version: typeof U12_POPULATION_COMMITMENT_VERSION;
  readonly candidateIdentities: readonly string[];
  readonly populationCommitment: string;
}

export type PrecisionGateReason =
  | "CERTIFIED"
  | "BELOW_PRECISION_THRESHOLD"
  | "WILSON_LOWER_BOUND_BELOW_THRESHOLD"
  | "BELOW_MINIMUM_FIRINGS"
  | "LOW_PREVALENCE_BELOW_MINIMUM_FIRINGS"
  | "INCOMPLETE_OPERATOR_ADJUDICATION"
  | "MULTIPLE_CANDIDATES_PER_SESSION";

export interface PrecisionGateResult {
  readonly detectorId: string;
  readonly ruleVersion: string;
  readonly parserVersion: string;
  readonly claudeCodeVersion: string;
  readonly status: "CERTIFIED_ON_BY_DEFAULT" | "REVIEW_ONLY";
  readonly routingTier: "ON_BY_DEFAULT" | "T3_REVIEW";
  readonly reason: PrecisionGateReason;
  readonly firingCount: number;
  readonly distinctSessionCount: number;
  readonly minimumFirings: number;
  readonly precisionThreshold: typeof U12_PRECISION_THRESHOLD;
  readonly estimatedPrecision: number | null;
  readonly agreementAudit: Readonly<{
    population: number;
    sampled: number;
    truePositive: number;
    rate: number;
    confidence95: Readonly<{ lower: number; upper: number }> | null;
  }>;
  readonly disagreementAdjudicated: number;
  readonly estimateConfidence95: Readonly<{ lower: number; upper: number }> | null;
  readonly populationCommitment: string;
  readonly limitation: "FULL_OPERATOR_ADJUDICATION";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} contains unknown or missing keys`);
  }
}

function assertClosedCode(
  value: unknown,
  allowed: readonly string[],
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !CODE.test(value) || !allowed.includes(value)) {
    throw new TypeError(`${name} is not in its closed vocabulary`);
  }
}

function assertClosedVersion(
  value: unknown,
  allowed: readonly string[],
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !VERSION_ID.test(value) || !allowed.includes(value)) {
    throw new TypeError(`${name} is not in its closed vocabulary`);
  }
}

/** Enforces SEC-3 before a caller can hand the value to a model client. */
export function assertPrelabelPayload(
  value: unknown,
  vocabulary: PrelabelVocabulary,
): asserts value is PrelabelPayload {
  if (!isRecord(value)) throw new TypeError("pre-label payload must be an object");
  exactKeys(
    value,
    [
      "version",
      "detector_id",
      "rule_version",
      "parser_version",
      "claude_code_version",
      "certification_session_id",
      "criteria_label",
      "anchors",
      "features",
    ],
    "pre-label payload",
  );
  if (value.version !== U12_PRELABEL_VERSION)
    throw new TypeError("pre-label payload version is invalid");
  assertClosedCode(value.detector_id, vocabulary.detectorIds, "detector_id");
  assertClosedVersion(value.rule_version, vocabulary.ruleVersions, "rule_version");
  assertClosedVersion(value.parser_version, vocabulary.parserVersions, "parser_version");
  assertClosedVersion(
    value.claude_code_version,
    vocabulary.claudeCodeVersions,
    "claude_code_version",
  );
  if (
    typeof value.certification_session_id !== "string" ||
    !SESSION_ID.test(value.certification_session_id)
  ) {
    throw new TypeError("certification_session_id is not structural");
  }
  assertClosedCode(value.criteria_label, vocabulary.criteriaLabels, "criteria_label");

  if (!Array.isArray(value.anchors) || value.anchors.length < 1 || value.anchors.length > 5) {
    throw new TypeError("pre-label anchors must contain one to five anchors");
  }
  for (const [index, anchorValue] of value.anchors.entries()) {
    if (!isRecord(anchorValue)) throw new TypeError(`pre-label anchor ${index} must be an object`);
    exactKeys(anchorValue, ["session_id", "message_id", "timestamp"], `pre-label anchor ${index}`);
    if (typeof anchorValue.session_id !== "string" || !SESSION_ID.test(anchorValue.session_id)) {
      throw new TypeError(`pre-label anchor ${index} session_id is not structural`);
    }
    if (typeof anchorValue.message_id !== "string" || !MESSAGE_ID.test(anchorValue.message_id)) {
      throw new TypeError(`pre-label anchor ${index} message_id is not structural`);
    }
    if (typeof anchorValue.timestamp !== "string" || !STRICT_UTC.test(anchorValue.timestamp)) {
      throw new TypeError(`pre-label anchor ${index} timestamp is invalid`);
    }
    const timestamp = new Date(anchorValue.timestamp);
    if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== anchorValue.timestamp) {
      throw new TypeError(`pre-label anchor ${index} timestamp is invalid`);
    }
  }
  const deterministicSessionId = [
    ...new Set(value.anchors.map((anchor) => anchor.session_id)),
  ].sort()[0];
  if (value.certification_session_id !== deterministicSessionId) {
    throw new TypeError(
      "certification_session_id must be the lowest included structural session id",
    );
  }

  if (!isRecord(value.features)) throw new TypeError("pre-label features must be an object");
  if (Object.keys(value.features).length === 0) {
    throw new TypeError("pre-label features must not be empty");
  }
  for (const [name, featureValue] of Object.entries(value.features)) {
    if (!vocabulary.featureNames.includes(name)) {
      throw new TypeError(`feature ${name} is not in the closed vocabulary`);
    }
    if (typeof featureValue === "number") {
      if (!Number.isFinite(featureValue)) throw new TypeError(`feature ${name} must be finite`);
      continue;
    }
    if (typeof featureValue === "boolean") continue;
    if (!isRecord(featureValue)) {
      throw new TypeError(`feature ${name} must be numeric, boolean, or a closed enum`);
    }
    exactKeys(featureValue, ["kind", "value"], `feature ${name}`);
    if (featureValue.kind !== "ENUM") throw new TypeError(`feature ${name} kind is invalid`);
    assertClosedCode(featureValue.value, vocabulary.featureEnums?.[name] ?? [], `feature ${name}`);
  }
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

export function surfacedFindingIdentity(payload: PrelabelPayload): string {
  const stableSurface = {
    version: payload.version,
    detector_id: payload.detector_id,
    rule_version: payload.rule_version,
    parser_version: payload.parser_version,
    claude_code_version: payload.claude_code_version,
    criteria_label: payload.criteria_label,
    anchors: [...payload.anchors].sort((left, right) =>
      canonical(left).localeCompare(canonical(right)),
    ),
  };
  const digest = crypto
    .createHash("sha256")
    .update(U12_AUDIT_ALGORITHM_VERSION)
    .update("\0")
    .update(canonical(stableSurface))
    .digest("hex");
  return `cand_${digest}`;
}

export const candidateIdentity = surfacedFindingIdentity;

function validateConfig(config: PrecisionGateConfig): void {
  if (!CODE.test(config.detectorId)) throw new TypeError("detectorId must be a closed identifier");
  if (!VERSION_ID.test(config.ruleVersion)) throw new TypeError("ruleVersion must be a version id");
  if (!VERSION_ID.test(config.parserVersion))
    throw new TypeError("parserVersion must be a version id");
  if (!VERSION_ID.test(config.claudeCodeVersion))
    throw new TypeError("claudeCodeVersion must be a version id");
  if (
    !Number.isSafeInteger(config.minimumFirings) ||
    config.minimumFirings < U12_MINIMUM_DISTINCT_SESSIONS
  ) {
    throw new TypeError(
      `minimumFirings must be at least ${U12_MINIMUM_DISTINCT_SESSIONS} distinct sessions`,
    );
  }
  if (config.agreementAuditRate !== 1) {
    throw new TypeError("agreementAuditRate must be 1 for full operator adjudication");
  }
  if (typeof config.lowPrevalence !== "boolean") {
    throw new TypeError("lowPrevalence must be explicit");
  }
  if (!/^[0-9a-f]{64}$/u.test(config.expectedPopulationCommitment)) {
    throw new TypeError("expectedPopulationCommitment must be an approved structural commitment");
  }
}

export function preparePrecisionPopulation(
  payloads: readonly PrelabelPayload[],
  vocabulary: PrelabelVocabulary,
): PreparedPrecisionPopulation {
  const identities = payloads.map((payload) => {
    assertPrelabelPayload(payload, vocabulary);
    return candidateIdentity(payload);
  });
  const sorted = [...identities].sort();
  if (new Set(sorted).size !== sorted.length)
    throw new TypeError("candidate structural payload must be unique");
  const populationCommitment = crypto
    .createHash("sha256")
    .update(U12_POPULATION_COMMITMENT_VERSION)
    .update("\0")
    .update(canonical(sorted))
    .digest("hex");
  return {
    version: U12_POPULATION_COMMITMENT_VERSION,
    candidateIdentities: sorted,
    populationCommitment,
  };
}

/** Selection is bound only to the frozen structural population, never labels or adjudications. */
export function selectAgreementAudit(
  candidates: readonly PrecisionCandidate[],
  auditRate: number,
  populationCommitment: string,
): ReadonlySet<string> {
  if (!(auditRate > 0 && auditRate <= 1)) throw new TypeError("auditRate must be in (0, 1]");
  const identified = candidates.map((candidate) => ({
    candidate,
    identity: candidateIdentity(candidate.payload),
  }));
  const agreements = identified.filter(({ candidate }) => candidate.prelabel === "SUPPORTED");
  const sampleN = Math.ceil(agreements.length * auditRate);
  return new Set(
    agreements
      .map(({ identity }) => ({
        alias: identity,
        rank: crypto
          .createHash("sha256")
          .update(U12_AUDIT_ALGORITHM_VERSION)
          .update("\0")
          .update(populationCommitment)
          .update("\0")
          .update(identity)
          .digest("hex"),
      }))
      .sort(
        (left, right) =>
          left.rank.localeCompare(right.rank) || left.alias.localeCompare(right.alias),
      )
      .slice(0, sampleN)
      .map(({ alias }) => alias),
  );
}

export function wilson95(successes: number, n: number): { lower: number; upper: number } {
  const z = 1.959963984540054;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function reviewOnly(
  config: PrecisionGateConfig,
  firingCount: number,
  distinctSessionCount: number,
  reason: PrecisionGateReason,
  agreementPopulation: number,
  sampled: number,
  disagreementAdjudicated: number,
  populationCommitment = "",
): PrecisionGateResult {
  return {
    detectorId: config.detectorId,
    ruleVersion: config.ruleVersion,
    parserVersion: config.parserVersion,
    claudeCodeVersion: config.claudeCodeVersion,
    status: "REVIEW_ONLY",
    routingTier: "T3_REVIEW",
    reason,
    firingCount,
    distinctSessionCount,
    minimumFirings: config.minimumFirings,
    precisionThreshold: U12_PRECISION_THRESHOLD,
    estimatedPrecision: null,
    agreementAudit: {
      population: agreementPopulation,
      sampled,
      truePositive: 0,
      rate: config.agreementAuditRate,
      confidence95: null,
    },
    disagreementAdjudicated,
    estimateConfidence95: null,
    populationCommitment,
    limitation: "FULL_OPERATOR_ADJUDICATION",
  };
}

export function evaluatePrecisionGate(
  candidates: readonly PrecisionCandidate[],
  config: PrecisionGateConfig,
  vocabulary: PrelabelVocabulary,
): PrecisionGateResult {
  validateConfig(config);
  const aliases = new Set<string>();
  const certificationSessions = new Set<string>();
  let hasRepeatedCertificationSession = false;
  for (const candidate of candidates) {
    assertPrelabelPayload(candidate.payload, vocabulary);
    if (candidate.payload.detector_id !== config.detectorId)
      throw new TypeError("candidate detector does not match gate detector");
    if (candidate.payload.rule_version !== config.ruleVersion)
      throw new TypeError("candidate rule version does not match gate rule version");
    if (candidate.payload.parser_version !== config.parserVersion)
      throw new TypeError("candidate parser version does not match gate parser version");
    if (candidate.payload.claude_code_version !== config.claudeCodeVersion)
      throw new TypeError("candidate Claude Code version does not match gate Claude Code version");
    const identity = candidateIdentity(candidate.payload);
    if (aliases.has(identity)) throw new TypeError("candidate structural payload must be unique");
    if (candidate.prelabel !== "SUPPORTED" && candidate.prelabel !== "UNSUPPORTED") {
      throw new TypeError("prelabel must be a closed verdict");
    }
    if (
      candidate.operatorAdjudication !== undefined &&
      candidate.operatorAdjudication !== "TRUE_POSITIVE" &&
      candidate.operatorAdjudication !== "FALSE_POSITIVE"
    ) {
      throw new TypeError("operatorAdjudication must be a closed verdict");
    }
    aliases.add(identity);
    if (certificationSessions.has(candidate.payload.certification_session_id)) {
      hasRepeatedCertificationSession = true;
    }
    certificationSessions.add(candidate.payload.certification_session_id);
  }

  const prepared = preparePrecisionPopulation(
    candidates.map((candidate) => candidate.payload),
    vocabulary,
  );
  const populationCommitment = prepared.populationCommitment;
  if (populationCommitment !== config.expectedPopulationCommitment) {
    throw new TypeError("candidate population does not match approved commitment");
  }

  const agreements = candidates.filter((candidate) => candidate.prelabel === "SUPPORTED");
  const disagreements = candidates.filter((candidate) => candidate.prelabel === "UNSUPPORTED");
  const adjudicatedDisagreements = disagreements.filter(
    (candidate) => candidate.operatorAdjudication !== undefined,
  );
  const distinctSessionCount = certificationSessions.size;

  if (hasRepeatedCertificationSession) {
    return reviewOnly(
      config,
      candidates.length,
      distinctSessionCount,
      "MULTIPLE_CANDIDATES_PER_SESSION",
      agreements.length,
      agreements.length,
      adjudicatedDisagreements.length,
      populationCommitment,
    );
  }

  if (distinctSessionCount < config.minimumFirings) {
    return reviewOnly(
      config,
      candidates.length,
      distinctSessionCount,
      config.lowPrevalence ? "LOW_PREVALENCE_BELOW_MINIMUM_FIRINGS" : "BELOW_MINIMUM_FIRINGS",
      agreements.length,
      agreements.length,
      adjudicatedDisagreements.length,
      populationCommitment,
    );
  }

  if (candidates.some((candidate) => candidate.operatorAdjudication === undefined)) {
    return reviewOnly(
      config,
      candidates.length,
      distinctSessionCount,
      "INCOMPLETE_OPERATOR_ADJUDICATION",
      agreements.length,
      agreements.length,
      adjudicatedDisagreements.length,
      populationCommitment,
    );
  }

  const auditedAgreementTp = agreements.filter(
    (candidate) => candidate.operatorAdjudication === "TRUE_POSITIVE",
  ).length;
  const truePositive = candidates.filter(
    (candidate) => candidate.operatorAdjudication === "TRUE_POSITIVE",
  ).length;
  const estimatedPrecision = truePositive / candidates.length;
  const agreementConfidence =
    agreements.length === 0 ? null : wilson95(auditedAgreementTp, agreements.length);
  const estimateConfidence = wilson95(truePositive, candidates.length);
  const pointPasses = estimatedPrecision >= U12_PRECISION_THRESHOLD;
  const certified = pointPasses && estimateConfidence.lower >= U12_PRECISION_THRESHOLD;

  return {
    detectorId: config.detectorId,
    ruleVersion: config.ruleVersion,
    parserVersion: config.parserVersion,
    claudeCodeVersion: config.claudeCodeVersion,
    status: certified ? "CERTIFIED_ON_BY_DEFAULT" : "REVIEW_ONLY",
    routingTier: certified ? "ON_BY_DEFAULT" : "T3_REVIEW",
    reason: certified
      ? "CERTIFIED"
      : pointPasses
        ? "WILSON_LOWER_BOUND_BELOW_THRESHOLD"
        : "BELOW_PRECISION_THRESHOLD",
    firingCount: candidates.length,
    distinctSessionCount,
    minimumFirings: config.minimumFirings,
    precisionThreshold: U12_PRECISION_THRESHOLD,
    estimatedPrecision,
    agreementAudit: {
      population: agreements.length,
      sampled: agreements.length,
      truePositive: auditedAgreementTp,
      rate: config.agreementAuditRate,
      confidence95: agreementConfidence,
    },
    disagreementAdjudicated: adjudicatedDisagreements.length,
    estimateConfidence95: estimateConfidence,
    populationCommitment,
    limitation: "FULL_OPERATOR_ADJUDICATION",
  };
}
