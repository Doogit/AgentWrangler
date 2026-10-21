/**
 * src/daemon/schedule-job.ts — P0-U14: the one entry point for recurring
 * daemon timers. A thin wrapper over setInterval (same period, same ordering,
 * same callback) that records each run's wall time under a budgeted job name
 * (job-budgets.ts). Not a lane scheduler — that stays ADR-113 / Phase 1+.
 *
 * A callback that returns a promise is timed to settlement. A throw (or
 * rejection) is recorded and then propagates exactly as it would from a raw
 * setInterval callback. Aggregate-only (SEC-101): names and durations.
 */

import type { JobName } from "./job-budgets.js";

export type { JobName } from "./job-budgets.js";

export interface JobStats {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

export interface JobHandle {
  cancel(): void;
}

let stats = new Map<string, JobStats>();

function record(name: string, durationMs: number): void {
  const prev = stats.get(name);
  stats.set(name, {
    count: (prev?.count ?? 0) + 1,
    totalMs: (prev?.totalMs ?? 0) + durationMs,
    lastMs: durationMs,
    maxMs: Math.max(prev?.maxMs ?? 0, durationMs),
  });
}

/**
 * Runs `fn` every `periodMs` (interval semantics) and records its run time
 * under `name`. `opts.unref` unrefs the timer so it cannot hold the process
 * open (default: ref'd, as a raw setInterval).
 */
export function scheduleJob(
  name: JobName,
  periodMs: number,
  fn: () => unknown,
  opts: { unref?: boolean } = {},
): JobHandle {
  const timer = setInterval(() => {
    const start = performance.now();
    let result: unknown;
    try {
      result = fn();
    } catch (e) {
      record(name, performance.now() - start);
      throw e;
    }
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      return (result as Promise<unknown>).then(
        (v) => {
          record(name, performance.now() - start);
          return v;
        },
        (e: unknown) => {
          record(name, performance.now() - start);
          throw e;
        },
      );
    }
    record(name, performance.now() - start);
    return undefined;
  }, periodMs);
  if (opts.unref) timer.unref();
  return { cancel: () => clearInterval(timer) };
}

/** Recorded run stats by job name. */
export function getJobStats(): Record<string, JobStats> {
  return Object.fromEntries(stats);
}

/** Test-only: clear recorded job stats between tests. */
export function resetJobStats(): void {
  stats = new Map();
}
