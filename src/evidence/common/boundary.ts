import * as fs from "node:fs";
import * as path from "node:path";

export class EvidenceBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvidenceBoundaryError";
  }
}

export interface FileIdentity {
  device: string;
  inode: string;
  size: string;
}

export interface ScratchBoundaryInput {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  repositoryRoot: string;
}

export interface ResolvedScratchBoundary {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  repositoryRoot: string;
  sourceIdentity: FileIdentity;
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Resolve symlinks/junctions through the nearest existing ancestor of a future path. */
export function resolveProspectivePath(inputPath: string): string {
  let existing = path.resolve(inputPath);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new EvidenceBoundaryError("path_has_no_existing_ancestor");
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

export function readFileIdentity(filePath: string): FileIdentity {
  const stat = fs.statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new EvidenceBoundaryError("database_path_not_file");
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
  };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.inode !== "0" && left.device === right.device && left.inode === right.inode;
}

export function assertScratchBoundary(input: ScratchBoundaryInput): ResolvedScratchBoundary {
  if (
    input.sourceDbPath.length === 0 ||
    input.scratchDbPath.length === 0 ||
    input.scratchStatePath.length === 0
  ) {
    throw new EvidenceBoundaryError("empty_path");
  }

  if (!fs.existsSync(input.sourceDbPath)) throw new EvidenceBoundaryError("source_missing");
  const sourceDbPath = fs.realpathSync.native(input.sourceDbPath);
  const sourceIdentity = readFileIdentity(sourceDbPath);
  const repositoryRoot = fs.realpathSync.native(input.repositoryRoot);
  const scratchDbPath = resolveProspectivePath(input.scratchDbPath);
  const scratchStatePath = resolveProspectivePath(input.scratchStatePath);

  if (isWithin(repositoryRoot, scratchDbPath) || isWithin(repositoryRoot, scratchStatePath)) {
    throw new EvidenceBoundaryError("output_inside_repository");
  }
  if (comparisonPath(sourceDbPath) === comparisonPath(scratchDbPath)) {
    throw new EvidenceBoundaryError("scratch_aliases_source");
  }

  if (fs.existsSync(scratchDbPath)) {
    const targetIdentity = readFileIdentity(scratchDbPath);
    if (sameFileIdentity(sourceIdentity, targetIdentity)) {
      throw new EvidenceBoundaryError("scratch_aliases_source");
    }
    throw new EvidenceBoundaryError("scratch_already_exists");
  }
  if (fs.existsSync(scratchStatePath)) {
    throw new EvidenceBoundaryError("scratch_state_already_exists");
  }
  if (isWithin(scratchStatePath, scratchDbPath) || isWithin(scratchDbPath, scratchStatePath)) {
    throw new EvidenceBoundaryError("overlapping_output_paths");
  }

  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    repositoryRoot,
    sourceIdentity,
  };
}
