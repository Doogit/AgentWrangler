import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTRACTOR_VERSIONS } from "../../outcomes/finding-extractors.js";
import type { LoadedApprovedEvidenceInput } from "../common/approved-input.js";
import { publishApprovedOutput } from "../common/approved-input.js";
import { EvidenceBoundaryError } from "../common/boundary.js";
import { canonicalJson, sha256Bytes } from "../common/canonical.js";
import { redactEvidenceExcerpt } from "../common/redaction.js";
import { COND1_RUNNER_VERSION, canonicalAnswerKeySha256 } from "./score.js";
import type {
  Cond1BlindedEntry,
  Cond1BlindedPacket,
  Cond1CorpusManifest,
  Cond1PreparedArtifact,
  Cond1SealedAnswer,
  Cond1SealedKey,
} from "./types.js";

export type Cond1RandomBytes = (size: number) => Buffer;

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function digest(value: unknown, code: string): string {
  const parsed = text(value, code);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) fail(code);
  return parsed;
}

function count(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function strictIdentity(value: unknown): Record<string, unknown> {
  const identity = record(value, "cond1_manifest_identity_invalid");
  exactKeys(
    identity,
    [
      "sourceCommit",
      "runnerVersion",
      "findingsModuleSha256",
      "extractorVersions",
      "packetVersion",
      "scorerVersion",
      "asOf",
    ],
    "cond1_manifest_identity_keys_invalid",
  );
  const versions = record(identity.extractorVersions, "cond1_manifest_versions_invalid");
  exactKeys(versions, ["E1", "E2", "E3"], "cond1_manifest_versions_keys_invalid");
  const asOf = text(identity.asOf, "cond1_as_of_invalid");
  const asOfMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/u.exec(asOf);
  const asOfTime = asOfMatch?.[1] === undefined ? Number.NaN : Date.parse(`${asOfMatch[1]}Z`);
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
      text(identity.sourceCommit, "cond1_source_commit_invalid"),
    ) ||
    identity.runnerVersion !== COND1_RUNNER_VERSION ||
    !/^[0-9a-f]{64}$/u.test(text(identity.findingsModuleSha256, "cond1_findings_digest_invalid")) ||
    versions.E1 !== EXTRACTOR_VERSIONS.E1 ||
    versions.E2 !== EXTRACTOR_VERSIONS.E2 ||
    versions.E3 !== EXTRACTOR_VERSIONS.E3 ||
    identity.packetVersion !== "cond1-blinded-v1" ||
    identity.scorerVersion !== "cond1-precision-v1" ||
    !Number.isFinite(asOfTime) ||
    new Date(asOfTime).toISOString().slice(0, 19) !== asOfMatch?.[1]
  ) {
    fail("cond1_manifest_identity_value_invalid");
  }
  return identity;
}

export function readApprovedArtifactJson(
  loaded: Pick<LoadedApprovedEvidenceInput, "scratchStatePath">,
  inputPath: string,
  expectedSha256: string,
): unknown {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) fail("cond1_input_digest_invalid");
  const resolved = path.resolve(inputPath);
  if (path.dirname(resolved) !== path.resolve(loaded.scratchStatePath)) {
    fail("cond1_input_not_direct_state_child");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail("cond1_input_missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("cond1_input_not_regular_file");
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch {
    fail("cond1_input_read_failed");
  }
  if (sha256Bytes(bytes) !== expectedSha256) fail("cond1_input_digest_mismatch");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return fail("cond1_input_json_invalid");
  }
}

