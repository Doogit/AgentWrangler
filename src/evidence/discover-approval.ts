import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EvidenceBoundaryError, readFileIdentity } from "./common/boundary.js";
import { canonicalJson } from "./common/canonical.js";
import { openQueryOnlyDb } from "./common/sqlite.js";
import { createScratchApprovalCandidate } from "./create-approval.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const PATH_SLUG_SUGGESTION_VERSION = "claude-path-slug-suggestion-v1" as const;
const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export interface DiscoverApprovalInput {
  sourceDbPath: string;
  scratchDbPath: string;
  scratchStatePath: string;
  searchRoots: readonly string[];
  outputPath: string;
  privateArtifactParentAcknowledged: true;
  maxEntries: number;
}

export interface DiscoverApprovalResult {
  suggestionHeuristicVersion: typeof PATH_SLUG_SUGGESTION_VERSION;
  sha256: string;
  mappedWorkspaceN: number;
  existingMappingN: number;
  suggestedMappingN: number;
  unresolvedWorkspaceN: number;
  reasonCounts: Record<string, number>;
}

export interface DiscoverApprovalOptions {
  repositoryRoot?: string;
  /** Test-only race seams. The production CLI never supplies hooks. */
  testHooks?: {
    beforeVisitDirectory?: (queuedPath: string) => void;
    beforeCandidatePublication?: () => void | Promise<void>;
    afterCandidatePublication?: () => void | Promise<void>;
  };
}

interface WorkspaceRow {
  workspaceId: string;
  projectSlug: string;
  repoPath: string | null;
  owner: string | null;
  repo: string | null;
}

interface LocalRepository {
  root: string;
  encodedRoot: string;
  identity?: { owner: string; repo: string };
  reason?: string;
}

function refuse(code: string): never {
  throw new EvidenceBoundaryError(code);
}

