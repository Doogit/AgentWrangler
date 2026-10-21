/**
 * scripts/parity/cli.ts — Phase-2 two-gauge parity/adoption harness CLI.
 *
 * Usage (after building seed DB with build-shared-seed.ts):
 *   node --import tsx/esm scripts/parity/cli.ts \
 *     --db  <path-to-seed.sqlite>         \
 *     (--golden-set <file> | --sessions <id1,id2,...>) \
 *     --out <output-dir>                  \
 *     [--prompt-arm]
 *
 * Pass EITHER --golden-set <file> (the frozen H2 golden set — sessions + their
 * must-catches, threaded into each scoresheet) OR --sessions <ids> (ad-hoc, no
 * must-catch). --golden-set takes precedence if both are given.
 *
 * With --prompt-arm OFF (default): stages all evidence, emits scoresheets and
 * adoption log stubs. Makes NO external calls.
 *
 * With --prompt-arm ON (or AW_PROMPT_ARM=1): additionally calls the Anthropic
 * API for each session's safe evidence packet. Requires ANTHROPIC_API_KEY.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runGauge1 } from "./gauge1.js";
import { emptyAdoptionRecord, writeAdoptionLog } from "./gauge2.js";
import { loadGoldenSet } from "./golden-set.js";

interface CliArgs {
  dbPath: string;
  sessions: string[];
  mustCatchBySession: Record<string, string>;
  outDir: string;
  promptArm: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let dbPath = "";
  let sessions: string[] = [];
  let goldenSetPath = "";
  let outDir = "";
  let promptArm = process.env["AW_PROMPT_ARM"] === "1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db" && i + 1 < args.length) {
      dbPath = args[++i] as string;
    } else if (arg === "--sessions" && i + 1 < args.length) {
      sessions = (args[++i] as string).split(",").filter(Boolean);
    } else if (arg === "--golden-set" && i + 1 < args.length) {
      goldenSetPath = args[++i] as string;
    } else if (arg === "--out" && i + 1 < args.length) {
      outDir = args[++i] as string;
    } else if (arg === "--prompt-arm") {
      promptArm = true;
    }
  }

  // --golden-set takes precedence: derive the session list + must-catches from it.
  const mustCatchBySession: Record<string, string> = {};
  if (goldenSetPath) {
    const golden = loadGoldenSet(goldenSetPath);
    sessions = golden.sessions.map((e) => e.session_id);
    for (const e of golden.sessions) {
      mustCatchBySession[e.session_id] = e.must_catch;
    }
    console.log(
      `Golden set: ${goldenSetPath} (${sessions.length} session(s)` +
        `${golden.frozen_at ? `, frozen ${golden.frozen_at}` : ", NOT yet frozen"})`,
    );
  }

  if (!dbPath || sessions.length === 0 || !outDir) {
    console.error(
      "Usage: cli.ts --db <path> (--golden-set <file> | --sessions <id1,id2,...>) --out <dir> [--prompt-arm]",
    );
    process.exit(1);
  }

  return { dbPath, sessions, mustCatchBySession, outDir, promptArm };
}

async function main(): Promise<void> {
  const { dbPath, sessions, mustCatchBySession, outDir, promptArm } = parseArgs(process.argv);

  if (!fs.existsSync(dbPath)) {
    console.error(`Seed DB not found at ${dbPath}. Build it first:`);
    console.error(`  node --import tsx/esm scripts/build-shared-seed.ts ${dbPath}`);
    process.exit(1);
  }

  if (promptArm) {
    console.log("Prompt arm: ENABLED (will call Anthropic API — requires ANTHROPIC_API_KEY)");
  } else {
    console.log("Prompt arm: OFF (default). Pass --prompt-arm or set AW_PROMPT_ARM=1 to enable.");
  }

  console.log(`\nGauge 1 (parity) — staging ${sessions.length} session(s)…`);
  const gauge1Out = path.join(outDir, "gauge1");
  const gauge1Results = await runGauge1({
    dbPath,
    goldenSessionIds: sessions,
    outDir: gauge1Out,
    promptArmEnabled: promptArm,
    mustCatchBySession,
  });

  console.log(`Gauge 2 (adoption) — building adoption log stubs…`);
  const db = new Database(dbPath, { readonly: true });
  const adoptionRecords = [];
  for (const r of gauge1Results) {
    for (const rec of r.engine_recs) {
      adoptionRecords.push(
        emptyAdoptionRecord(
          rec.rec_id,
          rec.detector_id,
          r.session_id,
          String(r.packet.fields["workspace_id"] ?? "unknown"),
          rec.target_metric ?? `${rec.detector_id ?? "unknown"}-before-metric`,
        ),
      );
    }
  }
  db.close();

  const gauge2Out = path.join(outDir, "gauge2");
  writeAdoptionLog(adoptionRecords, path.join(gauge2Out, "adoption-log.json"));

  console.log(`\nDone. Output written to: ${outDir}`);
  console.log(`  Gauge 1 scoresheets : ${gauge1Results.length} file(s) in ${gauge1Out}`);
  console.log(`  Gauge 2 adoption log: ${path.join(gauge2Out, "adoption-log.json")}`);
  console.log(`  Total recs staged   : ${adoptionRecords.length}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
