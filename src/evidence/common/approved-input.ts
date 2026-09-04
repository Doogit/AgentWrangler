import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  type ApprovedRepoMapEntry,
  SCRATCH_APPROVAL_VERSION,
  SCRATCH_PREPARATION_VERSION,
  type ScratchApprovalManifest,
  type ScratchPreparationManifest,
} from "../create-scratch.js";
import {
  EvidenceBoundaryError,
  type FileIdentity,
  readFileIdentity,
  sameFileIdentity,
} from "./boundary.js";
import { sha256Bytes } from "./canonical.js";
import { assertDatabaseIntegrity } from "./sqlite.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;

export interface ApprovedEvidenceInput {
  approvalManifestPath: string;
  approvalManifestSha256: string;
  preparationManifestPath: string;
  preparationManifestSha256: string;
  scratchDbPath: string;
  scratchDbSha256: string;
  /**
   * Explicit retained hard-link leaf inside approved state; it must not exist.
   * This stabilizes pathname/object identity only. It adds no ACL immutability and same-owner
   * in-place mutation is bounded only by the before/after descriptor digest checks.
   */
  scratchVerificationPath: string;
  scratchStatePath: string;
  repoMapPath: string;
  repoMapSha256: string;
  liveDbPath: string;
  repositoryRoot: string;
}

export interface LoadedApprovedEvidenceInput {
  approvalManifestPath: string;
  approvalManifestSha256: string;
  preparationManifestPath: string;
  preparationManifestSha256: string;
  /** Attested operator path for reporting only; campaign code must never reopen it. */
  approvedScratchDbPath: string;
  scratchDbSha256: string;
  /** Retained hard-link identity attestation only, never a DB read source. Manual cleanup only. */
  scratchVerificationPath: string;
  scratchStatePath: string;
  repoMapPath: string;
  repoMapSha256: string;
  liveDbPath: string;
  repositoryRoot: string;
  repositories: readonly ApprovedRepoMapEntry[];
  /** Open a fresh query-only in-memory clone of the private attested snapshot bytes. */
  openVerifiedScratchDb: () => Database.Database;
}

export interface ApprovedEvidenceTestHooks {
  onJsonDescriptorRead?: (kind: string, resolvedPath: string) => void;
  beforeScratchVerificationLink?: () => void;
  afterScratchVerificationLink?: () => void;
  beforeScratchVerificationOpen?: () => void;
  beforeSnapshotIntegrity?: () => void;
  afterSnapshotIntegrity?: () => void;
}

export interface ApprovedOutputPublication {
  path: string;
  sha256: string;
  identity: FileIdentity;
}

export interface ApprovedOutputTestHooks {
  beforePublishLink?: (temporaryPath: string, destinationPath: string) => void;
  afterPublishLink?: (temporaryPath: string, destinationPath: string) => void;
}

function refuse(code: string): never {
  throw new EvidenceBoundaryError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    refuse(code);
  }
}

function nonempty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) refuse(code);
  return value as string;
}

function sha256(value: unknown, code: string): string {
  const parsed = nonempty(value, code);
  if (!SHA256_RE.test(parsed)) refuse(code);
  return parsed;
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse(code);
  return value;
}

function fileIdentity(value: unknown, code: string): FileIdentity {
  const parsed = record(value, code);
  exactKeys(parsed, ["device", "inode", "size"], code);
  return {
    device: nonempty(parsed.device, code),
    inode: nonempty(parsed.inode, code),
    size: nonempty(parsed.size, code),
  };
}

function repositoryEntry(value: unknown): ApprovedRepoMapEntry {
  const parsed = record(value, "repository_map_entry_invalid");
  exactKeys(
    parsed,
    ["workspaceId", "owner", "repo", "reportAlias"],
    "repository_map_entry_unknown_or_missing_key",
  );
  return {
    workspaceId: nonempty(parsed.workspaceId, "repository_workspace_id_invalid"),
    owner: nonempty(parsed.owner, "repository_owner_invalid"),
    repo: nonempty(parsed.repo, "repository_name_invalid"),
    reportAlias: nonempty(parsed.reportAlias, "repository_report_alias_invalid"),
  };
}

