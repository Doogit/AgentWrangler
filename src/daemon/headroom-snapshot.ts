import type { Db } from "../db/open.js";
import {
  type EfficiencyHeadroom,
  getEfficiencyHeadroom,
} from "../query/api/efficiency-headroom.js";
import type { ApiResponse, SnapshotFreshness } from "../query/envelope.js";
import { type HeadroomWindow, createHeadroomWorkerRunner } from "./headroom-worker-runner.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import { createSnapshotService, freshnessOf } from "./snapshot-service.js";

/** A function window is resolved when the build starts (after any gate wait). */
export type HeadroomBuilder = (
  window: HeadroomWindow | (() => HeadroomWindow),
  onStart?: () => void,
) => Promise<ApiResponse<EfficiencyHeadroom>>;

const MAX_KEYS = 500; // as the old route memo (MEMO_MAX_ENTRIES)

export interface HeadroomSnapshotService {
  /**
   * The snapshot for `key` (a window shape: preset or from). A stale one is served at once while
   * one rebuild runs; a cold key waits for its first build (off the main thread). `resolve` gives
   * the window at build time, so a rolling preset is `now`-relative when the build starts.
   */
  get(
    key: string,
    resolve: () => { from: string; to: string },
  ): Promise<{ response: ApiResponse<EfficiencyHeadroom>; freshness: SnapshotFreshness | null }>;
  /** An explicit from+to range: built on every call, never cached. */
  compute(from: string, to: string): Promise<ApiResponse<EfficiencyHeadroom>>;
  stop(): void;
}

/**
 * P3-U5: `/api/efficiency-headroom` as a snapshot over snapshot-service.ts. It rebuilds on the
 * inputs the old route memo tracked: the recs-snapshot revision, the newest analysis_runs row
 * and the 10-minute bucket (the core's default staleness). The build runs in a worker.
 */
export function createHeadroomSnapshotService(options: {
  db: Db;
  recs: { revision(): number };
  dbPath?: string;
  builder?: HeadroomBuilder;
  /** RB1-B: shared one-heavy-job-at-a-time gate. */
  gate?: HeavyJobGate;
  now?: () => number;
}): HeadroomSnapshotService {
  const { db } = options;
  const runner =
    options.dbPath && !options.builder
      ? createHeadroomWorkerRunner(options.dbPath, options.gate)
      : null;
  const builder: HeadroomBuilder =
    options.builder ??
    (runner
      ? (window, onStart) => runner.run(window, onStart)
      : async (window) => {
          // In-process (tests, scripts): yield so the GET that started the build answers first.
          await new Promise((resolve) => setImmediate(resolve));
          return getEfficiencyHeadroom(db, typeof window === "function" ? window() : window);
        });
  const resolvers = new Map<string, () => HeadroomWindow>();
  const core = createSnapshotService<string, ApiResponse<EfficiencyHeadroom>>({
    ...(options.now ? { now: options.now } : {}),
    inputsToken: () => {
      const runs = (
        db.prepare("SELECT IFNULL(MAX(rowid), 0) AS m FROM analysis_runs").get() as { m: number }
      ).m;
      return `${options.recs.revision()}|${runs}`;
    },
    build: (key, _inputsAsOfMs, _onStage, onStart) => {
      const resolve = resolvers.get(key);
      if (!resolve) return Promise.reject(new Error("headroom window not registered"));
      return builder(resolve, onStart);
    },
  });

  return {
    async get(key, resolve) {
      if (!resolvers.has(key) && resolvers.size >= MAX_KEYS) {
        // Bound the keys like the old memo did: drop every snapshot and start over.
        resolvers.clear();
        core.invalidate();
      }
      resolvers.set(key, resolve);
      core.refresh(key);
      let peeked = core.peek(key);
      if (peeked.state === "failed") core.clearFailure(key);
      // Twice: a key-cap reset (above) from another GET can discard the first build.
      for (let attempt = 0; attempt < 2 && peeked.state !== "ready"; attempt += 1) {
        await core.start(key).task;
        peeked = core.peek(key);
      }
      if (peeked.state !== "ready") throw new Error("headroom snapshot unavailable");
      return { response: peeked.snapshot.value, freshness: freshnessOf(peeked) };
    },
    compute: (from, to) => builder({ from, to }),
    stop() {
      runner?.stop();
      core.stop();
    },
  };
}
