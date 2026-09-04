import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import type { ApprovedEvidenceInput } from "../../../src/evidence/common/approved-input.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Canonical,
  sha256File,
} from "../../../src/evidence/common/canonical.js";
import {
  SCRATCH_APPROVAL_VERSION,
  createApprovedScratchCopy,
} from "../../../src/evidence/create-scratch.js";
import type { EvidenceGithubClient } from "../../../src/evidence/github/client.js";
import { runR3Cli } from "../../../src/evidence/r3/cli.js";
import { evaluateR3 } from "../../../src/evidence/r3/evaluate.js";
import { packetR3 } from "../../../src/evidence/r3/packet.js";
import { prepareR3 } from "../../../src/evidence/r3/prepare.js";
import { scoreR3 } from "../../../src/evidence/r3/score.js";
import type { R3HumanVerdict } from "../../../src/evidence/r3/types.js";
import { fingerprintBranchRef } from "../../../src/outcomes/branch-key.js";

const roots: string[] = [];
const evaluatorModulePath = path.join(process.cwd(), "src", "outcomes", "linker.ts");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(
  schema: 5 | 6 | 7 = 7,
  withUnmappedSession = false,
  unmappedEvidenceBearing = true,
  withEvidenceFreeLinkedSession = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentwrangler-r3-"));
  roots.push(root);
  const liveDb = path.join(root, "live.sqlite");
  const scratchDb = path.join(root, "scratch.sqlite");
  const state = path.join(root, "state");
  const transcriptA = path.join(root, "a.jsonl");
  const transcriptB = path.join(root, "b.jsonl");
  fs.writeFileSync(transcriptA, `${JSON.stringify({ gitBranch: "feat/uplift" })}\n`);
  fs.writeFileSync(transcriptB, `${JSON.stringify({ gitBranch: "feat/backtest" })}\n`);
  const db = new Database(liveDb);
  runMigrations(db);
  // Keep this fixture's migration ledger at the historical R3 boundary. The
  // current schema is fully created above, but R3 intentionally tests only the
  // exact 5/6/7 migration ledgers.
  for (const version of [
    "008_thinking_tokens",
    "009_user_turn_count",
    "010_workspace_cwd",
    "011_reports",
    "012_reconcile_indexes",
    "013_friction_fields",
    "014_session_churn",
    "015_gap_aggregates",
  ]) {
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
  }
  if (schema < 7) {
    db.exec("DROP TABLE work_item_branch_keys");
    db.prepare("DELETE FROM schema_migrations WHERE version='007_work_item_branch_keys'").run();
  }
  if (schema < 6) {
    db.prepare("DELETE FROM schema_migrations WHERE version='006_d7_query_indexes'").run();
  }
  db.prepare(
    `INSERT INTO workspaces
       (workspace_id, project_slug, repo_path, repo_owner, repo_name, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("ws-1", "project", root, "owner", "repo", "2026-01-01T00:00:00.000Z");
  const insertSession = db.prepare(
    "INSERT INTO sessions (session_id,workspace_id,file_path,first_turn_at,last_turn_at,state) VALUES (?,?,?,?,?,'RECONCILED')",
  );
  insertSession.run(
    "session-a",
    "ws-1",
    transcriptA,
    "2026-01-02T00:00:00.000Z",
    "2026-01-02T01:00:00.000Z",
  );
  insertSession.run(
    "session-b",
    "ws-1",
    transcriptB,
    "2026-01-03T00:00:00.000Z",
    "2026-01-03T01:00:00.000Z",
  );
  const tool = db.prepare(
    "INSERT INTO tool_events (event_id,session_id,ts,tool_name,commit_sha) VALUES (?,?,?,?,?)",
  );
  tool.run("te-a", "session-a", "2026-01-02T00:30:00.000Z", "Bash", null);
  tool.run("te-b", "session-b", "2026-01-03T00:30:00.000Z", "Bash", "a".repeat(40));
  const work = db.prepare(
    "INSERT INTO work_items (work_item_id,workspace_id,number,state,opened_at,merged_at,synced_at) VALUES (?,?,?,'MERGED',?,?,?)",
  );
  work.run(
    "gh:owner/repo#1",
    "ws-1",
    1,
    "2026-01-01T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
  );
  work.run(
    "gh:owner/repo#2",
    "ws-1",
    2,
    "2026-01-01T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
  );
  db.prepare("INSERT INTO session_work_links VALUES (?,?,?,?)").run(
    "session-b",
    "gh:owner/repo#2",
    0.8,
    "SHA_OVERLAP",
  );
  if (withUnmappedSession) {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, repo_path, repo_owner, repo_name, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ws-unmapped", "unmapped-project", null, null, null, "2026-01-01T00:00:00.000Z");
    insertSession.run(
      "session-unmapped",
      "ws-unmapped",
      path.join(root, "must-not-be-read.jsonl"),
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T01:00:00.000Z",
    );
    tool.run("te-unmapped", "session-unmapped", "2026-01-02T00:30:00.000Z", "Bash", null);
    if (unmappedEvidenceBearing) {
      // Make ws-unmapped evidence-bearing (a work item) so it stays in the §5G corpus and
      // still trips the allowlist guard — the guard must reject an unmapped *eligible* workspace.
      work.run(
        "gh:unmapped/repo#1",
        "ws-unmapped",
        1,
        "2026-01-01T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
      );
    }
  }
  if (withEvidenceFreeLinkedSession) {
    db.prepare(
      `INSERT INTO workspaces
         (workspace_id, project_slug, repo_path, repo_owner, repo_name, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "ws-empty",
      "empty-project",
      root,
      "empty-owner",
      "empty-repo",
      "2026-01-01T00:00:00.000Z",
    );
    insertSession.run(
      "session-empty",
      "ws-empty",
      transcriptA,
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T01:00:00.000Z",
    );
    tool.run("te-empty", "session-empty", "2026-01-04T00:30:00.000Z", "Bash", null);
    db.prepare("INSERT INTO session_work_links VALUES (?,?,?,?)").run(
      "session-empty",
      "gh:owner/repo#1",
      1.0,
      "MANUAL",
    );
  }
  db.close();
  const approval = {
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: liveDb,
    scratchDbPath: scratchDb,
    scratchStatePath: state,
    repositories: [
      { workspaceId: "ws-1", owner: "owner", repo: "repo", reportAlias: "repo-a" },
      ...(withEvidenceFreeLinkedSession
        ? [
            {
              workspaceId: "ws-empty",
              owner: "empty-owner",
              repo: "empty-repo",
              reportAlias: "repo-empty",
            },
          ]
        : []),
    ],
    privateArtifactParentAcknowledged: true,
  };
  const approvalPath = path.join(root, "approval.json");
  const approvalText = canonicalJson(approval);
  fs.writeFileSync(approvalPath, approvalText);
  const created = await createApprovedScratchCopy(
    {
      sourceDbPath: liveDb,
      scratchDbPath: scratchDb,
      scratchStatePath: state,
      approvalManifestPath: approvalPath,
      approvalSha256: sha256Bytes(approvalText),
    },
    { repositoryRoot: process.cwd(), now: new Date("2026-01-05T00:00:00.000Z") },
  );
  const base = (verification: string): ApprovedEvidenceInput => ({
    approvalManifestPath: approvalPath,
    approvalManifestSha256: sha256Bytes(approvalText),
    preparationManifestPath: path.join(state, "preparation-manifest.json"),
    preparationManifestSha256: created.manifestSha256,
    scratchDbPath: scratchDb,
    scratchDbSha256: created.scratchDbSha256,
    scratchVerificationPath: path.join(state, verification),
    scratchStatePath: state,
    repoMapPath: path.join(state, "repo-map.json"),
    repoMapSha256: created.repoMapSha256,
    liveDbPath: liveDb,
    repositoryRoot: process.cwd(),
  });
  const client: EvidenceGithubClient = {
    enabled: true,
    getPRHeadKey: async (_owner, _repo, number) => ({
      ok: true,
      data: fingerprintBranchRef(number === 1 ? "feat/uplift" : "feat/backtest"),
    }),
    listMergedPRs: async () => ({ ok: true, data: [] }),
    getPRBody: async () => ({ ok: true, data: null }),
    getPRDiff: async () => ({ ok: true, data: "" }),
    getReviewThreads: async () => ({ ok: true, data: [] }),
  };
  return { root, state, transcriptA, transcriptB, base, client };
}

