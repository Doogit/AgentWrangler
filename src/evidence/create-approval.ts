import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EvidenceBoundaryError,
  assertScratchBoundary,
  resolveProspectivePath,
} from "./common/boundary.js";
import { canonicalJson, sha256Bytes } from "./common/canonical.js";
import {
  type ApprovedRepoMapEntry,
  SCRATCH_APPROVAL_VERSION,
  type ScratchApprovalManifest,
} from "./create-scratch.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SAFE_REPORT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const PROTOTYPE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export interface BuildScratchApprovalInput {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  repositories: unknown;
  privateArtifactParentAcknowledged: boolean;
}

export interface CreateScratchApprovalInput {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  repositoriesJson: string;
  outputPath: string;
  privateArtifactParentAcknowledged: boolean;
}

export interface CreateScratchApprovalResult {
  sha256: string;
  mappedWorkspaceN: number;
}

export interface CreateScratchApprovalOptions {
  repositoryRoot?: string;
  /** Test-only race seam. The production CLI never supplies hooks. */
  testHooks?: {
    beforePublish?: (outputPath: string, temporaryPath: string) => void | Promise<void>;
    afterPublishedRead?: (outputPath: string) => void | Promise<void>;
  };
}

function refuse(code: string): never {
  throw new EvidenceBoundaryError(code);
}

function refuseRetained(code: string, artifacts: "candidate" | "output_and_candidate"): never {
  refuse(`${code}_${artifacts}_retained`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
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

function nonemptyString(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    refuse(code);
  }
  return value;
}

function reportAlias(value: unknown): string {
  const parsed = nonemptyString(value, "approval_report_alias_invalid");
  if (
    !SAFE_REPORT_ALIAS.test(parsed) ||
    parsed.endsWith(".") ||
    parsed.includes("..") ||
    PROTOTYPE_NAMES.has(parsed)
  ) {
    refuse("approval_report_alias_invalid");
  }
  return parsed;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseRepositories(value: unknown): ApprovedRepoMapEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    refuse("approval_repository_allowlist_invalid");
  }
  const workspaceIds = new Set<string>();
  const reportAliases = new Set<string>();
  const canonicalRepositories = new Set<string>();
  const repositories = value.map((entry) => {
    if (!isPlainRecord(entry)) refuse("approval_repository_invalid");
    assertExactKeys(
      entry,
      ["workspaceId", "owner", "repo", "reportAlias"],
      "approval_repository_unknown_or_missing_key",
    );
    const parsed: ApprovedRepoMapEntry = {
      workspaceId: nonemptyString(entry.workspaceId, "approval_workspace_id_invalid"),
      owner: nonemptyString(entry.owner, "approval_owner_invalid"),
      repo: nonemptyString(entry.repo, "approval_repo_invalid"),
      reportAlias: reportAlias(entry.reportAlias),
    };
    if (workspaceIds.has(parsed.workspaceId)) refuse("approval_workspace_duplicate");
    if (reportAliases.has(parsed.reportAlias)) refuse("approval_report_alias_duplicate");
    const canonicalRepository = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
    if (canonicalRepositories.has(canonicalRepository)) refuse("approval_repository_duplicate");
    workspaceIds.add(parsed.workspaceId);
    reportAliases.add(parsed.reportAlias);
    canonicalRepositories.add(canonicalRepository);
    return parsed;
  });
  return repositories.sort((left, right) => binaryCompare(left.workspaceId, right.workspaceId));
}

/** Build the exact v1 approval shape without filesystem, database, GitHub, or transcript access. */
export function buildScratchApprovalManifest(
  input: BuildScratchApprovalInput,
): ScratchApprovalManifest {
  if (input.privateArtifactParentAcknowledged !== true) {
    refuse("private_artifact_parent_not_acknowledged");
  }
  return {
    version: SCRATCH_APPROVAL_VERSION,
    sourceDbPath: nonemptyString(input.sourceDbPath, "approval_source_path_invalid"),
    scratchDbPath: nonemptyString(input.scratchDbPath, "approval_scratch_path_invalid"),
    scratchStatePath: nonemptyString(input.scratchStatePath, "approval_state_path_invalid"),
    repositories: parseRepositories(input.repositories),
    privateArtifactParentAcknowledged: true,
  };
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseRepositoriesJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    refuse("approval_repositories_json_invalid");
  }
}

