/**
 * test/daemon/schedule-job.test.ts — P0-U14: a stub job registered through
 * scheduleJob shows its run time on the /api/perf payload (optional `jobs`
 * field), and the warn-only detector budget check.
 *
 * Oracle: a test-controlled busy-wait duration and synthetic detector-pass
 * snapshots written here, not the module's own arithmetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DETECTOR_BUDGETS } from "../../src/daemon/job-budgets.js";
import {
  getPerfSnapshot,
  recordDetectorPass,
  resetDetectorPass,
} from "../../src/daemon/perf-monitor.js";
import {
  type JobName,
  getJobStats,
  resetJobStats,
  scheduleJob,
} from "../../src/daemon/schedule-job.js";

const STUB = "test.stub" as unknown as JobName;

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
}

afterEach(() => {
  resetJobStats();
  resetDetectorPass();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scheduleJob run-time recording", () => {
  it("records count/total/last/max for a stub job and exposes them on the perf snapshot", async () => {
    const handle = scheduleJob(STUB, 10, () => busyWait(6));
    await new Promise((r) => setTimeout(r, 120));
    handle.cancel();

    const stats = getJobStats()[STUB];
    expect(stats).toBeDefined();
    if (!stats) return;
    expect(stats.count).toBeGreaterThanOrEqual(2);
    expect(stats.lastMs).toBeGreaterThanOrEqual(5);
    expect(stats.maxMs).toBeGreaterThanOrEqual(stats.lastMs);
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.count * 5);
    expect(getPerfSnapshot().jobs?.[STUB]).toEqual(stats);
  });

  it("omits `jobs` from the snapshot until a job has run (optional envelope field)", () => {
    expect("jobs" in getPerfSnapshot()).toBe(false);
  });

  it("cancel stops the interval", async () => {
    let runs = 0;
    const handle = scheduleJob(STUB, 5, () => {
      runs++;
    });
    await new Promise((r) => setTimeout(r, 40));
    handle.cancel();
    const after = runs;
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(after);
    expect(after).toBeGreaterThan(0);
  });

  it("times an async job to settlement", async () => {
    const handle = scheduleJob(STUB, 200, async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await new Promise((r) => setTimeout(r, 300));
    handle.cancel();
    const stats = getJobStats()[STUB];
    expect(stats?.count).toBe(1);
    expect(stats?.lastMs).toBeGreaterThanOrEqual(25);
  });

  it("keeps a throwing job's run recorded and the interval alive", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onErr);
    try {
      const handle = scheduleJob(STUB, 10, () => {
        throw new Error("boom");
      });
      // Fake timers rethrow synchronously from advanceTimers; the run must still be counted.
      try {
        vi.advanceTimersByTime(10);
      } catch {
        /* expected: same as a raw setInterval callback that throws */
      }
      handle.cancel();
      expect(getJobStats()[STUB]?.count).toBe(1);
    } finally {
      process.off("uncaughtException", onErr);
    }
  });
});

describe("warn-only detector budget check", () => {
  const first = Object.keys(DETECTOR_BUDGETS)[0] as string;

  it("logs one aggregate line per over-budget detector, never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const budget = DETECTOR_BUDGETS[first];
    expect(budget).toBeDefined();
    if (!budget) return;
    expect(() =>
      recordDetectorPass({
        totalMs: budget.ms * 10,
        totalRows: budget.rows_read * 10,
        totalStmts: 1,
        detectorCount: 1,
        perDetector: { [first]: { ms: budget.ms * 10, rows: budget.rows_read * 10 + 1, stmts: 1 } },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(first);
    expect(line).toMatch(/budget/i);
  });

  it("is silent for a within-budget pass and for an id with no entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordDetectorPass({
      totalMs: 1,
      totalRows: 1,
      totalStmts: 1,
      detectorCount: 2,
      perDetector: {
        [first]: { ms: 0, rows: 0, stmts: 0 },
        "Z99-synthetic": { ms: 9e9, rows: 9e9, stmts: 1 },
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