async function prepared(
  schema: 6 | 7 = 7,
  withEvidenceFreeLinkedSession = false,
  withUnmappedEvidenceFreeSession = false,
) {
  const fx = await fixture(
    schema,
    withUnmappedEvidenceFreeSession,
    false,
    withEvidenceFreeLinkedSession,
  );
  const paths = {
    sealed: path.join(fx.state, "sealed.sqlite"),
    manifest: path.join(fx.state, "r3-manifest.json"),
    corpus: path.join(fx.state, "corpus.json"),
    aggregate: path.join(fx.state, "aggregate.json"),
    working: path.join(fx.state, "working.sqlite"),
  };
  const manifest = await prepareR3(
    {
      approvedInput: fx.base("verify-prepare.sqlite"),
      sealedDbOut: paths.sealed,
      manifestOut: paths.manifest,
      privateCorpusOut: paths.corpus,
      workingDbPath: paths.working,
      workingDbSha256: null,
      resume: false,
      evaluatorCommit: "a".repeat(40),
      evaluatorModuleSha256: await sha256File(evaluatorModulePath),
      asOf: "2026-01-05T00:00:00.000Z",
      backfillPageSize: 1,
      githubConcurrency: 2,
    },
    { github: fx.client, now: () => new Date("2026-01-05T00:00:00.000Z") },
  );
  const request = {
    approvedInput: fx.base("verify-evaluate.sqlite"),
    sealedDbPath: paths.sealed,
    sealedDbSha256: manifest.identity.sealedHydratedDbSha256,
    manifestPath: paths.manifest,
    manifestSha256: await sha256File(paths.manifest),
    privateCorpusPath: paths.corpus,
    privateCorpusSha256: manifest.identity.privateCorpusSha256,
    out: paths.aggregate,
  };
  const aggregate = await evaluateR3(request);
  return { ...fx, paths, manifest, request, aggregate };
}

