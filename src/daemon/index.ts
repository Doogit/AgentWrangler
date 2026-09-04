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
import type * as http from "node:http";
import process from "node:process";
import { runMigrations } from "../db/migrate.js";
import { openDb } from "../db/open.js";
import { configGet as bptConfigGet, calibrateBytesPerToken } from "../detector/calibration.js";
import { runContextProbe } from "../detector/context-probe.js";
import { runDetectors } from "../detector/index.js";
import { runMeasurementPass } from "../detector/measurement.js";
import { installHook, uninstallHook } from "../hook/install.js";
import { collectSessionChurn } from "../ingest/churn-collector.js";
import { runPostProbeHook, setPostIngestHook, setPostProbeHook } from "../ingest/detector-hook.js";
import { Ingestor } from "../ingest/index.js";
import type { TailHandle } from "../ingest/index.js";
import { writeObservedOutcomes } from "../outcomes/derive.js";
import { extractAllFindings } from "../outcomes/findings.js";
import { readGithubToken } from "../outcomes/github/credential.js";
import { GhCliClient } from "../outcomes/github/gh-cli-client.js";
import { linkSessions } from "../outcomes/linker.js";
import { syncAllWorkspaces } from "../outcomes/sync.js";
import { generateWeeklyReport } from "../query/api/reports.js";
import { setQueryDb } from "../query/db-context.js";
import { setHealthInstance, setRuntimeResetHook } from "../query/settings-store.js";
import { loadConfig } from "./config.js";
import { createServer } from "./http.js";
import { type OutcomesPassResult, createOutcomesPassRunner } from "./outcomes-pass.js";
import { setReady } from "./readiness.js";

const VERSION = "0.1.0";

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

// ── 1. Open DB ────────────────────────────────────────────────────────────────
const db = openDb(config.dbPath);
console.log("DB  : opened (WAL + FK)");

// ── 2. Run migrations ─────────────────────────────────────────────────────────
const applied = runMigrations(db);
if (applied.length > 0) {
  console.log(`Migrations applied: ${applied.join(", ")}`);
} else {
  console.log("Migrations: up to date");
}

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
    "apply_jobs",
    "analysis_runs",
    "ingest_quarantine",
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