/** Experimental, collision-prone heuristic for confirmation-only proposal matching. */
export function encodeCheckoutRootSuggestion(canonicalCheckoutRoot: string): string {
  return canonicalCheckoutRoot.replace(/[^A-Za-z0-9-]/gu, "-");
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function exactIdentity(
  left: ReturnType<typeof readFileIdentity>,
  right: ReturnType<typeof readFileIdentity>,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size;
}

function sourceMetadataUnchanged(
  sourceDbPath: string,
  expectedIdentity: ReturnType<typeof readFileIdentity>,
  expectedRows: readonly WorkspaceRow[],
): boolean {
  try {
    return (
      exactIdentity(expectedIdentity, readFileIdentity(sourceDbPath)) &&
      canonicalJson(expectedRows) === canonicalJson(readWorkspaces(sourceDbPath))
    );
  } catch {
    return false;
  }
}

function readWorkspaces(sourceDbPath: string): WorkspaceRow[] {
  const db = openQueryOnlyDb(sourceDbPath);
  try {
    const rows = db
      .prepare(
        `SELECT workspace_id, project_slug, repo_path, repo_owner, repo_name
           FROM workspaces
          ORDER BY workspace_id COLLATE BINARY`,
      )
      .all() as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    return rows.map((row) => {
      if (
        typeof row.workspace_id !== "string" ||
        row.workspace_id.length === 0 ||
        typeof row.project_slug !== "string" ||
        row.project_slug.length === 0 ||
        (row.repo_path !== null && typeof row.repo_path !== "string")
      ) {
        refuse("discovery_workspace_row_invalid");
      }
      if (seen.has(row.workspace_id)) refuse("discovery_workspace_duplicate");
      seen.add(row.workspace_id);
      const ownerMissing = row.repo_owner === null;
      const repoMissing = row.repo_name === null;
      if (ownerMissing !== repoMissing) refuse("discovery_partial_repository_mapping");
      if (
        (!ownerMissing && (typeof row.repo_owner !== "string" || row.repo_owner.length === 0)) ||
        (!repoMissing && (typeof row.repo_name !== "string" || row.repo_name.length === 0))
      ) {
        refuse("discovery_repository_mapping_invalid");
      }
      return {
        workspaceId: row.workspace_id,
        projectSlug: row.project_slug,
        repoPath: row.repo_path as string | null,
        owner: row.repo_owner as string | null,
        repo: row.repo_name as string | null,
      };
    });
  } finally {
    db.close();
  }
}

function gitConfigPath(checkoutRoot: string): string | undefined {
  const dotGit = path.join(checkoutRoot, ".git");
  const stat = fs.lstatSync(dotGit);
  if (stat.isSymbolicLink()) return undefined;
  if (stat.isDirectory()) return path.join(dotGit, "config");
  return undefined;
}

function parseGitHubOrigin(
  value: string,
): { identity: { owner: string; repo: string } } | { reason: string } {
  let owner: string | undefined;
  let repo: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/(.+)$/iu.exec(value);
  if (scp !== null) {
    owner = scp[1];
    repo = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { reason: "origin_malformed" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
      return { reason: "origin_unsupported" };
    }
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.port !== "") {
      return { reason: "origin_non_github" };
    }
    if (parsed.search !== "" || parsed.hash !== "") return { reason: "origin_malformed" };
    if (parsed.password !== "" || (parsed.protocol === "https:" && parsed.username !== "")) {
      return { reason: "origin_credentials_present" };
    }
    if (parsed.protocol === "ssh:" && parsed.username !== "git") {
      return { reason: "origin_malformed" };
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return { reason: "origin_malformed" };
    [owner, repo] = segments;
  }
  repo = repo?.replace(/\.git$/u, "");
  const component = /^[A-Za-z0-9_.-]+$/u;
  if (
    owner === undefined ||
    repo === undefined ||
    !component.test(owner) ||
    !component.test(repo) ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    return { reason: "origin_malformed" };
  }
  return { identity: { owner, repo } };
}

function readLocalOrigin(checkoutRoot: string): Omit<LocalRepository, "root" | "encodedRoot"> {
  let configPath: string | undefined;
  let descriptor: number | undefined;
  let configBytes: string;
  try {
    configPath = gitConfigPath(checkoutRoot);
    if (configPath === undefined) return { reason: "git_metadata_unsafe" };
    const unresolvedStat = fs.lstatSync(configPath);
    if (!unresolvedStat.isFile() || unresolvedStat.isSymbolicLink()) {
      return { reason: "git_config_unsafe" };
    }
    const resolvedConfig = fs.realpathSync.native(configPath);
    const relative = path.relative(checkoutRoot, resolvedConfig);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { reason: "git_config_unsafe" };
    }
    const pathStat = fs.lstatSync(resolvedConfig, { bigint: true });
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size > BigInt(MAX_CONFIG_BYTES)
    ) {
      return { reason: "git_config_unsafe" };
    }
    descriptor = fs.openSync(configPath, fs.constants.O_RDONLY);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathStat.dev ||
      before.ino === 0n ||
      before.ino !== pathStat.ino ||
      before.size !== pathStat.size
    ) {
      throw new Error("git_config_identity_changed");
    }
    configBytes = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("git_config_identity_changed");
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The aggregate refusal reason remains the same.
      }
    }
    return { reason: "git_metadata_unreadable" };
  }
  let section = "";
  const origins: string[] = [];
  for (const rawLine of configBytes.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading?.[1] !== undefined) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (section !== 'remote "origin"') continue;
    const value = /^url\s*=\s*(.+)$/iu.exec(line)?.[1];
    if (value !== undefined) origins.push(value.trim());
  }
  if (origins.length === 0) return { reason: "origin_missing" };
  if (origins.length !== 1) return { reason: "origin_ambiguous" };
  return parseGitHubOrigin(origins[0] as string);
}

