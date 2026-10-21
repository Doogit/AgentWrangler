/**
 * src/daemon/timer-probe.ts — P0-U10: timer-registration counter (audit
 * §9.3 N1, `census-probe.mjs` technique). Counts setTimeout/setInterval
 * registrations bucketed by their requested period (ms).
 *
 * A true no-op — global timers are never wrapped — unless AW_PERF_PROBE=1 is
 * set. `installTimerProbe` is the only entry point and checks the env var
 * itself, so callers need no conditional around it. Aggregate-only
 * (SEC-101): periods and counts only, never callback identity or content.
 */

type SetTimeoutFn = typeof globalThis.setTimeout;
type SetIntervalFn = typeof globalThis.setInterval;

let counts: Map<string, number> | undefined;
let originalSetTimeout: SetTimeoutFn | undefined;
let originalSetInterval: SetIntervalFn | undefined;

/**
 * Wraps global setTimeout/setInterval to count registrations by period, ONLY
 * when AW_PERF_PROBE=1 is set. No-op — not even installed — otherwise.
 * Idempotent: a second call while already installed does nothing.
 */
export function installTimerProbe(): void {
  if (process.env.AW_PERF_PROBE !== "1") return;
  if (counts !== undefined) return;

  const localCounts = new Map<string, number>();
  counts = localCounts;
  const origSetTimeout = global.setTimeout;
  const origSetInterval = global.setInterval;
  originalSetTimeout = origSetTimeout;
  originalSetInterval = origSetInterval;

  function record(ms: unknown): void {
    const key = typeof ms === "number" ? String(Math.round(ms)) : "non-numeric";
    localCounts.set(key, (localCounts.get(key) ?? 0) + 1);
  }

  global.setTimeout = ((...args: Parameters<SetTimeoutFn>) => {
    record(args[1]);
    return origSetTimeout(...args);
  }) as SetTimeoutFn;

  global.setInterval = ((...args: Parameters<SetIntervalFn>) => {
    record(args[1]);
    return origSetInterval(...args);
  }) as SetIntervalFn;
}

/** Timer registrations by period (ms, as a string key), or undefined until installed. */
export function getTimerRegistrations(): Record<string, number> | undefined {
  if (counts === undefined) return undefined;
  return Object.fromEntries(counts);
}

/** Test-only: uninstall and clear recorded counts between tests. */
export function resetTimerProbe(): void {
  if (originalSetTimeout !== undefined) global.setTimeout = originalSetTimeout;
  if (originalSetInterval !== undefined) global.setInterval = originalSetInterval;
  counts = undefined;
  originalSetTimeout = undefined;
  originalSetInterval = undefined;
}
