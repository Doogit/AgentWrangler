/**
 * src/daemon/index.ts — AgentWrangler daemon entry point.
 *
 * Boot sequence:
 *   1. Load config (env vars + defaults).
 *   2. Open on-disk SQLite (WAL + FK).
 *   3. Run migrations (idempotent).
 *   4. In --smoke mode: assert all v2 tables exist, exit 0.
 *   5. Start HTTP server on 127.0.0.1.
 *   6. Auto-open browser (unless --no-open or AW_NO_OPEN=1).
 *
 * Flags:
 *   --smoke      Boot, assert DB tables, exit 0. For CI.
 *   --no-open    Suppress browser auto-open. Implied by --smoke.
 *   --db-path    Override the DB file path (also: AW_DB_PATH env var).
 *   --port       Override port (also: AW_PORT env var).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createIdleCheckpointer } from "../db/idle-checkpoint.js";
import { runMigrations } from "../db/migrate.js";
import { openDb } from "../db/open.js";
import {
  awaitDbWriteGate,
  combineWriteGates,
  setDbWriteGate,
  watchUngatedWrites,
} from "../db/write-gate.js";
import { calibrateBytesPerTokenIfStale } from "../detector/calibration.js";
import { runContextProbe } from "../detector/context-probe.js";
import { installHook, uninstallHook } from "../hook/install.js";
import {
  bootFilesTotal,
  endHistoryPhase,
  getBootProgress,
  pushBootEvent,
  reportHistoryWeek,
  setHistoryCoverage,
  setPipelineFailed,
  setPipelineProgress,
  setPipelineRetryHook,
} from "../ingest/boot-progress.js";
import { purgeCanaryRows } from "../ingest/canary-purge.js";
import { collectSessionChurn } from "../ingest/churn-collector.js";
import { resolveCommitLinks } from "../ingest/commit-linker.js";
import { relabelDestructiveOps } from "../ingest/destructive-relabel.js";
import { runPostProbeHook, setPostIngestHook, setPostProbeHook } from "../ingest/detector-hook.js";
import { Ingestor } from "../ingest/index.js";
import type { TailHandle } from "../ingest/index.js";
import {
  type BackgroundPipelineProgress,
  type IngestSlice,
  firstSliceLimits,
} from "../ingest/ingestor.js";
import { relabelInterrupts } from "../ingest/interrupt-relabel.js";
import { repriceTurns } from "../ingest/reprice.js";
import { repairSessionAttribution } from "../ingest/session-attribution-repair.js";
import { repairTestCommands } from "../ingest/test-command-repair.js";
import { repairToolErrorClasses } from "../ingest/tool-error-repair.js";
import { mergeWorktreeWorkspaces } from "../ingest/worktree-workspace-merge.js";
import { writeObservedOutcomes } from "../outcomes/derive.js";
import { extractAllFindings } from "../outcomes/findings.js";
import { readGithubToken } from "../outcomes/github/credential.js";
import { GhCliClient } from "../outcomes/github/gh-cli-client.js";
import { linkSessions } from "../outcomes/linker.js";
import { syncAllWorkspaces } from "../outcomes/sync.js";
import { generateWeeklyReport } from "../query/api/reports.js";
import { setQueryDb } from "../query/db-context.js";
import {
  getSettingsData,
  setHealthInstance,
  setRuntimeResetHook,
} from "../query/settings-store.js";
import { createDetectorBootGate } from "./boot-state.js";
import { loadConfig, oneDriveWarning } from "./config.js";
import { bumpDataVersion } from "./data-version.js";
import { completeBackgroundDetectorPhase, createDetectorPassRunner } from "./detector-pass.js";
import { createDiagnosticsSnapshotService } from "./diagnostics-snapshot.js";
import { runEffectMeasurementPass } from "./effect-pass.js";
import { createHeadroomSnapshotService } from "./headroom-snapshot.js";
import { createHeavyJobGate } from "./heavy-job-gate.js";
import { createHistoryWorkerRunner } from "./history-worker-runner.js";
import { createServer } from "./http.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { createDaemonLifecycle } from "./lifecycle.js";
import { createOutcomesControlService } from "./outcomes-control.js";
import {
  OUTCOMES_POLL_INTERVAL_MS,
  type OutcomesPassResult,
  createOutcomesPassRunner,
} from "./outcomes-pass.js";
import {
  formatBootMarks,
  recordBootMark,
  startProcessSamplers,
  stopPerfMonitor,
} from "./perf-monitor.js";
import { setReady, setScanRoots, setScanState } from "./readiness.js";
import { createRecsSnapshotService, prewarmRecsSnapshot } from "./recs-snapshot.js";
import { createRouteSnapshotService } from "./route-snapshot.js";
import { stopScanWorkers } from "./scan-offload.js";
import { installTimerProbe } from "./timer-probe.js";
import { startWalCheckpointer } from "./wal-checkpointer.js";

// package.json sits two levels up from both src/daemon/ and dist/daemon/.
const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Parse a named CLI argument: --name value or --name=value. */
function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === undefined) continue;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}` && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return undefined;
}

// P0-U10: timer-registration probe (audit §9.3 N1) — installed as early as
// this file's own code can run. A true no-op unless AW_PERF_PROBE=1.
installTimerProbe();

// O-4 (P0-U4/U10): the earliest point index.ts's own top-level code can mark
// as "process start" (imports resolve before this runs). Every other boot
// mark is recorded relative to this one (see perf-monitor.ts getBootMarks).
recordBootMark("process_start", performance.now());

const isSmoke = process.argv.includes("--smoke");
const noOpen = isSmoke || process.argv.includes("--no-open") || process.env.AW_NO_OPEN === "1";

// These commands only update the user's Claude Code settings; they do not need
// a database or a running daemon.
if (process.argv.includes("--install-hook")) {
  const result = installHook();
  console.log(
    `${result.changed ? "Installed" : "Already installed"} context-budget hook: ${result.settingsPath}`,
  );
  process.exit(0);
}
if (process.argv.includes("--uninstall-hook")) {
  const result = uninstallHook();
  console.log(
    `${result.changed ? "Uninstalled" : "Not installed"} context-budget hook: ${result.settingsPath}`,
  );
  process.exit(0);
}

// CLI overrides.
const cliDbPath = getArg("db-path");
const cliPort = getArg("port");

const config = loadConfig({
  ...(cliDbPath !== undefined ? { dbPath: cliDbPath } : {}),
  ...(cliPort !== undefined ? { port: Number.parseInt(cliPort, 10) } : {}),
});

console.log(`AgentWrangler daemon v${VERSION}`);
console.log(`Node ${process.version}`);
console.log(`DB  : ${config.dbPath}`);
console.log(`Port: ${config.port}`);
const oneDrive = oneDriveWarning(config.dbPath, process.env);
if (oneDrive !== null) console.warn(oneDrive);

// ── 1. Open DB ────────────────────────────────────────────────────────────────
// P3-U8 R-8: one daemon per DB. A second one exits here, before it opens or migrates the DB.
const instanceLock = acquireInstanceLock(config.dbPath);
if (!instanceLock.ok) {
  console.error(
    `AgentWrangler: a daemon is already running on this DB (pid ${instanceLock.pid}). Open the dashboard it serves, or stop it first.`,
  );
  process.exit(1);
}
process.on("exit", () => instanceLock.release());
const db = openDb(config.dbPath);
console.log("DB  : opened (WAL + FK)");
// Write-gate check mode (tests and the seed-DB check run only): report every main-connection write
// that starts while a WAL checkpoint is in flight. Installed before anything prepares on `db`.
let checkpointInFlight = (): boolean => false;
if (process.env.AW_WRITE_GATE_CHECK === "1") {
  const logPath = process.env.AW_WRITE_GATE_LOG;
  watchUngatedWrites(
    db,
    () => checkpointInFlight(),
    ({ sql, stack }) => {
      const at = stack
        .split("\n")
        .slice(2)
        .filter((l) => !l.includes("write-gate") && !l.includes("node:"))
        .slice(0, 4)
        .map((l) => l.trim());
      console.error(`[write-gate] ungated write during checkpoint: ${sql} ${at.join(" < ")}`);
      if (logPath) appendFileSync(logPath, `${JSON.stringify({ sql, at })}\n`);
    },
  );
}
recordBootMark("db_open", performance.now());

// ── 2. Run migrations ─────────────────────────────────────────────────────────
let applied: string[];
try {
  applied = runMigrations(db);
} catch (err) {
  // P3-U8 R-9: a newer-schema DB (or a failed migration) stops boot with the reason, not a stack.
  console.error(`AgentWrangler: cannot start — ${(err as Error).message}`);
  db.close();
  process.exit(1);
}
if (applied.length > 0) {
  console.log(`Migrations applied: ${applied.join(", ")}`);
} else {
  console.log("Migrations: up to date");
}
recordBootMark("migrations", performance.now());

// ── 3. Smoke mode ─────────────────────────────────────────────────────────────
if (isSmoke) {
  // Assert all v2 tables are present.
  const V2_TABLES = [
    "workspaces",
    "sessions",
    "turns",
    "tool_events",
    "pricing_snapshots",
    "context_inventory",
    "work_items",
    "session_work_links",
    "observed_outcomes",
    "review_findings",
    "recommendations",
    "recommendation_effects",
    "effect_cycles",
    "effect_guardrail_results",
    "effect_rollback_operations",
    "effect_mutation_keys",
    "apply_jobs",
    "analysis_runs",
    "ingest_quarantine",
    "ingest_metric_events",
    "ingest_metric_baselines",
    "ingest_offsets",
    "schema_migrations",
    "user_config",
    "reports",
  ] as const;

  const present = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );

  const missing = V2_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    console.error(`smoke: FAIL — missing tables: ${missing.join(", ")}`);
    db.close();
    process.exit(1);
  }

  console.log(`smoke: ${V2_TABLES.length}/${V2_TABLES.length} v2 tables present — OK`);
  db.close();
  process.exit(0);
}

// ── Bind the query layer to the daemon's DB, then start ingestion ────────────
setQueryDb(db);
// P0-U2b: WAL bytes + RSS/heapUsed samplers (unref'd 1 s interval; stopped by
// stopPerfMonitor in closeDb below).
startProcessSamplers(config.dbPath);
// P2-U4b: WAL checkpoints run on a worker connection; the main connection's auto-checkpoint is off.
const walCheckpointer = startWalCheckpointer(db, config.dbPath);

// P0-U4: the weekly-report bootstrap moved off the pre-listen critical path.
// See runDeferredBootWork(), scheduled from the listen callback below.

// RB1-B: recs, history and diagnostics workers run one at a time (peak RAM).
const heavyJobGate = createHeavyJobGate();
const historyWorkers = createHistoryWorkerRunner(config.dbPath, heavyJobGate);
// Every main-thread write section awaits this gate (src/db/write-gate.ts).
const writeGate = combineWriteGates(
  () => walCheckpointer.writeGate(),
  () => historyWorkers.writeGate(),
);
setDbWriteGate(writeGate);
checkpointInFlight = () => walCheckpointer.inFlight();
const recsSnapshot = createRecsSnapshotService({
  dbPath: config.dbPath,
  gate: heavyJobGate,
  durationFile: path.join(path.dirname(config.dbPath), "recs-build-ms.json"),
});
const diagnosticsSnapshot = createDiagnosticsSnapshotService({
  dbPath: config.dbPath,
  gate: heavyJobGate,
  durationsFile: path.join(path.dirname(config.dbPath), "diagnostics-build-ms.json"),
});
const headroomSnapshot = createHeadroomSnapshotService({
  db,
  recs: recsSnapshot,
  dbPath: config.dbPath,
  gate: heavyJobGate,
});
const routeSnapshot = createRouteSnapshotService({ dbPath: config.dbPath });
// P0-U13 S4: every walk records what it read once it completes; the boot walk
// (runBootScan) is skipped when nothing changed since then.
const detectorBootGate = createDetectorBootGate(db);
const trackedWalk = detectorBootGate.track((_db, now, onWeek) => historyWorkers.run(now, onWeek));
const backgroundDetectorPass = createDetectorPassRunner({
  db,
  // P2-U4: a floored (mid-backfill) walk is not recorded by the boot gate; it does not
  // cover the history, so the full walk after the last slice must still run.
  run: (walkDb, now, onWeek, floor) =>
    floor === undefined ? trackedWalk(walkDb, now, onWeek) : historyWorkers.run(now, onWeek, floor),
});
/** P2-U4: true while the slice loop runs; its own walks replace the post-ingest ones. */
let sliceLoopRunning = false;

// Wire post-ingest detector work for tail/discovery updates. The historical
// bootstrap pass is deliberately deferred until after readiness by U3. P2H: the
// pass is the history walk (W0 + closed weeks with new turns; cached weeks are
// free), not the single-window runDetectors, whose per-window rec-GC would
// delete every rec anchored in an older week. Non-overlapping and coalesced by
// the runner; a failure is logged and never breaks the ingest loop. The walk
// runs at the ingestor's injected clock (NFR-107 / Review F4), never new Date().
setPostIngestHook((_detectorDb, now) => {
  // P2-U4: the tail runs from W0 on. Until the last slice, a walk here would see
  // partial history; the full walk after the loop covers what the tail ingested.
  if (sliceLoopRunning) return;
  diagnosticsSnapshot.markStale();
  backgroundDetectorPass
    .runIfDue(
      true,
      ({ weeks_done, weeks_total, new_findings }) => {
        console.log(
          reportHistoryWeek({
            weeksDone: weeks_done,
            weeksTotal: weeks_total,
            newFindings: new_findings,
          }),
        );
      },
      now,
    )
    .then(() => {
      diagnosticsSnapshot.markStale();
    })
    .catch((e) => {
      console.warn(
        `post-ingest history walk failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(endHistoryPhase);
});

