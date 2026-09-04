import { createHash } from "node:crypto";
import { EXTRACTOR_VERSIONS } from "../../outcomes/finding-extractors.js";
import type {
  Cond1AggregateScore,
  Cond1HumanVerdict,
  Cond1Limitation,
  Cond1SealedAnswer,
  Cond1Status,
  Cond1Verdict,
  ExtractorId,
  ExtractorPrecisionScore,
  FrozenCond1Identity,
  ScoreCond1Input,
} from "./types.js";

const EXTRACTORS: readonly ExtractorId[] = ["E1", "E2", "E3"];
const VERDICTS = new Set<Cond1Verdict>(["TRUE_POSITIVE", "FALSE_POSITIVE", "UNCERTAIN"]);
const REASON_CODES = new Set([
  "EVIDENCE_SUPPORTS",
  "CONTEXT_NEGATES",
  "NOT_A_DEFERRAL",
  "NOT_AN_ADDED_MARKER",
  "WRONG_THREAD_STATE",
  "INSUFFICIENT_EVIDENCE",
]);
const MIN_INFORMATIVE_FINDINGS = 20;
const PRECISION_THRESHOLD = 0.8 as const;
export const COND1_RUNNER_VERSION = "cond1-runner-v1" as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UTC_RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const IDENTITY_KEYS = [
  "sourceCommit",
  "runnerVersion",
  "findingsModuleSha256",
  "extractorVersions",
  "packetVersion",
  "scorerVersion",
  "asOf",
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalAnswerKeySha256(answers: readonly Cond1SealedAnswer[]): string {
  const stableIdentities = answers
    .map(
      ({
        extractor,
        extractorVersion,
        sourceFindingId,
        corpusPrKey,
        evidenceSufficient,
        projectionFailure,
      }) => ({
        extractor,
        extractorVersion,
        sourceFindingId,
        corpusPrKey,
        evidenceSufficient,
        projectionFailure,
      }),
    )
    .sort((left, right) => {
      return (
        compareText(left.extractor, right.extractor) ||
        compareText(left.corpusPrKey, right.corpusPrKey) ||
        compareText(left.sourceFindingId, right.sourceFindingId) ||
        compareText(left.extractorVersion, right.extractorVersion)
      );
    });
  return canonicalSha256(stableIdentities);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStrictUtcRfc3339(value: string): boolean {
  const match = UTC_RFC3339_RE.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(yearText) &&
    parsed.getUTCMonth() + 1 === Number(monthText) &&
    parsed.getUTCDate() === Number(dayText) &&
    parsed.getUTCHours() === Number(hourText) &&
    parsed.getUTCMinutes() === Number(minuteText) &&
    parsed.getUTCSeconds() === Number(secondText)
  );
}

function frozenIdentity(identity: FrozenCond1Identity): FrozenCond1Identity {
  return {
    sourceCommit: identity.sourceCommit,
    runnerVersion: COND1_RUNNER_VERSION,
    findingsModuleSha256: identity.findingsModuleSha256,
    extractorVersions: {
      E1: identity.extractorVersions.E1,
      E2: identity.extractorVersions.E2,
      E3: identity.extractorVersions.E3,
    },
    packetVersion: identity.packetVersion,
    scorerVersion: identity.scorerVersion,
    asOf: identity.asOf,
  };
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isVerdict(value: unknown): value is Cond1Verdict {
  return typeof value === "string" && VERDICTS.has(value as Cond1Verdict);
}

function isValidVerdictRow(value: Cond1HumanVerdict): boolean {
  return (
    typeof value.findingAlias === "string" &&
    value.findingAlias.length > 0 &&
    isVerdict(value.verdict) &&
    typeof value.adjudicatorAlias === "string" &&
    value.adjudicatorAlias.length > 0 &&
    typeof value.reasonCode === "string" &&
    REASON_CODES.has(value.reasonCode)
  );
}

function scoreStatus(precision: number | null, limitation: Cond1Limitation): Cond1Status {
  if (limitation !== "NONE") return "DATA_INSUFFICIENT";
  return precision !== null && precision >= PRECISION_THRESHOLD ? "PASS" : "FAIL";
}

function overallStatus(scores: Record<ExtractorId, ExtractorPrecisionScore>): Cond1Status {
  const statuses = EXTRACTORS.map((extractor) => scores[extractor].status);
  if (statuses.includes("DATA_INSUFFICIENT")) return "DATA_INSUFFICIENT";
  if (statuses.includes("FAIL")) return "FAIL";
  return "PASS";
}

/**
 * Score a complete COND-1 answer key and verdict set. The function has no I/O
 * and returns only the approved durable aggregate shape.
 */
export function scoreCond1(input: ScoreCond1Input): Cond1AggregateScore {
  const { manifest, answers, verdicts } = input;
  const { corpusReadSummary } = manifest;
  const durableIdentity = frozenIdentity(manifest.identity);
  const answerKeyCanonicalSha256 = canonicalAnswerKeySha256(answers);

  let globalIdentityMismatch =
    !SHA256_RE.test(input.corpusManifestFileSha256) ||
    manifest.version !== "cond1-corpus-manifest-v1" ||
    answerKeyCanonicalSha256 !== manifest.answerCanonicalSha256 ||
    manifest.identity.packetVersion !== "cond1-blinded-v1" ||
    manifest.identity.scorerVersion !== "cond1-precision-v1" ||
    manifest.campaignId.length === 0 ||
    manifest.identity.runnerVersion !== COND1_RUNNER_VERSION ||
    !GIT_COMMIT_RE.test(manifest.identity.sourceCommit) ||
    !SHA256_RE.test(manifest.identity.findingsModuleSha256) ||
    !SHA256_RE.test(manifest.scratchDbSha256) ||
    !SHA256_RE.test(manifest.repoMapSha256) ||
    !SHA256_RE.test(manifest.preparedArtifactSha256) ||
    !SHA256_RE.test(manifest.answerCanonicalSha256) ||
    !isStrictUtcRfc3339(manifest.identity.asOf) ||
    !hasExactKeys(manifest.identity, IDENTITY_KEYS) ||
    !hasExactKeys(manifest.identity.extractorVersions, EXTRACTORS) ||
    EXTRACTORS.some(
      (extractor) =>
        manifest.identity.extractorVersions[extractor] !== EXTRACTOR_VERSIONS[extractor],
    );

  const countsAreValid =
    isNonNegativeInteger(manifest.eligiblePrN) &&
    isNonNegativeInteger(corpusReadSummary.fullyReadPrN) &&
    isNonNegativeInteger(corpusReadSummary.failedPrN) &&
    corpusReadSummary.fullyReadPrN + corpusReadSummary.failedPrN === manifest.eligiblePrN &&
    corpusReadSummary.failedPrN <=
      EXTRACTORS.reduce((sum, extractor) => sum + manifest.readCompletion[extractor].failedN, 0);
  if (!countsAreValid) globalIdentityMismatch = true;
  const answersByAlias = new Map<string, Cond1SealedAnswer>();
  const answerAliasesByExtractor: Record<ExtractorId, Set<string>> = {
    E1: new Set(),
    E2: new Set(),
    E3: new Set(),
  };
  const duplicateAnswerExtractors = new Set<ExtractorId>();
  const sourceIdentities = new Set<string>();
  for (const answer of answers) {
    if (
      !EXTRACTORS.includes(answer.extractor) ||
      answer.extractorVersion !== EXTRACTOR_VERSIONS[answer.extractor] ||
      answer.findingAlias.length === 0 ||
      answer.sourceFindingId.length === 0 ||
      answer.corpusPrKey.length === 0 ||
      typeof answer.evidenceSufficient !== "boolean" ||
      !(answer.projectionFailure === null || answer.projectionFailure === "REDACTION_FAILED") ||
      answer.evidenceSufficient === (answer.projectionFailure !== null)
    ) {
      globalIdentityMismatch = true;
      continue;
    }
    if (answersByAlias.has(answer.findingAlias)) {
      duplicateAnswerExtractors.add(answer.extractor);
      globalIdentityMismatch = true;
    }
    const sourceIdentity = canonicalSha256([
      answer.extractor,
      answer.corpusPrKey,
      answer.sourceFindingId,
    ]);
    if (sourceIdentities.has(sourceIdentity)) globalIdentityMismatch = true;
    sourceIdentities.add(sourceIdentity);
    answersByAlias.set(answer.findingAlias, answer);
    answerAliasesByExtractor[answer.extractor].add(answer.findingAlias);
  }

  const verdictsByAlias = new Map<string, Cond1HumanVerdict>();
  const duplicateVerdictExtractors = new Set<ExtractorId>();
  const adjudicatorAliases = new Set<string>();
  let invalidAdjudicatorAlias = false;
  let unknownVerdictAlias = false;
  for (const verdict of verdicts) {
    if (typeof verdict.adjudicatorAlias !== "string" || verdict.adjudicatorAlias.length === 0) {
      invalidAdjudicatorAlias = true;
    } else {
      adjudicatorAliases.add(verdict.adjudicatorAlias);
    }
    const answer = answersByAlias.get(verdict.findingAlias);
    if (answer === undefined) {
      unknownVerdictAlias = true;
      continue;
    }
    if (verdictsByAlias.has(verdict.findingAlias)) duplicateVerdictExtractors.add(answer.extractor);
    verdictsByAlias.set(verdict.findingAlias, verdict);
  }
  if (unknownVerdictAlias) globalIdentityMismatch = true;
  if (invalidAdjudicatorAlias || adjudicatorAliases.size !== 1) globalIdentityMismatch = true;

  const extractorScores = {} as Record<ExtractorId, ExtractorPrecisionScore>;
  for (const extractor of EXTRACTORS) {
    const read = manifest.readCompletion[extractor];
    const emittedN = manifest.emittedFindingN[extractor];
    let extractorIdentityMismatch =
      globalIdentityMismatch ||
      duplicateAnswerExtractors.has(extractor) ||
      duplicateVerdictExtractors.has(extractor) ||
      !isNonNegativeInteger(emittedN) ||
      !isNonNegativeInteger(read.requiredN) ||
      !isNonNegativeInteger(read.succeededN) ||
      !isNonNegativeInteger(read.failedN) ||
      read.requiredN !== manifest.eligiblePrN ||
      read.succeededN + read.failedN !== read.requiredN ||
      answerAliasesByExtractor[extractor].size !== emittedN;

    if (
      countsAreValid &&
      (read.succeededN < corpusReadSummary.fullyReadPrN ||
        read.failedN > corpusReadSummary.failedPrN)
    ) {
      extractorIdentityMismatch = true;
    }

    const counts = { truePositiveN: 0, falsePositiveN: 0, uncertainN: 0 };
    let adjudicatedN = 0;
    let invalidVerdict = false;
    let unsupportedProjectionVerdict = false;
    for (const alias of answerAliasesByExtractor[extractor]) {
      const verdict = verdictsByAlias.get(alias);
      if (verdict === undefined) continue;
      if (!isValidVerdictRow(verdict)) {
        invalidVerdict = true;
        continue;
      }
      const answer = answersByAlias.get(alias);
      if (
        answer !== undefined &&
        !answer.evidenceSufficient &&
        (verdict.verdict !== "UNCERTAIN" || verdict.reasonCode !== "INSUFFICIENT_EVIDENCE")
      ) {
        unsupportedProjectionVerdict = true;
        continue;
      }
      adjudicatedN++;
      if (verdict.verdict === "TRUE_POSITIVE") counts.truePositiveN++;
      else if (verdict.verdict === "FALSE_POSITIVE") counts.falsePositiveN++;
      else counts.uncertainN++;
    }

    const unadjudicatedN = Math.max(emittedN - adjudicatedN, 0);
    const precisionDenominator = counts.truePositiveN + counts.falsePositiveN;
    const completeReads = read.failedN === 0 && read.succeededN === read.requiredN;
    const completeAdjudication =
      !invalidVerdict &&
      !unsupportedProjectionVerdict &&
      adjudicatedN === emittedN &&
      unadjudicatedN === 0 &&
      !duplicateVerdictExtractors.has(extractor);
    const precision =
      extractor !== "E1" &&
      emittedN > 0 &&
      completeReads &&
      completeAdjudication &&
      counts.uncertainN === 0
        ? counts.truePositiveN / precisionDenominator
        : null;
    const sparse = emittedN < MIN_INFORMATIVE_FINDINGS;

    let limitation: Cond1Limitation = "NONE";
    if (extractorIdentityMismatch) limitation = "IDENTITY_MISMATCH";
    else if (!completeReads) limitation = "INCOMPLETE_READS";
    else if (emittedN === 0) limitation = "ZERO_EMISSIONS";
    else if (!completeAdjudication) limitation = "INCOMPLETE_ADJUDICATION";
    else if (counts.uncertainN > 0) limitation = "UNCERTAIN_VERDICTS";
    else if (extractor === "E1") limitation = "CURRENT_STATE_ONLY";
    else if (sparse) limitation = "SPARSE_LT_20";

    extractorScores[extractor] = {
      extractor,
      corpusPrN: manifest.eligiblePrN,
      emittedN,
      requiredAdjudicationN: emittedN,
      adjudicatedN,
      truePositiveN: counts.truePositiveN,
      falsePositiveN: counts.falsePositiveN,
      uncertainN: counts.uncertainN,
      unadjudicatedN,
      precisionNumerator: counts.truePositiveN,
      precisionDenominator,
      precision,
      threshold: PRECISION_THRESHOLD,
      sparse,
      status: scoreStatus(precision, limitation),
      limitation,
    };
  }

  return {
    campaign: "COND1_FINDINGS_PRECISION",
    identity: {
      sourceCommit: durableIdentity.sourceCommit,
      runnerVersion: durableIdentity.runnerVersion,
      findingsModuleSha256: durableIdentity.findingsModuleSha256,
      extractorVersions: durableIdentity.extractorVersions,
      packetVersion: durableIdentity.packetVersion,
      scorerVersion: durableIdentity.scorerVersion,
      asOf: durableIdentity.asOf,
      scratchDbSha256: manifest.scratchDbSha256,
      repoMapSha256: manifest.repoMapSha256,
      corpusManifestSha256: input.corpusManifestFileSha256,
      answerKeyCanonicalSha256,
    },
    corpus: {
      eligiblePrN: manifest.eligiblePrN,
      fullyReadPrN: corpusReadSummary.fullyReadPrN,
      failedPrN: corpusReadSummary.failedPrN,
    },
    extractors: extractorScores,
    overallStatus: overallStatus(extractorScores),
    durablePrivacy: { rawEvidenceN: 0, evidenceRefN: 0, pathN: 0, tokenN: 0 },
  };
}
