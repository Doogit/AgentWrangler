import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../common/approved-input.js";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../common/canonical.js";
import type { R3AggregateReport, R3HumanVerdict, R3ScoredReport, R3SealedKey } from "./types.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const COVERAGE_THRESHOLD = 0.8;
const PRECISION_THRESHOLD = 0.95;
const VERDICTS = new Set(["CORRECT", "INCORRECT", "UNCERTAIN"]);
const REASONS = new Set([
  "TIMELINE",
  "COMMIT_SIGNAL",
  "KNOWN_WORK_ITEM",
  "CONFLICT",
  "INSUFFICIENT",
]);

export interface R3ScoreRequest {
  approvedInput: ApprovedEvidenceInput;
  aggregatePath: string;
  aggregateSha256: string;
  sealedKeyPath: string;
  sealedKeySha256: string;
  verdictsPath: string;
  verdictsSha256: string;
  out: string;
}

function refuse(code: string): never {
  throw new Error(code);
}

function retainedFailure(error: unknown): Error {
  const message =
    error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "r3_score_failure";
  return new Error(`${message}_scratch_verification_retained`);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) refuse(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value as Record<string, unknown>;
}

function readJson(state: string, file: string, digest: string, code: string): unknown {
  if (!SHA256_RE.test(digest)) refuse(`${code}_digest_invalid`);
  const stateReal = fs.realpathSync.native(state);
  const fileReal = fs.realpathSync.native(file);
  if (path.dirname(fileReal) !== stateReal) refuse(`${code}_path_invalid`);
  const bytes = fs.readFileSync(fileReal);
  if (sha256Bytes(bytes) !== digest) refuse(`${code}_digest_mismatch`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    refuse(`${code}_json_invalid`);
  }
}

function parseAggregate(value: unknown): R3AggregateReport {
  const parsed = record(value, "r3_score_aggregate_invalid");
  exactKeys(
    parsed,
    [
      "campaign",
      "status",
      "identity",
      "backfill",
      "denominator",
      "shadow",
      "adjudication",
      "projected",
      "byRepoAlias",
      "deterministicRerun",
      "privacy",
    ],
    "r3_score_aggregate_keys_invalid",
  );
  if (
    parsed.campaign !== "R3_U4_BRANCH_LINKAGE" ||
    (parsed.status !== "PREPARED" && parsed.status !== "DATA_INSUFFICIENT") ||
    !Array.isArray(parsed.byRepoAlias)
  )
    refuse("r3_score_aggregate_value_invalid");
  const denominator = record(parsed.denominator, "r3_score_denominator_invalid");
  exactKeys(
    denominator,
    [
      "reconciledSessionsN",
      "outcomeBearingSessionsN",
      "baselineLinkedOutcomeBearingN",
      "excludedNotReconciledN",
      "excludedNoBashN",
      "excludedNoWorkItemsN",
    ],
    "r3_score_denominator_keys_invalid",
  );
  for (const count of Object.values(denominator)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      refuse("r3_score_denominator_value_invalid");
  }
  const privacy = record(parsed.privacy, "r3_score_privacy_invalid");
  exactKeys(
    privacy,
    ["linkTableUnchanged", "rawRefN", "transcriptPathN", "tokenN"],
    "r3_score_privacy_keys_invalid",
  );
  if (
    typeof privacy.linkTableUnchanged !== "boolean" ||
    privacy.rawRefN !== 0 ||
    privacy.transcriptPathN !== 0 ||
    privacy.tokenN !== 0
  )
    refuse("r3_score_privacy_value_invalid");
  const shadow = record(parsed.shadow, "r3_score_shadow_invalid");
  exactKeys(
    shadow,
    [
      "candidateReasonN",
      "dispositionReasonN",
      "uniqueUpliftCandidatesN",
      "higherPrecedenceCandidatesN",
      "backtestEligibleN",
      "backtestAgreementN",
      "backtestDisagreementN",
      "transcriptSucceededN",
      "transcriptFailureReasonN",
    ],
    "r3_score_shadow_keys_invalid",
  );
  for (const key of [
    "uniqueUpliftCandidatesN",
    "higherPrecedenceCandidatesN",
    "backtestEligibleN",
    "backtestAgreementN",
    "backtestDisagreementN",
    "transcriptSucceededN",
  ] as const) {
    if (typeof shadow[key] !== "number" || !Number.isSafeInteger(shadow[key]) || shadow[key] < 0)
      refuse("r3_score_shadow_value_invalid");
  }
  const rerun = record(parsed.deterministicRerun, "r3_score_rerun_invalid");
  exactKeys(
    rerun,
    ["firstCanonicalSha256", "secondCanonicalSha256", "equal"],
    "r3_score_rerun_keys_invalid",
  );
  if (
    typeof rerun.firstCanonicalSha256 !== "string" ||
    !SHA256_RE.test(rerun.firstCanonicalSha256) ||
    typeof rerun.secondCanonicalSha256 !== "string" ||
    !SHA256_RE.test(rerun.secondCanonicalSha256) ||
    typeof rerun.equal !== "boolean"
  )
    refuse("r3_score_rerun_value_invalid");
  const aliases = new Set<string>();
  for (const raw of parsed.byRepoAlias) {
    const cohort = record(raw, "r3_score_cohort_invalid");
    exactKeys(
      cohort,
      [
        "repoAlias",
        "outcomeBearingSessionsN",
        "baselineLinkedOutcomeBearingN",
        "candidateReasonN",
        "dispositionReasonN",
        "requiredAdjudicationN",
        "adjudicatedN",
        "correctN",
        "incorrectN",
        "uncertainN",
      ],
      "r3_score_cohort_keys_invalid",
    );
    if (
      typeof cohort.repoAlias !== "string" ||
      cohort.repoAlias.length === 0 ||
      aliases.has(cohort.repoAlias)
    )
      refuse("r3_score_cohort_alias_invalid");
    aliases.add(cohort.repoAlias);
  }
  return value as R3AggregateReport;
}