// ── Context probe (best-effort, never crash daemon) ──────────────────────────
// Run before startTail so the first detector pass sees inventory.
// Re-run inside the outcomes poll cadence so inventory stays fresh.
function runProbePass(label: string): void {
  try {
    const now = new Date();
    const { rows } = runContextProbe(db, now);
    console.log(`ContextProbe[${label}]: ${rows} row(s) upserted`);
    if (label === "boot") recordBootMark("probe", performance.now());
    // Best-effort measurement after each probe, using the same observation clock.
    runPostProbeHook(db, now);
    if (label === "boot") recordBootMark("effect_pass", performance.now());
  } catch (e) {
    console.log(`ContextProbe[${label}]: skipped — ${e instanceof Error ? e.message : String(e)}`);
  }
  // P1-U0: probe upserts and effect-pass writes (even a pass that threw part-way).
  bumpDataVersion("ingest");
}

// Versioned measurement owns new cycles; W4 history stays read-only under the code gate.
setPostProbeHook((probeDb, now) => {
  runEffectMeasurementPass(probeDb, now);
});

// P0-U4 review fix: the boot probe pass (and the effect-measurement pass it
// triggers) moved off the pre-listen critical path, but must not be gated
// behind the weekly-report bootstrap's recs-snapshot await either — that can
// itself be a slow/cold worker-built snapshot. O-4 requires probe/effect_pass
// to land before first_detector_cycle_start, which proceeds on an independent
// chain (armBootFallback → kickBootScan → readiness slice → background
// backfill) that nothing sequences against a recs-snapshot await. Scheduled
// from the listen callback below in its own setTimeout(0), ahead of the
// report bootstrap's, so it always runs first and runs synchronously (no
// awaits inside runProbePass) — well before the first detector pass.
function runDeferredProbePass(): void {
  void awaitDbWriteGate().then(() => {
    if (lifecycle.isShutDown) return;
    runProbePass("boot");
  });
}

