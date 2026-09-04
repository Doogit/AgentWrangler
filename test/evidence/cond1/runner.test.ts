import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovedEvidenceInput } from "../../../src/evidence/common/approved-input.js";
import {
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../../../src/evidence/common/approved-input.js";
import { EvidenceBoundaryError, readFileIdentity } from "../../../src/evidence/common/boundary.js";
import { sha256Bytes, sha256File } from "../../../src/evidence/common/canonical.js";
import { runCond1Cli, strictSealedKey, strictVerdicts } from "../../../src/evidence/cond1/cli.js";
import {
  packetCond1,
  parseCond1Manifest,
  parseCond1Prepared,
  readApprovedArtifactJson,
} from "../../../src/evidence/cond1/packet.js";
import { prepareCond1 } from "../../../src/evidence/cond1/prepare.js";
import { canonicalSha256, scoreCond1 } from "../../../src/evidence/cond1/score.js";
import type { Cond1SealedKey } from "../../../src/evidence/cond1/types.js";
import {
  SCRATCH_APPROVAL_VERSION,
  SCRATCH_PREPARATION_VERSION,
} from "../../../src/evidence/create-scratch.js";
import type { EvidenceGithubClient } from "../../../src/evidence/github/client.js";
import { EXTRACTOR_VERSIONS } from "../../../src/outcomes/finding-extractors.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-cond1-runner-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture(verificationLeaf = "verify.sqlite"): Promise<ApprovedEvidenceInput> {
  const caseRoot = fs.mkdtempSync(path.join(root, "case-"));
  const repositoryRoot = path.join(caseRoot, "repo-root");
  const state = path.join(caseRoot, "approved", "state");
  const live = path.join(caseRoot, "live.sqlite");
  const scratchPath = path.join(caseRoot, "approved", "scratch.sqlite");
  const repoMapPath = path.join(state, "repo-map.json");
  const approvalPath = path.join(caseRoot, "approval.json");
  const preparationPath = path.join(state, "preparation-manifest.json");
  fs.mkdirSync(repositoryRoot);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(live, "not-opened-live", "utf8");
  const db = new Database(scratchPath);
  db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('ok')");
  db.close();
  const repositories = [
    { workspaceId: "workspace-a", owner: "owner-a", repo: "repo-a", reportAlias: "repo-001" },
  ];
  const repoMapBytes = `${JSON.stringify(repositories)}\n`;
  fs.writeFileSync(repoMapPath, repoMapBytes);
  const repoMapSha256 = sha256Bytes(repoMapBytes);
  const approvalBytes = JSON.stringify({
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: live,
    scratchDbPath: scratchPath,
    scratchStatePath: state,
    repositories,
    privateArtifactParentAcknowledged: true,
  });
  fs.writeFileSync(approvalPath, approvalBytes);
  const approvalSha = sha256Bytes(approvalBytes);
  const scratchSha = await sha256File(scratchPath);
  const preparationBytes = JSON.stringify({
    version: SCRATCH_PREPARATION_VERSION,
    createdAt: "2026-08-26T20:00:00.000Z",
    approval: {
      version: SCRATCH_APPROVAL_VERSION,
      sha256: approvalSha,
      privateArtifactParentAcknowledged: true,
    },
    source: {
      path: live,
      identity: readFileIdentity(live),
      access: "explicit-readonly-online-backup",
    },
    scratch: {
      path: scratchPath,
      identity: readFileIdentity(scratchPath),
      sha256: scratchSha,
      integrity: "ok",
      publication: "atomic-hard-link-no-replace",
    },
    state: {
      path: state,
      cleanup: "manual-only",
      privateArtifactBoundary:
        process.platform === "win32"
          ? "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED"
          : "POSIX_OWNER_ONLY_MODES_REQUESTED",
    },
    repositoryMap: { file: "repo-map.json", sha256: repoMapSha256, mappedWorkspaceN: 1 },
    backup: { totalPages: 1, remainingPages: 0 },
    prohibitedOperations: [
      "migrations",
      "github-reads",
      "transcript-reads",
      "reset-replay-vacuum-prune-delete",
    ],
  });
  fs.writeFileSync(preparationPath, preparationBytes);
  return {
    approvalManifestPath: approvalPath,
    approvalManifestSha256: approvalSha,
    preparationManifestPath: preparationPath,
    preparationManifestSha256: sha256Bytes(preparationBytes),
    scratchDbPath: scratchPath,
    scratchDbSha256: scratchSha,
    scratchVerificationPath: path.join(state, verificationLeaf),
    scratchStatePath: state,
    repoMapPath,
    repoMapSha256,
    liveDbPath: live,
    repositoryRoot,
  };
}