export function parseCond1Manifest(value: unknown): Cond1CorpusManifest {
  const manifest = record(value, "cond1_manifest_invalid");
  exactKeys(
    manifest,
    [
      "version",
      "campaignId",
      "identity",
      "scratchDbSha256",
      "repoMapSha256",
      "eligiblePrN",
      "readCompletion",
      "corpusReadSummary",
      "emittedFindingN",
      "preparedArtifactSha256",
      "answerCanonicalSha256",
    ],
    "cond1_manifest_keys_invalid",
  );
  if (
    manifest.version !== "cond1-corpus-manifest-v1" ||
    !/^cond1-[0-9a-f]{32}$/u.test(text(manifest.campaignId, "cond1_campaign_invalid"))
  )
    fail("cond1_manifest_version_or_campaign_invalid");
  strictIdentity(manifest.identity);
  digest(manifest.scratchDbSha256, "cond1_scratch_digest_invalid");
  digest(manifest.repoMapSha256, "cond1_repo_map_digest_invalid");
  digest(manifest.preparedArtifactSha256, "cond1_prepared_digest_invalid");
  digest(manifest.answerCanonicalSha256, "cond1_answer_digest_invalid");
  const eligiblePrN = count(manifest.eligiblePrN, "cond1_eligible_count_invalid");
  exactKeys(
    record(manifest.readCompletion, "cond1_manifest_reads_invalid"),
    ["E1", "E2", "E3"],
    "cond1_manifest_reads_keys_invalid",
  );
  const succeededCounts: number[] = [];
  const failedCounts: number[] = [];
  for (const extractor of ["E1", "E2", "E3"]) {
    const read = record(
      (manifest.readCompletion as Record<string, unknown>)[extractor],
      "cond1_manifest_read_invalid",
    );
    exactKeys(read, ["requiredN", "succeededN", "failedN"], "cond1_manifest_read_keys_invalid");
    const requiredN = count(read.requiredN, "cond1_manifest_read_count_invalid");
    const succeededN = count(read.succeededN, "cond1_manifest_read_count_invalid");
    const failedN = count(read.failedN, "cond1_manifest_read_count_invalid");
    if (requiredN !== eligiblePrN || succeededN + failedN !== requiredN)
      fail("cond1_manifest_read_count_mismatch");
    succeededCounts.push(succeededN);
    failedCounts.push(failedN);
  }
  const summary = record(manifest.corpusReadSummary, "cond1_manifest_summary_invalid");
  exactKeys(summary, ["fullyReadPrN", "failedPrN"], "cond1_manifest_summary_keys_invalid");
  exactKeys(
    record(manifest.emittedFindingN, "cond1_manifest_counts_invalid"),
    ["E1", "E2", "E3"],
    "cond1_manifest_counts_keys_invalid",
  );
  const fullyReadPrN = count(summary.fullyReadPrN, "cond1_manifest_summary_count_invalid");
  const failedPrN = count(summary.failedPrN, "cond1_manifest_summary_count_invalid");
  if (fullyReadPrN + failedPrN !== eligiblePrN) fail("cond1_manifest_summary_count_mismatch");
  if (
    succeededCounts.some((succeededN) => succeededN < fullyReadPrN) ||
    failedCounts.some((extractorFailedN) => extractorFailedN > failedPrN) ||
    failedPrN > failedCounts.reduce((sum, failedN) => sum + failedN, 0)
  ) {
    fail("cond1_manifest_intersection_count_mismatch");
  }
  const emitted = manifest.emittedFindingN as Record<string, unknown>;
  for (const extractor of ["E1", "E2", "E3"])
    count(emitted[extractor], "cond1_manifest_emitted_count_invalid");
  return value as Cond1CorpusManifest;
}

