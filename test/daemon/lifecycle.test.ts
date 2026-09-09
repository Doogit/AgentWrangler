/**
 * test/daemon/lifecycle.test.ts — daemon lifecycle harness: timer registration
 * and graceful shutdown (PERF5).
 *
 * Covers, with fake clocks and injected synthetic jobs:
 *   - one-shot boot kick (concurrent kicks run the scan once)
 *   - the three daemon intervals arm only after the boot scan resolves and
 *     fire at their cadences (calibration / outcomes / reports)
 *   - the weekly-reports overlap guard skips a tick while one is pending
 *   - a throwing tick is non-fatal (the interval keeps firing)
 *   - shutdown clears ALL intervals — including calibration (the leak this
 *     branch fixes) — and orders tail-stop → server close → db close → exit
 *   - shutdown is idempotent across both signals (second call is a no-op)
 *   - shutdown during boot-in-progress: timers never arm; the tail handle is
 *     stopped when the scan resolves (previously both leaked past db.close())
 *   - a pending boot-kick immediate after shutdown never starts the scan
 *   - the boot fallback timeout kicks the scan; shutdown first clears it
 *   - a degraded scan (null tail handle) shuts down cleanly
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonLifecycle } from "../../src/daemon/lifecycle.js";
import type { LifecycleDeps, TailHandleLike } from "../../src/daemon/lifecycle.js";

const CAL_MS = 700;
const OUT_MS = 100;
const REP_MS = 300;
const FALLBACK_MS = 50;

interface Harness {
  deps: LifecycleDeps;
  calls: string[];
  tailStops: number;
  resolveScan: (handle: TailHandleLike | null) => void;
}

function makeHarness(overrides: Partial<LifecycleDeps> = {}): Harness {
  const calls: string[] = [];
  const h: Harness = {
    calls,
    tailStops: 0,
    resolveScan: () => {},
    deps: {} as LifecycleDeps,
  };
  h.deps = {
    bootScan: () => {
      calls.push("boot-scan");
      return new Promise<TailHandleLike | null>((resolve) => {
        h.resolveScan = resolve;
      });
    },
    calibrationTick: () => calls.push("calibration"),
    outcomesTick: () => calls.push("outcomes"),
    reportsTick: () => calls.push("reports"),
    closeServer: (onClosed) => {
      calls.push("server-close");
      onClosed();
    },
    closeDb: () => calls.push("db-close"),
    onClosed: () => calls.push("exit"),
    error: () => {},
    calibrationIntervalMs: CAL_MS,
    outcomesIntervalMs: OUT_MS,
    reportsIntervalMs: REP_MS,
    bootFallbackMs: FALLBACK_MS,
    ...overrides,
  };
  return h;
}

/** Kick the scan and let it resolve with the tail handle. */
async function bootTo(h: Harness, lc: ReturnType<typeof createDaemonLifecycle>): Promise<void> {
  lc.kickBootScan();
  await vi.advanceTimersByTimeAsync(0); // flush the kick immediate
  h.resolveScan({
    stop: () => {
      h.tailStops++;
      h.calls.push("tail-stop");
    },
  });
  await vi.advanceTimersByTimeAsync(0); // flush the .then arming the timers
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createDaemonLifecycle — boot kick", () => {
  it("runs the boot scan exactly once across concurrent kicks", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan();
    lc.kickBootScan();
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c === "boot-scan")).toHaveLength(1);
  });

  it("does not arm any interval before the boot scan resolves", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(CAL_MS * 2); // scan still pending
    expect(h.calls).toEqual(["boot-scan"]);
  });

  it("the fallback timeout kicks the scan when no request arrives", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.armBootFallback();
    await vi.advanceTimersByTimeAsync(FALLBACK_MS);
    await vi.runAllTimersAsync(); // flush the kick immediate queued by the timeout
    expect(h.calls).toEqual(["boot-scan"]);
  });
});

