import * as fs from "node:fs";
import * as path from "node:path";
import {
  EXTRACTOR_VERSIONS,
  extractDeferralFindings,
  projectDiffMarkerCandidates,
  projectReviewThreadFindings,
} from "../../outcomes/finding-extractors.js";
import type {
  ApprovedEvidenceInput,
  LoadedApprovedEvidenceInput,
} from "../common/approved-input.js";
import { loadApprovedEvidenceInput, publishApprovedOutput } from "../common/approved-input.js";
import { EvidenceBoundaryError } from "../common/boundary.js";
import { canonicalJson, sha256Canonical } from "../common/canonical.js";
import { redactEvidenceExcerpt } from "../common/redaction.js";
import type { EvidenceGithubClient, EvidenceGithubPullRequest } from "../github/client.js";
import { COND1_RUNNER_VERSION, canonicalAnswerKeySha256 } from "./score.js";
import type {
  Cond1CorpusManifest,
  Cond1PreparedArtifact,
  Cond1PreparedFinding,
  Cond1SealedAnswer,
  FrozenCond1Identity,
} from "./types.js";

export interface PrepareCond1Input {
  approvedInput: ApprovedEvidenceInput;
  github: EvidenceGithubClient;
  identity: FrozenCond1Identity;
  manifestOutPath: string;
  preparedOutPath: string;
  publishOutput?: typeof publishApprovedOutput;
}

export interface PrepareCond1Result {
  campaignId: string;
  eligiblePrN: number;
  emittedFindingN: { E1: number; E2: number; E3: number };
  preparedArtifactSha256: string;
  manifestSha256: string;
  answerCanonicalSha256: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateIdentity(identity: FrozenCond1Identity): void {
  const asOf = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/u.exec(identity.asOf);
  const asOfDate = asOf === null ? Number.NaN : Date.parse(`${asOf[1]}Z`);
  if (
    Object.keys(identity).sort().join("|") !==
      [
        "sourceCommit",
        "runnerVersion",
        "findingsModuleSha256",
        "extractorVersions",
        "packetVersion",
        "scorerVersion",
        "asOf",
      ]
        .sort()
        .join("|") ||
    Object.keys(identity.extractorVersions).sort().join("|") !== "E1|E2|E3" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.sourceCommit) ||
    identity.runnerVersion !== COND1_RUNNER_VERSION ||
    !/^[0-9a-f]{64}$/u.test(identity.findingsModuleSha256) ||
    identity.packetVersion !== "cond1-blinded-v1" ||
    identity.scorerVersion !== "cond1-precision-v1" ||
    identity.extractorVersions.E1 !== EXTRACTOR_VERSIONS.E1 ||
    identity.extractorVersions.E2 !== EXTRACTOR_VERSIONS.E2 ||
    identity.extractorVersions.E3 !== EXTRACTOR_VERSIONS.E3 ||
    !Number.isFinite(asOfDate) ||
    new Date(asOfDate).toISOString().slice(0, 19) !== asOf?.[1]
  ) {
    fail("cond1_identity_invalid");
  }
}

function privatePrKey(pr: EvidenceGithubPullRequest): string {
  return `${pr.reportAlias}#${pr.number}`;
}

function utcKey(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (match?.[1] === undefined) return null;
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  ) {
    return null;
  }
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}

function normalizeInventory(
  inventory: readonly EvidenceGithubPullRequest[],
  repositoryAliases: ReadonlySet<string>,
  asOf: string,
): EvidenceGithubPullRequest[] {
  const asOfKey = utcKey(asOf) ?? fail("cond1_as_of_invalid");
  const seen = new Set<string>();
  const rows = inventory.map((row) => {
    const mergedAtKey = utcKey(row.mergedAt);
    if (
      !repositoryAliases.has(row.reportAlias) ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0 ||
      mergedAtKey === null ||
      mergedAtKey > asOfKey
    ) {
      fail("cond1_inventory_row_invalid");
    }
    const key = privatePrKey(row);
    if (seen.has(key)) fail("cond1_inventory_duplicate");
    seen.add(key);
    return { reportAlias: row.reportAlias, number: row.number, mergedAt: row.mergedAt };
  });
  return rows.sort(
    (left, right) =>
      binaryCompare(left.reportAlias, right.reportAlias) || left.number - right.number,
  );
}

interface RawCond1Pr {
  pr: EvidenceGithubPullRequest;
  threads?: readonly { id: string; isResolved: boolean }[];
  body?: string;
  diff?: string;
}

interface AcquiredCorpus {
  raw: RawCond1Pr[];
  readCompletion: Cond1CorpusManifest["readCompletion"];
  fullyReadPrN: number;
}