function enumerateLocalRepositories(
  searchRoots: readonly string[],
  maxEntries: number,
  beforeVisitDirectory?: (queuedPath: string) => void,
): LocalRepository[] {
  if (searchRoots.length === 0) refuse("discovery_search_root_required");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) refuse("discovery_max_entries_invalid");
  const pending: string[] = [];
  const roots = new Set<string>();
  for (const candidate of searchRoots) {
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(candidate);
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("discovery_search_root_unsafe");
    } catch (error) {
      if (error instanceof EvidenceBoundaryError) throw error;
      refuse("discovery_search_root_unreadable");
    }
    if (roots.has(resolved)) refuse("discovery_search_root_duplicate");
    roots.add(resolved);
    pending.push(resolved);
  }
  const orderedRoots = [...roots].sort(binaryCompare);
  for (let index = 0; index < orderedRoots.length; index += 1) {
    for (let other = index + 1; other < orderedRoots.length; other += 1) {
      const relative = path.relative(orderedRoots[index] as string, orderedRoots[other] as string);
      if (relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..") {
        refuse("discovery_search_roots_overlap");
      }
    }
  }
  pending.sort(binaryCompare).reverse();
  const repositories: LocalRepository[] = [];
  const visited = new Set<string>();
  let visitedEntries = 0;
  while (pending.length > 0) {
    const queued = pending.pop() as string;
    beforeVisitDirectory?.(queued);
    let current: string;
    try {
      const queuedStat = fs.lstatSync(queued, { bigint: true });
      if (!queuedStat.isDirectory() || queuedStat.isSymbolicLink()) continue;
      current = fs.realpathSync.native(queued);
      const canonicalStat = fs.lstatSync(current, { bigint: true });
      if (
        !canonicalStat.isDirectory() ||
        canonicalStat.isSymbolicLink() ||
        queuedStat.dev !== canonicalStat.dev ||
        queuedStat.ino === 0n ||
        queuedStat.ino !== canonicalStat.ino
      ) {
        continue;
      }
      const contained = orderedRoots.some((root) => {
        const relative = path.relative(root, current);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
      });
      if (!contained || visited.has(current)) continue;
      visited.add(current);
    } catch {
      continue;
    }
    const dotGit = path.join(current, ".git");
    if (fs.existsSync(dotGit)) {
      let canonical: string;
      let before: fs.BigIntStats;
      try {
        before = fs.lstatSync(current, { bigint: true });
        canonical = fs.realpathSync.native(current);
        if (!before.isDirectory() || before.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const origin = readLocalOrigin(canonical);
      let identityStable = false;
      try {
        const after = fs.lstatSync(current, { bigint: true });
        identityStable =
          after.isDirectory() &&
          !after.isSymbolicLink() &&
          before.dev === after.dev &&
          before.ino !== 0n &&
          before.ino === after.ino &&
          fs.realpathSync.native(current) === canonical;
      } catch {
        identityStable = false;
      }
      repositories.push({
        root: canonical,
        encodedRoot: encodeCheckoutRootSuggestion(canonical),
        ...(identityStable ? origin : { reason: "checkout_identity_changed" }),
      });
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => binaryCompare(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxEntries) refuse("discovery_traversal_bound_exhausted");
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      pending.push(path.join(current, entry.name));
    }
    pending.sort(binaryCompare).reverse();
  }
  return repositories.sort((left, right) => binaryCompare(left.root, right.root));
}

export function parseDiscoverApprovalArgs(args: readonly string[]): DiscoverApprovalInput {
  const single = new Set([
    "--source-db",
    "--scratch-db",
    "--scratch-state",
    "--out",
    "--max-entries",
  ]);
  const values = new Map<string, string>();
  const searchRoots: string[] = [];
  let acknowledged = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--acknowledge-private-parent") {
      if (acknowledged) refuse("duplicate_cli_argument");
      acknowledged = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      refuse("missing_cli_value");
    }
    if (flag === "--search-root") searchRoots.push(value);
    else {
      if (flag === undefined || !single.has(flag)) refuse("unknown_cli_argument");
      if (values.has(flag)) refuse("duplicate_cli_argument");
      values.set(flag, value);
    }
    index += 1;
  }
  const sourceDbPath = values.get("--source-db");
  const scratchDbPath = values.get("--scratch-db");
  const scratchStatePath = values.get("--scratch-state");
  const outputPath = values.get("--out");
  if (
    sourceDbPath === undefined ||
    scratchDbPath === undefined ||
    scratchStatePath === undefined ||
    outputPath === undefined ||
    searchRoots.length === 0
  ) {
    refuse("missing_required_cli_argument");
  }
  if (!acknowledged) refuse("private_artifact_parent_not_acknowledged");
  const maxEntriesText = values.get("--max-entries") ?? String(DEFAULT_MAX_ENTRIES);
  if (!/^\d+$/u.test(maxEntriesText)) refuse("discovery_max_entries_invalid");
  return {
    sourceDbPath,
    scratchDbPath,
    scratchStatePath,
    searchRoots,
    outputPath,
    maxEntries: Number(maxEntriesText),
    privateArtifactParentAcknowledged: true,
  };
}

