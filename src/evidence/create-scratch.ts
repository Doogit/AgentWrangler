import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  EvidenceBoundaryError,
  type FileIdentity,
  assertScratchBoundary,
  readFileIdentity,
  resolveProspectivePath,
  sameFileIdentity,
} from "./common/boundary.js";
import { canonicalJson, sha256Bytes, sha256File } from "./common/canonical.js";
import { assertDatabaseIntegrity, openQueryOnlyDb } from "./common/sqlite.js";
import { writeApprovedStateJson } from "./common/state.js";

export const SCRATCH_APPROVAL_VERSION = "wave2-scratch-approval-v1" as const;
export const SCRATCH_PREPARATION_VERSION = "wave2-scratch-preparation-v2" as const;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SHA256_RE = /^[0-9a-f]{64}$/u;

export interface CreateScratchInput {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  approvalManifestPath: string;
  approvalSha256: string;
}

export interface ApprovedRepoMapEntry {
  workspaceId: string;
  owner: string;
  repo: string;
  reportAlias: string;
}

export interface ScratchApprovalManifest {
  version: typeof SCRATCH_APPROVAL_VERSION;
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  repositories: readonly ApprovedRepoMapEntry[];
  privateArtifactParentAcknowledged: true;
}

export type PrivateArtifactBoundary =
  | "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED"
  | "POSIX_OWNER_ONLY_MODES_REQUESTED";

export interface ScratchPreparationManifest {
  version: typeof SCRATCH_PREPARATION_VERSION;
  createdAt: string;
  approval: {
    version: typeof SCRATCH_APPROVAL_VERSION;
    sha256: string;
    privateArtifactParentAcknowledged: true;
  };
  source: {
    path: string;
    identity: FileIdentity;
    access: "explicit-readonly-online-backup";
  };
  scratch: {
    path: string;
    identity: FileIdentity;
    sha256: string;
    integrity: "ok";
    publication: "atomic-hard-link-no-replace";
  };
  state: {
    path: string;
    cleanup: "manual-only";
    privateArtifactBoundary: PrivateArtifactBoundary;
  };
  repositoryMap: {
    file: "repo-map.json";
    sha256: string;
    mappedWorkspaceN: number;
  };
  backup: { totalPages: number; remainingPages: 0 };
  prohibitedOperations: readonly [
    "migrations",
    "github-reads",
    "transcript-reads",
    "reset-replay-vacuum-prune-delete",
  ];
}

export interface CreateScratchResult {
  scratchDbSha256: string;
  repoMapSha256: string;
  manifestSha256: string;
  approvalSha256: string;
  mappedWorkspaceN: number;
  totalPages: number;
  privateArtifactBoundary: PrivateArtifactBoundary;
}

export interface CreateScratchOptions {
  repositoryRoot?: string;
  now?: Date;
  /** Test-only fault seam; the production CLI never supplies hooks. */
  testHooks?: {
    afterBackup?: (partialDbPath: string) => void | Promise<void>;
    duringMappingOverlay?: (updatedN: number) => void;
    beforePublish?: (partialDbPath: string) => void | Promise<void>;
    beforeState?: () => void | Promise<void>;
    beforeManifestWrite?: () => void | Promise<void>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new EvidenceBoundaryError(code);
  }
}

function requiredNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new EvidenceBoundaryError(code);
  return value;
}