function fakeGithub(calls: string[]): EvidenceGithubClient {
  return {
    enabled: true,
    async getPRHeadKey() {
      throw new Error("not approved for COND-1");
    },
    async listMergedPRs() {
      calls.push("inventory");
      return {
        ok: true,
        data: [{ reportAlias: "repo-001", number: 7, mergedAt: "2026-08-01T00:00:00Z" }],
      };
    },
    async getReviewThreads() {
      calls.push("E1");
      return { ok: true, data: [{ id: "private-thread", isResolved: false }] };
    },
    async getPRBody() {
      calls.push("E2");
      return { ok: true, data: "## Deferred\n- TODO use token=ghp_abcdefghijklmnopqrstuvwxyz" };
    },
    async getPRDiff() {
      calls.push("E3");
      return { ok: true, data: "+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+// FIXME C:\\private\\secret" };
    },
  };
}

function rng(): (size: number) => Buffer {
  let counter = 1;
  return (size) => Buffer.alloc(size, counter++);
}

describe("COND-1 fixture-only runner", () => {
  it("prepares, randomizes, and scores without raw evidence in the aggregate", async () => {
    const calls: string[] = [];
    const approved = await fixture();
    const preparedOut = path.join(approved.scratchStatePath, "prepared.json");
    const manifestOut = path.join(approved.scratchStatePath, "manifest.json");
    const preparedResult = await prepareCond1({
      approvedInput: approved,
      github: fakeGithub(calls),
      identity: {
        sourceCommit: "a".repeat(40),
        runnerVersion: "cond1-runner-v1",
        findingsModuleSha256: "b".repeat(64),
        extractorVersions: EXTRACTOR_VERSIONS,
        packetVersion: "cond1-blinded-v1",
        scorerVersion: "cond1-precision-v1",
        asOf: "2026-08-26T00:00:00Z",
      },
      manifestOutPath: manifestOut,
      preparedOutPath: preparedOut,
    });
    expect(calls).toEqual(["inventory", "E1", "E2", "E3"]);
    expect(() => fs.writeFileSync(preparedOut, "replace", { flag: "wx" })).toThrow();

    const loaded = await loadApprovedEvidenceInput({
      ...approved,
      scratchVerificationPath: path.join(approved.scratchStatePath, "verify-packet.sqlite"),
    });
    const manifest = parseCond1Manifest(
      readApprovedArtifactJson(loaded, manifestOut, preparedResult.manifestSha256),
    );
    const prepared = parseCond1Prepared(
      readApprovedArtifactJson(loaded, preparedOut, preparedResult.preparedArtifactSha256),
    );
    const unsafePrepared = structuredClone(prepared);
    const unsafeFinding = unsafePrepared.findings.find(({ extractor }) => extractor === "E2");
    if (unsafeFinding === undefined) throw new Error("fixture missing E2");
    unsafeFinding.evidence = { boundedExcerpt: "token=ghp_abcdefghijklmnopqrstuvwxyz" };
    expect(() => parseCond1Prepared(unsafePrepared)).toThrow("cond1_excerpt_not_redacted");
    const duplicatePrepared = {
      ...structuredClone(prepared),
      findings: [...prepared.findings, prepared.findings[0] as (typeof prepared.findings)[number]],
    };
    expect(() => parseCond1Prepared(duplicatePrepared)).toThrow("cond1_prepared_source_duplicate");
    const malformedManifest = structuredClone(manifest) as unknown as Record<string, unknown>;
    (malformedManifest.emittedFindingN as Record<string, unknown>).E2 = "1";
    expect(() => parseCond1Manifest(malformedManifest)).toThrow(
      "cond1_manifest_emitted_count_invalid",
    );
    const malformedIdentity = structuredClone(manifest) as unknown as Record<string, unknown>;
    (malformedIdentity.identity as Record<string, unknown>).token = "ghp_not_allowed";
    expect(() => parseCond1Manifest(malformedIdentity)).toThrow(
      "cond1_manifest_identity_keys_invalid",
    );
    const malformedIntersection = structuredClone(manifest);
    malformedIntersection.readCompletion.E1 = { requiredN: 1, succeededN: 0, failedN: 1 };
    expect(() => parseCond1Manifest(malformedIntersection)).toThrow(
      "cond1_manifest_intersection_count_mismatch",
    );
    const mismatchedPrepared = structuredClone(prepared);
    mismatchedPrepared.identity.sourceCommit = "c".repeat(40);
    expect(() =>
      packetCond1({
        loaded,
        manifest,
        prepared: mismatchedPrepared,
        preparedFileSha256: preparedResult.preparedArtifactSha256,
        packetOutPath: path.join(approved.scratchStatePath, "mismatch-packet.json"),
        keyOutPath: path.join(approved.scratchStatePath, "mismatch-key.json"),
        randomBytes: rng(),
      }),
    ).toThrow("cond1_prepared_manifest_mismatch");
    const packet = packetCond1({
      loaded,
      manifest,
      prepared,
      preparedFileSha256: preparedResult.preparedArtifactSha256,
      packetOutPath: path.join(approved.scratchStatePath, "packet.json"),
      keyOutPath: path.join(approved.scratchStatePath, "key.json"),
      randomBytes: rng(),
    });
    const packetAgain = packetCond1({
      loaded,
      manifest,
      prepared,
      preparedFileSha256: preparedResult.preparedArtifactSha256,
      packetOutPath: path.join(approved.scratchStatePath, "packet-again.json"),
      keyOutPath: path.join(approved.scratchStatePath, "key-again.json"),
      randomBytes: (size) => Buffer.alloc(size, 200),
    });
    const key = JSON.parse(
      fs.readFileSync(path.join(approved.scratchStatePath, "key.json"), "utf8"),
    ) as Cond1SealedKey;
    expect(strictSealedKey(key)).toEqual(key);
    expect(() => strictSealedKey({ ...key, answers: [...key.answers, key.answers[0]] })).toThrow(
      "cond1_answer_duplicate",
    );
    expect(() =>
      strictVerdicts([
        {
          findingAlias: key.answers[0]?.findingAlias,
          verdict: "TRUE_POSITIVE",
          adjudicatorAlias: "reviewer",
          reasonCode: "EVIDENCE_SUPPORTS",
          extra: true,
        },
      ]),
    ).toThrow("cond1_verdict_keys_invalid");
    expect(packet.answerCanonicalSha256).toBe(preparedResult.answerCanonicalSha256);
    expect(packetAgain.answerCanonicalSha256).toBe(packet.answerCanonicalSha256);
    expect(packetAgain.packetSha256).not.toBe(packet.packetSha256);
    const preparedText = fs.readFileSync(preparedOut, "utf8");
    const packetText = fs.readFileSync(path.join(approved.scratchStatePath, "packet.json"), "utf8");
    expect(preparedText).not.toContain("ghp_");
    expect(preparedText).not.toContain("C:\\private");
    expect(packetText).not.toContain("private-thread");
    expect(packetText).not.toContain("repo-001#7");
    const score = scoreCond1({
      manifest,
      corpusManifestFileSha256: preparedResult.manifestSha256,
      answers: key.answers,
      verdicts: key.answers.map(({ findingAlias }) => ({
        findingAlias,
        verdict: "TRUE_POSITIVE",
        adjudicatorAlias: "one-adjudicator",
        reasonCode: "EVIDENCE_SUPPORTS",
      })),
    });
    expect(score.extractors.E1).toMatchObject({
      status: "DATA_INSUFFICIENT",
      limitation: "CURRENT_STATE_ONLY",
    });
    expect(key.answers.find(({ extractor }) => extractor === "E3")).toMatchObject({
      evidenceSufficient: false,
      projectionFailure: "REDACTION_FAILED",
    });
    expect(score.extractors.E3).toMatchObject({
      status: "DATA_INSUFFICIENT",
      limitation: "INCOMPLETE_ADJUDICATION",
    });
    expect(score.identity.corpusManifestSha256).toBe(preparedResult.manifestSha256);
    expect(score.identity.corpusManifestSha256).not.toBe(canonicalSha256(manifest));
    const serialized = JSON.stringify(score);
    for (const privateValue of ["private-thread", "FIXME", "ghp_", "src/a.ts", "repo-001#7"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("rejects extra JSON keys and records per-extractor read failures", async () => {
    const approved = await fixture();
    const loaded = await loadApprovedEvidenceInput(approved);
    const extra = path.join(approved.scratchStatePath, "extra.json");
    fs.writeFileSync(extra, JSON.stringify({ version: "cond1-corpus-manifest-v1", extra: true }));
    expect(() =>
      parseCond1Manifest(
        readApprovedArtifactJson(loaded, extra, sha256Bytes(fs.readFileSync(extra))),
      ),
    ).toThrow("cond1_manifest_keys_invalid");

    const failedApproved = await fixture("verify-failure.sqlite");
    const github = fakeGithub([]);
    github.getPRDiff = async () => ({ ok: false, reason: "EVIDENCE_GITHUB_COMMAND_FAILED" });
    const failedResult = await prepareCond1({
      approvedInput: failedApproved,
      github,
      identity: {
        sourceCommit: "a".repeat(40),
        runnerVersion: "cond1-runner-v1",
        findingsModuleSha256: "b".repeat(64),
        extractorVersions: EXTRACTOR_VERSIONS,
        packetVersion: "cond1-blinded-v1",
        scorerVersion: "cond1-precision-v1",
        asOf: "2026-08-26T00:00:00Z",
      },
      manifestOutPath: path.join(failedApproved.scratchStatePath, "failed-manifest.json"),
      preparedOutPath: path.join(failedApproved.scratchStatePath, "failed-prepared.json"),
    });
    const failedManifest = JSON.parse(
      fs.readFileSync(path.join(failedApproved.scratchStatePath, "failed-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(failedResult.emittedFindingN).toEqual({ E1: 1, E2: 1, E3: 0 });
    expect(failedManifest).toMatchObject({
      readCompletion: {
        E1: { requiredN: 1, succeededN: 1, failedN: 0 },
        E2: { requiredN: 1, succeededN: 1, failedN: 0 },
        E3: { requiredN: 1, succeededN: 0, failedN: 1 },
      },
      corpusReadSummary: { fullyReadPrN: 0, failedPrN: 1 },
    });
  });

  it("prints aggregate-only CLI output and requires every binding", async () => {
    const approved = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const args = [
      "prepare",
      "--approval-manifest",
      approved.approvalManifestPath,
      "--approval-sha256",
      approved.approvalManifestSha256,
      "--scratch-preparation-manifest",
      approved.preparationManifestPath,
      "--scratch-preparation-sha256",
      approved.preparationManifestSha256,
      "--scratch-db",
      approved.scratchDbPath,
      "--approved-scratch-db-sha256",
      approved.scratchDbSha256,
      "--repo-map",
      approved.repoMapPath,
      "--repo-map-sha256",
      approved.repoMapSha256,
      "--scratch-state",
      approved.scratchStatePath,
      "--scratch-verification",
      approved.scratchVerificationPath,
      "--live-db",
      approved.liveDbPath,
      "--manifest-out",
      path.join(approved.scratchStatePath, "cli-manifest.json"),
      "--prepared-out",
      path.join(approved.scratchStatePath, "cli-prepared.json"),
      "--extractor-commit",
      "a".repeat(40),
      "--findings-module-sha256",
      "b".repeat(64),
      "--as-of",
      "2026-08-26T00:00:00Z",
      "--corpus",
      "full-merged",
    ];
    expect(
      await runCond1Cli(args, {
        github: fakeGithub([]),
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      }),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      status: "PREPARED",
      eligiblePrN: 1,
      emittedFindingN: { E1: 1, E2: 1, E3: 1 },
    });
    for (const raw of ["private-thread", "owner-a", "repo-a", "FIXME", "ghp_"]) {
      expect(output[0]).not.toContain(raw);
    }

    const refused: string[] = [];
    expect(await runCond1Cli(args.slice(0, -2), { stderr: (line) => refused.push(line) })).toBe(1);
    expect(JSON.parse(refused[0] as string)).toEqual({
      failure: "cond1_cli_argument_missing",
      status: "REFUSED",
    });
  });

  it("preflights paired outputs and reports the exact retained first artifact on second failure", async () => {
    const approved = await fixture();
    const preparedOut = path.join(approved.scratchStatePath, "retained-prepared.json");
    const manifestOut = path.join(approved.scratchStatePath, "missing-manifest.json");
    let publishN = 0;
    await expect(
      prepareCond1({
        approvedInput: approved,
        github: fakeGithub([]),
        identity: {
          sourceCommit: "a".repeat(40),
          runnerVersion: "cond1-runner-v1",
          findingsModuleSha256: "b".repeat(64),
          extractorVersions: EXTRACTOR_VERSIONS,
          packetVersion: "cond1-blinded-v1",
          scorerVersion: "cond1-precision-v1",
          asOf: "2026-08-26T00:00:00Z",
        },
        manifestOutPath: manifestOut,
        preparedOutPath: preparedOut,
        publishOutput: (loaded, output, value, hooks) => {
          publishN++;
          if (publishN === 2) {
            throw new EvidenceBoundaryError("output_publish_failed_temporary_retained");
          }
          return publishApprovedOutput(loaded, output, value, hooks);
        },
      }),
    ).rejects.toThrow(
      "cond1_manifest_publication_failed_prepared_output_retained_output_publish_failed_temporary_retained",
    );
    expect(fs.existsSync(preparedOut)).toBe(true);
    expect(fs.existsSync(manifestOut)).toBe(false);

    const packetApproved = await fixture();
    const packetPreparedOut = path.join(packetApproved.scratchStatePath, "prepared.json");
    const packetManifestOut = path.join(packetApproved.scratchStatePath, "manifest.json");
    const result = await prepareCond1({
      approvedInput: packetApproved,
      github: fakeGithub([]),
      identity: {
        sourceCommit: "a".repeat(40),
        runnerVersion: "cond1-runner-v1",
        findingsModuleSha256: "b".repeat(64),
        extractorVersions: EXTRACTOR_VERSIONS,
        packetVersion: "cond1-blinded-v1",
        scorerVersion: "cond1-precision-v1",
        asOf: "2026-08-26T00:00:00Z",
      },
      manifestOutPath: packetManifestOut,
      preparedOutPath: packetPreparedOut,
    });
    const loaded = await loadApprovedEvidenceInput({
      ...packetApproved,
      scratchVerificationPath: path.join(packetApproved.scratchStatePath, "verify-packet.sqlite"),
    });
    const manifest = parseCond1Manifest(
      readApprovedArtifactJson(loaded, packetManifestOut, result.manifestSha256),
    );
    const prepared = parseCond1Prepared(
      readApprovedArtifactJson(loaded, packetPreparedOut, result.preparedArtifactSha256),
    );
    const packetOut = path.join(packetApproved.scratchStatePath, "retained-packet.json");
    const keyOut = path.join(packetApproved.scratchStatePath, "missing-key.json");
    publishN = 0;
    expect(() =>
      packetCond1({
        loaded,
        manifest,
        prepared,
        preparedFileSha256: result.preparedArtifactSha256,
        packetOutPath: packetOut,
        keyOutPath: keyOut,
        randomBytes: rng(),
        publishOutput: (approvedInput, output, value, hooks) => {
          publishN++;
          if (publishN === 2) {
            throw new EvidenceBoundaryError("output_publish_failed_temporary_and_output_retained");
          }
          return publishApprovedOutput(approvedInput, output, value, hooks);
        },
      }),
    ).toThrow(
      "cond1_key_publication_failed_packet_output_retained_output_publish_failed_temporary_and_output_retained",
    );
    expect(fs.existsSync(packetOut)).toBe(true);
    expect(fs.existsSync(keyOut)).toBe(false);
  });
});
