/**
 * src/daemon/lifecycle.ts — daemon timer registration and graceful shutdown.
 *
 * Extracted from daemon/index.ts (PERF5) so the boot-kick guard, the three
 * daemon-owned intervals (calibration / outcomes / weekly reports), and the
 * shutdown ordering are deterministically unit-testable without booting the
 * daemon. The signal handlers in index.ts stay thin: both call shutdown().
 *
 * Shutdown contract:
 *   - idempotent — a second signal is a no-op
 *   - clears the boot-fallback timeout so a shutdown during the 3 s window
 *     cannot start a scan afterwards
 *   - a pending boot-kick setImmediate checks the flag and never starts the
 *     scan after shutdown
 *   - when shutdown lands while the boot scan is still in flight, the timers
 *     are never armed and the tail handle is stopped as soon as the scan
 *     resolves (previously both leaked past db.close())
 *   - stopping the tail does NOT drain a suspended tail pass; the Ingestor's
 *     stopped flag makes it quit at the next file boundary (its contract)
 */

import { type JobHandle, scheduleJob } from "./schedule-job.js";

export interface TailHandleLike {
  stop(): void;
}

export interface LifecycleDeps {
  /** Yielding boot scan; resolves with the tail handle, or null when ingestion failed to start. */
  bootScan(): Promise<TailHandleLike | null>;
  /** Weekly bytes-per-token calibration tick (internally gated on opt-in + staleness). */
  calibrationTick(): void;
  /** 10-minute outcomes poll tick (fire-and-forget; the runner has its own skip-guard). */
  outcomesTick(): void;
  /** Weekly report generation (overlap-guarded here); a returned promise is awaited. */
  reportsTick(): unknown;
  /** P0-U5: 30 s check that truncates the WAL once the DB has been write-idle for 60 s. */
  idleCheckpointTick?(): void;
  /** server.close — invoke `onClosed` once all connections have drained. */
  closeServer(onClosed: () => void): void;
  closeDb(): void;
  /** Runs after closeDb (production: process.exit(0)). */
  onClosed?: () => void;
  error?: (msg: string) => void;
  calibrationIntervalMs?: number;
  outcomesIntervalMs?: number;
  reportsIntervalMs?: number;
  idleCheckpointIntervalMs?: number;
  bootFallbackMs?: number;
}

export interface DaemonLifecycle {
  /** One-shot: schedules the boot scan on the next macrotask. Safe to call repeatedly. */
  kickBootScan(): void;
  /** Arms the fallback timeout that kicks the boot scan when no request arrives. */
  armBootFallback(): void;
  /** Graceful shutdown; idempotent across both signals. */
  shutdown(): void;
  readonly isShutDown: boolean;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function createDaemonLifecycle(deps: LifecycleDeps): DaemonLifecycle {
  const error = deps.error ?? ((msg: string) => console.error(msg));
  const calibrationIntervalMs = deps.calibrationIntervalMs ?? WEEK_MS;
  const outcomesIntervalMs = deps.outcomesIntervalMs ?? 10 * 60 * 1000;
  const reportsIntervalMs = deps.reportsIntervalMs ?? WEEK_MS;
  const idleCheckpointIntervalMs = deps.idleCheckpointIntervalMs ?? 30_000;
  const bootFallbackMs = deps.bootFallbackMs ?? 3000;

  let scanKicked = false;
  let shutDown = false;
  let handle: TailHandleLike | null = null;
  let calibrationTimer: JobHandle | null = null;
  let outcomesTimer: JobHandle | null = null;
  let reportsTimer: JobHandle | null = null;
  let idleCheckpointTimer: JobHandle | null = null;
  let fallbackTimer: NodeJS.Timeout | null = null;
  let reportsRunning = false;

  function armTimers(): void {
    calibrationTimer = scheduleJob("lifecycle.calibration-tick", calibrationIntervalMs, () => {
      try {
        deps.calibrationTick();
      } catch (e) {
        error(
          `Bytes-per-token calibration poll failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    outcomesTimer = scheduleJob("lifecycle.outcomes-tick", outcomesIntervalMs, () => {
      try {
        deps.outcomesTick();
      } catch (e) {
        error(`Outcomes poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    reportsTimer = scheduleJob("lifecycle.reports-tick", reportsIntervalMs, () => {
      if (reportsRunning) return;
      reportsRunning = true;
      return Promise.resolve()
        .then(() => deps.reportsTick())
        .catch((e) => {
          error(`Weekly report poll failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          reportsRunning = false;
        });
    });

    const idleTick = deps.idleCheckpointTick;
    if (idleTick !== undefined) {
      idleCheckpointTimer = scheduleJob(
        "lifecycle.wal-idle-checkpoint",
        idleCheckpointIntervalMs,
        () => {
          try {
            idleTick();
          } catch (e) {
            error(
              `WAL idle checkpoint failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
        { unref: true },
      );
    }
  }

  function kickBootScan(): void {
    if (scanKicked || shutDown) return;
    scanKicked = true;
    // setImmediate so the triggering HTTP response flushes before boot work
    // starts. The scan itself also yields between bounded batches.
    setImmediate(() => {
      if (shutDown) return;
      deps
        .bootScan()
        .then((h) => {
          handle = h;
          if (shutDown) {
            // Shutdown landed mid-scan: never arm timers; stop the tail now.
            handle?.stop();
            handle = null;
            return;
          }
          armTimers();
        })
        .catch((e) => {
          error(`Boot scan failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    });
  }

  function shutdown(): void {
    if (shutDown) return;
    shutDown = true;
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    handle?.stop();
    handle = null;
    calibrationTimer?.cancel();
    outcomesTimer?.cancel();
    reportsTimer?.cancel();
    idleCheckpointTimer?.cancel();
    deps.closeServer(() => {
      deps.closeDb();
      deps.onClosed?.();
    });
  }

  return {
    kickBootScan,
    armBootFallback(): void {
      fallbackTimer = setTimeout(kickBootScan, bootFallbackMs);
    },
    shutdown,
    get isShutDown(): boolean {
      return shutDown;
    },
  };
}