// Populate the current ISO week's deterministic report at startup. This is a
// best-effort local aggregate snapshot and never blocks daemon availability.
try {
  generateWeeklyReport(db, new Date());
} catch (e) {
  console.error(`Weekly report bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
}

// Wire the post-ingest detector pass BEFORE startTail so the initial back-scan
// already produces recommendations. runDetectors receives the ingestor's
// injected clock (deterministic; NFR-107 / Review F4), never new Date().
setPostIngestHook((detectorDb, now) => runDetectors(detectorDb, { now }));

// ── Context probe (best-effort, never crash daemon) ──────────────────────────
// Run before startTail so the first detector pass sees inventory.
// Re-run inside the outcomes poll cadence so inventory stays fresh.
function runProbePass(label: string): void {
  try {
    const now = new Date();
    const { rows } = runContextProbe(db, now);
    console.log(`ContextProbe[${label}]: ${rows} row(s) upserted`);
    // W4: measurement pass after each probe (best-effort; the seam never throws
    // through, and runMeasurementPass itself is guarded/log-not-throw).
    runPostProbeHook(db, now);
  } catch (e) {
    console.log(`ContextProbe[${label}]: skipped — ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Wire the W4 Impact Ledger measurement pass onto the post-probe seam. The pass
// receives the probe's clock (deterministic; NFR-107), is throttled internally.
setPostProbeHook((probeDb, now) => {
  runMeasurementPass(probeDb, now);
});

runProbePass("boot");

// ── Outcomes bootstrap (WP5 — best-effort, never crash daemon) ────────────────
// Pattern mirrors ingestion boot: try/catch in pass body, degraded mode on failure.
// The runner (src/daemon/outcomes-pass.ts) adds a hard 15-min per-pass deadline:
// a hung pass can no longer wedge the poll cadence forever — the running flag
// always clears and the next poll resumes.
let outcomesTimer: NodeJS.Timeout | null = null;
let reportsTimer: NodeJS.Timeout | null = null;
let reportsRunning = false;
let bptCalibrationTimer: NodeJS.Timeout | null = null;

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

function runOutcomesPass(): Promise<OutcomesPassResult> {
  return outcomesRunner.run();
}

// ── Deferred boot scan (runs AFTER the HTTP port is bound) ───────────────────
// startTailBatched() performs a yielding initial back-scan (ingestAllKnown +
// reconcile), then arms the tail/discovery timers. We do NOT
// also call runBackscan — that would spin up a second Ingestor whose separate
// Health instance is the one surfaced in Settings. One Ingestor, one Health.
// Bounded: if ingestion fails to start, still serve the dashboard (degraded).
let handle: TailHandle | null = null;

// One-shot guard: runBootScan executes exactly once regardless of how many
// requests or timers fire kickBootScan concurrently.
let scanKicked = false;

function kickBootScan(): void {
  if (scanKicked) return;
  scanKicked = true;
  // Use setImmediate so the triggering HTTP response flushes before boot work
  // starts. The scan itself also yields between bounded batches.
  setImmediate(() => {
    runBootScan().catch((e) => {
      console.error(`Boot scan failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
}

async function runBootScan(): Promise<void> {
  try {
    const ingestor = new Ingestor(db, config.scanRoots, {
      onNewMappings: (count) => {
        console.log(`Discovery mapped ${count} new repo(s) — scheduling outcomes pass`);
        runOutcomesPass().catch((e) => {
          console.error(
            `Outcomes pass (new mappings) failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      },
    });
    setHealthInstance(ingestor.health);
    handle = await ingestor.startTailBatched();
    setRuntimeResetHook(() => ingestor.clearRuntimeState());
    console.log(
      `Ingestion: initial scan complete — health ${JSON.stringify(ingestor.healthSnapshot())}`,
    );
  } catch (e) {
    console.error(
      `Ingestion failed to start — serving dashboard in degraded mode: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // After the initial back-scan, workspaces are discovered — re-probe so per-workspace
  // sources (project memory, project CLAUDE.md) are captured even on a cold DB, where the
  // boot probe ran before any workspace existed and could only size the global sources.
  // Then re-evaluate detectors so D1 surfaces its per-source context recs on the first run
  // instead of waiting for the next 10-minute poll.
  runProbePass("post-scan");
  try {
    runDetectors(db, { now: new Date() });
  } catch (e) {
    console.error(
      `Post-scan detector pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Signal readiness BEFORE the outcomes pass — outcomes is a slow ~97s I/O
  // pass that yields on `gh` subprocess I/O; the loading page must not wait on it.
  setReady();

  // Outcomes bootstrap — deferred until after the back-scan so the event loop
  // is free and readGithubToken() execFile (10 s timeout) cannot be starved.
  runOutcomesPass().catch((e) => {
    console.error(`Outcomes bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Self-churn collector (RV9b — L2b) — best-effort, never crash the daemon.
  // Synchronous git reader; deferred via setImmediate so it never blocks
  // readiness or the outcomes pass.
  setImmediate(() => {
    try {
      collectSessionChurn(db);
    } catch (e) {
      console.error(
        `Self-churn collection failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  // R12 bytes→token calibration — best-effort, never crash the daemon.
  // Runs on boot (deferred) and weekly when: opt-in enabled AND ratio is absent
  // or older than 30 days. Mirrors the outcomes bootstrap pattern.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  function runBptCalibrationIfStale(): void {
    const enabled = bptConfigGet(db, "bytes_per_token_calibration_enabled");
    if (enabled !== "true") return;
    const measuredAt = bptConfigGet(db, "bytes_per_token_measured_at");
    if (measuredAt !== null && Date.now() - new Date(measuredAt).getTime() < THIRTY_DAYS_MS) return;
    calibrateBytesPerToken(db).catch((e) => {
      console.error(
        `Bytes-per-token calibration failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  setImmediate(() => {
    try {
      runBptCalibrationIfStale();
    } catch (e) {
      console.error(
        `Bytes-per-token calibration boot failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  bptCalibrationTimer = setInterval(
    () => {
      try {
        runBptCalibrationIfStale();
      } catch (e) {
        console.error(
          `Bytes-per-token calibration poll failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    7 * 24 * 60 * 60 * 1000, // weekly
  );

  // 10-minute poll — guarded by outcomesRunning to prevent overlap
  outcomesTimer = setInterval(
    () => {
      runOutcomesPass().catch((e) => {
        console.error(`Outcomes poll failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    10 * 60 * 1000,
  );

  reportsTimer = setInterval(
    async () => {
      if (reportsRunning) return;
      reportsRunning = true;
      try {
        await Promise.resolve(generateWeeklyReport(db, new Date()));
      } catch (e) {
        console.error(`Weekly report poll failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        reportsRunning = false;
      }
    },
    7 * 24 * 60 * 60 * 1000,
  );
}

// ── 4. Start HTTP server ──────────────────────────────────────────────────────
// Bind the port BEFORE the back-scan so the loading page is delivered
// immediately while the initial scan yields between file batches.
// Generate a random in-memory session token for the CSRF token gate.
// NEVER log it, NEVER persist it — it lives only in process memory.
const sessionToken = randomUUID();
const server: http.Server = createServer(
  db,
  config.port,
  config.uiRoot,
  sessionToken,
  kickBootScan,
);
server.listen(config.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`Listening on ${url}`);

  // ── 5. Auto-open browser ──────────────────────────────────────────────────
  // Opens immediately onto the loading page; the page's poll loop will reload
  // once /api/ready returns { ready: true }.
  if (!noOpen) {
    openBrowser(url);
  }

  // Fallback: kick the back-scan after 3 s even if no browser request arrives
  // (headless mode, --no-open, CI). The one-shot guard in kickBootScan() makes
  // whichever trigger fires first the only one that runs the scan.
  setTimeout(kickBootScan, 3000);
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
      exec(cmd, (err) => {
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
  handle?.stop();
  if (outcomesTimer !== null) clearInterval(outcomesTimer);
  if (reportsTimer !== null) clearInterval(reportsTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  handle?.stop();
  if (outcomesTimer !== null) clearInterval(outcomesTimer);
  if (reportsTimer !== null) clearInterval(reportsTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
