/**
 * src/daemon/wal-checkpointer.ts — P2-U4b: WAL checkpoints run off the main thread.
 *
 * SQLite's auto-checkpoint runs inside a commit on the committing connection. On the main connection
 * that is a page copy plus an fsync on the event loop (ingest steps of 270–1,249 ms on X). So the main
 * connection turns it off, and a worker connection runs wal_checkpoint(PASSIVE) every `periodMs`.
 * PASSIVE takes no writer lock and copies only frames no reader still needs, so main keeps writing;
 * main's next write restarts the WAL once every frame is copied.
 *
 * A PASSIVE racing a steady writer never copies every frame, so the WAL would never restart (on a
 * 32 MiB test write the -wal file held all of it). Ingest therefore awaits `writeGate()` before each
 * write step: while a checkpoint is in flight it waits on a promise, so the event loop stays free and
 * the WAL is bounded by one period's writes plus one step. Every other main-thread write awaits the
 * same gate through src/db/write-gate.ts: on Windows a write that extends the -wal file blocks behind
 * the worker's flush of it, which stalled the event loop for seconds on a slow disk.
 *
 * The trigger is time, not -wal size: the file keeps its high-water size after a restart, so its size
 * cannot tell how many frames are waiting. A PASSIVE with nothing to copy is a cheap no-op.
 * If the worker dies, main gets its auto-checkpoint back so the WAL stays bounded.
 * P0-U5's idle checkpoint (src/db/idle-checkpoint.ts) is a RESTART, so the -wal keeps its size.
 */

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { Db } from "../db/open.js";
import { type WalCheckpointGauge, recordWalCheckpoint } from "./perf-monitor.js";
import { scheduleJob } from "./schedule-job.js";

export const WAL_CHECKPOINT_PERIOD_MS = 1_000;
const SQLITE_DEFAULT_AUTOCHECKPOINT = 1000;

export interface WalCheckpointer {
  /** True while a checkpoint request is out with the worker. */
  inFlight(): boolean;
  /** Resolves when the in-flight checkpoint finishes; null when none is in flight. */
  writeGate(): Promise<void> | null;
  stats(): WalCheckpointGauge;
  stop(): Promise<void>;
}

/** A positive ms value from `name`, honoured only under AW_TEST_HOOKS=1 (the write-gate check run). */
function testHookMs(name: string): number | undefined {
  if (process.env.AW_TEST_HOOKS !== "1") return undefined;
  const ms = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function startWalCheckpointer(
  db: Db,
  dbPath: string,
  /** `delayMs` (test seam): hold every checkpoint in flight this long after it runs. */
  opts: { periodMs?: number; delayMs?: number } = {},
): WalCheckpointer {
  db.pragma("wal_autocheckpoint = 0");
  const builtUrl = new URL("./wal-checkpoint-worker.js", import.meta.url);
  const sourceMode = !existsSync(builtUrl);
  const delayMs = opts.delayMs ?? testHookMs("AW_TEST_WAL_CHECKPOINT_DELAY_MS") ?? 0;
  const worker = new Worker(
    sourceMode ? new URL("./wal-checkpoint-worker.ts", import.meta.url) : builtUrl,
    {
      workerData: { dbPath, delayMs },
      ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
    },
  );
  worker.unref();
  const stats: WalCheckpointGauge = { count: 0, lastMs: 0, maxMs: 0 };
  let gate: Promise<void> | null = null;
  let openGate = (): void => {};
  let stopped = false;
  const release = (): void => {
    gate = null;
    openGate();
  };
  const kick = scheduleJob(
    "db.wal-checkpoint-kick",
    opts.periodMs ?? testHookMs("AW_TEST_WAL_CHECKPOINT_PERIOD_MS") ?? WAL_CHECKPOINT_PERIOD_MS,
    () => {
      if (gate) return;
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      worker.postMessage(null);
    },
    { unref: true },
  );
  worker.on("message", ({ ms }: { ms: number }) => {
    release();
    stats.count++;
    stats.lastMs = ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    recordWalCheckpoint(ms);
  });
  const fallBack = (): void => {
    kick.cancel();
    release();
    if (!stopped && db.open) db.pragma(`wal_autocheckpoint = ${SQLITE_DEFAULT_AUTOCHECKPOINT}`);
  };
  worker.once("error", (error) => {
    console.error(`WAL checkpoint worker failed (${error.message}); main auto-checkpoints again`);
    fallBack();
  });
  worker.once("exit", fallBack);
  return {
    inFlight: () => gate !== null,
    writeGate: () => gate,
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      kick.cancel();
      release();
      await worker.terminate();
    },
  };
}