export async function discoverScratchApprovalCandidate(
  input: DiscoverApprovalInput,
  options: DiscoverApprovalOptions = {},
): Promise<DiscoverApprovalResult> {
  const sourceIdentityBefore = readFileIdentity(input.sourceDbPath);
  const workspaces = readWorkspaces(input.sourceDbPath);
  const repositories = enumerateLocalRepositories(
    input.searchRoots,
    input.maxEntries,
    options.testHooks?.beforeVisitDirectory,
  );
  const storedMatches = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    for (const value of new Set([workspace.workspaceId, workspace.projectSlug])) {
      const matches = storedMatches.get(value) ?? new Set<string>();
      matches.add(workspace.workspaceId);
      storedMatches.set(value, matches);
    }
  }
  const reasonCounts: Record<string, number> = {};
  const proposed: Array<{ workspaceId: string; owner: string; repo: string; reportAlias: string }> =
    [];
  let existingMappingN = 0;
  let suggestedMappingN = 0;
  let unresolvedWorkspaceN = 0;
  for (const workspace of workspaces) {
    if (workspace.owner !== null && workspace.repo !== null) {
      existingMappingN += 1;
      proposed.push({
        workspaceId: workspace.workspaceId,
        owner: workspace.owner,
        repo: workspace.repo,
        reportAlias: "",
      });
      continue;
    }
    const candidates = repositories.filter(
      (repository) =>
        repository.encodedRoot === workspace.workspaceId ||
        repository.encodedRoot === workspace.projectSlug,
    );
    const storedCollision = candidates.some(
      (candidate) => (storedMatches.get(candidate.encodedRoot)?.size ?? 0) > 1,
    );
    if (candidates.length !== 1 || storedCollision) {
      unresolvedWorkspaceN += 1;
      increment(
        reasonCounts,
        candidates.length === 0 ? "no_exact_path_match" : "path_encoding_collision",
      );
      continue;
    }
    const candidate = candidates[0] as LocalRepository;
    if (candidate.identity === undefined) {
      unresolvedWorkspaceN += 1;
      increment(reasonCounts, candidate.reason ?? "origin_unresolved");
      continue;
    }
    suggestedMappingN += 1;
    proposed.push({ workspaceId: workspace.workspaceId, ...candidate.identity, reportAlias: "" });
  }
  proposed.sort((left, right) => binaryCompare(left.workspaceId, right.workspaceId));
  proposed.forEach((entry, index) => {
    entry.reportAlias = `repo-${String(index + 1).padStart(3, "0")}`;
  });
  if (proposed.length === 0) refuse("discovery_no_repository_mappings");
  await options.testHooks?.beforeCandidatePublication?.();
  if (!sourceMetadataUnchanged(input.sourceDbPath, sourceIdentityBefore, workspaces)) {
    refuse("discovery_source_changed");
  }
  const candidate = await createScratchApprovalCandidate(
    {
      sourceDbPath: input.sourceDbPath,
      scratchDbPath: input.scratchDbPath,
      scratchStatePath: input.scratchStatePath,
      repositoriesJson: JSON.stringify(proposed),
      outputPath: input.outputPath,
      privateArtifactParentAcknowledged: true,
    },
    { repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT },
  );
  await options.testHooks?.afterCandidatePublication?.();
  if (!sourceMetadataUnchanged(input.sourceDbPath, sourceIdentityBefore, workspaces)) {
    refuse("discovery_source_changed_candidate_retained");
  }
  return {
    suggestionHeuristicVersion: PATH_SLUG_SUGGESTION_VERSION,
    sha256: candidate.sha256,
    mappedWorkspaceN: candidate.mappedWorkspaceN,
    existingMappingN,
    suggestedMappingN,
    unresolvedWorkspaceN,
    reasonCounts,
  };
}

async function main(): Promise<void> {
  try {
    const result = await discoverScratchApprovalCandidate(
      parseDiscoverApprovalArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `${canonicalJson({ status: "SUGGESTIONS_CONFIRMATION_REQUIRED", ...result })}\n`,
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
