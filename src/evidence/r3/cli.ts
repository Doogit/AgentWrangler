import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TokenResult } from "../../outcomes/github/credential.js";
import { readGithubToken } from "../../outcomes/github/credential.js";
import type { ApprovedEvidenceInput } from "../common/approved-input.js";
import { canonicalJson, sha256Canonical } from "../common/canonical.js";
import { EvidenceGhCliClient } from "../github/gh-cli-client.js";
import { evaluateR3 } from "./evaluate.js";
import { packetR3 } from "./packet.js";
import { prepareR3 } from "./prepare.js";
import { scoreR3 } from "./score.js";

const BASE_FLAGS = [
  "--approval-manifest",
  "--approval-sha256",
  "--scratch-preparation-manifest",
  "--scratch-preparation-sha256",
  "--scratch-db",
  "--approved-scratch-db-sha256",
  "--repo-map",
  "--repo-map-sha256",
  "--scratch-state",
  "--scratch-verification",
  "--live-db",
  "--repository-root",
] as const;

export interface R3CliDependencies {
  token?: () => Promise<TokenResult>;
}

function refuse(code: string): never {
  throw new Error(code);
}

function parseValues(
  args: readonly string[],
  commandFlags: readonly string[],
): Map<string, string> {
  const allowed = new Set([...BASE_FLAGS, ...commandFlags]);
  const values = new Map<string, string>();
  if (args.length % 2 !== 0) refuse("r3_cli_missing_value");
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag)) refuse("r3_cli_unknown_argument");
    if (values.has(flag)) refuse("r3_cli_duplicate_argument");
    if (value === undefined || value.length === 0 || value.startsWith("--"))
      refuse("r3_cli_missing_value");
    values.set(flag, value);
  }
  for (const flag of allowed) if (!values.has(flag)) refuse("r3_cli_missing_required_argument");
  return values;
}

function get(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) refuse("r3_cli_missing_required_argument");
  return value;
}

function integer(values: Map<string, string>, flag: string): number {
  const value = get(values, flag);
  if (!/^\d+$/u.test(value)) refuse("r3_cli_integer_invalid");
  return Number(value);
}

function approved(values: Map<string, string>): ApprovedEvidenceInput {
  return {
    approvalManifestPath: get(values, "--approval-manifest"),
    approvalManifestSha256: get(values, "--approval-sha256"),
    preparationManifestPath: get(values, "--scratch-preparation-manifest"),
    preparationManifestSha256: get(values, "--scratch-preparation-sha256"),
    scratchDbPath: get(values, "--scratch-db"),
    scratchDbSha256: get(values, "--approved-scratch-db-sha256"),
    repoMapPath: get(values, "--repo-map"),
    repoMapSha256: get(values, "--repo-map-sha256"),
    scratchStatePath: get(values, "--scratch-state"),
    scratchVerificationPath: get(values, "--scratch-verification"),
    liveDbPath: get(values, "--live-db"),
    repositoryRoot: get(values, "--repository-root"),
  };
}

function evaluation(values: Map<string, string>) {
  return {
    approvedInput: approved(values),
    sealedDbPath: get(values, "--sealed-scratch-db"),
    sealedDbSha256: get(values, "--sealed-scratch-db-sha256"),
    manifestPath: get(values, "--manifest"),
    manifestSha256: get(values, "--manifest-sha256"),
    privateCorpusPath: get(values, "--private-corpus"),
    privateCorpusSha256: get(values, "--private-corpus-sha256"),
  };
}

const EVALUATION_FLAGS = [
  "--sealed-scratch-db",
  "--sealed-scratch-db-sha256",
  "--manifest",
  "--manifest-sha256",
  "--private-corpus",
  "--private-corpus-sha256",
] as const;