export function parseCond1Prepared(value: unknown): Cond1PreparedArtifact {
  const prepared = record(value, "cond1_prepared_invalid");
  exactKeys(
    prepared,
    [
      "version",
      "campaignId",
      "identity",
      "scratchDbSha256",
      "repoMapSha256",
      "eligiblePrN",
      "findings",
    ],
    "cond1_prepared_keys_invalid",
  );
  if (
    prepared.version !== "cond1-prepared-v1" ||
    !/^cond1-[0-9a-f]{32}$/u.test(text(prepared.campaignId, "cond1_prepared_campaign_invalid")) ||
    !Array.isArray(prepared.findings)
  ) {
    fail("cond1_prepared_shape_invalid");
  }
  strictIdentity(prepared.identity);
  digest(prepared.scratchDbSha256, "cond1_prepared_scratch_digest_invalid");
  digest(prepared.repoMapSha256, "cond1_prepared_repo_digest_invalid");
  count(prepared.eligiblePrN, "cond1_prepared_eligible_count_invalid");
  const sourceIdentities = new Set<string>();
  const corpusRepositories = new Map<string, string>();
  for (const item of prepared.findings) {
    const finding = record(item, "cond1_prepared_finding_invalid");
    exactKeys(
      finding,
      [
        "extractor",
        "extractorVersion",
        "sourceFindingId",
        "corpusPrKey",
        "repoAlias",
        "evidenceKind",
        "evidence",
        "evidenceSufficient",
        "projectionFailure",
      ],
      "cond1_prepared_finding_keys_invalid",
    );
    const evidence = record(finding.evidence, "cond1_prepared_evidence_invalid");
    const allowedEvidenceKeys = new Set([
      "stateAtRelevantTime",
      "temporalBasis",
      "boundedExcerpt",
      "locationAlias",
    ]);
    if (Object.keys(evidence).some((key) => !allowedEvidenceKeys.has(key))) {
      fail("cond1_prepared_evidence_keys_invalid");
    }
    const extractor = text(finding.extractor, "cond1_prepared_extractor_invalid");
    if (!(extractor === "E1" || extractor === "E2" || extractor === "E3"))
      fail("cond1_prepared_extractor_invalid");
    if (finding.extractorVersion !== EXTRACTOR_VERSIONS[extractor])
      fail("cond1_prepared_extractor_version_invalid");
    const sourceFindingId = text(finding.sourceFindingId, "cond1_prepared_source_id_invalid");
    const corpusPrKey = text(finding.corpusPrKey, "cond1_prepared_pr_key_invalid");
    const repoAlias = text(finding.repoAlias, "cond1_prepared_repo_alias_invalid");
    if (!/^[A-Za-z0-9_.-]+$/u.test(repoAlias)) fail("cond1_prepared_repo_alias_invalid");
    const existingRepoAlias = corpusRepositories.get(corpusPrKey);
    if (existingRepoAlias !== undefined && existingRepoAlias !== repoAlias) {
      fail("cond1_prepared_corpus_repo_conflict");
    }
    corpusRepositories.set(corpusPrKey, repoAlias);
    const expectedKind = {
      E1: "REVIEW_THREAD_STATE",
      E2: "DEFERRAL_LIST_ITEM",
      E3: "ADDED_DIFF_MARKER",
    }[extractor];
    if (finding.evidenceKind !== expectedKind) fail("cond1_prepared_evidence_kind_invalid");
    if (typeof finding.evidenceSufficient !== "boolean")
      fail("cond1_prepared_evidence_sufficiency_invalid");
    if (!(finding.projectionFailure === null || finding.projectionFailure === "REDACTION_FAILED"))
      fail("cond1_prepared_projection_failure_invalid");
    if (finding.evidenceSufficient === (finding.projectionFailure !== null))
      fail("cond1_prepared_projection_marker_mismatch");
    if (extractor === "E1") {
      exactKeys(
        evidence,
        ["stateAtRelevantTime", "temporalBasis"],
        "cond1_e1_evidence_keys_invalid",
      );
      if (
        !(["RESOLVED", "UNRESOLVED"] as unknown[]).includes(evidence.stateAtRelevantTime) ||
        evidence.temporalBasis !== "CURRENT_STATE_ONLY" ||
        !finding.evidenceSufficient
      )
        fail("cond1_e1_evidence_invalid");
    } else {
      const requiredKeys = extractor === "E3" ? ["locationAlias"] : [];
      const actual = Object.keys(evidence)
        .filter((key) => key !== "boundedExcerpt")
        .sort();
      if (actual.join("|") !== requiredKeys.sort().join("|"))
        fail("cond1_text_evidence_keys_invalid");
      if (
        extractor === "E3" &&
        !/^loc-[0-9a-f]{20}$/u.test(text(evidence.locationAlias, "cond1_location_alias_invalid"))
      )
        fail("cond1_location_alias_invalid");
      if (finding.evidenceSufficient) {
        const excerpt = text(evidence.boundedExcerpt, "cond1_excerpt_invalid");
        if (redactEvidenceExcerpt(excerpt) !== excerpt) fail("cond1_excerpt_not_redacted");
      } else if (evidence.boundedExcerpt !== undefined) fail("cond1_failed_projection_has_excerpt");
    }
    const sourceIdentity = JSON.stringify([extractor, corpusPrKey, sourceFindingId]);
    if (sourceIdentities.has(sourceIdentity)) fail("cond1_prepared_source_duplicate");
    sourceIdentities.add(sourceIdentity);
  }
  if (corpusRepositories.size > (prepared.eligiblePrN as number)) {
    fail("cond1_prepared_corpus_count_invalid");
  }
  return value as Cond1PreparedArtifact;
}

function opaque(random: Cond1RandomBytes): string {
  const value = random(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) fail("cond1_rng_invalid");
  return value.toString("hex");
}

function uniqueOpaque(random: Cond1RandomBytes, used: Set<string>): string {
  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = opaque(random);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return fail("cond1_rng_collision_limit");
}

function seededRandom(seed: Buffer): Cond1RandomBytes {
  let counter = 0;
  return (size) => {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < size) {
      const block = createHmac("sha256", seed).update(`cond1-randomization:${counter++}`).digest();
      chunks.push(block);
      length += block.length;
    }
    return Buffer.concat(chunks).subarray(0, size);
  };
}

export interface PacketCond1Input {
  loaded: LoadedApprovedEvidenceInput;
  manifest: Cond1CorpusManifest;
  prepared: Cond1PreparedArtifact;
  preparedFileSha256: string;
  packetOutPath: string;
  keyOutPath: string;
  randomBytes?: Cond1RandomBytes;
  publishOutput?: typeof publishApprovedOutput;
}

export interface PacketCond1Result {
  findingN: number;
  packetSha256: string;
  keySha256: string;
  answerCanonicalSha256: string;
}