function parseApprovalManifest(value: unknown): ScratchApprovalManifest {
  if (!isRecord(value)) throw new EvidenceBoundaryError("approval_manifest_invalid");
  assertExactKeys(
    value,
    [
      "version",
      "sourceDbPath",
      "scratchDbPath",
      "scratchStatePath",
      "repositories",
      "privateArtifactParentAcknowledged",
    ],
    "approval_manifest_unknown_or_missing_key",
  );
  if (value.version !== SCRATCH_APPROVAL_VERSION) {
    throw new EvidenceBoundaryError("approval_manifest_version_mismatch");
  }
  if (value.privateArtifactParentAcknowledged !== true) {
    throw new EvidenceBoundaryError("private_artifact_parent_not_acknowledged");
  }
  if (!Array.isArray(value.repositories)) {
    throw new EvidenceBoundaryError("approval_repository_allowlist_invalid");
  }

  const workspaceIds = new Set<string>();
  const reportAliases = new Set<string>();
  const canonicalRepositories = new Set<string>();
  const repositories = value.repositories.map((entry) => {
    if (!isRecord(entry)) throw new EvidenceBoundaryError("approval_repository_invalid");
    assertExactKeys(
      entry,
      ["workspaceId", "owner", "repo", "reportAlias"],
      "approval_repository_unknown_or_missing_key",
    );
    const parsed: ApprovedRepoMapEntry = {
      workspaceId: requiredNonEmptyString(entry.workspaceId, "approval_workspace_id_invalid"),
      owner: requiredNonEmptyString(entry.owner, "approval_owner_invalid"),
      repo: requiredNonEmptyString(entry.repo, "approval_repo_invalid"),
      reportAlias: requiredNonEmptyString(entry.reportAlias, "approval_report_alias_invalid"),
    };
    if (workspaceIds.has(parsed.workspaceId)) {
      throw new EvidenceBoundaryError("approval_workspace_duplicate");
    }
    if (reportAliases.has(parsed.reportAlias)) {
      throw new EvidenceBoundaryError("approval_report_alias_duplicate");
    }
    const canonicalRepository = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
    if (canonicalRepositories.has(canonicalRepository)) {
      throw new EvidenceBoundaryError("approval_repository_duplicate");
    }
    workspaceIds.add(parsed.workspaceId);
    reportAliases.add(parsed.reportAlias);
    canonicalRepositories.add(canonicalRepository);
    return parsed;
  });

  return {
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: requiredNonEmptyString(value.sourceDbPath, "approval_source_path_invalid"),
    scratchDbPath: requiredNonEmptyString(value.scratchDbPath, "approval_scratch_path_invalid"),
    scratchStatePath: requiredNonEmptyString(value.scratchStatePath, "approval_state_path_invalid"),
    repositories,
    privateArtifactParentAcknowledged: true,
  };
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function exactFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

function readCanonicalSourceRepositoryRows(sourceDbPath: string): string {
  const db = openQueryOnlyDb(sourceDbPath);
  try {
    const rows = db
      .prepare(
        `SELECT workspace_id, repo_owner, repo_name
           FROM workspaces
          ORDER BY workspace_id COLLATE BINARY`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (
        typeof row.workspace_id !== "string" ||
        row.workspace_id.length === 0 ||
        (row.repo_owner !== null && typeof row.repo_owner !== "string") ||
        (row.repo_name !== null && typeof row.repo_name !== "string")
      ) {
        throw new EvidenceBoundaryError("source_repository_mapping_invalid");
      }
    }
    return canonicalJson(rows);
  } finally {
    db.close();
  }
}

function readApproval(
  approvalManifestPath: string,
  approvalSha256: string,
  repositoryRoot: string,
): ScratchApprovalManifest {
  if (!SHA256_RE.test(approvalSha256)) throw new EvidenceBoundaryError("approval_sha256_invalid");
  if (!fs.existsSync(approvalManifestPath)) {
    throw new EvidenceBoundaryError("approval_manifest_missing");
  }
  const resolvedPath = fs.realpathSync.native(approvalManifestPath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new EvidenceBoundaryError("approval_manifest_not_file");
  if (isWithin(repositoryRoot, resolvedPath)) {
    throw new EvidenceBoundaryError("approval_manifest_inside_repository");
  }
  const bytes = fs.readFileSync(resolvedPath);
  if (sha256Bytes(bytes) !== approvalSha256) {
    throw new EvidenceBoundaryError("approval_sha256_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EvidenceBoundaryError("approval_manifest_invalid_json");
  }
  return parseApprovalManifest(parsed);
}

function assertApprovalPaths(
  approval: ScratchApprovalManifest,
  boundary: ReturnType<typeof assertScratchBoundary>,
): void {
  let approvedSource: string;
  try {
    approvedSource = fs.realpathSync.native(approval.sourceDbPath);
  } catch {
    throw new EvidenceBoundaryError("approval_source_path_unresolvable");
  }
  const approvedScratch = resolveProspectivePath(approval.scratchDbPath);
  const approvedState = resolveProspectivePath(approval.scratchStatePath);
  if (
    comparisonPath(approvedSource) !== comparisonPath(boundary.sourceDbPath) ||
    comparisonPath(approvedScratch) !== comparisonPath(boundary.scratchDbPath) ||
    comparisonPath(approvedState) !== comparisonPath(boundary.scratchStatePath)
  ) {
    throw new EvidenceBoundaryError("approval_path_binding_mismatch");
  }
}

interface RepositoryOverlayPlan {
  repoMap: ApprovedRepoMapEntry[];
  additions: ApprovedRepoMapEntry[];
}

function planApprovedRepoMap(
  db: Database.Database,
  approved: readonly ApprovedRepoMapEntry[],
  permitUnmappedAdditions: boolean,
): RepositoryOverlayPlan {
  const rows = db
    .prepare(
      `SELECT workspace_id, repo_owner, repo_name
         FROM workspaces
        ORDER BY workspace_id COLLATE BINARY`,
    )
    .all() as Array<{
    workspace_id: unknown;
    repo_owner: unknown;
    repo_name: unknown;
  }>;

  const live = new Map<string, { owner: string; repo: string } | null>();
  for (const row of rows) {
    if (typeof row.workspace_id !== "string" || row.workspace_id.length === 0) {
      throw new EvidenceBoundaryError("invalid_workspace_identity");
    }
    const ownerMissing = row.repo_owner === null;
    const repoMissing = row.repo_name === null;
    if (ownerMissing !== repoMissing) throw new EvidenceBoundaryError("partial_repository_mapping");
    if (live.has(row.workspace_id)) throw new EvidenceBoundaryError("duplicate_db_workspace");
    if (ownerMissing) {
      live.set(row.workspace_id, null);
      continue;
    }
    if (
      typeof row.repo_owner !== "string" ||
      row.repo_owner.length === 0 ||
      typeof row.repo_name !== "string" ||
      row.repo_name.length === 0
    ) {
      throw new EvidenceBoundaryError("invalid_repository_mapping");
    }
    live.set(row.workspace_id, { owner: row.repo_owner, repo: row.repo_name });
  }

  const result = [...approved].sort((left, right) =>
    left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0,
  );
  const approvedByWorkspace = new Map(result.map((entry) => [entry.workspaceId, entry]));
  const additions: ApprovedRepoMapEntry[] = [];
  for (const [workspaceId, dbMapping] of live) {
    const entry = approvedByWorkspace.get(workspaceId);
    if (dbMapping === null) {
      if (entry !== undefined) additions.push(entry);
      continue;
    }
    if (entry === undefined || dbMapping.owner !== entry.owner || dbMapping.repo !== entry.repo) {
      throw new EvidenceBoundaryError("repository_allowlist_not_exact");
    }
  }
  for (const entry of result) {
    if (!live.has(entry.workspaceId)) {
      throw new EvidenceBoundaryError("repository_allowlist_unknown_workspace");
    }
    if (live.get(entry.workspaceId) === null && !permitUnmappedAdditions) {
      throw new EvidenceBoundaryError("repository_overlay_verification_failed");
    }
  }
  return { repoMap: result, additions };
}

function applyApprovedRepoMapOverlay(
  partialDbPath: string,
  approved: readonly ApprovedRepoMapEntry[],
  duringMappingOverlay?: (updatedN: number) => void,
): void {
  const db = new Database(partialDbPath, { fileMustExist: true });
  try {
    const plan = planApprovedRepoMap(db, approved, true);
    const update = db.prepare(
      `UPDATE workspaces
          SET repo_owner = ?, repo_name = ?
        WHERE workspace_id = ? AND repo_owner IS NULL AND repo_name IS NULL`,
    );
    const apply = db.transaction(() => {
      let updatedN = 0;
      for (const entry of plan.additions) {
        const result = update.run(entry.owner, entry.repo, entry.workspaceId);
        if (result.changes !== 1) throw new EvidenceBoundaryError("repository_overlay_race");
        const verified = db
          .prepare("SELECT repo_owner, repo_name FROM workspaces WHERE workspace_id = ?")
          .get(entry.workspaceId) as { repo_owner?: unknown; repo_name?: unknown } | undefined;
        if (verified?.repo_owner !== entry.owner || verified.repo_name !== entry.repo) {
          throw new EvidenceBoundaryError("repository_overlay_readback_failed");
        }
        updatedN += 1;
        duringMappingOverlay?.(updatedN);
      }
    });
    apply();
    if (db.pragma("journal_mode", { simple: true }) === "wal") {
      const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      if (checkpoint.length !== 1 || checkpoint[0]?.busy !== 0 || checkpoint[0]?.log !== 0) {
        throw new EvidenceBoundaryError("repository_overlay_checkpoint_failed");
      }
    }
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
      throw new EvidenceBoundaryError("repository_overlay_journal_mode_failed");
    }
  } finally {
    db.close();
  }
}

function reservePartialPath(scratchDbPath: string): string {
  const parent = path.dirname(scratchDbPath);
  for (let attempt = 0; attempt < 10; attempt++) {
    const partialPath = path.join(
      parent,
      `.${path.basename(scratchDbPath)}.${process.pid}.${randomUUID()}.partial`,
    );
    try {
      const descriptor = fs.openSync(partialPath, "wx", 0o600);
      fs.closeSync(descriptor);
      return partialPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new EvidenceBoundaryError("partial_reservation_failed");
}

function retainedFailure(error: unknown, fallback: string): EvidenceBoundaryError {
  const base = error instanceof EvidenceBoundaryError ? error.code : fallback;
  return new EvidenceBoundaryError(`${base}_partial_retained`);
}

function privateArtifactBoundary(): PrivateArtifactBoundary {
  return process.platform === "win32"
    ? "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED"
    : "POSIX_OWNER_ONLY_MODES_REQUESTED";
}

export function parseCreateScratchArgs(args: readonly string[]): CreateScratchInput {
  const allowed = new Set([
    "--source-db",
    "--scratch-db",
    "--scratch-state",
    "--approval-manifest",
    "--approval-sha256",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag)) {
      throw new EvidenceBoundaryError("unknown_cli_argument");
    }
    if (values.has(flag)) throw new EvidenceBoundaryError("duplicate_cli_argument");
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new EvidenceBoundaryError("missing_cli_value");
    }
    values.set(flag, value);
  }
  const sourceDbPath = values.get("--source-db");
  const scratchDbPath = values.get("--scratch-db");
  const scratchStatePath = values.get("--scratch-state");
  const approvalManifestPath = values.get("--approval-manifest");
  const approvalSha256 = values.get("--approval-sha256");
  if (
    sourceDbPath === undefined ||
    scratchDbPath === undefined ||
    scratchStatePath === undefined ||
    approvalManifestPath === undefined ||
    approvalSha256 === undefined
  ) {
    throw new EvidenceBoundaryError("missing_required_cli_argument");
  }
  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    approvalManifestPath,
    approvalSha256,
  };
}

export async function createApprovedScratchCopy(
  input: CreateScratchInput,
  options: CreateScratchOptions = {},
): Promise<CreateScratchResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new EvidenceBoundaryError("invalid_clock");
  const repositoryRoot = fs.realpathSync.native(options.repositoryRoot ?? REPOSITORY_ROOT);
  const approval = readApproval(input.approvalManifestPath, input.approvalSha256, repositoryRoot);
  const boundary = assertScratchBoundary({
    sourceDbPath: input.sourceDbPath,
    scratchDbPath: input.scratchDbPath,
    scratchStatePath: input.scratchStatePath,
    repositoryRoot,
  });
  assertApprovalPaths(approval, boundary);
  const sourceShaBefore = await sha256File(boundary.sourceDbPath);
  const sourceRepositoryRowsBefore = readCanonicalSourceRepositoryRows(boundary.sourceDbPath);

  fs.mkdirSync(path.dirname(boundary.scratchDbPath), { recursive: true });
  const partialDbPath = reservePartialPath(boundary.scratchDbPath);
  let backup: Database.BackupMetadata;
  let source: Database.Database | undefined;
  try {
    source = openQueryOnlyDb(boundary.sourceDbPath);
    backup = await source.backup(partialDbPath);
  } catch (error) {
    throw retainedFailure(error, "online_backup_failed");
  } finally {
    source?.close();
  }

  await options.testHooks?.afterBackup?.(partialDbPath);
  let verifiedSourceIdentity: FileIdentity;
  try {
    verifiedSourceIdentity = readFileIdentity(boundary.sourceDbPath);
  } catch {
    throw new EvidenceBoundaryError("source_identity_changed_partial_retained");
  }
  if (!exactFileIdentity(boundary.sourceIdentity, verifiedSourceIdentity)) {
    throw new EvidenceBoundaryError("source_identity_changed_partial_retained");
  }
  if (backup.remainingPages !== 0) {
    throw new EvidenceBoundaryError("online_backup_incomplete_partial_retained");
  }

  const reservedPartialIdentity = readFileIdentity(partialDbPath);
  if (sameFileIdentity(verifiedSourceIdentity, reservedPartialIdentity)) {
    throw new EvidenceBoundaryError("partial_aliases_source_partial_retained");
  }
  try {
    applyApprovedRepoMapOverlay(
      partialDbPath,
      approval.repositories,
      options.testHooks?.duringMappingOverlay,
    );
  } catch (error) {
    throw retainedFailure(error, "repository_overlay_failed");
  }
  const partialIdentity = readFileIdentity(partialDbPath);
  const firstSha = await sha256File(partialDbPath);
  let repoMap: ApprovedRepoMapEntry[];
  const scratch = openQueryOnlyDb(partialDbPath);
  try {
    assertDatabaseIntegrity(scratch);
    repoMap = planApprovedRepoMap(scratch, approval.repositories, false).repoMap;
  } catch (error) {
    throw retainedFailure(error, "scratch_verification_failed");
  } finally {
    scratch.close();
  }
  const verifiedSha = await sha256File(partialDbPath);
  if (verifiedSha !== firstSha) {
    throw new EvidenceBoundaryError("scratch_sha_changed_during_verify_partial_retained");
  }

  await options.testHooks?.beforePublish?.(partialDbPath);
  let sourceShaAfter: string;
  try {
    sourceShaAfter = await sha256File(boundary.sourceDbPath);
  } catch {
    throw new EvidenceBoundaryError("source_bytes_changed_partial_retained");
  }
  let finalSourceIdentity: FileIdentity;
  try {
    finalSourceIdentity = readFileIdentity(boundary.sourceDbPath);
  } catch {
    throw new EvidenceBoundaryError("source_bytes_changed_partial_retained");
  }
  if (
    sourceShaAfter !== sourceShaBefore ||
    !exactFileIdentity(verifiedSourceIdentity, finalSourceIdentity)
  ) {
    throw new EvidenceBoundaryError("source_bytes_changed_partial_retained");
  }
  let sourceRepositoryRowsAfter: string;
  try {
    sourceRepositoryRowsAfter = readCanonicalSourceRepositoryRows(boundary.sourceDbPath);
  } catch {
    throw new EvidenceBoundaryError("source_mapping_changed_partial_retained");
  }
  if (sourceRepositoryRowsAfter !== sourceRepositoryRowsBefore) {
    throw new EvidenceBoundaryError("source_mapping_changed_partial_retained");
  }
  try {
    fs.linkSync(partialDbPath, boundary.scratchDbPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new EvidenceBoundaryError(
      code === "EEXIST"
        ? "scratch_publish_target_exists_partial_retained"
        : "scratch_publish_failed_partial_retained",
    );
  }

  let publishedSha: string;
  try {
    publishedSha = await sha256File(boundary.scratchDbPath);
  } catch {
    throw new EvidenceBoundaryError("published_scratch_hash_failed_partial_and_scratch_retained");
  }
  if (publishedSha !== verifiedSha) {
    throw new EvidenceBoundaryError("published_scratch_sha_mismatch_partial_and_scratch_retained");
  }

  try {
    fs.unlinkSync(partialDbPath);
  } catch {
    throw new EvidenceBoundaryError("partial_unlink_failed_partial_and_scratch_retained");
  }

  let scratchIdentity: FileIdentity;
  try {
    scratchIdentity = readFileIdentity(boundary.scratchDbPath);
  } catch {
    throw new EvidenceBoundaryError("published_scratch_identity_failed_scratch_retained");
  }
  if (!exactFileIdentity(partialIdentity, scratchIdentity)) {
    throw new EvidenceBoundaryError("published_scratch_identity_mismatch_scratch_retained");
  }

  try {
    await options.testHooks?.beforeState?.();
    fs.mkdirSync(path.dirname(boundary.scratchStatePath), { recursive: true });
    fs.mkdirSync(boundary.scratchStatePath, { recursive: false, mode: 0o700 });
  } catch {
    throw new EvidenceBoundaryError(
      "scratch_state_create_failed_scratch_published_state_may_be_retained",
    );
  }
  let repoMapWrite: ReturnType<typeof writeApprovedStateJson>;
  try {
    repoMapWrite = writeApprovedStateJson(boundary.scratchStatePath, "repo-map.json", repoMap);
  } catch {
    throw new EvidenceBoundaryError("repo_map_write_failed_scratch_published_state_retained");
  }
  const artifactBoundary = privateArtifactBoundary();
  const manifest: ScratchPreparationManifest = {
    version: SCRATCH_PREPARATION_VERSION,
    createdAt: now.toISOString(),
    approval: {
      version: SCRATCH_APPROVAL_VERSION,
      sha256: input.approvalSha256,
      privateArtifactParentAcknowledged: true,
    },
    source: {
      path: boundary.sourceDbPath,
      identity: verifiedSourceIdentity,
      access: "explicit-readonly-online-backup",
    },
    scratch: {
      path: boundary.scratchDbPath,
      identity: scratchIdentity,
      sha256: verifiedSha,
      integrity: "ok",
      publication: "atomic-hard-link-no-replace",
    },
    state: {
      path: boundary.scratchStatePath,
      cleanup: "manual-only",
      privateArtifactBoundary: artifactBoundary,
    },
    repositoryMap: {
      file: "repo-map.json",
      sha256: repoMapWrite.sha256,
      mappedWorkspaceN: repoMap.length,
    },
    backup: { totalPages: backup.totalPages, remainingPages: 0 },
    prohibitedOperations: [
      "migrations",
      "github-reads",
      "transcript-reads",
      "reset-replay-vacuum-prune-delete",
    ],
  };
  let manifestWrite: ReturnType<typeof writeApprovedStateJson>;
  try {
    await options.testHooks?.beforeManifestWrite?.();
    manifestWrite = writeApprovedStateJson(
      boundary.scratchStatePath,
      "preparation-manifest.json",
      manifest,
    );
  } catch {
    throw new EvidenceBoundaryError("manifest_write_failed_scratch_published_state_retained");
  }

  return {
    scratchDbSha256: verifiedSha,
    repoMapSha256: repoMapWrite.sha256,
    manifestSha256: manifestWrite.sha256,
    approvalSha256: input.approvalSha256,
    mappedWorkspaceN: repoMap.length,
    totalPages: backup.totalPages,
    privateArtifactBoundary: artifactBoundary,
  };
}

async function main(): Promise<void> {
  try {
    const result = await createApprovedScratchCopy(parseCreateScratchArgs(process.argv.slice(2)));
    process.stdout.write(`${canonicalJson({ status: "CREATED", ...result })}\n`);
  } catch (error) {
    const code = error instanceof EvidenceBoundaryError ? error.code : "unexpected_failure";
    process.stderr.write(`${canonicalJson({ status: "REFUSED", failure: code })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  void main();
}