async function safeRead<T>(read: () => Promise<{ ok: boolean; data?: T }>): Promise<T | undefined> {
  try {
    const result = await read();
    return result.ok ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function acquireCorpus(
  github: EvidenceGithubClient,
  repositories: readonly { owner: string; repo: string; reportAlias: string }[],
  prs: readonly EvidenceGithubPullRequest[],
): Promise<AcquiredCorpus> {
  const byAlias = new Map(repositories.map((repo) => [repo.reportAlias, repo]));
  const raw: RawCond1Pr[] = [];
  const succeeded = { E1: 0, E2: 0, E3: 0 };
  let fullyReadPrN = 0;
  for (const pr of prs) {
    const repo = byAlias.get(pr.reportAlias);
    if (repo === undefined) fail("cond1_inventory_repository_unknown");
    const [threads, body, diff] = await Promise.all([
      safeRead(() => github.getReviewThreads(repo.owner, repo.repo, pr.number)),
      safeRead(() => github.getPRBody(repo.owner, repo.repo, pr.number)),
      safeRead(() => github.getPRDiff(repo.owner, repo.repo, pr.number)),
    ]);
    if (threads !== undefined) succeeded.E1++;
    if (body !== undefined) succeeded.E2++;
    if (diff !== undefined) succeeded.E3++;
    if (threads !== undefined && body !== undefined && diff !== undefined) fullyReadPrN++;
    raw.push({
      pr,
      ...(threads === undefined ? {} : { threads }),
      ...(body === undefined ? {} : { body: body ?? "" }),
      ...(diff === undefined ? {} : { diff }),
    });
  }
  const requiredN = prs.length;
  return {
    raw,
    readCompletion: {
      E1: { requiredN, succeededN: succeeded.E1, failedN: requiredN - succeeded.E1 },
      E2: { requiredN, succeededN: succeeded.E2, failedN: requiredN - succeeded.E2 },
      E3: { requiredN, succeededN: succeeded.E3, failedN: requiredN - succeeded.E3 },
    },
    fullyReadPrN,
  };
}

function extractCorpus(raw: readonly RawCond1Pr[]): Cond1PreparedFinding[] {
  const findings: Cond1PreparedFinding[] = [];
  for (const { pr, threads, body, diff } of raw) {
    const corpusPrKey = privatePrKey(pr);
    for (const projected of projectReviewThreadFindings(corpusPrKey, threads ?? [])) {
      findings.push({
        extractor: "E1",
        extractorVersion: EXTRACTOR_VERSIONS.E1,
        sourceFindingId: projected.sourceFindingId,
        corpusPrKey,
        repoAlias: pr.reportAlias,
        evidenceKind: "REVIEW_THREAD_STATE",
        evidence: projected.evidence,
        evidenceSufficient: true,
        projectionFailure: null,
      });
    }
    for (const projected of extractDeferralFindings(body ?? "", corpusPrKey)) {
      const excerpt = redactEvidenceExcerpt(projected.evidenceText);
      findings.push({
        extractor: "E2",
        extractorVersion: EXTRACTOR_VERSIONS.E2,
        sourceFindingId: projected.sourceFindingId,
        corpusPrKey,
        repoAlias: pr.reportAlias,
        evidenceKind: "DEFERRAL_LIST_ITEM",
        evidence: excerpt === null ? {} : { boundedExcerpt: excerpt },
        evidenceSufficient: excerpt !== null,
        projectionFailure: excerpt === null ? "REDACTION_FAILED" : null,
      });
    }
    for (const [index, projected] of projectDiffMarkerCandidates(diff ?? "").entries()) {
      const excerpt = redactEvidenceExcerpt(projected.evidenceText);
      findings.push({
        extractor: "E3",
        extractorVersion: EXTRACTOR_VERSIONS.E3,
        sourceFindingId: `e3:${corpusPrKey}:${index}`,
        corpusPrKey,
        repoAlias: pr.reportAlias,
        evidenceKind: "ADDED_DIFF_MARKER",
        evidence: {
          ...(excerpt === null ? {} : { boundedExcerpt: excerpt }),
          locationAlias: `loc-${sha256Canonical([projected.filePath, projected.lineNumber]).slice(0, 20)}`,
        },
        evidenceSufficient: excerpt !== null,
        projectionFailure: excerpt === null ? "REDACTION_FAILED" : null,
      });
    }
  }
  return findings.sort(
    (a, b) =>
      binaryCompare(a.extractor, b.extractor) ||
      binaryCompare(a.corpusPrKey, b.corpusPrKey) ||
      binaryCompare(a.sourceFindingId, b.sourceFindingId),
  );
}

function answerMaterial(findings: readonly Cond1PreparedFinding[]): Cond1SealedAnswer[] {
  return findings.map((finding) => ({
    findingAlias: "",
    extractor: finding.extractor,
    extractorVersion: finding.extractorVersion,
    sourceFindingId: finding.sourceFindingId,
    corpusPrKey: finding.corpusPrKey,
    evidenceSufficient: finding.evidenceSufficient,
    projectionFailure: finding.projectionFailure,
  }));
}

function preflightOutputs(
  loaded: Pick<LoadedApprovedEvidenceInput, "scratchStatePath">,
  outputs: readonly string[],
): void {
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

export async function prepareCond1(input: PrepareCond1Input): Promise<PrepareCond1Result> {
  validateIdentity(input.identity);
  if (!input.github.enabled) fail("cond1_github_disabled");
  const loaded = await loadApprovedEvidenceInput(input.approvedInput);
  preflightOutputs(loaded, [input.preparedOutPath, input.manifestOutPath]);
  const scratch = loaded.openVerifiedScratchDb();
  try {
    scratch.prepare("SELECT 1").get();
  } finally {
    scratch.close();
  }
  const repositories = loaded.repositories.map(({ owner, repo, reportAlias }) => ({
    owner,
    repo,
    reportAlias,
  }));
  const inventory = await input.github.listMergedPRs(repositories, input.identity.asOf);
  if (!inventory.ok) fail("cond1_inventory_failed");
  const orderedInventory = normalizeInventory(
    inventory.data,
    new Set(repositories.map(({ reportAlias }) => reportAlias)),
    input.identity.asOf,
  );

  // A second pure extraction pass detects nondeterministic projection before any artifact write.
  const acquired = await acquireCorpus(input.github, repositories, orderedInventory);
  const first = extractCorpus(acquired.raw);
  const second = extractCorpus(acquired.raw);
  if (sha256Canonical(first) !== sha256Canonical(second)) fail("cond1_extraction_nondeterministic");

  const answers = answerMaterial(first);
  const answerCanonicalSha256 = canonicalAnswerKeySha256(answers);
  const campaignId = `cond1-${sha256Canonical({
    identity: input.identity,
    scratchDbSha256: loaded.scratchDbSha256,
    repoMapSha256: loaded.repoMapSha256,
    inventory: orderedInventory,
  }).slice(0, 32)}`;
  const prepared: Cond1PreparedArtifact = {
    version: "cond1-prepared-v1",
    campaignId,
    identity: input.identity,
    scratchDbSha256: loaded.scratchDbSha256,
    repoMapSha256: loaded.repoMapSha256,
    eligiblePrN: orderedInventory.length,
    findings: first,
  };
  const publish = input.publishOutput ?? publishApprovedOutput;
  const preparedPublication = publish(
    loaded,
    input.preparedOutPath,
    `${canonicalJson(prepared)}\n`,
  );
  const counts = {
    E1: first.filter((finding) => finding.extractor === "E1").length,
    E2: first.filter((finding) => finding.extractor === "E2").length,
    E3: first.filter((finding) => finding.extractor === "E3").length,
  };
  const manifest: Cond1CorpusManifest = {
    version: "cond1-corpus-manifest-v1",
    campaignId,
    identity: input.identity,
    scratchDbSha256: loaded.scratchDbSha256,
    repoMapSha256: loaded.repoMapSha256,
    eligiblePrN: orderedInventory.length,
    readCompletion: acquired.readCompletion,
    corpusReadSummary: {
      fullyReadPrN: acquired.fullyReadPrN,
      failedPrN: orderedInventory.length - acquired.fullyReadPrN,
    },
    emittedFindingN: counts,
    preparedArtifactSha256: preparedPublication.sha256,
    answerCanonicalSha256,
  };
  let manifestPublication: ReturnType<typeof publishApprovedOutput>;
  try {
    manifestPublication = publish(loaded, input.manifestOutPath, `${canonicalJson(manifest)}\n`);
  } catch (error) {
    const code = error instanceof EvidenceBoundaryError ? error.code : "unexpected_failure";
    fail(`cond1_manifest_publication_failed_prepared_output_retained_${code}`);
  }
  return {
    campaignId,
    eligiblePrN: orderedInventory.length,
    emittedFindingN: counts,
    preparedArtifactSha256: preparedPublication.sha256,
    manifestSha256: manifestPublication.sha256,
    answerCanonicalSha256,
  };
}