describe("R3 fixture-only runner", () => {
  it("rejects incomplete, unknown, and duplicate CLI arguments before any evidence read", async () => {
    await expect(runR3Cli([])).rejects.toThrow("r3_cli_command_invalid");
    await expect(runR3Cli(["evaluate", "--unknown", "value"])).rejects.toThrow(
      "r3_cli_unknown_argument",
    );
    await expect(
      runR3Cli(["score", "--approval-manifest", "a", "--approval-manifest", "b"]),
    ).rejects.toThrow("r3_cli_duplicate_argument");
  });

  it.each([6, 7] as const)("prepares schema %i without mutating Stage-0", async (schema) => {
    const fx = await prepared(schema);
    expect(fx.manifest.status).toBe("PREPARED");
    expect(fx.manifest.backfill).toMatchObject({
      completed: true,
      selectedN: 2,
      keyedN: 2,
      failedN: 0,
    });
    const stage0 = new Database(path.join(fx.root, "scratch.sqlite"), { readonly: true });
    try {
      const table = stage0
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_item_branch_keys'")
        .get();
      if (schema === 6) expect(table).toBeUndefined();
      else
        expect(
          (stage0.prepare("SELECT COUNT(*) n FROM work_item_branch_keys").get() as { n: number }).n,
        ).toBe(0);
    } finally {
      stage0.close();
    }
  });

  it("evaluates twice deterministically and preserves accepted links", async () => {
    const fx = await prepared();
    expect(fx.aggregate.deterministicRerun.equal).toBe(true);
    expect(fx.aggregate.privacy.linkTableUnchanged).toBe(true);
    expect(fx.aggregate.shadow).toMatchObject({ uniqueUpliftCandidatesN: 1, backtestEligibleN: 1 });
  });

  it("evaluation scope excludes evidence-free unmapped workspaces instead of refusing", async () => {
    // ws-unmapped is RECONCILED+Bash but has zero work_items and is NOT allowlisted. Under §5G the
    // evaluation workspace-scope check (the 6th corpus site) must mirror the corpus predicate and
    // exclude it — not refuse r3_evaluation_workspace_not_allowlisted.
    const fx = await prepared(7, false, true);
    expect(fx.aggregate.deterministicRerun.equal).toBe(true);
    expect(fx.aggregate.denominator.excludedNoWorkItemsN).toBeGreaterThanOrEqual(1);
  });

  it("keeps the baseline-linked numerator within the evidence-bearing corpus", async () => {
    const fx = await prepared(7, true);
    const cohortBaselineLinkedN = fx.aggregate.byRepoAlias.reduce(
      (sum, cohort) => sum + cohort.baselineLinkedOutcomeBearingN,
      0,
    );
    expect(fx.aggregate.denominator.baselineLinkedOutcomeBearingN).toBeLessThanOrEqual(
      fx.aggregate.denominator.outcomeBearingSessionsN,
    );
    expect(fx.aggregate.denominator.baselineLinkedOutcomeBearingN).toBe(cohortBaselineLinkedN);
  });

  it("refuses schemas outside the exact 6-to-7 or already-7 transition", async () => {
    const fx = await fixture(5);
    await expect(
      prepareR3(
        {
          approvedInput: fx.base("verify-schema-refusal.sqlite"),
          sealedDbOut: path.join(fx.state, "sealed.sqlite"),
          manifestOut: path.join(fx.state, "manifest.json"),
          privateCorpusOut: path.join(fx.state, "corpus.json"),
          workingDbPath: path.join(fx.state, "schema-working.sqlite"),
          workingDbSha256: null,
          resume: false,
          evaluatorCommit: "a".repeat(40),
          evaluatorModuleSha256: await sha256File(evaluatorModulePath),
          asOf: "2026-01-05T00:00:00.000Z",
          backfillPageSize: 10,
          githubConcurrency: 1,
        },
        { github: fx.client },
      ),
    ).rejects.toThrow("r3_schema_version_refused");
    expect(fs.existsSync(path.join(fx.state, "sealed.sqlite"))).toBe(false);
  });

  it("verifies the actual evaluator module before creating a verification artifact", async () => {
    const fx = await fixture();
    const verification = path.join(fx.state, "verify-bad-evaluator.sqlite");
    await expect(
      prepareR3(
        {
          approvedInput: fx.base(path.basename(verification)),
          sealedDbOut: path.join(fx.state, "bad-evaluator-sealed.sqlite"),
          manifestOut: path.join(fx.state, "bad-evaluator-manifest.json"),
          privateCorpusOut: path.join(fx.state, "bad-evaluator-corpus.json"),
          workingDbPath: path.join(fx.state, "bad-evaluator-working.sqlite"),
          workingDbSha256: null,
          resume: false,
          evaluatorCommit: "a".repeat(40),
          evaluatorModuleSha256: "b".repeat(64),
          asOf: "2026-01-05T00:00:00.000Z",
          backfillPageSize: 1,
          githubConcurrency: 1,
        },
        { github: fx.client },
      ),
    ).rejects.toThrow("r3_evaluator_module_digest_mismatch");
    expect(fs.existsSync(verification)).toBe(false);
  });

  it("retains exact GitHub read failures and marks preparation data-insufficient", async () => {
    const fx = await fixture();
    const failingClient: EvidenceGithubClient = {
      ...fx.client,
      getPRHeadKey: async () => ({ ok: false, reason: "EVIDENCE_GITHUB_COMMAND_FAILED" }),
    };
    const manifest = await prepareR3(
      {
        approvedInput: fx.base("verify-read-failure.sqlite"),
        sealedDbOut: path.join(fx.state, "failed-sealed.sqlite"),
        manifestOut: path.join(fx.state, "failed-manifest.json"),
        privateCorpusOut: path.join(fx.state, "failed-corpus.json"),
        workingDbPath: path.join(fx.state, "failed-working.sqlite"),
        workingDbSha256: null,
        resume: false,
        evaluatorCommit: "a".repeat(40),
        evaluatorModuleSha256: await sha256File(evaluatorModulePath),
        asOf: "2026-01-05T00:00:00.000Z",
        backfillPageSize: 1,
        githubConcurrency: 1,
      },
      { github: failingClient },
    );
    expect(manifest.status).toBe("DATA_INSUFFICIENT");
    expect(manifest.backfill).toMatchObject({
      completed: true,
      selectedN: 2,
      failedN: 2,
      missingN: 2,
      failureReasonN: { GITHUB_READ_FAILED: 2, GITHUB_READ_THREW: 0 },
    });
  });

  it("resumes the explicit working DB without re-fetching a successfully keyed PR", async () => {
    const fx = await fixture();
    const workingDbPath = path.join(fx.state, "resume-working.sqlite");
    const baseRequest = {
      sealedDbOut: path.join(fx.state, "resume-sealed.sqlite"),
      manifestOut: path.join(fx.state, "resume-manifest.json"),
      privateCorpusOut: path.join(fx.state, "resume-corpus.json"),
      workingDbPath,
      evaluatorCommit: "a".repeat(40),
      evaluatorModuleSha256: await sha256File(evaluatorModulePath),
      asOf: "2026-01-05T00:00:00.000Z",
      backfillPageSize: 1,
      githubConcurrency: 1,
    };
    await expect(
      prepareR3(
        {
          ...baseRequest,
          approvedInput: fx.base("verify-interrupted.sqlite"),
          workingDbSha256: null,
          resume: false,
        },
        {
          github: fx.client,
          onBackfillCheckpoint: () => {
            throw new Error("simulated_interrupt");
          },
        },
      ),
    ).rejects.toThrow("simulated_interrupt_scratch_verification_and_working_db_retained");
    const originalWorkingBytes = fs.readFileSync(workingDbPath);
    const mutated = new Database(workingDbPath);
    mutated
      .prepare(
        "UPDATE session_work_links SET confidence=0.7 WHERE session_id='session-b' AND work_item_id='gh:owner/repo#2'",
      )
      .run();
    mutated.close();
    let refusedReadN = 0;
    const noReadClient: EvidenceGithubClient = {
      ...fx.client,
      getPRHeadKey: async (...args) => {
        refusedReadN += 1;
        return fx.client.getPRHeadKey(...args);
      },
    };
    await expect(
      prepareR3(
        {
          ...baseRequest,
          approvedInput: fx.base("verify-mutated-resume.sqlite"),
          workingDbSha256: await sha256File(workingDbPath),
          resume: true,
        },
        { github: noReadClient },
      ),
    ).rejects.toThrow("r3_working_db_checkpoint_binding_mismatch");
    expect(refusedReadN).toBe(0);
    fs.writeFileSync(workingDbPath, originalWorkingBytes);
    let resumedReadN = 0;
    const resumedClient: EvidenceGithubClient = {
      ...fx.client,
      getPRHeadKey: async (...args) => {
        resumedReadN += 1;
        return fx.client.getPRHeadKey(...args);
      },
    };
    const manifest = await prepareR3(
      {
        ...baseRequest,
        approvedInput: fx.base("verify-resumed.sqlite"),
        workingDbSha256: await sha256File(workingDbPath),
        resume: true,
      },
      { github: resumedClient },
    );
    expect(resumedReadN).toBe(1);
    expect(manifest.backfill).toMatchObject({ selectedN: 2, keyedN: 2, failedN: 0 });
    expect(manifest.status).toBe("PREPARED");
  });

  it("resumes after publication fails following a completed backfill", async () => {
    const fx = await fixture();
    const workingDbPath = path.join(fx.state, "publication-working.sqlite");
    const blockedManifestPath = path.join(fx.state, "publication-blocked-manifest.json");
    fs.writeFileSync(blockedManifestPath, "reserved");
    const baseRequest = {
      approvedInput: fx.base("verify-publication-interrupted.sqlite"),
      sealedDbOut: path.join(fx.state, "publication-first-sealed.sqlite"),
      manifestOut: blockedManifestPath,
      privateCorpusOut: path.join(fx.state, "publication-first-corpus.json"),
      workingDbPath,
      evaluatorCommit: "a".repeat(40),
      evaluatorModuleSha256: await sha256File(evaluatorModulePath),
      asOf: "2026-01-05T00:00:00.000Z",
      backfillPageSize: 1,
      githubConcurrency: 1,
    };
    await expect(
      prepareR3({ ...baseRequest, workingDbSha256: null, resume: false }, { github: fx.client }),
    ).rejects.toThrow(
      "output_already_exists_scratch_verification_and_working_db_and_sealed_db_and_private_corpus_retained",
    );
    let resumedReadN = 0;
    const resumedClient: EvidenceGithubClient = {
      ...fx.client,
      getPRHeadKey: async (...args) => {
        resumedReadN += 1;
        return fx.client.getPRHeadKey(...args);
      },
    };
    const manifest = await prepareR3(
      {
        ...baseRequest,
        approvedInput: fx.base("verify-publication-resumed.sqlite"),
        sealedDbOut: path.join(fx.state, "publication-resumed-sealed.sqlite"),
        manifestOut: path.join(fx.state, "publication-resumed-manifest.json"),
        privateCorpusOut: path.join(fx.state, "publication-resumed-corpus.json"),
        workingDbSha256: await sha256File(workingDbPath),
        resume: true,
      },
      { github: resumedClient },
    );
    expect(resumedReadN).toBe(0);
    expect(manifest.status).toBe("PREPARED");
  });

  it("refuses an unmapped eligible workspace before opening its transcript", async () => {
    const fx = await fixture(7, true);
    await expect(
      prepareR3(
        {
          approvedInput: fx.base("verify-unmapped.sqlite"),
          sealedDbOut: path.join(fx.state, "unmapped-sealed.sqlite"),
          manifestOut: path.join(fx.state, "unmapped-manifest.json"),
          privateCorpusOut: path.join(fx.state, "unmapped-corpus.json"),
          workingDbPath: path.join(fx.state, "unmapped-working.sqlite"),
          workingDbSha256: null,
          resume: false,
          evaluatorCommit: "a".repeat(40),
          evaluatorModuleSha256: await sha256File(evaluatorModulePath),
          asOf: "2026-01-05T00:00:00.000Z",
          backfillPageSize: 2,
          githubConcurrency: 1,
        },
        { github: fx.client },
      ),
    ).rejects.toThrow("r3_corpus_workspace_not_allowlisted");
    expect(fs.existsSync(path.join(fx.root, "must-not-be-read.jsonl"))).toBe(false);
  });

  it("passes the corpus guard when an unmapped workspace is evidence-free", async () => {
    // ws-unmapped is RECONCILED + Bash but has zero work_items, so under the §5G
    // corpus narrowing it is not eligible and must not trip the allowlist guard.
    const fx = await fixture(7, true, false);
    const manifest = await prepareR3(
      {
        approvedInput: fx.base("verify-evidence-free.sqlite"),
        sealedDbOut: path.join(fx.state, "evidence-free-sealed.sqlite"),
        manifestOut: path.join(fx.state, "evidence-free-manifest.json"),
        privateCorpusOut: path.join(fx.state, "evidence-free-corpus.json"),
        workingDbPath: path.join(fx.state, "evidence-free-working.sqlite"),
        workingDbSha256: null,
        resume: false,
        evaluatorCommit: "a".repeat(40),
        evaluatorModuleSha256: await sha256File(evaluatorModulePath),
        asOf: "2026-01-05T00:00:00.000Z",
        backfillPageSize: 2,
        githubConcurrency: 1,
      },
      { github: fx.client },
    );
    expect(manifest.campaign).toBe("R3_U4_BRANCH_LINKAGE");
    // The evidence-free workspace is excluded, so its transcript is never opened.
    expect(fs.existsSync(path.join(fx.root, "must-not-be-read.jsonl"))).toBe(false);
  });

  it("counts changed frozen transcripts and makes the rerun data-insufficient", async () => {
    const fx = await prepared();
    fs.appendFileSync(fx.transcriptA, `${JSON.stringify({ gitBranch: "feat/changed" })}\n`);
    const report = await evaluateR3({
      ...fx.request,
      approvedInput: fx.base("verify-changed.sqlite"),
      out: path.join(fx.state, "changed-aggregate.json"),
    });
    expect(report.status).toBe("DATA_INSUFFICIENT");
    expect(report.shadow.transcriptFailureReasonN.CHANGED).toBe(1);
  });

  it("blinds and mixes all uplift with bounded backtest, then scores inclusive thresholds", async () => {
    const fx = await prepared();
    const packetPath = path.join(fx.state, "packet.json");
    const keyPath = path.join(fx.state, "key.json");
    const packet = await packetR3(
      {
        ...fx.request,
        approvedInput: fx.base("verify-packet.sqlite"),
        aggregatePath: fx.paths.aggregate,
        aggregateSha256: await sha256File(fx.paths.aggregate),
        packetOut: packetPath,
        keyOut: keyPath,
      },
      { randomSeed: () => Buffer.alloc(32, 7) },
    );
    expect(packet.packet.entries).toHaveLength(2);
    const serialized = canonicalJson(packet.packet);
    expect(serialized).not.toContain("session-a");
    expect(serialized).not.toContain("gh:owner/repo");
    const verdicts: R3HumanVerdict[] = packet.packet.entries.map((entry) => ({
      candidateId: entry.candidateId,
      verdict: "CORRECT",
      adjudicatorAlias: "judge-a",
      reasonCode: "TIMELINE",
    }));
    const verdictPath = path.join(fx.state, "verdicts.json");
    fs.writeFileSync(verdictPath, canonicalJson(verdicts));
    const score = await scoreR3({
      approvedInput: fx.base("verify-score.sqlite"),
      aggregatePath: fx.paths.aggregate,
      aggregateSha256: await sha256File(fx.paths.aggregate),
      sealedKeyPath: keyPath,
      sealedKeySha256: await sha256File(keyPath),
      verdictsPath: verdictPath,
      verdictsSha256: await sha256File(verdictPath),
      out: path.join(fx.state, "score.json"),
    });
    expect(score.projected.precision).toBe(1);
    expect(score.projected.coverage).toBe(1);
    expect(score.status).toBe("PASS");
  });

  it("passes the inclusive 0.80 coverage and 0.95 precision edges", async () => {
    const fx = await prepared();
    const aggregate = {
      ...fx.aggregate,
      status: "PREPARED" as const,
      denominator: {
        ...fx.aggregate.denominator,
        outcomeBearingSessionsN: 100,
        baselineLinkedOutcomeBearingN: 79,
      },
      shadow: {
        ...fx.aggregate.shadow,
        uniqueUpliftCandidatesN: 1,
        higherPrecedenceCandidatesN: 19,
        backtestEligibleN: 19,
      },
    };
    const aggregatePath = path.join(fx.state, "edge-aggregate.json");
    fs.writeFileSync(aggregatePath, canonicalJson(aggregate));
    const seed = Buffer.alloc(32, 9);
    const entries = Array.from({ length: 20 }, (_, index) => ({
      candidateId: `candidate-${index}`,
      sessionId: `private-session-${index}`,
      candidateWorkItemId: `private-work-item-${index}`,
      repoAlias: "repo-a",
      cohort: index === 0 ? ("UPLIFT" as const) : ("BACKTEST" as const),
      backtestCorrect: index === 0 ? null : true,
      redactionFailed: false,
    }));
    const aggregateSha256 = await sha256File(aggregatePath);
    const key = {
      campaignId: sha256Canonical({
        identity: aggregate.identity,
        aggregate: aggregateSha256,
      }).slice(0, 32),
      packetVersion: "r3-u4-blinded-v1" as const,
      scorerVersion: "r3-u4-score-v1" as const,
      randomizationSeed: seed.toString("hex"),
      randomizationSeedCommitment: sha256Bytes(seed),
      aggregateSha256,
      entries,
    };
    const keyPath = path.join(fx.state, "edge-key.json");
    fs.writeFileSync(keyPath, canonicalJson(key));
    const verdicts: R3HumanVerdict[] = entries.map((entry, index) => ({
      candidateId: entry.candidateId,
      verdict: index === 19 ? "INCORRECT" : "CORRECT",
      adjudicatorAlias: "judge-edge",
      reasonCode: "TIMELINE",
    }));
    const verdictPath = path.join(fx.state, "edge-verdicts.json");
    fs.writeFileSync(verdictPath, canonicalJson(verdicts));
    const score = await scoreR3({
      approvedInput: fx.base("verify-edge-score.sqlite"),
      aggregatePath,
      aggregateSha256,
      sealedKeyPath: keyPath,
      sealedKeySha256: await sha256File(keyPath),
      verdictsPath: verdictPath,
      verdictsSha256: await sha256File(verdictPath),
      out: path.join(fx.state, "edge-score.json"),
    });
    expect(score.projected.coverage).toBe(0.8);
    expect(score.projected.precision).toBe(0.95);
    expect(score.status).toBe("PASS");
  });
});
