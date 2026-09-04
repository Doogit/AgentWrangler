import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Db } from "../../db/open.js";
import { openDb } from "../../db/open.js";
import { readAnthropicApiKey } from "../../oauth/anthropic-api-key.js";
import { type JudgeClient, claudeJudgeClient } from "../../oauth/judge-g2-client.js";
import type { Cond1BlindedPacket, Cond1CorpusManifest, Cond1SealedKey } from "../cond1/types.js";
import type { G2PacketEntry } from "./adjudicate.js";
import { G2_KAPPA_GATE, G2_MIN_SEED_N } from "./kappa.js";
import type { G2JudgePipelineDeps, G2SeedLabel } from "./pipeline.js";
import { runG2JudgePipeline } from "./pipeline.js";
import { isG2JudgeOptIn } from "./store.js";

export interface G2Artifacts {
  packetEntries: readonly G2PacketEntry[];
  key: Cond1SealedKey;
  manifest: Cond1CorpusManifest;
  corpusManifestFileSha256: string;
  seed: readonly G2SeedLabel[];
}

export interface G2JudgeCliDeps {
  db?: Db;
  judge?: JudgeClient;
  loadArtifacts?: () => G2Artifacts;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  pipelineDeps?: G2JudgePipelineDeps;
}

function defaultLiveDb(): string {
  return path.join(os.homedir(), ".agentwrangler", "db.sqlite");
}

interface ParsedArgs {
  execute: boolean;
  liveDb: string;
  scratchState: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let execute = false;
  let liveDb = defaultLiveDb();
  let scratchState = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--live-db") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--live-db requires a value");
      liveDb = val;
      i++;
      continue;
    }
    if (arg === "--scratch-state") {
      const val = argv[i + 1];
      if (val === undefined) throw new Error("--scratch-state requires a value");
      scratchState = val;
      i++;
    }
  }

  return { execute, liveDb, scratchState };
}

/**
 * Load G2 artifacts from the scratch state directory produced by `evidence:prepare-g2 -- --execute`.
 *
 * Expected files:
 *   <scratchState>/manifest.json  — Cond1CorpusManifest
 *   <scratchState>/packet.json    — Cond1BlindedPacket (entries mapped to G2PacketEntry)
 *   <scratchState>/key.json       — Cond1SealedKey
 *   <scratchState>/seed.json      — G2SeedLabel[] (~10 hand-labeled findings for kappa calibration)
 */
function loadArtifactsFromState(scratchState: string): G2Artifacts {
  const manifestBytes = fs.readFileSync(path.join(scratchState, "manifest.json"));
  const corpusManifestFileSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Cond1CorpusManifest;

  const packet = JSON.parse(
    fs.readFileSync(path.join(scratchState, "packet.json"), "utf8"),
  ) as Cond1BlindedPacket;
  const packetEntries: G2PacketEntry[] = packet.entries.map(
    ({ findingAlias, evidenceKind, evidence }) => ({
      findingAlias,
      evidenceKind,
      evidence,
    }),
  );

  const key = JSON.parse(
    fs.readFileSync(path.join(scratchState, "key.json"), "utf8"),
  ) as Cond1SealedKey;
  const seed = JSON.parse(
    fs.readFileSync(path.join(scratchState, "seed.json"), "utf8"),
  ) as G2SeedLabel[];

  return { packetEntries, key, manifest, corpusManifestFileSha256, seed };
}

/**
 * Testable core of the evidence:judge-g2 CLI.
 *
 * Deps are optional so tests can inject fakes without touching disk or the network.
 * When execute=false (no --execute flag), prints a plan and returns 0 without any DB or API calls.
 *
 * SEC-101: rationaleTag from judge verdicts is never written to disk, DB, or output.
 */
