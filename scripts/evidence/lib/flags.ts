import * as os from "node:os";
import * as path from "node:path";

/** The 11 "COMMON" flag values required by every cond1 / d7-coverage command. */
export interface CommonFlagValues {
  approvalManifest: string;
  approvalSha256: string;
  scratchPreparationManifest: string;
  scratchPreparationSha256: string;
  scratchDb: string;
  approvedScratchDbSha256: string;
  repoMap: string;
  repoMapSha256: string;
  scratchState: string;
  scratchVerification: string;
  liveDb: string;
}

/**
 * Build the 11 COMMON flag pairs (22 items total) required by all
 * cond1 prepare / packet / score and d7-coverage commands.
 */
export function buildCommonFlagArray(v: CommonFlagValues): readonly string[] {
  return [
    "--approval-manifest",
    v.approvalManifest,
    "--approval-sha256",
    v.approvalSha256,
    "--scratch-preparation-manifest",
    v.scratchPreparationManifest,
    "--scratch-preparation-sha256",
    v.scratchPreparationSha256,
    "--scratch-db",
    v.scratchDb,
    "--approved-scratch-db-sha256",
    v.approvedScratchDbSha256,
    "--repo-map",
    v.repoMap,
    "--repo-map-sha256",
    v.repoMapSha256,
    "--scratch-state",
    v.scratchState,
    "--scratch-verification",
    v.scratchVerification,
    "--live-db",
    v.liveDb,
  ];
}

/** Generate a timestamped scratch-run identifier: "<prefix>-YYYYMMDD-HHmmss". */
export function scratchRunId(prefix: string, now: Date): string {
  const iso = now.toISOString(); // "2026-09-01T12:00:00.000Z"
  const datePart = iso.slice(0, 10).replace(/-/gu, ""); // "20260901"
  const timePart = iso.slice(11, 19).replace(/:/gu, ""); // "120000"
  return `${prefix}-${datePart}-${timePart}`;
}

/** All derived scratch paths for a single run (all inside runDir, outside the repo). */
export interface ScratchPathSet {
  runDir: string;
  scratchDb: string;
  scratchState: string;
  /** Verification path for the prepare command (must not exist before prepare runs). */
  verifyPrepare: string;
  /** Verification path for the packet command (must not exist before packet runs). */
  verifyPacket: string;
  /** Verification path for the score command (must not exist before score runs). */
  verifyScore: string;
  /** Verification path for d7-coverage (must not exist before coverage run). */
  verifyD7: string;
  /** Path to preparation-manifest.json inside scratchState. */
  preparationManifest: string;
  /** Path to repo-map.json inside scratchState. */
  repoMap: string;
}

/** Derive all scratch paths for a run under baseDir/runId. */
export function scratchPaths(baseDir: string, runId: string): ScratchPathSet {
  const runDir = path.join(baseDir, runId);
  const state = path.join(runDir, "state");
  return {
    runDir,
    scratchDb: path.join(runDir, "scratch.sqlite"),
    scratchState: state,
    verifyPrepare: path.join(state, "verify-prepare"),
    verifyPacket: path.join(state, "verify-packet"),
    verifyScore: path.join(state, "verify-score"),
    verifyD7: path.join(state, "verify-d7"),
    preparationManifest: path.join(state, "preparation-manifest.json"),
    repoMap: path.join(state, "repo-map.json"),
  };
}

/** Default live-DB path: ~/.agentwrangler/db.sqlite */
export function defaultLiveDbPath(): string {
  return path.join(os.homedir(), ".agentwrangler", "db.sqlite");
}

/** Default O1 approval-manifest durable copy path. */
export function defaultApprovalManifestPath(): string {
  return path.join(
    os.homedir(),
    ".agentwrangler",
    "approvals",
    "wave2-approval-v3-b96fcb40.json",
  );
}

/** Default base dir for all scratch evidence artifacts. */
export function defaultScratchBaseDir(): string {
  return path.join(os.homedir(), ".agentwrangler", "evidence");
}

/**
 * Format an npm run command as a multi-line shell string.
 * Each flag pair is on its own line, continued with backslash.
 */
export function formatNpmCommand(
  script: string,
  subcommand: string | null,
  flags: readonly string[],
): string {
  const head =
    subcommand !== null ? `npm run ${script} -- ${subcommand}` : `npm run ${script}`;
  if (flags.length === 0) return head;
  const lines: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    lines.push(`  ${flags[i] ?? ""} ${flags[i + 1] ?? ""}`);
  }
  return `${head} \\\n${lines.join(" \\\n")}`;
}
