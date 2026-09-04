/**
 * O12 one-command B6 / D7 forward-coverage prepare wrapper.
 *
 * Re-snapshots the live DB against the CURRENT state (preventing live_db_identity_mismatch),
 * computes all required SHAs, and either PRINTS the assembled d7-coverage command (default)
 * or EXECUTES it (--execute).
 *
 * IMPORTANT: Stop the daemon before running to freeze db.sqlite:
 *   pkill -f "node.*daemon" OR close the terminal running `npm run daemon`
 *   (Windows: tasklist | findstr node → taskkill /PID <pid> /F)
 *
 * Usage:
 *   npm run evidence:prepare-b6 [-- [options]]
 *
 * Options:
 *   --live-db <path>           Live DB (default: ~/.agentwrangler/db.sqlite)
 *   --approval-manifest <path> O1 manifest (default: ~/.agentwrangler/approvals/wave2-approval-v3-b96fcb40.json)
 *   --scratch-base <dir>       Scratch parent dir (default: ~/.agentwrangler/evidence)
 *   --execute                  Also run evidence:d7-coverage. Default: print only.
 *
 * See spec-evidence-campaigns.md §B6 for the full runbook.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type CommonFlagValues,
  buildCommonFlagArray,
  defaultApprovalManifestPath,
  defaultLiveDbPath,
  defaultScratchBaseDir,
  formatNpmCommand,
  scratchPaths,
  scratchRunId,
} from "./lib/flags.js";

/** SHA-256 of a file's raw bytes. */
export function sha256File(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function gitHead(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Parsed CLI arguments for prepare-b6. */
export interface B6Args {
  liveDb: string;
  approvalManifest: string;
  scratchBase: string;
  execute: boolean;
}

export function parseB6Args(argv: readonly string[]): B6Args {
  const values: Record<string, string> = {};
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      values[key] = val;
      i++;
    }
  }
  return {
    liveDb: values["live-db"] ?? defaultLiveDbPath(),
    approvalManifest: values["approval-manifest"] ?? defaultApprovalManifestPath(),
    scratchBase: values["scratch-base"] ?? defaultScratchBaseDir(),
    execute,
  };
}

/** Build the d7-coverage flag array (common + d7-specific extras). */
export function buildD7Flags(opts: {
  common: readonly string[];
  repositoryRoot: string;
  sourceCommit: string;
  asOf: string;
  out: string;
}): readonly string[] {
  return [
    ...opts.common,
    "--repository-root",
    opts.repositoryRoot,
    "--source-commit",
    opts.sourceCommit,
    "--as-of",
    opts.asOf,
    "--window-days",
    "30",
    "--out",
    opts.out,
  ];
}

/** Repo root: two directories above scripts/evidence/. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function main(): Promise<void> {
  const opts = parseB6Args(process.argv.slice(2));

  process.stderr.write(
    `[prepare-b6] IMPORTANT: Stop the daemon before continuing to freeze db.sqlite.\n` +
      `[prepare-b6] On Windows: tasklist | findstr node  →  taskkill /PID <pid> /F\n`,
  );

  // 1. Verify approval manifest and compute its SHA.
  if (!fs.existsSync(opts.approvalManifest)) {
    process.stderr.write(
      `[prepare-b6] Approval manifest not found: ${opts.approvalManifest}\n` +
        `[prepare-b6] Pass --approval-manifest <path> or copy the O1 durable manifest to the default location.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const approvalSha = sha256File(opts.approvalManifest);

  // 2. Generate scratch run paths (fresh run = fresh snapshot = no identity mismatch).
  const runId = scratchRunId("b6", new Date());
  const paths = scratchPaths(opts.scratchBase, runId);

  process.stderr.write(`[prepare-b6] Scratch run: ${runId}\n`);
  process.stderr.write(`[prepare-b6] Scratch dir: ${paths.runDir}\n`);
  process.stderr.write(`[prepare-b6] Freezing scratch DB snapshot (no GitHub access)...\n`);

  // 3. Create scratch snapshot (always; re-snapshotting fixes live_db_identity_mismatch).
  const createResult = spawnSync(
    "node",
    [
      "--import",
      "tsx/esm",
      "src/evidence/create-scratch.ts",
      "--source-db",
      opts.liveDb,
      "--scratch-db",
      paths.scratchDb,
      "--scratch-state",
      paths.scratchState,
      "--approval-manifest",
      opts.approvalManifest,
      "--approval-sha256",
      approvalSha,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  if (createResult.status !== 0) {
    const msg = createResult.stdout.trim() || createResult.stderr.trim();
    process.stderr.write(`[prepare-b6] create-scratch REFUSED: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  const created = JSON.parse(createResult.stdout.trim()) as Record<string, unknown>;
  const scratchDbSha = created["scratchDbSha256"] as string;
  const repoMapSha = created["repoMapSha256"] as string;
  const preparationManifestSha = created["manifestSha256"] as string;

  process.stderr.write(
    `[prepare-b6] Snapshot ready (scratch DB sha256: ${scratchDbSha.slice(0, 16)}...)\n`,
  );

  // 4. Compute source commit and output path.
  const sourceCommit = gitHead(REPO_ROOT);
  const asOf = new Date().toISOString();
  const reportOut = path.join(paths.scratchState, "d7-coverage-report.json");

  // 5. Build common flags + d7-coverage flags.
  const commonValues: CommonFlagValues = {
    approvalManifest: opts.approvalManifest,
    approvalSha256: approvalSha,
    scratchPreparationManifest: paths.preparationManifest,
    scratchPreparationSha256: preparationManifestSha,
    scratchDb: paths.scratchDb,
    approvedScratchDbSha256: scratchDbSha,
    repoMap: paths.repoMap,
    repoMapSha256: repoMapSha,
    scratchState: paths.scratchState,
    scratchVerification: paths.verifyD7,
    liveDb: opts.liveDb,
  };

  const d7Flags = buildD7Flags({
    common: buildCommonFlagArray(commonValues),
    repositoryRoot: REPO_ROOT,
    sourceCommit,
    asOf,
    out: reportOut,
  });

  process.stdout.write(`\n# B6 — D7 forward-coverage run\n`);
  process.stdout.write(`${formatNpmCommand("evidence:d7-coverage", null, d7Flags)}\n\n`);

  if (!opts.execute) {
    process.stdout.write(
      `# Scratch dir is ready at: ${paths.runDir}\n` +
        `# Run with --execute to also execute the coverage measurement.\n`,
    );
    return;
  }

  // Execute mode: run d7-coverage.
  process.stderr.write(`[prepare-b6] Running evidence:d7-coverage...\n`);
  const coverageResult = spawnSync(
    "node",
    ["--import", "tsx/esm", "src/evidence/d7/cli.ts", ...d7Flags],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  if (coverageResult.stderr.length > 0) process.stderr.write(coverageResult.stderr);
  if (coverageResult.status !== 0) {
    process.stderr.write(
      `[prepare-b6] d7-coverage REFUSED: ${coverageResult.stdout.trim()}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`# D7 coverage output:\n${coverageResult.stdout.trim()}\n\n`);
  process.stdout.write(`Report written: ${reportOut}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  void main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