function parseKey(value: unknown): R3SealedKey {
  const parsed = record(value, "r3_score_key_invalid");
  exactKeys(
    parsed,
    [
      "campaignId",
      "packetVersion",
      "scorerVersion",
      "randomizationSeed",
      "randomizationSeedCommitment",
      "aggregateSha256",
      "entries",
    ],
    "r3_score_key_keys_invalid",
  );
  if (
    typeof parsed.campaignId !== "string" ||
    parsed.campaignId.length === 0 ||
    parsed.packetVersion !== "r3-u4-blinded-v1" ||
    parsed.scorerVersion !== "r3-u4-score-v1" ||
    typeof parsed.randomizationSeed !== "string" ||
    !/^[0-9a-f]{64,}$/u.test(parsed.randomizationSeed) ||
    typeof parsed.randomizationSeedCommitment !== "string" ||
    !SHA256_RE.test(parsed.randomizationSeedCommitment) ||
    typeof parsed.aggregateSha256 !== "string" ||
    !SHA256_RE.test(parsed.aggregateSha256) ||
    !Array.isArray(parsed.entries)
  )
    refuse("r3_score_key_value_invalid");
  const ids = new Set<string>();
  for (const raw of parsed.entries) {
    const entry = record(raw, "r3_score_key_entry_invalid");
    exactKeys(
      entry,
      [
        "candidateId",
        "sessionId",
        "candidateWorkItemId",
        "repoAlias",
        "cohort",
        "backtestCorrect",
        "redactionFailed",
      ],
      "r3_score_key_entry_keys_invalid",
    );
    if (
      typeof entry.candidateId !== "string" ||
      entry.candidateId.length === 0 ||
      ids.has(entry.candidateId) ||
      typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 ||
      typeof entry.candidateWorkItemId !== "string" ||
      entry.candidateWorkItemId.length === 0 ||
      typeof entry.repoAlias !== "string" ||
      entry.repoAlias.length === 0 ||
      (entry.cohort !== "UPLIFT" && entry.cohort !== "BACKTEST") ||
      !(typeof entry.backtestCorrect === "boolean" || entry.backtestCorrect === null) ||
      typeof entry.redactionFailed !== "boolean"
    )
      refuse("r3_score_key_entry_value_invalid");
    ids.add(entry.candidateId);
  }
  return value as R3SealedKey;
}

function parseVerdicts(value: unknown): R3HumanVerdict[] {
  if (!Array.isArray(value)) refuse("r3_verdicts_invalid");
  const ids = new Set<string>();
  return value.map((raw) => {
    const row = record(raw, "r3_verdict_invalid");
    exactKeys(
      row,
      ["candidateId", "verdict", "adjudicatorAlias", "reasonCode"],
      "r3_verdict_keys_invalid",
    );
    if (
      typeof row.candidateId !== "string" ||
      row.candidateId.length === 0 ||
      ids.has(row.candidateId) ||
      typeof row.verdict !== "string" ||
      !VERDICTS.has(row.verdict) ||
      typeof row.adjudicatorAlias !== "string" ||
      row.adjudicatorAlias.length === 0 ||
      typeof row.reasonCode !== "string" ||
      !REASONS.has(row.reasonCode)
    )
      refuse("r3_verdict_value_invalid");
    ids.add(row.candidateId);
    return row as unknown as R3HumanVerdict;
  });
}

