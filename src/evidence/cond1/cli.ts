import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTRACTOR_VERSIONS } from "../../outcomes/finding-extractors.js";
import { type TokenReader, readGithubToken } from "../../outcomes/github/credential.js";
import {
  type ApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../common/approved-input.js";
import { EvidenceBoundaryError } from "../common/boundary.js";
import { canonicalJson } from "../common/canonical.js";
import type { EvidenceGithubClient } from "../github/client.js";
import { EvidenceGhCliClient } from "../github/gh-cli-client.js";
import {
  packetCond1,
  parseCond1Manifest,
  parseCond1Prepared,
  readApprovedArtifactJson,
} from "./packet.js";
import { prepareCond1 } from "./prepare.js";
import { COND1_RUNNER_VERSION, canonicalAnswerKeySha256, scoreCond1 } from "./score.js";
import type { Cond1HumanVerdict, Cond1SealedKey, FrozenCond1Identity } from "./types.js";

const COMMON = [
  "approval-manifest",
  "approval-sha256",
  "scratch-preparation-manifest",
  "scratch-preparation-sha256",
  "scratch-db",
  "approved-scratch-db-sha256",
  "repo-map",
  "repo-map-sha256",
  "scratch-state",
  "scratch-verification",
  "live-db",
] as const;

function fail(code: string): never {
  throw new Error(code);
}

function parseArgs(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || value.length === 0) {
      fail("cond1_cli_argument_invalid");
    }
    const key = flag.slice(2);
    if (!allowed.includes(key) || values.has(key)) fail("cond1_cli_argument_unknown_or_duplicate");
    values.set(key, value);
  }
  if (values.size !== allowed.length || allowed.some((key) => !values.has(key))) {
    fail("cond1_cli_argument_missing");
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  return values.get(key) ?? fail("cond1_cli_argument_missing");
}

function approved(values: Map<string, string>): ApprovedEvidenceInput {
  return {
    approvalManifestPath: required(values, "approval-manifest"),
    approvalManifestSha256: required(values, "approval-sha256"),
    preparationManifestPath: required(values, "scratch-preparation-manifest"),
    preparationManifestSha256: required(values, "scratch-preparation-sha256"),
    scratchDbPath: required(values, "scratch-db"),
    scratchDbSha256: required(values, "approved-scratch-db-sha256"),
    repoMapPath: required(values, "repo-map"),
    repoMapSha256: required(values, "repo-map-sha256"),
    scratchStatePath: required(values, "scratch-state"),
    scratchVerificationPath: required(values, "scratch-verification"),
    liveDbPath: required(values, "live-db"),
    repositoryRoot: process.cwd(),
  };
}

export function strictSealedKey(value: unknown): Cond1SealedKey {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("cond1_key_invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("|") !==
      ["answerCanonicalSha256", "answers", "campaignId", "randomizationSeed", "version"]
        .sort()
        .join("|") ||
    record.version !== "cond1-sealed-key-v1" ||
    typeof record.campaignId !== "string" ||
    !/^cond1-[0-9a-f]{32}$/u.test(record.campaignId) ||
    typeof record.randomizationSeed !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.randomizationSeed) ||
    typeof record.answerCanonicalSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.answerCanonicalSha256) ||
    !Array.isArray(record.answers)
  ) {
    fail("cond1_key_shape_invalid");
  }
  const aliases = new Set<string>();
  const sources = new Set<string>();
  for (const answer of record.answers) {
    if (answer === null || typeof answer !== "object" || Array.isArray(answer))
      fail("cond1_answer_invalid");
    if (
      Object.keys(answer as object)
        .sort()
        .join("|") !==
      [
        "findingAlias",
        "extractor",
        "extractorVersion",
        "sourceFindingId",
        "corpusPrKey",
        "evidenceSufficient",
        "projectionFailure",
      ]
        .sort()
        .join("|")
    ) {
      fail("cond1_answer_keys_invalid");
    }
    const row = answer as Record<string, unknown>;
    if (
      typeof row.findingAlias !== "string" ||
      !/^[0-9a-f]{32}$/u.test(row.findingAlias) ||
      !(row.extractor === "E1" || row.extractor === "E2" || row.extractor === "E3") ||
      row.extractorVersion !== EXTRACTOR_VERSIONS[row.extractor] ||
      typeof row.sourceFindingId !== "string" ||
      row.sourceFindingId.length === 0 ||
      typeof row.corpusPrKey !== "string" ||
      row.corpusPrKey.length === 0 ||
      typeof row.evidenceSufficient !== "boolean" ||
      !(row.projectionFailure === null || row.projectionFailure === "REDACTION_FAILED") ||
      row.evidenceSufficient === (row.projectionFailure !== null)
    ) {
      fail("cond1_answer_value_invalid");
    }
    const source = JSON.stringify([row.extractor, row.corpusPrKey, row.sourceFindingId]);
    if (aliases.has(row.findingAlias) || sources.has(source)) fail("cond1_answer_duplicate");
    aliases.add(row.findingAlias);
    sources.add(source);
  }
  return value as Cond1SealedKey;
}

