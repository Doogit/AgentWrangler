/**
 * PERF5 per-job attribution: recurring daemon jobs at ORIGINAL cadences.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/perf5-job-attribution.ts
 *
 * Per scale, in an isolated synthetic child (same harness as
 * synthetic-history.ts — no operator config, transcripts, or network):
 *   1. Seed the frozen synthetic fixture and write the ingest corpus.
 *   2. Populate the harness claude dir with synthetic context sources so the
 *      probe sizes real files (settings.json, CLAUDE.md, skills, memory).
 *   3. `recurring-jobs`: real Ingestor boot scan, then a bounded window at the
 *      original 2 s tail / 30 s discovery cadences with a growth workload and
 *      concurrent HTTP interference reads. Per-invocation elapsed/CPU per job
 *      family, window event-loop delay, and interference latency are reported
 *      separately.
 *   4. `direct-jobs`: direct invocation of the weekly/representative jobs
 *      (weekly report, effect measurement, populated context probe, detectors,
 *      calibration gated check) and the outcomes pass steps via a synthetic
 *      injected provider.
 *
 * Fake-clock cadence/shutdown lifecycle evidence lives in
 * test/daemon/lifecycle.test.ts; accelerated cadences are not used here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import { seedSyntheticHistory, writeSyntheticIngestCorpus } from "./synthetic-fixture.js";
import {
  type ChildHarness,
  removeSyntheticDirectory,
  startChild,
  summarizePhase,
} from "./synthetic-history.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const WINDOW_MS = 35_000; // >= one 30s discovery tick at original cadence
const RECURRING_EVENT_TIMEOUT_MS = 300_000;
const INTERFERENCE_TIMEOUT_MS = 120_000;
const INTERFERENCE_ROUTE =
  "/api/overview?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-15T00%3A00%3A00.000Z";

/** Synthetic context sources only (SEC-101: fabricated content, no operator data). */
function populateSyntheticClaudeDir(claudeDir: string): void {
  const filler = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => `synthetic context line ${i} — no real content`).join(
      "\n",
    );
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "synthetic-plugin@synthetic": true } }, null, 2),
  );
  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), filler(120));
  const skillDir = path.join(claudeDir, "skills", "synthetic-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: synthetic-skill\ndescription: synthetic benchmark skill\n---\n${filler(40)}`,
  );
  for (let workspace = 0; workspace < 3; workspace += 1) {
    const memoryDir = path.join(claudeDir, "projects", `synthetic-project-${workspace}`, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), filler(60));
  }
}

async function request(port: number, route: string, timeoutMs: number): Promise<number> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get({ hostname: "127.0.0.1", port, path: route, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`interference read HTTP ${res.statusCode}`));
        else resolve(performance.now() - started);
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`interference read timed out (${timeoutMs}ms)`)));
    req.on("error", reject);
  });
}

interface Combo {
  label: string;
  gatingOff: boolean;
  growthOff: boolean;
  /** Only the production-shaped combo also runs the direct-jobs pass. */
  directJobs: boolean;
}

const COMBOS: readonly Combo[] = [
  { label: "gated_growth", gatingOff: false, growthOff: false, directJobs: true },
  { label: "gated_idle", gatingOff: false, growthOff: true, directJobs: false },
  { label: "ungated_growth", gatingOff: true, growthOff: false, directJobs: false },
  { label: "ungated_idle", gatingOff: true, growthOff: true, directJobs: false },
];