// Weekly-report bootstrap: reads top recs from `recsSnapshot.get()`
// (worker-built) instead of the main-thread `listRecommendations()`
// `generateWeeklyReport`'s old boot call used. Independent of the probe pass
// above so a slow/cold recs-snapshot build cannot delay it. Best-effort —
// never crashes the daemon. Guarded against shutdown landing mid-await (a
// stopped recsSnapshot or a closed db would otherwise surface as a spurious
// error log on an otherwise-clean shutdown; mirrors kickBootScan's guard).
async function runDeferredReportBootstrap(): Promise<void> {
  try {
    // Test-only seam (AW_TEST_HOOKS=1): simulates a slow report build with a
    // real event-loop yield, so a spawned-daemon test can prove /api/status
    // still answers while this deferred work is in flight. Ignored otherwise.
    if (process.env.AW_TEST_HOOKS === "1") {
      const delayMs = Number.parseInt(process.env.AW_TEST_BOOT_REPORT_DELAY_MS ?? "", 10);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // RB1-A: wait for the first pass so this does not start a second boot build.
    await bootPipelineSettled;
    if (lifecycle.isShutDown) return;
    const recs = await recsSnapshot.get();
    await awaitDbWriteGate();
    if (lifecycle.isShutDown) return;
    const report = generateWeeklyReport(db, new Date(), recs.data ?? undefined);
    console.log(`Weekly report: ${report.report_id}`);
    recordBootMark("weekly_report", performance.now());
  } catch (e) {
    console.error(`Weekly report bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Outcomes bootstrap (WP5 — best-effort, never crash daemon) ────────────────
// Pattern mirrors ingestion boot: try/catch in pass body, degraded mode on failure.
// The runner (src/daemon/outcomes-pass.ts) adds a hard 15-min per-pass deadline:
// a hung pass can no longer wedge the poll cadence forever — the running flag
// always clears and the next poll resumes.
const outcomesRunner = createOutcomesPassRunner({
  db,
  probe: () => runProbePass("poll"),
  readToken: readGithubToken,
  createClient: (tokenResult) => new GhCliClient(tokenResult),
  sync: syncAllWorkspaces,
  link: linkSessions,
  derive: writeObservedOutcomes,
  findings: extractAllFindings,
});
const outcomesControl = createOutcomesControlService(db, outcomesRunner, readGithubToken);

function runOutcomesPass(): Promise<OutcomesPassResult> {
  return outcomesRunner.run();
}

// R12 bytes→token calibration — best-effort, never crash the daemon.
// Runs on boot (deferred) and weekly when: opt-in enabled AND ratio is absent
// or older than 30 days. Mirrors the outcomes bootstrap pattern.
function runBptCalibrationIfStale(): void {
  calibrateBytesPerTokenIfStale(db).catch((e) => {
    console.error(
      `Bytes-per-token calibration failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/** Resolves when the first background pipeline run ends (or at once without an ingestor). */
let settleBootPipeline: () => void = () => {};
const bootPipelineSettled = new Promise<void>((resolve) => {
  settleBootPipeline = resolve;
});

// ── Deferred boot scan (runs AFTER the HTTP port is bound) ───────────────────
// startTailBatched() performs a yielding initial back-scan (ingestAllKnown +
// reconcile), then arms the tail/discovery timers. We do NOT
// also call runBackscan — that would spin up a second Ingestor whose separate
// Health instance is the one surfaced in Settings. One Ingestor, one Health.
// Bounded: if ingestion fails to start, still serve the dashboard (degraded).
// The one-shot kick guard, the daemon-owned intervals, and shutdown ordering
// live in the lifecycle harness (src/daemon/lifecycle.ts).
async function runBootScan(): Promise<TailHandle | null> {
  // The returned handle is a proxy: the real tail handle is produced by the
  // NOT-awaited background backfill (startTailBatched) after readiness fires, so
  // stop() forwards to it once it exists (and short-circuits if we stop first).
  let ingestor: Ingestor | null = null;
  // P2-U4: the slices left after W0, for the background loop (a retry re-plans).
  let pendingSlices: IngestSlice[] | undefined;
  let w0Complete = false;
  let bgHandle: TailHandle | null = null;
  let churnTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const handle: TailHandle = {
    stop() {
      stopped = true;
      if (churnTimer !== null) clearTimeout(churnTimer);
      bgHandle?.stop();
    },
  };
  try {
    const scanRoots = getSettingsData(db).scan_roots;
    setScanRoots(scanRoots);
    // One-time F6 repair: must run before the first scan, which re-ingests what it resets.
    const repair = await repairSessionAttribution(db, scanRoots);
    if (repair.groups > 0) console.log(`Session attribution repair: ${JSON.stringify(repair)}`);
    await awaitDbWriteGate(); // the sync repairs below write
    // One-time U2 repair: classify stored <tool_use_error>-wrapped errors the old anchors missed.
    const toolErr = repairToolErrorClasses(db);
    if (toolErr.checked > 0) console.log(`Tool-error repair: ${JSON.stringify(toolErr)}`);
    // One-time card review F6 repair: relabel destructive_op with the parsed classifier.
    const relabel = relabelDestructiveOps(db);
    if (relabel.checked > 0) console.log(`Destructive relabel: ${JSON.stringify(relabel)}`);
    // One-time RC-D14 repair: re-derive is_interrupt / interrupt-cancel from the user Esc record.
    const interrupts = await relabelInterrupts(db);
    if (interrupts.files > 0) console.log(`Interrupt relabel: ${JSON.stringify(interrupts)}`);
    await awaitDbWriteGate(); // the sync repairs below write
    // One-time judge-setup repair: re-flag test runs the old Bash-only, whole-command match missed.
    const testCmd = repairTestCommands(db);
    if (testCmd.checked > 0) console.log(`Test-command repair: ${JSON.stringify(testCmd)}`);
    // P3.1-T3: drop parity-canary rows an older daemon ingested (discovery now skips them).
    const canary = purgeCanaryRows(db);
    if (canary.sessions > 0) console.log(`Canary purge: ${JSON.stringify(canary)}`);
    const merged = mergeWorktreeWorkspaces(db);
    if (merged > 0) console.log(`Worktree workspaces merged: ${merged}`);
    // PRICE-O55: move turns priced under an older tier to the tier their model has now.
    const reprice = repriceTurns(db, new Date().toISOString());
    if (reprice.turns > 0) console.log(`Turn re-price: ${JSON.stringify(reprice)}`);
    const bootIngestor = new Ingestor(db, scanRoots, {
      detectorIdleGate: (at) => detectorBootGate.idleDue(at),
      writeGate,
      onNewMappings: (count) => {
        console.log(`Discovery mapped ${count} new repo(s) — scheduling outcomes pass`);
        runOutcomesPass().catch((e) => {
          console.error(
            `Outcomes pass (new mappings) failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      },
    });
    setHealthInstance(bootIngestor.health);
    // P2-U4: gate readiness on the W0 slice (every file modified in the last 7 days,
    // D4), stopped by its time guard. Older weeks (and a W0b remainder) are
    // backfilled in the background after setReady() (offset-incremental).
    const slices = bootIngestor.planSlices();
    const w0 = slices[0]?.index === 0 ? slices.shift() : undefined;
    // Determinate denominator for the escalation loading screen (BOOT-2).
    bootFilesTotal(w0?.files.length ?? 0);
    pushBootEvent("root", `readiness slice — ${w0?.files.length ?? 0} recent session(s)`);
    w0Complete = w0 === undefined;
    if (w0 !== undefined) {
      const result = await bootIngestor.ingestSlice(w0, firstSliceLimits(process.env));
      if (result.rest.length > 0)
        slices.unshift({ ...w0, files: result.rest }); // W0b
      else w0Complete = true;
    }
    setHistoryCoverage(bootIngestor.historyCoverage());
    pendingSlices = slices;
    ingestor = bootIngestor;
    setScanState("complete");
    pushBootEvent(
      "stage",
      `parse complete — ${getBootProgress().boot_sessions_found} sessions found`,
    );
    setRuntimeResetHook(() => bootIngestor.clearRuntimeState());
    console.log(
      `Ingestion: readiness slice complete — health ${JSON.stringify(bootIngestor.healthSnapshot())}`,
    );
  } catch (e) {
    setScanState("failed");
    console.error(
      `Ingestion failed to start — serving dashboard in degraded mode: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // The bounded readiness slice is not a full historical scan. Keep its
  // probe best-effort, but defer detector evaluation to the post-ready U3 pass.
  pushBootEvent("stage", "building aggregates…");
  await awaitDbWriteGate();
  runProbePass("post-scan");

  // Signal readiness BEFORE the outcomes pass — outcomes is a slow ~97s I/O
  // pass that yields on `gh` subprocess I/O; the SPA must not wait on it.
  pushBootEvent("stage", "ready — opening dashboard");
  setReady();

  // U3/U4: background historical backfill + post-ingest detector pass. Delaying
  // this one-shot to the next turn lets the ready response paint first; the
  // ingestor itself reuses PERF4's 1 MiB chunks and setImmediate boundaries.
  if (ingestor) {
    const bgIngestor = ingestor;

    // U4: non-overlap guard — a retry must not race a still-running pipeline.
    let pipelineRunning = false;
    let tailArmed = false;

    let discoveryArmed = false;
    /** The tail after W0 (P2-U4); discovery only once the pipeline ends, as before. */
    function armTimers(timers: { tail: boolean; discovery: boolean }): void {
      const tail = timers.tail && !tailArmed;
      const discovery = timers.discovery && !discoveryArmed;
      if (!tail && !discovery) return;
      tailArmed ||= tail;
      discoveryArmed ||= discovery;
      const armed = bgIngestor.startTailAfterBackground({ tail, discovery });
      const previous = bgHandle;
      bgHandle = {
        stop() {
          previous?.stop();
          armed.stop();
        },
      };
      if (stopped) bgHandle.stop();
    }

    /**
     * P2-U4: W0 is complete. Arm the tail (it leaves pending slices' files alone) and
     * walk W0 so this week's recs appear now (M7), floored at the complete history.
     */
    let afterW0Done = false;
    function afterW0(): void {
      if (afterW0Done) return;
      afterW0Done = true;
      armTimers({ tail: true, discovery: false });
      const floor = bgIngestor.historyCoverage().complete_through_ms;
      if (floor === null) return;
      detectorBootGate
        .forBoot(backgroundDetectorPass)
        .runIfDue(true, undefined, undefined, floor)
        .then((result) => {
          if (!result.ran) return;
          recordBootMark("w0_walk_end", performance.now());
          diagnosticsSnapshot.markStale();
        })
        .catch((e) => {
          console.warn(`W0 history walk failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    /** Re-runnable pipeline body. Idempotent due to offset-incremental backfill. */
    async function runBackgroundPipeline(): Promise<void> {
      if (pipelineRunning) return;
      pipelineRunning = true;
      try {
        // O-4: "catch-up" is this background historical backfill — the read
        // phase beyond the bounded readiness slice. recordBootMark is
        // first-wins, so only the first pipeline run's marks stick.
        recordBootMark("catch_up_start", performance.now());
        if (w0Complete) afterW0();
        const slices = pendingSlices;
        pendingSlices = undefined;
        sliceLoopRunning = true;
        let progress: BackgroundPipelineProgress;
        try {
          progress = await bgIngestor.runBackgroundBackfill(
            100,
            (snapshot) => {
              setPipelineProgress(snapshot);
              if (
                snapshot.files_completed === 0 ||
                snapshot.files_completed === snapshot.files_total ||
                snapshot.files_completed % 100 === 0
              ) {
                console.log(`Background pipeline: ${JSON.stringify(snapshot)}`);
              }
            },
            {
              ...(slices && { slices }),
              onSlice: (slice, result) => {
                setHistoryCoverage(result.coverage);
                console.log(
                  `Background slice W${slice.index}: ${slice.files.length - result.rest.length} files, ${result.sessions} sessions, reconcile ${Math.round(result.reconcile_ms)} ms / ${result.reconcile_batches} batches, weeks ${result.coverage.weeks_done}/${result.coverage.weeks_total}`,
                );
                if (!w0Complete && result.coverage.complete_through_ms !== null) {
                  w0Complete = true;
                  afterW0();
                }
              },
            },
          );
        } finally {
          sliceLoopRunning = false;
        }
        recordBootMark("catch_up_end", performance.now());
        diagnosticsSnapshot.markStale();
        // O-3: link git commit calls before the detector phase reads commit_sha (budget
        // boot.commit-linker). Best-effort: a failure leaves rows unlinked, never halts the pass.
        await resolveCommitLinks(db)
          .then((r) => console.log(`Commit links: expanded ${r.expanded}, resolved ${r.resolved}`))
          .catch((e) => {
            console.error(
              `Commit linking failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        // Separate try so a detector-phase throw is reported as such, not
        // misattributed to the reading phase. P2H: the history walk runs on every
        // pass (also with files_with_new_data === 0), which covers the restart gap
        // and a retry after a detecting-phase failure.
        try {
          // O-4: the "first detector cycle" — the detecting phase that follows
          // catch-up in this same background pass.
          recordBootMark("first_detector_cycle_start", performance.now());
          await completeBackgroundDetectorPhase(
            progress,
            detectorBootGate.forBoot(backgroundDetectorPass),
            (snapshot) => {
              setPipelineProgress(snapshot);
              console.log(`Background pipeline: ${JSON.stringify(snapshot)}`);
            },
            ({ weeks_done, weeks_total, new_findings }) => {
              console.log(
                reportHistoryWeek({
                  weeksDone: weeks_done,
                  weeksTotal: weeks_total,
                  newFindings: new_findings,
                }),
              );
            },
          );
          if (recordBootMark("first_detector_cycle_end", performance.now())) {
            console.log(`Boot marks (ms): ${formatBootMarks()}`);
          }
          diagnosticsSnapshot.markStale();
        } catch (e) {
          setPipelineFailed("detecting");
          console.error(
            `Background pipeline halted at detecting phase: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } catch (e) {
        setPipelineFailed("reading");
        console.error(
          `Background pipeline halted at reading phase: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        pipelineRunning = false;
        settleBootPipeline();
        // The tail is normally armed after W0; this arms it too if the loop failed first.
        armTimers({ tail: true, discovery: true });
      }
    }

    // Wire the retry hook so the router can re-invoke the pipeline.
    setPipelineRetryHook(() => {
      void runBackgroundPipeline();
    });

    setImmediate(() => {
      void runBackgroundPipeline();
    });
  } else {
    settleBootPipeline();
  }

  // Outcomes bootstrap — deferred until after the back-scan so the event loop
  // is free and readGithubToken() execFile (10 s timeout) cannot be starved.
  // P0-U13 S4: skipped when the last completed pass is within the poll interval.
  outcomesRunner
    .runAtBoot()
    .then((r) => {
      if (r.skipped) console.log("Outcomes bootstrap skipped: last completed pass is recent");
    })
    .catch((e) => {
      console.error(`Outcomes bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    });

  // Self-churn collector (RV9b — L2b) — best-effort, never crash the daemon.
  // Defer synchronous Git work until the dashboard has had time to paint.
  churnTimer = setTimeout(() => {
    if (stopped) return;
    void collectSessionChurn(db).catch((e) => {
      console.error(
        `Self-churn collection failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }, 60_000);
  churnTimer.unref();

  // Deferred boot calibration check (the weekly interval is armed by the
  // lifecycle harness after this scan resolves).
  setImmediate(() => {
    try {
      runBptCalibrationIfStale();
    } catch (e) {
      console.error(
        `Bytes-per-token calibration boot failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  return handle;
}

// ── Lifecycle harness: boot-kick guard, daemon intervals, shutdown ordering ──
// closeServer closes over `server` (declared below); shutdown only ever runs
// after listen, so the reference is initialized by then.
const idleCheckpoint = createIdleCheckpointer(db);
const lifecycle = createDaemonLifecycle({
  bootScan: runBootScan,
  idleCheckpointTick: () => {
    // A checkpoint is a write too; the worker's in flight: the next tick retries.
    if (walCheckpointer.inFlight()) return;
    idleCheckpoint.tick();
  },
  calibrationTick: runBptCalibrationIfStale,
  outcomesTick: () => {
    runOutcomesPass().catch((e) => {
      console.error(`Outcomes poll failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  },
  outcomesIntervalMs: OUTCOMES_POLL_INTERVAL_MS,
  // P0-U4: async-then-sync — await the worker-built recs snapshot, then call
  // the still-synchronous generateWeeklyReport with it (see reports.ts).
  reportsTick: () =>
    recsSnapshot.get().then(async (recs) => {
      await awaitDbWriteGate();
      return generateWeeklyReport(db, new Date(), recs.data ?? undefined);
    }),
  bootFallbackMs: 100,
  closeServer: (onClosed) => server.close(onClosed),
  closeDb: () => {
    heavyJobGate.stop();
    historyWorkers.stop();
    recsSnapshot.stop();
    diagnosticsSnapshot.stop();
    headroomSnapshot.stop();
    routeSnapshot.stop();
    void stopScanWorkers();
    void walCheckpointer.stop();
    stopPerfMonitor();
    db.close();
  },
  onClosed: () => process.exit(0),
});

// ── 4. Start HTTP server ──────────────────────────────────────────────────────
// Bind the port BEFORE the back-scan so the SPA is delivered immediately while
// the initial scan yields between file batches.
// Generate a random in-memory session token for the CSRF token gate.
// NEVER log it, NEVER persist it — it lives only in process memory.
const sessionToken = randomUUID();
const server: http.Server = createServer(
  db,
  config.port,
  config.uiRoot,
  sessionToken,
  lifecycle.kickBootScan,
  outcomesControl,
  recsSnapshot,
  diagnosticsSnapshot,
  routeSnapshot,
  headroomSnapshot,
);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  // P3-U8 R-8: another process holds the port (another daemon on a different DB, or another app).
  console.error(
    `AgentWrangler: port ${config.port} is already in use. Stop that process or pass --port <n>.`,
  );
  process.exit(1);
});
server.listen(config.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`Listening on ${url}`);
  recordBootMark("listen", performance.now());
  // P0-U4: the boot probe pass + weekly-report bootstrap, deferred until now so
  // neither can delay time-to-listen. Two separate setTimeout(0) macrotasks,
  // probe first — see runDeferredProbePass/runDeferredReportBootstrap above for
  // why they must not share one await chain.
  setTimeout(() => {
    runDeferredProbePass();
  }, 0);
  setTimeout(() => {
    void runDeferredReportBootstrap();
  }, 0);
  // ADOPT-1b: build the all-scope recommendations snapshot once the first pass has settled
  // (RB1-A: one build per boot). A page load before then builds on demand.
  void prewarmRecsSnapshot(recsSnapshot, bootPipelineSettled);
  // KTD-6: pre-warm Diagnostics 7d then 30d, one at a time so they don't compete for the CPU.
  // The 30d waits for the boot pipeline: building it alongside the back-scan doubled its time.
  void diagnosticsSnapshot
    .prewarm(7)
    .then(() => bootPipelineSettled)
    .then(() => diagnosticsSnapshot.prewarm(30));

  // ── 5. Auto-open browser ──────────────────────────────────────────────────
  // Opens immediately onto the SPA, which renders its own boot state.
  if (!noOpen) {
    openBrowser(url);
  }

  // Backstop for headless, --no-open, and CI boots with no SPA navigation.
  // The one-shot guard makes this safe alongside the navigation-triggered kick.
  lifecycle.armBootFallback();
});

/** Open `url` in the system default browser (best-effort; never crashes the daemon). */
function openBrowser(url: string): void {
  import("node:child_process")
    .then(({ exec }) => {
      const cmd =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd, { windowsHide: true }, (err) => {
        if (err) console.warn(`auto-open: ${err.message}`);
      });
    })
    .catch(() => {
      // child_process unavailable — skip silently.
    });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("Shutting down…");
  lifecycle.shutdown();
});

process.on("SIGTERM", () => {
  lifecycle.shutdown();
});