export function strictVerdicts(value: unknown): Cond1HumanVerdict[] {
  if (!Array.isArray(value)) fail("cond1_verdicts_invalid");
  const aliases = new Set<string>();
  for (const verdict of value) {
    if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
      fail("cond1_verdict_invalid");
    }
    if (
      Object.keys(verdict as object)
        .sort()
        .join("|") !==
      ["findingAlias", "verdict", "adjudicatorAlias", "reasonCode"].sort().join("|")
    ) {
      fail("cond1_verdict_keys_invalid");
    }
    const row = verdict as Record<string, unknown>;
    if (
      typeof row.findingAlias !== "string" ||
      !/^[0-9a-f]{32}$/u.test(row.findingAlias) ||
      !(
        row.verdict === "TRUE_POSITIVE" ||
        row.verdict === "FALSE_POSITIVE" ||
        row.verdict === "UNCERTAIN"
      ) ||
      typeof row.adjudicatorAlias !== "string" ||
      row.adjudicatorAlias.length === 0 ||
      !(
        row.reasonCode === "EVIDENCE_SUPPORTS" ||
        row.reasonCode === "CONTEXT_NEGATES" ||
        row.reasonCode === "NOT_A_DEFERRAL" ||
        row.reasonCode === "NOT_AN_ADDED_MARKER" ||
        row.reasonCode === "WRONG_THREAD_STATE" ||
        row.reasonCode === "INSUFFICIENT_EVIDENCE"
      )
    ) {
      fail("cond1_verdict_value_invalid");
    }
    if (aliases.has(row.findingAlias)) fail("cond1_verdict_duplicate");
    aliases.add(row.findingAlias);
  }
  return value as Cond1HumanVerdict[];
}