function preflightOutputs(loaded: LoadedApprovedEvidenceInput, outputs: readonly string[]): void {
  const state = path.resolve(loaded.scratchStatePath);
  const resolved = outputs.map((output) => path.resolve(output));
  if (new Set(resolved).size !== resolved.length) fail("cond1_output_paths_duplicate");
  for (const output of resolved) {
    if (path.dirname(output) !== state) fail("cond1_output_not_direct_state_child");
    try {
      fs.lstatSync(output);
      fail("cond1_output_already_exists");
    } catch (error) {
      if (error instanceof Error && error.message === "cond1_output_already_exists") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("cond1_output_preflight_failed");
    }
  }
}

export function packetCond1(input: PacketCond1Input): PacketCond1Result {
  const manifest = parseCond1Manifest(input.manifest);
  const prepared = parseCond1Prepared(input.prepared);
  preflightOutputs(input.loaded, [input.packetOutPath, input.keyOutPath]);
  const counts = { E1: 0, E2: 0, E3: 0 };
  for (const finding of prepared.findings) counts[finding.extractor]++;
  if (
    manifest.scratchDbSha256 !== input.loaded.scratchDbSha256 ||
    manifest.repoMapSha256 !== input.loaded.repoMapSha256 ||
    input.preparedFileSha256 !== manifest.preparedArtifactSha256 ||
    prepared.campaignId !== manifest.campaignId ||
    prepared.scratchDbSha256 !== manifest.scratchDbSha256 ||
    prepared.repoMapSha256 !== manifest.repoMapSha256 ||
    prepared.eligiblePrN !== manifest.eligiblePrN ||
    canonicalJson(prepared.identity) !== canonicalJson(manifest.identity) ||
    counts.E1 !== manifest.emittedFindingN.E1 ||
    counts.E2 !== manifest.emittedFindingN.E2 ||
    counts.E3 !== manifest.emittedFindingN.E3
  ) {
    fail("cond1_prepared_manifest_mismatch");
  }
  const entropy = input.randomBytes ?? randomBytes;
  const seed = entropy(32);
  if (!Buffer.isBuffer(seed) || seed.length !== 32) fail("cond1_rng_invalid");
  const random = seededRandom(seed);
  const prAliases = new Map<string, string>();
  const used = new Set<string>();
  const usedPrAliases = new Set<string>();
  const rows: Array<{ order: string; entry: Cond1BlindedEntry; answer: Cond1SealedAnswer }> = [];
  for (const finding of prepared.findings) {
    const findingAlias = uniqueOpaque(random, used);
    let prAlias = prAliases.get(finding.corpusPrKey);
    if (prAlias === undefined) {
      prAlias = uniqueOpaque(random, usedPrAliases);
      prAliases.set(finding.corpusPrKey, prAlias);
    }
    rows.push({
      order: opaque(random),
      entry: {
        findingAlias,
        repoAlias: finding.repoAlias,
        prAlias,
        evidenceKind: finding.evidenceKind,
        criterion: "DOES_THE_DISPLAYED_EVIDENCE_SUPPORT_THE_STATED_FINDING",
        evidence: finding.evidence,
      },
      answer: {
        findingAlias,
        extractor: finding.extractor,
        extractorVersion: finding.extractorVersion,
        sourceFindingId: finding.sourceFindingId,
        corpusPrKey: finding.corpusPrKey,
        evidenceSufficient: finding.evidenceSufficient,
        projectionFailure: finding.projectionFailure,
      },
    });
  }
  rows.sort((left, right) => (left.order < right.order ? -1 : left.order > right.order ? 1 : 0));
  const answers = rows.map(({ answer }) => answer);
  const answerCanonicalSha256 = canonicalAnswerKeySha256(answers);
  if (answerCanonicalSha256 !== manifest.answerCanonicalSha256) {
    fail("cond1_answer_canonical_digest_mismatch");
  }
  const packet: Cond1BlindedPacket = {
    campaignId: manifest.campaignId,
    packetVersion: "cond1-blinded-v1",
    randomizationSeedCommitment: sha256Bytes(seed),
    entries: rows.map(({ entry }) => entry),
  };
  const key: Cond1SealedKey = {
    version: "cond1-sealed-key-v1",
    campaignId: manifest.campaignId,
    randomizationSeed: seed.toString("hex"),
    answerCanonicalSha256,
    answers,
  };
  const publish = input.publishOutput ?? publishApprovedOutput;
  const packetPublication = publish(
    input.loaded,
    input.packetOutPath,
    `${canonicalJson(packet)}\n`,
  );
  let keyPublication: ReturnType<typeof publishApprovedOutput>;
  try {
    keyPublication = publish(input.loaded, input.keyOutPath, `${canonicalJson(key)}\n`);
  } catch (error) {
    const code = error instanceof EvidenceBoundaryError ? error.code : "unexpected_failure";
    fail(`cond1_key_publication_failed_packet_output_retained_${code}`);
  }
  return {
    findingN: rows.length,
    packetSha256: packetPublication.sha256,
    keySha256: keyPublication.sha256,
    answerCanonicalSha256,
  };
}