/** Score one exact packet key and complete one-adjudicator verdict set. */
export async function scoreR3(request: R3ScoreRequest): Promise<R3ScoredReport> {
  const approved = await loadApprovedEvidenceInput(request.approvedInput);
  try {
    const aggregate = parseAggregate(
      readJson(
        approved.scratchStatePath,
        request.aggregatePath,
        request.aggregateSha256,
        "r3_aggregate",
      ),
    );
    const key = parseKey(
      readJson(approved.scratchStatePath, request.sealedKeyPath, request.sealedKeySha256, "r3_key"),
    );
    const verdicts = parseVerdicts(
      readJson(
        approved.scratchStatePath,
        request.verdictsPath,
        request.verdictsSha256,
        "r3_verdicts",
      ),
    );
    if (key.aggregateSha256 !== request.aggregateSha256)
      refuse("r3_score_aggregate_binding_mismatch");
    const expectedCampaignId = sha256Canonical({
      identity: aggregate.identity,
      aggregate: request.aggregateSha256,
    }).slice(0, 32);
    if (key.campaignId !== expectedCampaignId) refuse("r3_score_campaign_binding_mismatch");
    if (sha256Bytes(Buffer.from(key.randomizationSeed, "hex")) !== key.randomizationSeedCommitment)
      refuse("r3_score_seed_commitment_mismatch");
    const entries = new Map(key.entries.map((entry) => [entry.candidateId, entry]));
    const upliftEntryN = key.entries.filter((entry) => entry.cohort === "UPLIFT").length;
    const backtestEntryN = key.entries.length - upliftEntryN;
    if (
      upliftEntryN !== aggregate.shadow.uniqueUpliftCandidatesN ||
      backtestEntryN !== Math.min(aggregate.shadow.backtestEligibleN, 100)
    )
      refuse("r3_score_packet_population_mismatch");
    const verdictMap = new Map<string, R3HumanVerdict>();
    const adjudicators = new Set<string>();
    for (const verdict of verdicts) {
      if (!entries.has(verdict.candidateId)) refuse("r3_score_unknown_verdict");
      verdictMap.set(verdict.candidateId, verdict);
      adjudicators.add(verdict.adjudicatorAlias);
    }
    if (verdicts.length > 0 && adjudicators.size !== 1)
      refuse("r3_score_adjudicator_count_invalid");
    let correctN = 0;
    let incorrectN = 0;
    let uncertainN = 0;
    let correctUpliftN = 0;
    let redactionViolation = false;
    const cohortByAlias = new Map(
      aggregate.byRepoAlias.map((cohort) => [
        cohort.repoAlias,
        {
          ...cohort,
          requiredAdjudicationN: 0,
          adjudicatedN: 0,
          correctN: 0,
          incorrectN: 0,
          uncertainN: 0,
        },
      ]),
    );
    for (const entry of key.entries) {
      const verdict = verdictMap.get(entry.candidateId);
      const effective = entry.redactionFailed ? "UNCERTAIN" : verdict?.verdict;
      if (entry.redactionFailed && verdict !== undefined && verdict.verdict !== "UNCERTAIN")
        redactionViolation = true;
      if (effective === "CORRECT") {
        correctN += 1;
        if (entry.cohort === "UPLIFT") correctUpliftN += 1;
      } else if (effective === "INCORRECT") incorrectN += 1;
      else if (effective === "UNCERTAIN") uncertainN += 1;
      const cohort = cohortByAlias.get(entry.repoAlias);
      if (cohort === undefined) refuse("r3_score_unknown_repo_alias");
      cohort.requiredAdjudicationN += 1;
      cohort.adjudicatedN += verdict === undefined ? 0 : 1;
      if (effective === "CORRECT") cohort.correctN += 1;
      else if (effective === "INCORRECT") cohort.incorrectN += 1;
      else if (effective === "UNCERTAIN") cohort.uncertainN += 1;
    }
    const complete =
      verdictMap.size === entries.size && adjudicators.size === (entries.size === 0 ? 0 : 1);
    const precisionDenominator = correctN + incorrectN;
    const precision =
      complete && uncertainN === 0 && precisionDenominator > 0
        ? correctN / precisionDenominator
        : null;
    const linkedNumerator = aggregate.denominator.baselineLinkedOutcomeBearingN + correctUpliftN;
    const coverage =
      aggregate.denominator.outcomeBearingSessionsN > 0
        ? linkedNumerator / aggregate.denominator.outcomeBearingSessionsN
        : null;
    const insufficient =
      aggregate.status === "DATA_INSUFFICIENT" ||
      !complete ||
      uncertainN > 0 ||
      redactionViolation ||
      precision === null ||
      coverage === null;
    const status = insufficient
      ? "DATA_INSUFFICIENT"
      : coverage >= COVERAGE_THRESHOLD && precision >= PRECISION_THRESHOLD
        ? "PASS"
        : "FAIL";
    const report: R3ScoredReport = {
      ...aggregate,
      status,
      adjudication: {
        requiredN: entries.size,
        adjudicatedN: verdictMap.size,
        correctN,
        incorrectN,
        uncertainN,
        precisionNumerator: correctN,
        precisionDenominator,
      },
      projected: {
        correctUniqueUpliftN: correctUpliftN,
        linkedNumerator,
        outcomeBearingDenominator: aggregate.denominator.outcomeBearingSessionsN,
        coverage,
        precision,
      },
      byRepoAlias: [...cohortByAlias.values()].sort((a, b) =>
        a.repoAlias < b.repoAlias ? -1 : a.repoAlias > b.repoAlias ? 1 : 0,
      ),
    };
    publishApprovedOutput(approved, request.out, canonicalJson(report));
    return report;
  } catch (error) {
    throw retainedFailure(error);
  }
}
