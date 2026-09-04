/**
 * O12 one-command G2 / COND-1 prepare wrapper.
 *
 * Freezes a scratch DB snapshot from the live DB, computes all required SHAs,
 * and either PRINTS the assembled prepare + packet commands (default, no GitHub
 * access) or EXECUTES them (--execute, fetches PRs from GitHub).
 *
 * Usage:
 *   npm run evidence:prepare-g2 [-- [options]]
 *
 * Options:
 *   --live-db <path>           Live DB (default: ~/.agentwrangler/db.sqlite)
 *   --approval-manifest <path> O1 manifest (default: ~/.agentwrangler/approvals/wave2-approval-v3-b96fcb40.json)
 *   --scratch-base <dir>       Scratch parent dir (default: ~/.agentwrangler/evidence)
 *   --execute                  Also run prepare + packet (fetches PRs from GitHub). Default: print only.
 *
 * See spec-evidence-campaigns.md §G2 for the full runbook.
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

/** Parsed CLI arguments for prepare-g2. */
export interface G2Args {
  liveDb: string;
  approvalManifest: string;
  scratchBase: string;
  execute: boolean;
}

export function parseG2Args(argv: readonly string[]): G2Args {
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

/** Build the prepare-specific flag array (common + prepare extras). */
export function buildPrepareFlags(opts: {
  common: readonly string[];
  manifestOut: string;
  preparedOut: string;
  extractorCommit: string;
  findingsModuleSha256: string;
  asOf: string;
}): readonly string[] {
  return [
    ...opts.common,
    "--manifest-out",
    opts.manifestOut,
    "--prepared-out",
    opts.preparedOut,
    "--extractor-commit",
    opts.extractorCommit,
    "--findings-module-sha256",
    opts.findingsModuleSha256,
    "--as-of",
    opts.asOf,
    "--corpus",
    "full-merged",
  ];
}

/** Build the packet-specific flag array (common + packet extras). */
export function buildPacketFlags(opts: {
  common: readonly string[];
  manifestPath: string;
  manifestSha256: string;
  preparedPath: string;
  preparedSha256: string;
  packetOut: string;
  keyOut: string;
}): readonly string[] {
  return [
    ...opts.common,
    "--manifest",
    opts.manifestPath,
    "--manifest-sha256",
    opts.manifestSha256,
    "--prepared",
    opts.preparedPath,
    "--prepared-sha256",
    opts.preparedSha256,
    "--packet-out",
    opts.packetOut,
    "--key-out",
    opts.keyOut,
  ];
}

/** Repo root: two directories above scripts/evidence/. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function main(): Promise<void> {
  const opts = parseG2Args(process.argv.slice(2));

  // 1. Verify approval manifest exists and compute its SHA.
  if (!fs.existsSync(opts.approvalManifest)) {
    process.stderr.write(
      `[prepare-g2] Approval manifest not found: ${opts.approvalManifest}\n` +
        `[prepare-g2] Pass --approval-manifest <path> or copy the O1 durable manifest to the default location.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const approvalSha = sha256File(opts.approvalManifest);

  // 2. Generate scratch run paths.
  const runId = scratchRunId("g2", new Date());
  const paths = scratchPaths(opts.scratchBase, runId);

  process.stderr.write(`[prepare-g2] Scratch run: ${runId}\n`);
  process.stderr.write(`[prepare-g2] Scratch dir: ${paths.runDir}\n`);
  process.stderr.write(
    `[prepare-g2] Freezing scratch DB snapshot (no GitHub access)...\n`,
  );

  // 3. Create scratch snapshot (always; this step never touches GitHub).
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
    process.stderr.write(`[prepare-g2] create-scratch REFUSED: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  const created = JSON.parse(createResult.stdout.trim()) as Record<string, unknown>;
  const scratchDbSha = created["scratchDbSha256"] as string;
  const repoMapSha = created["repoMapSha256"] as string;
  const preparationManifestSha = created["manifestSha256"] as string;

  process.stderr.write(
    `[prepare-g2] Snapshot ready (scratch DB sha256: ${scratchDbSha.slice(0, 16)}...)\n`,
  );

  // 4. Compute extractor commit and findings-module SHA.
  const extractorCommit = gitHead(REPO_ROOT);
  const findingsModulePath = path.join(REPO_ROOT, "src", "outcomes", "finding-extractors.ts");
  const findingsModuleSha = sha256File(findingsModulePath);

  // 5. Assemble output artifact paths.
  const manifestOut = path.join(paths.scratchState, "manifest.json");
  const preparedOut = path.join(paths.scratchState, "prepared.json");
  const packetOut = path.join(paths.scratchState, "packet.json");
  const keyOut = path.join(paths.scratchState, "key.json");
  const asOf = new Date().toISOString();

  // 6. Build common + prepare flags (using verify-prepare for the prepare command).
  const commonForPrepare: CommonFlagValues = {
    approvalManifest: opts.approvalManifest,
    approvalSha256: approvalSha,
    scratchPreparationManifest: paths.preparationManifest,
    scratchPreparationSha256: preparationManifestSha,
    scratchDb: paths.scratchDb,
    approvedScratchDbSha256: scratchDbSha,
    repoMap: paths.repoMap,
    repoMapSha256: repoMapSha,
    scratchState: paths.scratchState,
    scratchVerification: paths.verifyPrepare,
    liveDb: opts.liveDb,
  };

  const prepareFlags = buildPrepareFlags({
    common: buildCommonFlagArray(commonForPrepare),
    manifestOut,
    preparedOut,
    extractorCommit,
    findingsModuleSha256: findingsModuleSha,
    asOf,
  });

  process.stdout.write(
    `\n# STEP 1 — PREPARE (fetches PRs from GitHub; requires AgentWrangler-GithubToken in Windows Credential Manager)\n`,
  );
  process.stdout.write(`${formatNpmCommand("evidence:cond1", "prepare", prepareFlags)}\n\n`);

  if (!opts.execute) {
    // Dry-run: print packet template with SHA placeholders.
    const commonForPacket: CommonFlagValues = {
      ...commonForPrepare,
      scratchVerification: paths.verifyPacket, // different verification path per command
    };
    const packetFlags = buildPacketFlags({
      common: buildCommonFlagArray(commonForPacket),
      manifestPath: manifestOut,
      manifestSha256: "<manifestSha256 from PREPARE stdout>",
      preparedPath: preparedOut,
      preparedSha256: "<preparedArtifactSha256 from PREPARE stdout>",
      packetOut,
      keyOut,
    });
    process.stdout.write(
      `# STEP 2 — PACKET (save manifestSha256 + preparedArtifactSha256 from PREPARE stdout first)\n`,
    );
    process.stdout.write(`${formatNpmCommand("evidence:cond1", "packet", packetFlags)}\n\n`);
    process.stdout.write(
      `# Scratch dir is ready at: ${paths.runDir}\n` +
        `# Run with --execute to also execute STEP 1 + STEP 2 automatically.\n`,
    );
    return;
  }

  // Execute mode: run prepare (hits GitHub).
  process.stderr.write(`[prepare-g2] Running cond1 prepare (fetches GitHub PRs)...\n`);
  const prepareResult = spawnSync(
    "node",
    ["--import", "tsx/esm", "src/evidence/cond1/cli.ts", "prepare", ...prepareFlags],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  if (prepareResult.stderr.length > 0) process.stderr.write(prepareResult.stderr);
  if (prepareResult.status !== 0) {
    process.stderr.write(
      `[prepare-g2] cond1 prepare REFUSED: ${prepareResult.stdout.trim()}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`# PREPARE output:\n${prepareResult.stdout.trim()}\n\n`);

  const prepareOut = JSON.parse(prepareResult.stdout.trim()) as Record<string, unknown>;
  const manifestSha256 = prepareOut["manifestSha256"] as string;
  const preparedSha256 = prepareOut["preparedArtifactSha256"] as string;

  // Build packet flags with real SHAs (different verification path for packet).
  const commonForPacket: CommonFlagValues = {
    ...commonForPrepare,
    scratchVerification: paths.verifyPacket,
  };
  const packetFlags = buildPacketFlags({
    common: buildCommonFlagArray(commonForPacket),
    manifestPath: manifestOut,
    manifestSha256,
    preparedPath: preparedOut,
    preparedSha256,
    packetOut,
    keyOut,
  });

  process.stderr.write(`[prepare-g2] Running cond1 packet...\n`);
  const packetResult = spawnSync(
    "node",
    ["--import", "tsx/esm", "src/evidence/cond1/cli.ts", "packet", ...packetFlags],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  if (packetResult.stderr.length > 0) process.stderr.write(packetResult.stderr);
  if (packetResult.status !== 0) {
    process.stderr.write(
      `[prepare-g2] cond1 packet REFUSED: ${packetResult.stdout.trim()}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`# PACKET output:\n${packetResult.stdout.trim()}\n\n`);
  process.stdout.write(
    `Packet written: ${packetOut}\n` +
      `Key sealed:     ${keyOut}  (keep this private; do NOT show to adjudicator)\n\n` +
      `Next: hand the packet file to the adjudicator for STEP 3 (hand-labeling).\n` +
      `See spec-evidence-campaigns.md §G2 for the score command (STEP 4).\n`,
  );
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