function resolveOutputPath(outputPath: string, repositoryRoot: string): string {
  if (outputPath.length === 0) refuse("approval_output_path_invalid");
  const resolved = resolveProspectivePath(outputPath);
  if (isWithin(repositoryRoot, resolved)) refuse("approval_output_inside_repository");
  if (fs.existsSync(resolved)) refuse("approval_output_already_exists");
  const parent = path.dirname(resolved);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    refuse("approval_output_parent_missing");
  }
  if (!parentStat.isDirectory()) refuse("approval_output_parent_not_directory");
  return resolved;
}

async function publishNoReplace(
  outputPath: string,
  bytes: string,
  beforePublish?: (outputPath: string, temporaryPath: string) => void | Promise<void>,
  afterPublishedRead?: (outputPath: string) => void | Promise<void>,
): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.candidate`,
  );
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, bytes, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } catch {
      refuseRetained("approval_output_write_or_fsync_failed", "candidate");
    }

    const temporaryIdentity = fileDescriptorIdentity(
      descriptor,
      "approval_output_temporary_identity_failed",
      "candidate",
    );
    await beforePublish?.(outputPath, temporaryPath);
    try {
      fs.linkSync(temporaryPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        refuseRetained("approval_output_race_lost", "candidate");
      }
      refuseRetained("approval_output_publish_failed", "candidate");
    }

    await verifyPublishedOutput(outputPath, temporaryIdentity, bytes, afterPublishedRead);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      const outputExists = fs.existsSync(outputPath);
      refuseRetained(
        "approval_output_close_failed",
        outputExists ? "output_and_candidate" : "candidate",
      );
    }
    throw error;
  }

  try {
    fs.closeSync(descriptor);
  } catch {
    refuseRetained("approval_output_close_failed", "output_and_candidate");
  }
  try {
    fs.unlinkSync(temporaryPath);
  } catch {
    refuseRetained("approval_output_unlink_failed", "output_and_candidate");
  }
  return sha256Bytes(bytes);
}

interface DescriptorIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
}

function fileDescriptorIdentity(
  descriptor: number,
  failure: string,
  artifacts: "candidate" | "output_and_candidate",
): DescriptorIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.fstatSync(descriptor, { bigint: true });
  } catch {
    refuseRetained(failure, artifacts);
  }
  if (!stat.isFile() || stat.ino === 0n) refuseRetained(failure, artifacts);
  return { device: stat.dev, inode: stat.ino, size: stat.size };
}

function sameDescriptorIdentity(left: DescriptorIdentity, right: DescriptorIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

async function verifyPublishedOutput(
  outputPath: string,
  temporaryIdentity: DescriptorIdentity,
  bytes: string,
  afterPublishedRead?: (outputPath: string) => void | Promise<void>,
): Promise<void> {
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(outputPath, { bigint: true });
  } catch {
    refuseRetained("approval_output_lstat_failed", "output_and_candidate");
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    refuseRetained("approval_output_not_regular_file", "output_and_candidate");
  }

  let publishedDescriptor: number;
  try {
    publishedDescriptor = fs.openSync(outputPath, "r");
  } catch {
    refuseRetained("approval_output_open_failed", "output_and_candidate");
  }
  try {
    const publishedIdentity = fileDescriptorIdentity(
      publishedDescriptor,
      "approval_output_identity_failed",
      "output_and_candidate",
    );
    const pathIdentity: DescriptorIdentity = {
      device: pathStat.dev,
      inode: pathStat.ino,
      size: pathStat.size,
    };
    if (
      !sameDescriptorIdentity(temporaryIdentity, pathIdentity) ||
      !sameDescriptorIdentity(temporaryIdentity, publishedIdentity)
    ) {
      refuseRetained("approval_output_identity_mismatch", "output_and_candidate");
    }
    const expected = Buffer.from(bytes, "utf8");
    let published: Buffer;
    try {
      published = fs.readFileSync(publishedDescriptor);
    } catch {
      refuseRetained("approval_output_verify_failed", "output_and_candidate");
    }
    if (!published.equals(expected) || sha256Bytes(published) !== sha256Bytes(expected)) {
      refuseRetained("approval_output_verify_mismatch", "output_and_candidate");
    }
    await afterPublishedRead?.(outputPath);
    let finalPathStat: fs.BigIntStats;
    try {
      finalPathStat = fs.lstatSync(outputPath, { bigint: true });
    } catch {
      refuseRetained("approval_output_final_lstat_failed", "output_and_candidate");
    }
    const finalPathIdentity: DescriptorIdentity = {
      device: finalPathStat.dev,
      inode: finalPathStat.ino,
      size: finalPathStat.size,
    };
    if (
      !finalPathStat.isFile() ||
      finalPathStat.isSymbolicLink() ||
      !sameDescriptorIdentity(temporaryIdentity, finalPathIdentity) ||
      !sameDescriptorIdentity(publishedIdentity, finalPathIdentity)
    ) {
      refuseRetained("approval_output_final_identity_mismatch", "output_and_candidate");
    }
  } finally {
    try {
      fs.closeSync(publishedDescriptor);
    } catch {
      refuseRetained("approval_output_close_failed", "output_and_candidate");
    }
  }
}

export function parseCreateScratchApprovalArgs(
  args: readonly string[],
): CreateScratchApprovalInput {
  const valueFlags = new Set([
    "--source-db",
    "--scratch-db",
    "--scratch-state",
    "--repositories",
    "--out",
  ]);
  const values = new Map<string, string>();
  let acknowledged = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--acknowledge-private-parent") {
      if (acknowledged) refuse("duplicate_cli_argument");
      acknowledged = true;
      continue;
    }
    if (flag === undefined || !valueFlags.has(flag)) refuse("unknown_cli_argument");
    if (values.has(flag)) refuse("duplicate_cli_argument");
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      refuse("missing_cli_value");
    }
    values.set(flag, value);
    index += 1;
  }
  const sourceDbPath = values.get("--source-db");
  const scratchDbPath = values.get("--scratch-db");
  const scratchStatePath = values.get("--scratch-state");
  const repositoriesJson = values.get("--repositories");
  const outputPath = values.get("--out");
  if (
    sourceDbPath === undefined ||
    scratchDbPath === undefined ||
    scratchStatePath === undefined ||
    repositoriesJson === undefined ||
    outputPath === undefined
  ) {
    refuse("missing_required_cli_argument");
  }
  if (!acknowledged) refuse("private_artifact_parent_not_acknowledged");
  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    repositoriesJson,
    outputPath,
    privateArtifactParentAcknowledged: true,
  };
}

export async function createScratchApprovalCandidate(
  input: CreateScratchApprovalInput,
  options: CreateScratchApprovalOptions = {},
): Promise<CreateScratchApprovalResult> {
  const repositoryRoot = fs.realpathSync.native(options.repositoryRoot ?? REPOSITORY_ROOT);
  const boundary = assertScratchBoundary({
    sourceDbPath: input.sourceDbPath,
    scratchDbPath: input.scratchDbPath,
    scratchStatePath: input.scratchStatePath,
    repositoryRoot,
  });
  const outputPath = resolveOutputPath(input.outputPath, repositoryRoot);
  if (
    comparisonPath(outputPath) === comparisonPath(boundary.sourceDbPath) ||
    comparisonPath(outputPath) === comparisonPath(boundary.scratchDbPath) ||
    isWithin(boundary.scratchStatePath, outputPath) ||
    isWithin(outputPath, boundary.scratchStatePath)
  ) {
    refuse("approval_output_overlaps_evidence_path");
  }
  const manifest = buildScratchApprovalManifest({
    sourceDbPath: boundary.sourceDbPath,
    scratchDbPath: boundary.scratchDbPath,
    scratchStatePath: boundary.scratchStatePath,
    repositories: parseRepositoriesJson(input.repositoriesJson),
    privateArtifactParentAcknowledged: input.privateArtifactParentAcknowledged,
  });
  const bytes = `${canonicalJson(manifest)}\n`;
  const sha256 = await publishNoReplace(
    outputPath,
    bytes,
    options.testHooks?.beforePublish,
    options.testHooks?.afterPublishedRead,
  );
  return { sha256, mappedWorkspaceN: manifest.repositories.length };
}

async function main(): Promise<void> {
  try {
    const result = await createScratchApprovalCandidate(
      parseCreateScratchApprovalArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `${canonicalJson({
        status: "CANDIDATE_CONFIRMATION_REQUIRED",
        sha256: result.sha256,
        mappedWorkspaceN: result.mappedWorkspaceN,
      })}\n`,
    );
  } catch (error) {
    const failure = error instanceof EvidenceBoundaryError ? error.code : "unexpected_failure";
    process.stderr.write(`${canonicalJson({ status: "REFUSED", failure })}\n`);
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
