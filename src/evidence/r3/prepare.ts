import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../../db/migrate.js";
import { snapshotSessionWorkLinks } from "../../outcomes/linker.js";
import { backfillMissingWorkItemBranchKeys } from "../../outcomes/sync.js";
import {
  type ApprovedEvidenceInput,
  type LoadedApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../common/approved-input.js";
import type { FileIdentity } from "../common/boundary.js";
import { canonicalJson, sha256Canonical, sha256File } from "../common/canonical.js";
import { assertDatabaseIntegrity } from "../common/sqlite.js";
import type { EvidenceGithubClient } from "../github/client.js";
import {
  type FrozenR3Identity,
  type R3PrepareManifest,
  type R3PrivateCorpus,
  R3_REASON_VOCABULARY_VERSION,
  R3_RUNNER_VERSION,
} from "./types.js";

const REQUIRED_SCHEMA_6 = [
  "001_observe",
  "002_indexes",
  "003_context_inventory_history",
  "004_apply_jobs",
  "005_tool_event_metadata",
  "006_d7_query_indexes",
] as const;
const REQUIRED_SCHEMA_7 = [...REQUIRED_SCHEMA_6, "007_work_item_branch_keys"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const EVALUATOR_MODULE_PATH = fileURLToPath(new URL("../../outcomes/linker.ts", import.meta.url));

export interface R3PrepareRequest {
  approvedInput: ApprovedEvidenceInput;
  sealedDbOut: string;
  manifestOut: string;
  privateCorpusOut: string;
  workingDbPath: string;
  workingDbSha256: string | null;
  resume: boolean;
  evaluatorCommit: string;
  evaluatorModuleSha256: string;
  asOf: string;
  backfillPageSize: number;
  githubConcurrency: number;
}

export interface R3PrepareDependencies {
  github: EvidenceGithubClient;
  loadApproved?: typeof loadApprovedEvidenceInput;
  now?: () => Date;
  onBackfillCheckpoint?: (checkpoint: {
    afterWorkItemId: string | null;
    selected: number;
    keyed: number;
    ineligible: number;
    failed: number;
  }) => void | Promise<void>;
}

function refuse(code: string): never {
  throw new Error(code);
}

function retainedFailure(error: unknown, artifacts: readonly string[]): Error {
  const message =
    error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "r3_prepare_failure";
  return new Error(`${message}_${artifacts.join("_and_")}_retained`);
}

function validateRequest(request: R3PrepareRequest): void {
  if (!COMMIT_RE.test(request.evaluatorCommit)) refuse("r3_evaluator_commit_invalid");
  if (!SHA256_RE.test(request.evaluatorModuleSha256)) refuse("r3_evaluator_digest_invalid");
  if (!STRICT_UTC.test(request.asOf) || !Number.isFinite(Date.parse(request.asOf))) {
    refuse("r3_as_of_invalid");
  }
  if (
    !Number.isSafeInteger(request.backfillPageSize) ||
    request.backfillPageSize < 1 ||
    request.backfillPageSize > 1_000
  ) {
    refuse("r3_backfill_page_size_invalid");
  }
  if (
    !Number.isSafeInteger(request.githubConcurrency) ||
    request.githubConcurrency < 1 ||
    request.githubConcurrency > 32
  ) {
    refuse("r3_github_concurrency_invalid");
  }
  if (request.resume !== (request.workingDbSha256 !== null)) {
    refuse("r3_working_db_resume_binding_invalid");
  }
  if (request.workingDbSha256 !== null && !SHA256_RE.test(request.workingDbSha256)) {
    refuse("r3_working_db_digest_invalid");
  }
}

function directWorkingPath(approved: LoadedApprovedEvidenceInput, candidate: string): string {
  const parent = fs.realpathSync.native(path.dirname(path.resolve(candidate)));
  if (parent !== approved.scratchStatePath) refuse("r3_working_db_not_direct_state_child");
  return path.join(parent, path.basename(candidate));
}

function initializeCheckpoint(
  db: Database.Database,
  request: R3PrepareRequest,
  approved: LoadedApprovedEvidenceInput,
): void {
  db.exec(`
    CREATE TABLE r3_prepare_checkpoint (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      approved_input_db_sha256 TEXT NOT NULL,
      evaluator_commit TEXT NOT NULL,
      evaluator_module_sha256 TEXT NOT NULL,
      repo_map_sha256 TEXT NOT NULL,
      as_of TEXT NOT NULL,
      link_snapshot_sha256 TEXT NOT NULL,
      ineligible_n INTEGER NOT NULL,
      failed_n INTEGER NOT NULL,
      failure_reason_json TEXT NOT NULL,
      completed INTEGER NOT NULL
    );
    CREATE TABLE r3_prepare_initial_keys (
      work_item_id TEXT PRIMARY KEY
    );
    INSERT INTO r3_prepare_initial_keys(work_item_id)
      SELECT work_item_id FROM work_item_branch_keys;
  `);
  db.prepare(
    `INSERT INTO r3_prepare_checkpoint
      (singleton,approved_input_db_sha256,evaluator_commit,evaluator_module_sha256,
       repo_map_sha256,as_of,link_snapshot_sha256,ineligible_n,failed_n,failure_reason_json,completed)
     VALUES (1,?,?,?,?,?,?,0,0,'{}',0)`,
  ).run(
    approved.scratchDbSha256,
    request.evaluatorCommit,
    request.evaluatorModuleSha256,
    approved.repoMapSha256,
    request.asOf,
    sha256Canonical(JSON.parse(snapshotSessionWorkLinks(db)) as unknown),
  );
}

function verifyAndResetCheckpoint(
  db: Database.Database,
  request: R3PrepareRequest,
  approved: LoadedApprovedEvidenceInput,
): void {
  if (!exactStrings(schemaVersions(db), REQUIRED_SCHEMA_7)) {
    refuse("r3_working_db_schema_invalid");
  }
  assertDatabaseIntegrity(db);
  const row = db.prepare("SELECT * FROM r3_prepare_checkpoint WHERE singleton=1").get() as
    | {
        evaluator_module_sha256: string;
        approved_input_db_sha256: string;
        evaluator_commit: string;
        repo_map_sha256: string;
        as_of: string;
        link_snapshot_sha256: string;
        completed: number;
      }
    | undefined;
  if (
    row === undefined ||
    row.approved_input_db_sha256 !== approved.scratchDbSha256 ||
    row.evaluator_commit !== request.evaluatorCommit ||
    row.evaluator_module_sha256 !== request.evaluatorModuleSha256 ||
    row.repo_map_sha256 !== approved.repoMapSha256 ||
    row.as_of !== request.asOf ||
    row.link_snapshot_sha256 !==
      sha256Canonical(JSON.parse(snapshotSessionWorkLinks(db)) as unknown) ||
    (row.completed !== 0 && row.completed !== 1)
  )
    refuse("r3_working_db_checkpoint_binding_mismatch");
  db.prepare(
    "UPDATE r3_prepare_checkpoint SET ineligible_n=0, failed_n=0, failure_reason_json='{}', completed=0 WHERE singleton=1",
  ).run();
}

function schemaVersions(db: Database.Database): string[] {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (table === undefined) refuse("r3_schema_missing");
  return (
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version COLLATE BINARY")
      .all() as Array<{
      version: unknown;
    }>
  ).map((row) => {
    if (typeof row.version !== "string") refuse("r3_schema_invalid");
    return row.version;
  });
}

function exactStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function migrateExactlyToSeven(db: Database.Database): void {
  const before = schemaVersions(db);
  if (exactStrings(before, REQUIRED_SCHEMA_6)) {
    // R3 is an exact historical schema-6-to-7 transition. Newer application
    // migrations (for example the reports artifact) must not enter this gate.
    const applied = runMigrations(db, "007_work_item_branch_keys");
    if (!exactStrings(applied, ["007_work_item_branch_keys"])) {
      refuse("r3_schema_transition_invalid");
    }
  } else if (!exactStrings(before, REQUIRED_SCHEMA_7)) {
    refuse("r3_schema_version_refused");
  }
  if (!exactStrings(schemaVersions(db), REQUIRED_SCHEMA_7)) refuse("r3_schema_seven_invalid");
}

function assertCorpusWorkspaceScope(
  db: Database.Database,
  approvedWorkspaceIds: ReadonlySet<string>,
): void {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.workspace_id
         FROM sessions s
        WHERE s.state = 'RECONCILED'
          AND EXISTS (SELECT 1 FROM tool_events te
                       WHERE te.session_id = s.session_id AND te.tool_name = 'Bash')
          -- R3 corpus: evidence-bearing workspaces only (see plan §5G). Keep this
          -- predicate byte-identical across all six corpus queries.
          AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)
        ORDER BY s.workspace_id COLLATE BINARY`,
    )
    .all() as Array<{ workspace_id: unknown }>;
  for (const row of rows) {
    if (typeof row.workspace_id !== "string" || !approvedWorkspaceIds.has(row.workspace_id)) {
      refuse("r3_corpus_workspace_not_allowlisted");
    }
  }
}

async function freezeCorpus(
  db: Database.Database,
  approvedWorkspaceIds: ReadonlySet<string>,
): Promise<R3PrivateCorpus> {
  assertCorpusWorkspaceScope(db, approvedWorkspaceIds);
  const rows = db
    .prepare(
      `SELECT s.session_id, s.file_path
         FROM sessions s
        WHERE s.state = 'RECONCILED'
          AND EXISTS (SELECT 1 FROM tool_events te
                       WHERE te.session_id = s.session_id AND te.tool_name = 'Bash')
          -- R3 corpus: evidence-bearing workspaces only (see plan §5G). Keep this
          -- predicate byte-identical across all six corpus queries.
          AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id = s.workspace_id)
        ORDER BY s.session_id COLLATE BINARY`,
    )
    .all() as Array<{ session_id: unknown; file_path: unknown }>;
  const entries = [];
  for (const row of rows) {
    if (
      typeof row.session_id !== "string" ||
      row.session_id.length === 0 ||
      typeof row.file_path !== "string" ||
      row.file_path.length === 0
    ) {
      refuse("r3_corpus_row_invalid");
    }
    const resolvedPath = fs.realpathSync.native(row.file_path);
    const handle = await fs.promises.open(resolvedPath, "r");
    try {
      const before = await handle.stat({ bigint: true });
      const pathnameBefore = await fs.promises.stat(resolvedPath, { bigint: true });
      const identity: FileIdentity = {
        device: before.dev.toString(),
        inode: before.ino.toString(),
        size: before.size.toString(),
      };
      const sameIdentity = (stat: fs.BigIntStats): boolean =>
        stat.isFile() &&
        stat.dev.toString() === identity.device &&
        stat.ino.toString() === identity.inode &&
        stat.size.toString() === identity.size &&
        identity.inode !== "0";
      if (!sameIdentity(pathnameBefore)) refuse("r3_corpus_path_replaced_before_hash");
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || size < 0) refuse("r3_corpus_size_invalid");
      let position = 0;
      while (position < size) {
        const remaining = size - position;
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, remaining),
          position,
        );
        if (bytesRead === 0) refuse("r3_corpus_short_read");
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const pathnameAfter = await fs.promises.stat(resolvedPath, { bigint: true });
      if (
        !sameIdentity(after) ||
        !sameIdentity(pathnameAfter) ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        refuse("r3_corpus_changed_during_hash");
      entries.push({
        sessionId: row.session_id,
        path: resolvedPath,
        identity,
        sha256: digest.digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  return { version: "r3-u4-private-corpus-v1", entries };
}

function identity(request: R3PrepareRequest): FrozenR3Identity {
  return {
    sourceCommit: request.evaluatorCommit,
    runnerVersion: R3_RUNNER_VERSION,
    evaluatorModuleSha256: request.evaluatorModuleSha256,
    normalizationVersion: "branch-v1",
    schemaVersion: 7,
    reasonVocabularyVersion: R3_REASON_VOCABULARY_VERSION,
  };
}

/** Prepare a sealed, hydrated clone. The attested Stage-0 database is never reopened or mutated. */
export async function prepareR3(
  request: R3PrepareRequest,
  dependencies: R3PrepareDependencies,
): Promise<R3PrepareManifest> {
  validateRequest(request);
  if ((await sha256File(EVALUATOR_MODULE_PATH)) !== request.evaluatorModuleSha256) {
    refuse("r3_evaluator_module_digest_mismatch");
  }
  if (!dependencies.github.enabled) refuse("r3_github_disabled");
  const approved = await (dependencies.loadApproved ?? loadApprovedEvidenceInput)(
    request.approvedInput,
  );
  const retainedArtifacts = ["scratch_verification"];
  let source: Database.Database | undefined;
  let working: Database.Database | undefined;
  try {
    const workingPath = directWorkingPath(approved, request.workingDbPath);
    if (request.resume) {
      let existing: string;
      try {
        existing = fs.realpathSync.native(workingPath);
      } catch {
        refuse("r3_working_db_missing");
      }
      retainedArtifacts.push("working_db");
      if ((await sha256File(existing)) !== request.workingDbSha256)
        refuse("r3_working_db_digest_mismatch");
      working = new Database(existing, { fileMustExist: true });
      if ((await sha256File(existing)) !== request.workingDbSha256)
        refuse("r3_working_db_changed_during_open");
      verifyAndResetCheckpoint(working, request, approved);
    } else {
      source = approved.openVerifiedScratchDb();
      const initial = new Database(source.serialize());
      source.close();
      source = undefined;
      try {
        migrateExactlyToSeven(initial);
        initializeCheckpoint(initial, request, approved);
        const publication = publishApprovedOutput(approved, workingPath, initial.serialize());
        retainedArtifacts.push("working_db");
        fs.chmodSync(publication.path, 0o600);
      } finally {
        initial.close();
      }
      working = new Database(workingPath, { fileMustExist: true });
    }

    const beforeLinks = snapshotSessionWorkLinks(working);
    const totals = {
      completed: false,
      selectedN: 0,
      keyedN: 0,
      ineligibleN: 0,
      failedN: 0,
      missingN: 0,
      failureReasonN: {} as Record<string, number>,
    };
    let cursor: string | null = "";
    do {
      const page = await backfillMissingWorkItemBranchKeys(
        working,
        dependencies.github as unknown as Parameters<typeof backfillMissingWorkItemBranchKeys>[1],
        {
          cursor,
          limit: request.backfillPageSize,
          concurrency: request.githubConcurrency,
          evidence: {
            repositories: approved.repositories.map(({ workspaceId, owner, repo }) => ({
              workspaceId,
              owner,
              repo,
            })),
            asOf: request.asOf,
            syncedAt: (dependencies.now?.() ?? new Date(request.asOf)).toISOString(),
            ...(dependencies.onBackfillCheckpoint === undefined
              ? {}
              : { onPageCheckpoint: dependencies.onBackfillCheckpoint }),
          },
        },
      );
      totals.selectedN += page.selected;
      totals.keyedN += page.keyed;
      totals.ineligibleN += page.ineligible;
      totals.failedN += page.failed;
      totals.missingN += page.missing;
      for (const [reason, count] of Object.entries(page.failureReasonCounts ?? {})) {
        totals.failureReasonN[reason] = (totals.failureReasonN[reason] ?? 0) + count;
      }
      const checkpointRow = working
        .prepare(
          "SELECT ineligible_n,failed_n,failure_reason_json FROM r3_prepare_checkpoint WHERE singleton=1",
        )
        .get() as {
        ineligible_n: number;
        failed_n: number;
        failure_reason_json: string;
      };
      const checkpointReasons = JSON.parse(checkpointRow.failure_reason_json) as Record<
        string,
        number
      >;
      for (const [reason, count] of Object.entries(page.failureReasonCounts ?? {})) {
        checkpointReasons[reason] = (checkpointReasons[reason] ?? 0) + count;
      }
      working
        .prepare(
          `UPDATE r3_prepare_checkpoint
              SET ineligible_n=?, failed_n=?, failure_reason_json=?
            WHERE singleton=1`,
        )
        .run(
          checkpointRow.ineligible_n + page.ineligible,
          checkpointRow.failed_n + page.failed,
          canonicalJson(checkpointReasons),
        );
      cursor = page.nextCursor;
    } while (cursor !== null);
    totals.completed = true;
    const checkpoint = working
      .prepare(
        `SELECT ineligible_n,failed_n,failure_reason_json,
                (SELECT COUNT(*) FROM work_item_branch_keys bk
                  WHERE NOT EXISTS (SELECT 1 FROM r3_prepare_initial_keys i WHERE i.work_item_id=bk.work_item_id)) keyed_n
           FROM r3_prepare_checkpoint WHERE singleton=1`,
      )
      .get() as {
      ineligible_n: number;
      failed_n: number;
      failure_reason_json: string;
      keyed_n: number;
    };
    totals.keyedN = checkpoint.keyed_n;
    totals.ineligibleN = checkpoint.ineligible_n;
    totals.failedN = checkpoint.failed_n;
    totals.missingN = checkpoint.ineligible_n + checkpoint.failed_n;
    totals.selectedN = totals.keyedN + totals.missingN;
    totals.failureReasonN = JSON.parse(checkpoint.failure_reason_json) as Record<string, number>;
    working.prepare("UPDATE r3_prepare_checkpoint SET completed=1 WHERE singleton=1").run();

    if (snapshotSessionWorkLinks(working) !== beforeLinks)
      refuse("r3_link_snapshot_changed_prepare");
    const corpus = await freezeCorpus(
      working,
      new Set(approved.repositories.map((repository) => repository.workspaceId)),
    );
    assertDatabaseIntegrity(working);
    working.pragma("wal_checkpoint(TRUNCATE)");
    const sealedBytes = working.serialize();
    working.close();
    working = undefined;

    const sealedPublication = publishApprovedOutput(approved, request.sealedDbOut, sealedBytes);
    retainedArtifacts.push("sealed_db");
    const corpusPublication = publishApprovedOutput(
      approved,
      request.privateCorpusOut,
      canonicalJson(corpus),
    );
    retainedArtifacts.push("private_corpus");
    try {
      fs.chmodSync(sealedPublication.path, 0o444);
    } catch {
      refuse("r3_sealed_db_readonly_failed_sealed_and_corpus_retained");
    }
    const manifest: R3PrepareManifest = {
      campaign: "R3_U4_BRANCH_LINKAGE",
      status:
        totals.completed && totals.failedN === 0 && totals.ineligibleN === 0
          ? "PREPARED"
          : "DATA_INSUFFICIENT",
      identity: {
        ...identity(request),
        approvedInputDbSha256: approved.scratchDbSha256,
        sealedHydratedDbSha256: sealedPublication.sha256,
        repoMapSha256: approved.repoMapSha256,
        privateCorpusSha256: corpusPublication.sha256,
        linkSnapshotSha256: sha256Canonical(JSON.parse(beforeLinks) as unknown),
        asOf: request.asOf,
      },
      backfill: totals,
      corpus: { outcomeBearingSessionsN: corpus.entries.length },
      privacy: { rawRefN: 0, transcriptPathN: 0, tokenN: 0 },
    };
    publishApprovedOutput(approved, request.manifestOut, canonicalJson(manifest));
    retainedArtifacts.push("manifest");
    return manifest;
  } catch (error) {
    throw retainedFailure(error, retainedArtifacts);
  } finally {
    source?.close();
    working?.close();
  }
}

export function approvedState(
  approved: LoadedApprovedEvidenceInput,
): Pick<LoadedApprovedEvidenceInput, "scratchStatePath"> {
  return { scratchStatePath: approved.scratchStatePath };
}