describe("createDaemonLifecycle — armed intervals", () => {
  it("fires calibration, outcomes, and reports at their cadences after boot", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    await bootTo(h, lc);
    h.calls.length = 0;

    await vi.advanceTimersByTimeAsync(OUT_MS); // 100
    expect(h.calls).toEqual(["outcomes"]);
    await vi.advanceTimersByTimeAsync(REP_MS - OUT_MS); // 300
    expect(h.calls).toEqual(["outcomes", "outcomes", "outcomes", "reports"]);
    await vi.advanceTimersByTimeAsync(CAL_MS - REP_MS); // 700
    expect(h.calls.filter((c) => c === "calibration")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "reports")).toHaveLength(2);
    expect(h.calls.filter((c) => c === "outcomes")).toHaveLength(7);
  });

  it("skips a reports tick while the previous one is still pending", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    let started = 0;
    h.deps.reportsTick = () => {
      started++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const lc = createDaemonLifecycle(h.deps);
    await bootTo(h, lc);

    await vi.advanceTimersByTimeAsync(REP_MS); // first tick: starts, stays pending
    await vi.advanceTimersByTimeAsync(REP_MS); // second tick: guarded, skipped
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(REP_MS); // guard released: runs again
    expect(started).toBe(2);
  });

  it("a throwing tick is non-fatal and the interval keeps firing", async () => {
    const errors: string[] = [];
    const h = makeHarness({ error: (m) => errors.push(m) });
    h.deps.calibrationTick = () => {
      throw new Error("calibration boom");
    };
    const lc = createDaemonLifecycle(h.deps);
    await bootTo(h, lc);

    await vi.advanceTimersByTimeAsync(CAL_MS * 2);
    expect(errors.filter((m) => m.includes("calibration boom"))).toHaveLength(2);
  });
});

describe("createDaemonLifecycle — shutdown", () => {
  it("clears all three intervals, including calibration, and orders the close", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    await bootTo(h, lc);
    h.calls.length = 0;

    lc.shutdown();
    expect(h.calls).toEqual(["tail-stop", "server-close", "db-close", "exit"]);

    // No interval survives — a whole calibration period passes silently.
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(CAL_MS * 2);
    expect(h.calls).toEqual([]);
  });

  it("is idempotent across both signals — the second shutdown is a no-op", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    await bootTo(h, lc);
    h.calls.length = 0;

    lc.shutdown(); // SIGINT
    lc.shutdown(); // SIGTERM
    expect(h.calls.filter((c) => c === "server-close")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "db-close")).toHaveLength(1);
    expect(h.tailStops).toBe(1);
    expect(lc.isShutDown).toBe(true);
  });

  it("during boot-in-progress: never arms timers, stops the tail on scan resolve", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0); // scan started, still pending

    lc.shutdown();
    expect(h.calls).toContain("server-close");
    expect(h.tailStops).toBe(0); // no handle yet

    h.resolveScan({
      stop: () => {
        h.tailStops++;
        h.calls.push("tail-stop");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.tailStops).toBe(1); // stopped as soon as it existed

    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(CAL_MS * 2);
    expect(h.calls).toEqual([]); // no interval was ever armed
  });

  it("a pending boot-kick immediate after shutdown never starts the scan", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan(); // immediate queued, not yet run
    lc.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c === "boot-scan")).toHaveLength(0);
  });

  it("clears the armed boot fallback so no scan starts after shutdown", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.armBootFallback();
    lc.shutdown();
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    expect(h.calls.filter((c) => c === "boot-scan")).toHaveLength(0);
  });

  it("ignores kicks after shutdown", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.shutdown();
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c === "boot-scan")).toHaveLength(0);
  });

  it("shuts down cleanly after a degraded scan (null tail handle)", async () => {
    const h = makeHarness();
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0);
    h.resolveScan(null); // ingestion failed to start; timers still arm
    await vi.advanceTimersByTimeAsync(0);

    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(OUT_MS);
    expect(h.calls).toEqual(["outcomes"]); // degraded mode still polls

    h.calls.length = 0;
    lc.shutdown();
    expect(h.calls).toEqual(["server-close", "db-close", "exit"]); // no tail to stop
  });

  it("a rejecting boot scan reports the error and leaves shutdown clean", async () => {
    const errors: string[] = [];
    const h = makeHarness({ error: (m) => errors.push(m) });
    h.deps.bootScan = () => Promise.reject(new Error("scan boom"));
    const lc = createDaemonLifecycle(h.deps);
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.some((m) => m.includes("scan boom"))).toBe(true);

    lc.shutdown();
    expect(h.calls).toContain("db-close");
  });
});