function parseRepositoryMap(value: unknown): ApprovedRepoMapEntry[] {
  if (!Array.isArray(value)) refuse("repository_map_invalid");
  const workspaceIds = new Set<string>();
  const aliases = new Set<string>();
  return value.map((item) => {
    const entry = repositoryEntry(item);
    if (workspaceIds.has(entry.workspaceId)) refuse("repository_workspace_duplicate");
    if (aliases.has(entry.reportAlias)) refuse("repository_report_alias_duplicate");
    workspaceIds.add(entry.workspaceId);
    aliases.add(entry.reportAlias);
    return entry;
  });
}

function parseApproval(value: unknown): ScratchApprovalManifest {
  const parsed = record(value, "approval_manifest_invalid");
  exactKeys(
    parsed,
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
  if (parsed.version !== SCRATCH_APPROVAL_VERSION) refuse("approval_manifest_version_mismatch");
  if (parsed.privateArtifactParentAcknowledged !== true) {
    refuse("private_artifact_parent_not_acknowledged");
  }
  return {
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: nonempty(parsed.sourceDbPath, "approval_source_path_invalid"),
    scratchDbPath: nonempty(parsed.scratchDbPath, "approval_scratch_path_invalid"),
    scratchStatePath: nonempty(parsed.scratchStatePath, "approval_state_path_invalid"),
    repositories: parseRepositoryMap(parsed.repositories),
    privateArtifactParentAcknowledged: true,
  };
}

function parsePreparation(value: unknown): ScratchPreparationManifest {
  const parsed = record(value, "preparation_manifest_invalid");
  exactKeys(
    parsed,
    [
      "version",
      "createdAt",
      "approval",
      "source",
      "scratch",
      "state",
      "repositoryMap",
      "backup",
      "prohibitedOperations",
    ],
    "preparation_manifest_unknown_or_missing_key",
  );
  if (parsed.version !== SCRATCH_PREPARATION_VERSION) {
    refuse("preparation_manifest_version_mismatch");
  }
  const createdAt = nonempty(parsed.createdAt, "preparation_created_at_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt)) {
    refuse("preparation_created_at_invalid");
  }

  const approval = record(parsed.approval, "preparation_approval_invalid");
  exactKeys(
    approval,
    ["version", "sha256", "privateArtifactParentAcknowledged"],
    "preparation_approval_unknown_or_missing_key",
  );
  if (
    approval.version !== SCRATCH_APPROVAL_VERSION ||
    approval.privateArtifactParentAcknowledged !== true
  ) {
    refuse("preparation_approval_invalid");
  }

  const source = record(parsed.source, "preparation_source_invalid");
  exactKeys(source, ["path", "identity", "access"], "preparation_source_unknown_or_missing_key");
  if (source.access !== "explicit-readonly-online-backup") refuse("preparation_source_invalid");

  const scratch = record(parsed.scratch, "preparation_scratch_invalid");
  exactKeys(
    scratch,
    ["path", "identity", "sha256", "integrity", "publication"],
    "preparation_scratch_unknown_or_missing_key",
  );
  if (scratch.integrity !== "ok" || scratch.publication !== "atomic-hard-link-no-replace") {
    refuse("preparation_scratch_invalid");
  }

  const state = record(parsed.state, "preparation_state_invalid");
  exactKeys(
    state,
    ["path", "cleanup", "privateArtifactBoundary"],
    "preparation_state_unknown_or_missing_key",
  );
  if (state.cleanup !== "manual-only") refuse("preparation_state_invalid");
  if (
    state.privateArtifactBoundary !== "WINDOWS_INHERITED_PARENT_ACL_ACKNOWLEDGED" &&
    state.privateArtifactBoundary !== "POSIX_OWNER_ONLY_MODES_REQUESTED"
  ) {
    refuse("preparation_state_invalid");
  }

  const repositoryMap = record(parsed.repositoryMap, "preparation_repository_map_invalid");
  exactKeys(
    repositoryMap,
    ["file", "sha256", "mappedWorkspaceN"],
    "preparation_repository_map_unknown_or_missing_key",
  );
  if (repositoryMap.file !== "repo-map.json") refuse("preparation_repository_map_invalid");

  const backup = record(parsed.backup, "preparation_backup_invalid");
  exactKeys(backup, ["totalPages", "remainingPages"], "preparation_backup_unknown_or_missing_key");
  if (backup.remainingPages !== 0) refuse("preparation_backup_incomplete");

  const prohibitedOperations = [
    "migrations",
    "github-reads",
    "transcript-reads",
    "reset-replay-vacuum-prune-delete",
  ] as const;
  if (
    !Array.isArray(parsed.prohibitedOperations) ||
    parsed.prohibitedOperations.length !== prohibitedOperations.length ||
    parsed.prohibitedOperations.some((item, index) => item !== prohibitedOperations[index])
  ) {
    refuse("preparation_prohibited_operations_invalid");
  }

  return {
    version: SCRATCH_PREPARATION_VERSION,
    createdAt,
    approval: {
      version: SCRATCH_APPROVAL_VERSION,
      sha256: sha256(approval.sha256, "preparation_approval_sha256_invalid"),
      privateArtifactParentAcknowledged: true,
    },
    source: {
      path: nonempty(source.path, "preparation_source_path_invalid"),
      identity: fileIdentity(source.identity, "preparation_source_identity_invalid"),
      access: "explicit-readonly-online-backup",
    },
    scratch: {
      path: nonempty(scratch.path, "preparation_scratch_path_invalid"),
      identity: fileIdentity(scratch.identity, "preparation_scratch_identity_invalid"),
      sha256: sha256(scratch.sha256, "preparation_scratch_sha256_invalid"),
      integrity: "ok",
      publication: "atomic-hard-link-no-replace",
    },
    state: {
      path: nonempty(state.path, "preparation_state_path_invalid"),
      cleanup: "manual-only",
      privateArtifactBoundary: state.privateArtifactBoundary,
    },
    repositoryMap: {
      file: "repo-map.json",
      sha256: sha256(repositoryMap.sha256, "preparation_repository_map_sha256_invalid"),
      mappedWorkspaceN: nonnegativeInteger(
        repositoryMap.mappedWorkspaceN,
        "preparation_mapped_workspace_count_invalid",
      ),
    },
    backup: {
      totalPages: nonnegativeInteger(backup.totalPages, "preparation_total_pages_invalid"),
      remainingPages: 0,
    },
    prohibitedOperations,
  };
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function existingFile(inputPath: string, code: string): string {
  if (inputPath.length === 0) refuse(code);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(inputPath);
  } catch {
    refuse(code);
  }
  if (!fs.statSync(resolved).isFile()) refuse(code);
  return resolved;
}

function existingDirectory(inputPath: string, code: string): string {
  if (inputPath.length === 0) refuse(code);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(inputPath);
  } catch {
    refuse(code);
  }
  if (!fs.statSync(resolved).isDirectory()) refuse(code);
  return resolved;
}