async function profileCombo(scale: number, combo: Combo): Promise<Record<string, unknown>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  const dbPath = path.join(tempDir, "synthetic.sqlite");
  const claudeDir = path.join(tempDir, "empty-claude");
  fs.mkdirSync(claudeDir);
  populateSyntheticClaudeDir(claudeDir);
  let child: ChildHarness | undefined;
  let result: Record<string, unknown> | undefined;
  let profileError: unknown;
  try {
    const db = openDb(dbPath);
    runMigrations(db);
    seedSyntheticHistory(db, scale);
    db.close();
    const corpusDir = path.join(tempDir, "ingest-corpus");
    const corpus = writeSyntheticIngestCorpus(corpusDir, scale);

    child = await startChild(dbPath, claudeDir);

    // Recurring window with concurrent interference reads.
    const startedEvent = await child.command(
      {
        command: "recurring-jobs",
        corpusDir,
        windowMs: WINDOW_MS,
        gatingOff: combo.gatingOff,
        growthOff: combo.growthOff,
      },
      RECURRING_EVENT_TIMEOUT_MS,
    );
    if (startedEvent.event !== "recurring-jobs-started")
      throw new Error(`Unexpected recurring-jobs acknowledgement: ${String(startedEvent.event)}`);
    let recurringEvent: Record<string, unknown> | undefined;
    let recurringError: unknown;
    let settled = false;
    const tracked = child
      .wait(RECURRING_EVENT_TIMEOUT_MS)
      .then(
        (event) => {
          recurringEvent = event;
        },
        (error: unknown) => {
          recurringError = error;
        },
      )
      .finally(() => {
        settled = true;
      });
    const interference: number[] = [];
    while (!settled) {
      interference.push(await request(child.port, INTERFERENCE_ROUTE, INTERFERENCE_TIMEOUT_MS));
      // Pace reads so interference is periodic, not a saturating loop.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await tracked;
    if (recurringError !== undefined)
      throw recurringError instanceof Error ? recurringError : new Error(String(recurringError));
    if (!recurringEvent || recurringEvent.event !== "recurring-jobs")
      throw new Error(`Unexpected recurring-jobs completion: ${String(recurringEvent?.event)}`);

    let directRest: Record<string, unknown> | undefined;
    if (combo.directJobs) {
      const directEvent = await child.command({ command: "direct-jobs" }, RECURRING_EVENT_TIMEOUT_MS);
      if (directEvent.event !== "direct-jobs")
        throw new Error(`Unexpected direct-jobs completion: ${String(directEvent.event)}`);
      const { event: _d, ...rest } = directEvent;
      directRest = rest;
    }

    const { event: _r, families, ...recurringRest } = recurringEvent;
    const familySummaries = Object.fromEntries(
      Object.entries((families ?? {}) as Record<string, { count: number; elapsed_ms: number[]; cpu_ms: number[] }>).map(
        ([family, samples]) => [
          family,
          {
            count: samples.count,
            elapsed_ms: summarizePhase(samples.elapsed_ms),
            cpu_ms_total: Number(samples.cpu_ms.reduce((sum, v) => sum + v, 0).toFixed(3)),
            cpu_ms: summarizePhase(samples.cpu_ms),
          },
        ],
      ),
    );
    result = {
      combo: combo.label,
      corpus: { turns: scale, ...corpus },
      startup_to_ready_ms: Number(child.startupToReadyMs.toFixed(3)),
      recurring: {
        ...recurringRest,
        families: familySummaries,
        concurrent_http_interference: {
          requests: interference.length,
          pacing_ms: 500,
          http_elapsed_ms: summarizePhase(interference),
        },
      },
      ...(directRest === undefined ? {} : { direct: directRest }),
    };
  } catch (error) {
    profileError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    if (child) await child.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeSyntheticDirectory(tempDir);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (profileError && cleanupErrors.length)
    throw new AggregateError([profileError, ...cleanupErrors], "PERF5 profile and cleanup failed");
  if (profileError) throw profileError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "PERF5 cleanup failed");
  if (!result) throw new Error("PERF5 profile completed without a result");
  return result;
}

async function profile(scale: number): Promise<Record<string, unknown>> {
  const combos: Record<string, unknown>[] = [];
  for (const combo of COMBOS) combos.push(await profileCombo(scale, combo));
  return { scale_turns: scale, combos };
}

async function main(): Promise<void> {
  const results: Record<string, unknown>[] = [];
  for (const scale of SCALES) results.push(await profile(scale));
  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        synthetic_only: true,
        tool: "perf5-job-attribution",
        window_ms: WINDOW_MS,
        cadence_note:
          "Original production cadences (2s tail / 30s discovery) in a bounded window; weekly jobs are directly invoked; fake-clock lifecycle evidence is test/daemon/lifecycle.test.ts.",
        excluded: [
          "src/daemon/index.ts",
          "live calibration (opt-in path measures the gated config check only)",
          "credential discovery / gh subprocesses (outcomes uses an injected stub provider)",
          "git churn collector",
          "external network",
        ],
        results,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
