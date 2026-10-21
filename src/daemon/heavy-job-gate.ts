/**
 * RB1-B: at most one heavy worker job (recs, history, diagnostics, headroom) runs at a time.
 * Leaf-only: only each runner's spawn-to-settle is gated, so no gated job awaits another one.
 */
export type HeavyJobLabel = "recs" | "history" | "diagnostics" | "headroom";

export interface HeavyJobGate {
  /** FIFO: `job` starts only when no other gated job runs. Rejects if the gate was stopped before it started. */
  run<T>(label: HeavyJobLabel, job: () => Promise<T>): Promise<T>;
  /** Rejects every queued (not started) job; a running job is left to its runner's stop(). */
  stop(): void;
}

interface Waiter {
  label: HeavyJobLabel;
  start: () => void;
  abort: (error: Error) => void;
}

export function createHeavyJobGate(): HeavyJobGate {
  let running: HeavyJobLabel | null = null;
  let stopped = false;
  const queue: Waiter[] = [];

  function next(): void {
    running = null;
    const waiter = queue.shift();
    if (waiter) waiter.start();
  }

  return {
    run<T>(label: HeavyJobLabel, job: () => Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(new Error("heavy job gate stopped"));
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          running = label;
          let promise: Promise<T>;
          try {
            promise = job();
          } catch (error) {
            reject(error);
            next();
            return;
          }
          promise.then(resolve, reject).finally(next);
        };
        if (running === null) start();
        else queue.push({ label, start, abort: reject });
      });
    },
    stop() {
      stopped = true;
      for (const waiter of queue.splice(0)) waiter.abort(new Error("heavy job gate stopped"));
    },
  };
}