function descriptorIdentity(descriptor: number, code: string): FileIdentity {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isFile()) refuse(code);
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
  };
}

function lstatFileIdentity(filePath: string, code: string): FileIdentity {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(code);
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
  };
}

function exactIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

function aliasesIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.inode === "0" || right.inode === "0") refuse("file_identity_unavailable");
  return sameFileIdentity(left, right);
}

function readDescriptorBytes(descriptor: number, identity: FileIdentity, code: string): Buffer {
  const size = Number(identity.size);
  if (!Number.isSafeInteger(size) || size < 0) refuse(`${code}_size_invalid`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) refuse(`${code}_short_read`);
    offset += read;
  }
  if (!exactIdentity(identity, descriptorIdentity(descriptor, `${code}_changed`))) {
    refuse(`${code}_changed`);
  }
  return bytes;
}

function queryOnlySnapshotFactory(snapshotBytes: Buffer): () => Database.Database {
  const privateSnapshot = Buffer.from(snapshotBytes);
  return () => {
    const db = new Database(Buffer.from(privateSnapshot));
    try {
      db.pragma("query_only = ON");
      if (db.pragma("query_only", { simple: true }) !== 1) {
        throw new Error("query_only_not_enabled");
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
}

function readDigestBoundJson(
  inputPath: string,
  expectedSha256: string,
  code: string,
  liveDbPath: string,
  liveIdentity: FileIdentity,
  testHooks: ApprovedEvidenceTestHooks,
): { path: string; value: unknown } {
  if (!SHA256_RE.test(expectedSha256)) refuse(`${code}_sha256_invalid`);
  const resolved = existingFile(inputPath, `${code}_missing_or_not_file`);
  const descriptor = fs.openSync(resolved, "r");
  let bytes: Buffer;
  try {
    const identity = descriptorIdentity(descriptor, `${code}_not_file`);
    if (!exactIdentity(liveIdentity, readFileIdentity(liveDbPath))) {
      refuse("live_db_identity_changed_before_json_read");
    }
    if (aliasesIdentity(liveIdentity, identity)) refuse(`${code}_aliases_live_db`);
    testHooks.onJsonDescriptorRead?.(code, resolved);
    bytes = readDescriptorBytes(descriptor, identity, code);
  } finally {
    fs.closeSync(descriptor);
  }
  if (sha256Bytes(bytes) !== expectedSha256) refuse(`${code}_sha256_mismatch`);
  try {
    return { path: resolved, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    refuse(`${code}_invalid_json`);
  }
}

function lstatExists(inputPath: string): boolean {
  try {
    fs.lstatSync(inputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeOutputLeaf(fileName: string): boolean {
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    /[<>:"/\\|?*]/u.test(fileName) ||
    /[. ]$/u.test(fileName)
  ) {
    return false;
  }
  const stem = fileName.split(".", 1)[0] ?? "";
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem);
}

function approvedOutputPath(
  approvedStatePath: string,
  outputPath: string,
  existingCode: string,
): string {
  if (outputPath.length === 0) refuse("output_path_invalid");
  const leaf = path.basename(outputPath);
  if (!safeOutputLeaf(leaf)) refuse("output_leaf_unsafe");
  const parent = path.dirname(path.resolve(outputPath));
  const resolvedParent = existingDirectory(parent, "output_parent_invalid");
  if (!samePath(resolvedParent, approvedStatePath)) refuse("output_not_direct_state_child");
  const resolvedOutput = path.join(resolvedParent, leaf);
  if (lstatExists(resolvedOutput)) refuse(existingCode);
  return resolvedOutput;
}

function assertExactRepositoryMap(
  approved: readonly ApprovedRepoMapEntry[],
  actual: readonly ApprovedRepoMapEntry[],
): void {
  if (approved.length !== actual.length) refuse("repository_map_content_mismatch");
  const byWorkspace = new Map(actual.map((entry) => [entry.workspaceId, entry]));
  for (const entry of approved) {
    const found = byWorkspace.get(entry.workspaceId);
    if (
      found === undefined ||
      found.owner !== entry.owner ||
      found.repo !== entry.repo ||
      found.reportAlias !== entry.reportAlias
    ) {
      refuse("repository_map_content_mismatch");
    }
  }
}

/**
 * Load the exact approval/preparation bundle without opening or reading the live database.
 * Only the approved scratch database is opened, read-only and with SQLite query_only enabled.
 */
export async function loadApprovedEvidenceInput(
  input: ApprovedEvidenceInput,
  testHooks: ApprovedEvidenceTestHooks = {},
): Promise<LoadedApprovedEvidenceInput> {
  const repositoryRoot = existingDirectory(input.repositoryRoot, "repository_root_invalid");
  const liveDbPath = existingFile(input.liveDbPath, "live_db_path_unknown");
  const liveIdentity = readFileIdentity(liveDbPath);
  const scratchDbPath = existingFile(input.scratchDbPath, "scratch_db_missing_or_not_file");
  const scratchStatePath = existingDirectory(
    input.scratchStatePath,
    "scratch_state_missing_or_not_directory",
  );
  const repoMapPath = existingFile(input.repoMapPath, "repository_map_missing_or_not_file");

  if (
    within(repositoryRoot, scratchDbPath) ||
    within(repositoryRoot, scratchStatePath) ||
    within(repositoryRoot, repoMapPath)
  ) {
    refuse("approved_artifact_inside_repository");
  }
  if (!samePath(path.dirname(repoMapPath), scratchStatePath)) {
    refuse("repository_map_not_direct_state_child");
  }
  if (samePath(liveDbPath, scratchDbPath)) refuse("scratch_aliases_live_db");
  const scratchIdentity = readFileIdentity(scratchDbPath);
  if (aliasesIdentity(liveIdentity, scratchIdentity)) refuse("scratch_aliases_live_db");

  const approvalRead = readDigestBoundJson(
    input.approvalManifestPath,
    input.approvalManifestSha256,
    "approval_manifest",
    liveDbPath,
    liveIdentity,
    testHooks,
  );
  const preparationRead = readDigestBoundJson(
    input.preparationManifestPath,
    input.preparationManifestSha256,
    "preparation_manifest",
    liveDbPath,
    liveIdentity,
    testHooks,
  );
  const repoMapRead = readDigestBoundJson(
    repoMapPath,
    input.repoMapSha256,
    "repository_map",
    liveDbPath,
    liveIdentity,
    testHooks,
  );
  const approval = parseApproval(approvalRead.value);
  const preparation = parsePreparation(preparationRead.value);
  const repositories = parseRepositoryMap(repoMapRead.value);

  if (within(repositoryRoot, approvalRead.path) || within(repositoryRoot, preparationRead.path)) {
    refuse("approved_artifact_inside_repository");
  }
  if (
    !samePath(path.dirname(preparationRead.path), scratchStatePath) ||
    path.basename(preparationRead.path) !== "preparation-manifest.json"
  ) {
    refuse("preparation_manifest_not_direct_state_child");
  }
  if (path.basename(repoMapPath) !== preparation.repositoryMap.file) {
    refuse("repository_map_file_binding_mismatch");
  }

  if (
    !samePath(
      liveDbPath,
      existingFile(approval.sourceDbPath, "approval_source_path_unresolvable"),
    ) ||
    !samePath(
      liveDbPath,
      existingFile(preparation.source.path, "preparation_source_path_unresolvable"),
    ) ||
    !samePath(
      scratchDbPath,
      existingFile(approval.scratchDbPath, "approval_scratch_path_unresolvable"),
    ) ||
    !samePath(
      scratchDbPath,
      existingFile(preparation.scratch.path, "preparation_scratch_path_unresolvable"),
    ) ||
    !samePath(
      scratchStatePath,
      existingDirectory(approval.scratchStatePath, "approval_state_path_unresolvable"),
    ) ||
    !samePath(
      scratchStatePath,
      existingDirectory(preparation.state.path, "preparation_state_path_unresolvable"),
    )
  ) {
    refuse("approved_path_binding_mismatch");
  }
  if (!exactIdentity(liveIdentity, preparation.source.identity)) {
    refuse("live_db_identity_mismatch");
  }
  if (!exactIdentity(scratchIdentity, preparation.scratch.identity)) {
    refuse("scratch_db_identity_mismatch");
  }
  if (
    preparation.approval.sha256 !== input.approvalManifestSha256 ||
    preparation.scratch.sha256 !== input.scratchDbSha256 ||
    preparation.repositoryMap.sha256 !== input.repoMapSha256
  ) {
    refuse("preparation_digest_binding_mismatch");
  }
  if (preparation.repositoryMap.mappedWorkspaceN !== repositories.length) {
    refuse("repository_map_count_mismatch");
  }
  assertExactRepositoryMap(approval.repositories, repositories);

  if (!SHA256_RE.test(input.scratchDbSha256)) refuse("scratch_db_sha256_invalid");
  const scratchVerificationPath = approvedOutputPath(
    scratchStatePath,
    input.scratchVerificationPath,
    "scratch_verification_already_exists",
  );
  const scratchDescriptor = fs.openSync(scratchDbPath, "r");
  let verificationDescriptor: number | undefined;
  let verificationIdentity: FileIdentity | undefined;
  let scratchVerificationPublished = false;
  try {
    const openedScratchIdentity = descriptorIdentity(
      scratchDescriptor,
      "scratch_db_missing_or_not_file",
    );
    if (aliasesIdentity(liveIdentity, openedScratchIdentity)) refuse("scratch_aliases_live_db");
    if (!exactIdentity(scratchIdentity, openedScratchIdentity)) {
      refuse("scratch_db_identity_changed_before_verification");
    }
    testHooks.beforeScratchVerificationLink?.();
    try {
      fs.linkSync(scratchDbPath, scratchVerificationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        refuse("scratch_verification_already_exists");
      }
      refuse("scratch_verification_publish_failed");
    }
    scratchVerificationPublished = true;
    testHooks.afterScratchVerificationLink?.();
    testHooks.beforeScratchVerificationOpen?.();
    try {
      verificationDescriptor = fs.openSync(scratchVerificationPath, "r");
    } catch {
      refuse("scratch_verification_open_failed");
    }
    verificationIdentity = descriptorIdentity(
      verificationDescriptor,
      "scratch_verification_not_file",
    );
    if (
      aliasesIdentity(liveIdentity, verificationIdentity) ||
      !exactIdentity(openedScratchIdentity, verificationIdentity) ||
      !exactIdentity(
        openedScratchIdentity,
        descriptorIdentity(scratchDescriptor, "scratch_db_changed_before_verification"),
      )
    ) {
      refuse("scratch_verification_identity_mismatch");
    }
    const snapshotBytes = readDescriptorBytes(
      scratchDescriptor,
      openedScratchIdentity,
      "scratch_snapshot",
    );
    const snapshotSha256 = sha256Bytes(snapshotBytes);
    if (snapshotSha256 !== input.scratchDbSha256) {
      refuse("scratch_db_sha256_mismatch");
    }
    const openVerifiedScratchDb = queryOnlySnapshotFactory(snapshotBytes);
    testHooks.beforeSnapshotIntegrity?.();
    let scratch: Database.Database | undefined;
    try {
      scratch = openVerifiedScratchDb();
      assertDatabaseIntegrity(scratch);
      testHooks.afterSnapshotIntegrity?.();
    } catch (error) {
      if (error instanceof EvidenceBoundaryError) throw error;
      refuse("scratch_db_integrity_failed");
    } finally {
      scratch?.close();
    }
    if (!exactIdentity(readFileIdentity(liveDbPath), liveIdentity)) {
      refuse("live_db_identity_changed_during_verification");
    }
    if (
      !exactIdentity(
        lstatFileIdentity(scratchVerificationPath, "scratch_verification_leaf_invalid"),
        verificationIdentity,
      )
    ) {
      refuse("scratch_verification_identity_changed");
    }

    return {
      approvalManifestPath: approvalRead.path,
      approvalManifestSha256: input.approvalManifestSha256,
      preparationManifestPath: preparationRead.path,
      preparationManifestSha256: input.preparationManifestSha256,
      approvedScratchDbPath: scratchDbPath,
      scratchDbSha256: input.scratchDbSha256,
      scratchVerificationPath,
      scratchStatePath,
      repoMapPath,
      repoMapSha256: input.repoMapSha256,
      liveDbPath,
      repositoryRoot,
      repositories,
      openVerifiedScratchDb,
    };
  } catch (error) {
    if (!scratchVerificationPublished) throw error;
    const code =
      error instanceof EvidenceBoundaryError
        ? error.code
        : "scratch_verification_unexpected_failure";
    throw new EvidenceBoundaryError(`${code}_scratch_verification_retained`);
  } finally {
    let closeFailed = false;
    try {
      if (verificationDescriptor !== undefined) fs.closeSync(verificationDescriptor);
    } catch {
      closeFailed = true;
    }
    try {
      fs.closeSync(scratchDescriptor);
    } catch {
      closeFailed = true;
    }
    if (closeFailed) {
      refuse(
        scratchVerificationPublished
          ? "scratch_descriptor_close_failed_scratch_verification_retained"
          : "scratch_descriptor_close_failed",
      );
    }
  }
}

/** Atomically create and verify one new private artifact. A failed partial is retained for manual cleanup. */
export function publishApprovedOutput(
  approved: Pick<LoadedApprovedEvidenceInput, "scratchStatePath">,
  outputPath: string,
  value: string | Buffer,
  testHooks: ApprovedOutputTestHooks = {},
): ApprovedOutputPublication {
  const resolvedOutput = approvedOutputPath(
    approved.scratchStatePath,
    outputPath,
    "output_already_exists",
  );
  const expectedBytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const expectedSha256 = sha256Bytes(expectedBytes);
  const temporaryPath = path.join(
    approved.scratchStatePath,
    `.evidence-output-${randomUUID()}.tmp`,
  );
  let temporaryDescriptor: number | undefined;
  try {
    temporaryDescriptor = fs.openSync(temporaryPath, "wx+", 0o600);
  } catch {
    refuse("output_temporary_create_failed");
  }
  let publishedDescriptor: number | undefined;
  let outputPublished = false;
  try {
    fs.writeFileSync(temporaryDescriptor, expectedBytes);
    fs.fsyncSync(temporaryDescriptor);
    const identity = descriptorIdentity(temporaryDescriptor, "output_temporary_not_file");
    const temporaryBytes = readDescriptorBytes(temporaryDescriptor, identity, "output_temporary");
    if (sha256Bytes(temporaryBytes) !== expectedSha256) {
      refuse("output_temporary_digest_mismatch");
    }
    testHooks.beforePublishLink?.(temporaryPath, resolvedOutput);
    try {
      fs.linkSync(temporaryPath, resolvedOutput);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("output_already_exists");
      refuse("output_publish_failed");
    }
    outputPublished = true;
    testHooks.afterPublishLink?.(temporaryPath, resolvedOutput);
    publishedDescriptor = fs.openSync(resolvedOutput, "r");
    const publishedIdentity = descriptorIdentity(publishedDescriptor, "output_not_file");
    if (!exactIdentity(identity, publishedIdentity)) {
      refuse("output_identity_mismatch");
    }
    const publishedBytes = readDescriptorBytes(
      publishedDescriptor,
      publishedIdentity,
      "output_published",
    );
    if (sha256Bytes(publishedBytes) !== expectedSha256) {
      refuse("output_digest_mismatch");
    }
    if (
      !exactIdentity(lstatFileIdentity(resolvedOutput, "output_leaf_changed"), publishedIdentity)
    ) {
      refuse("output_identity_changed");
    }
    fs.closeSync(publishedDescriptor);
    publishedDescriptor = undefined;
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    fs.unlinkSync(temporaryPath);
    return { path: resolvedOutput, sha256: expectedSha256, identity: publishedIdentity };
  } catch (error) {
    const code = error instanceof EvidenceBoundaryError ? error.code : "output_unexpected_failure";
    return refuse(
      `${code}_${outputPublished ? "temporary_and_output_retained" : "temporary_retained"}`,
    );
  } finally {
    let closeFailed = false;
    try {
      if (publishedDescriptor !== undefined) fs.closeSync(publishedDescriptor);
    } catch {
      closeFailed = true;
    }
    try {
      if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    } catch {
      closeFailed = true;
    }
    if (closeFailed) {
      refuse(
        `output_descriptor_close_failed_${outputPublished ? "temporary_and_output_retained" : "temporary_retained"}`,
      );
    }
  }
}