export async function runR3Cli(
  args: readonly string[],
  dependencies: R3CliDependencies = {},
): Promise<unknown> {
  const [command, ...rest] = args;
  if (command === "prepare") {
    const values = parseValues(rest, [
      "--sealed-db-out",
      "--manifest-out",
      "--private-corpus-out",
      "--working-db",
      "--working-db-sha256",
      "--resume",
      "--evaluator-commit",
      "--evaluator-module-sha256",
      "--as-of",
      "--backfill-page-size",
      "--github-concurrency",
    ]);
    const envToken = process.env.GH_TOKEN;
    const token =
      envToken !== undefined && envToken.length > 0
        ? ({ ok: true, data: envToken } as const)
        : await (dependencies.token?.() ?? readGithubToken());
    const resumeValue = get(values, "--resume");
    if (resumeValue !== "true" && resumeValue !== "false") refuse("r3_cli_resume_invalid");
    const workingDigest = get(values, "--working-db-sha256");
    const manifest = await prepareR3(
      {
        approvedInput: approved(values),
        sealedDbOut: get(values, "--sealed-db-out"),
        manifestOut: get(values, "--manifest-out"),
        privateCorpusOut: get(values, "--private-corpus-out"),
        workingDbPath: get(values, "--working-db"),
        workingDbSha256: workingDigest === "NEW" ? null : workingDigest,
        resume: resumeValue === "true",
        evaluatorCommit: get(values, "--evaluator-commit"),
        evaluatorModuleSha256: get(values, "--evaluator-module-sha256"),
        asOf: get(values, "--as-of"),
        backfillPageSize: integer(values, "--backfill-page-size"),
        githubConcurrency: integer(values, "--github-concurrency"),
      },
      { github: new EvidenceGhCliClient(token) },
    );
    return {
      status: manifest.status,
      backfill: manifest.backfill,
      corpus: manifest.corpus,
      identity: manifest.identity,
      privacy: manifest.privacy,
    };
  }
  if (command === "evaluate") {
    const values = parseValues(rest, [...EVALUATION_FLAGS, "--out"]);
    return evaluateR3({ ...evaluation(values), out: get(values, "--out") });
  }
  if (command === "packet") {
    const values = parseValues(rest, [
      ...EVALUATION_FLAGS,
      "--aggregate",
      "--aggregate-sha256",
      "--packet-out",
      "--key-out",
    ]);
    const result = await packetR3({
      ...evaluation(values),
      aggregatePath: get(values, "--aggregate"),
      aggregateSha256: get(values, "--aggregate-sha256"),
      packetOut: get(values, "--packet-out"),
      keyOut: get(values, "--key-out"),
    });
    return {
      status: "PACKET_CREATED",
      campaignId: result.packet.campaignId,
      entryN: result.packet.entries.length,
      aggregateSha256: result.packet.aggregateSha256,
      packetCanonicalSha256: sha256Canonical(result.packet),
      keyCanonicalSha256: sha256Canonical(result.key),
      privacy: { rawRefN: 0, transcriptPathN: 0, tokenN: 0 },
    };
  }
  if (command === "score") {
    const values = parseValues(rest, [
      "--aggregate",
      "--aggregate-sha256",
      "--sealed-key",
      "--sealed-key-sha256",
      "--verdicts",
      "--verdicts-sha256",
      "--out",
    ]);
    return scoreR3({
      approvedInput: approved(values),
      aggregatePath: get(values, "--aggregate"),
      aggregateSha256: get(values, "--aggregate-sha256"),
      sealedKeyPath: get(values, "--sealed-key"),
      sealedKeySha256: get(values, "--sealed-key-sha256"),
      verdictsPath: get(values, "--verdicts"),
      verdictsSha256: get(values, "--verdicts-sha256"),
      out: get(values, "--out"),
    });
  }
  refuse("r3_cli_command_invalid");
}

async function main(): Promise<void> {
  try {
    const result = await runR3Cli(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "r3_unexpected_failure";
    const failure = /^[a-z0-9_]+$/u.test(message) ? message : "r3_unexpected_failure";
    process.stderr.write(`${canonicalJson({ status: "REFUSED", failure })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
)
  void main();