export interface Cond1CliDependencies {
  github?: EvidenceGithubClient;
  tokenReader?: TokenReader;
  randomBytes?: (size: number) => Buffer;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runCond1Cli(
  argv: readonly string[],
  dependencies: Cond1CliDependencies = {},
): Promise<number> {
  const writeOut = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const writeErr = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const [command, ...rest] = argv;
    if (command === undefined) fail("cond1_cli_command_missing");
    if (command === "prepare") {
      const extra = [
        "manifest-out",
        "prepared-out",
        "extractor-commit",
        "findings-module-sha256",
        "as-of",
        "corpus",
      ] as const;
      const values = parseArgs(rest, [...COMMON, ...extra]);
      if (required(values, "corpus") !== "full-merged") fail("cond1_corpus_mode_invalid");
      const identity: FrozenCond1Identity = {
        sourceCommit: required(values, "extractor-commit"),
        runnerVersion: COND1_RUNNER_VERSION,
        findingsModuleSha256: required(values, "findings-module-sha256"),
        extractorVersions: EXTRACTOR_VERSIONS,
        packetVersion: "cond1-blinded-v1",
        scorerVersion: "cond1-precision-v1",
        asOf: required(values, "as-of"),
      };
      const github =
        dependencies.github ??
        new EvidenceGhCliClient(await readGithubToken(dependencies.tokenReader));
      const result = await prepareCond1({
        approvedInput: approved(values),
        github,
        identity,
        manifestOutPath: required(values, "manifest-out"),
        preparedOutPath: required(values, "prepared-out"),
      });
      writeOut(canonicalJson({ status: "PREPARED", ...result }));
      return 0;
    }
    if (command === "packet") {
      const extra = [
        "manifest",
        "manifest-sha256",
        "prepared",
        "prepared-sha256",
        "packet-out",
        "key-out",
      ] as const;
      const values = parseArgs(rest, [...COMMON, ...extra]);
      const loaded = await loadApprovedEvidenceInput(approved(values));
      const manifest = parseCond1Manifest(
        readApprovedArtifactJson(
          loaded,
          required(values, "manifest"),
          required(values, "manifest-sha256"),
        ),
      );
      const prepared = parseCond1Prepared(
        readApprovedArtifactJson(
          loaded,
          required(values, "prepared"),
          required(values, "prepared-sha256"),
        ),
      );
      const result = packetCond1({
        loaded,
        manifest,
        prepared,
        preparedFileSha256: required(values, "prepared-sha256"),
        packetOutPath: required(values, "packet-out"),
        keyOutPath: required(values, "key-out"),
        ...(dependencies.randomBytes === undefined
          ? {}
          : { randomBytes: dependencies.randomBytes }),
      });
      writeOut(canonicalJson({ status: "PACKET_CREATED", ...result }));
      return 0;
    }
    if (command === "score") {
      const extra = [
        "manifest",
        "manifest-sha256",
        "sealed-key",
        "sealed-key-sha256",
        "verdicts",
        "verdicts-sha256",
        "out",
      ] as const;
      const values = parseArgs(rest, [...COMMON, ...extra]);
      const loaded = await loadApprovedEvidenceInput(approved(values));
      const manifest = parseCond1Manifest(
        readApprovedArtifactJson(
          loaded,
          required(values, "manifest"),
          required(values, "manifest-sha256"),
        ),
      );
      const key = strictSealedKey(
        readApprovedArtifactJson(
          loaded,
          required(values, "sealed-key"),
          required(values, "sealed-key-sha256"),
        ),
      );
      const verdicts = strictVerdicts(
        readApprovedArtifactJson(
          loaded,
          required(values, "verdicts"),
          required(values, "verdicts-sha256"),
        ),
      );
      if (
        manifest.scratchDbSha256 !== loaded.scratchDbSha256 ||
        manifest.repoMapSha256 !== loaded.repoMapSha256 ||
        key.campaignId !== manifest.campaignId ||
        key.answerCanonicalSha256 !== manifest.answerCanonicalSha256 ||
        canonicalAnswerKeySha256(key.answers) !== manifest.answerCanonicalSha256
      ) {
        fail("cond1_key_manifest_mismatch");
      }
      const score = scoreCond1({
        manifest,
        corpusManifestFileSha256: required(values, "manifest-sha256"),
        answers: key.answers,
        verdicts,
      });
      const publication = publishApprovedOutput(
        loaded,
        required(values, "out"),
        `${canonicalJson(score)}\n`,
      );
      writeOut(
        canonicalJson({
          status: "SCORED",
          overallStatus: score.overallStatus,
          eligiblePrN: score.corpus.eligiblePrN,
          emittedFindingN: {
            E1: score.extractors.E1.emittedN,
            E2: score.extractors.E2.emittedN,
            E3: score.extractors.E3.emittedN,
          },
          scoreSha256: publication.sha256,
        }),
      );
      return 0;
    }
    fail("cond1_cli_command_invalid");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_failure";
    const failure =
      error instanceof EvidenceBoundaryError || /^[a-z0-9_]+$/u.test(message)
        ? message
        : "unexpected_failure";
    writeErr(canonicalJson({ status: "REFUSED", failure }));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  void runCond1Cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