export async function runG2JudgeCli(
  argv: readonly string[],
  deps: G2JudgeCliDeps = {},
): Promise<number> {
  const writeOut = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const writeErr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const args = parseArgs(argv);

  if (!args.execute) {
    writeOut(
      `evidence:judge-g2 — G2 Claude-judge pipeline

What leaves your machine:
  On --execute (with a valid seed), ALL blinded evidence excerpts in the packet are sent to the
  Claude API (Anthropic) in one offline batch — not just the seed. The κ gate below decides whether
  labels are persisted and scored; it does NOT reduce what is transmitted. An invalid seed is
  rejected up front and sends nothing.

Plan:
  1. ADJUDICATE — Judge every blinded packet finding (CONFIRMED/REJECTED + confidence).
     Rationale text is never written to disk (SEC-101).
  2. CALIBRATE — Compute Cohen's κ over the hand-labeled human seed (seed.json in the scratch
     state directory) vs the judge's verdicts on those same findings.
  3. KAPPA GATE (κ ≥ ${G2_KAPPA_GATE}, seed ≥ ${G2_MIN_SEED_N}) — If calibration fails the run is
     BLOCKED_LOW_KAPPA: no verdicts are persisted and nothing is scored.
  4. LABEL + SCORE — On pass, de-blind against the sealed key, persist verdicts to the live DB,
     and score precision.

Opt-in required:
  The key "g2_claude_judge_opt_in" in user_config must be set to "true" in the live DB.
  This confirms consent to sending the blinded PR evidence excerpts to the Claude API.

Usage:
  npm run evidence:judge-g2 -- --execute --scratch-state <path/to/state>
  npm run evidence:judge-g2 -- --execute --scratch-state <path> --live-db <path/to/db.sqlite>`,
    );
    return 0;
  }

  const db = deps.db ?? openDb(args.liveDb);

  if (!isG2JudgeOptIn(db)) {
    writeErr(
      `[judge-g2] REFUSED: g2_claude_judge_opt_in is not set to "true" in user_config.

Set it with:
  INSERT OR REPLACE INTO user_config (key, value)
  VALUES ('g2_claude_judge_opt_in', 'true');

This confirms consent to sending blinded PR evidence excerpts to the Claude API (Anthropic).
The evidence leaves your machine. No rationale text is written to disk (SEC-101).`,
    );
    return 1;
  }

  const loadArtifacts = deps.loadArtifacts ?? (() => loadArtifactsFromState(args.scratchState));
  let artifacts: G2Artifacts;
  try {
    artifacts = loadArtifacts();
  } catch {
    // Do NOT echo the underlying error — a JSON parse error can embed a fragment
    // of the evidence payload (SEC-101).
    writeErr(
      "[judge-g2] Could not load G2 artifacts. Expected manifest.json, packet.json, key.json, " +
        "and a hand-authored seed.json in the --scratch-state directory (from evidence:prepare-g2).",
    );
    return 1;
  }
  let judge = deps.judge;
  if (judge === undefined) {
    // Prefer a raw Anthropic API key (separate rate-limit pool) over the shared
    // Claude Code subscription OAuth token. SEC-101: log the source, never the key.
    const keyResult = await readAnthropicApiKey();
    if (keyResult.ok) {
      writeOut(`[judge-g2] auth: api-key (${keyResult.source})`);
      judge = claudeJudgeClient({ apiKey: keyResult.data });
    } else {
      writeOut(`[judge-g2] auth: oauth (subscription; no API key: ${keyResult.reason})`);
      judge = claudeJudgeClient();
    }
  }

  const result = await runG2JudgePipeline(
    {
      db,
      judge,
      packetEntries: artifacts.packetEntries,
      seed: artifacts.seed,
      key: artifacts.key,
      manifest: artifacts.manifest,
      corpusManifestFileSha256: artifacts.corpusManifestFileSha256,
    },
    deps.pipelineDeps,
  );

  if (result.status === "JUDGE_ERROR") {
    writeErr(`[judge-g2] JUDGE_ERROR on ${result.findingAlias}: ${result.reason}`);
    return 1;
  }

  if (result.status === "INVALID_SEED") {
    writeErr(
      `[judge-g2] INVALID_SEED: ${result.reason}
seedN: ${result.seedN}  matchedN: ${result.matchedN}  minSeedN: ${result.minSeedN}
No evidence was sent, no verdicts were persisted, and nothing was scored.`,
    );
    return 1;
  }

  if (result.status === "BLOCKED_LOW_KAPPA") {
    writeOut(
      `status: BLOCKED_LOW_KAPPA
kappa: ${result.kappa.toFixed(4)}
rawAgreement: ${result.rawAgreement.toFixed(4)}
seedN: ${result.seedN}
gate: ${result.gate}

Calibration failed (κ < ${result.gate}). Auto-labeling was skipped; no DB writes occurred.`,
    );
    return 1;
  }

  // SCORED — print aggregate summary (SEC-101: no rationaleTag)
  const { score } = result;
  const extLines = (["E1", "E2", "E3"] as const)
    .map((id) => {
      const ex = score.extractors[id];
      if (ex === undefined) return `  ${id}: not scored`;
      const p = ex.precision !== null ? ex.precision.toFixed(4) : "null";
      return `  ${id}: status=${ex.status} precision=${p} emittedN=${ex.emittedN}`;
    })
    .join("\n");

  writeOut(
    `status: SCORED
kappa: ${result.kappa.toFixed(4)}
rawAgreement: ${result.rawAgreement.toFixed(4)}
seedN: ${result.seedN}
labeledN: ${result.labeledN}
overallStatus: ${score.overallStatus}
extractors:
${extLines}`,
  );
  return 0;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  runG2JudgeCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // Never surface a raw stack — it could echo evidence (SEC-101). Fail closed.
      process.stderr.write("[judge-g2] fatal error\n");
      process.exitCode = 1;
    });
}
