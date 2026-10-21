import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { clearWriteIntent, createWriteIntent, writeIntentGate } from "../db/write-intent.js";
import type { HistoryWeekListener, LiveDetectorStatus } from "../detector/engine.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import {
  type DetectorPassSnapshot,
  formatDetectorPass,
  instrumentWorkerSpawn,
  recordDetectorPass,
} from "./perf-monitor.js";

type WorkerMessage =
  | { type: "week"; progress: Parameters<HistoryWeekListener>[0] }
  | { type: "result"; statuses: LiveDetectorStatus[]; detectorPass: DetectorPassSnapshot }
  | { type: "error"; message: string };

/** One worker per walk; the detector-pass runner serializes and coalesces requests. */
export function createHistoryWorkerRunner(
  dbPath: string,
  gate?: HeavyJobGate,
): {
  run: (
    now: Date,
    onWeek?: HistoryWeekListener,
    completeThroughMs?: number,
  ) => Promise<LiveDetectorStatus[]>;
  /** Resolves once the walk's pending write is done; null when none is (src/db/write-intent.ts). */
  writeGate: () => Promise<void> | null;
  stop: () => void;
} {
  const active = new Set<Worker>();
  let stopped = false;
  const writeIntent = createWriteIntent();
  function spawn(
    now: Date,
    onWeek?: HistoryWeekListener,
    completeThroughMs?: number,
  ): Promise<LiveDetectorStatus[]> {
    return new Promise<LiveDetectorStatus[]>((resolve, reject) => {
      const builtUrl = new URL("./history-worker.js", import.meta.url);
      const sourceMode = !existsSync(builtUrl);
      const worker = new Worker(
        sourceMode ? new URL("./history-worker.ts", import.meta.url) : builtUrl,
        {
          workerData: { dbPath, nowIso: now.toISOString(), completeThroughMs, writeIntent },
          ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
        },
      );
      active.add(worker);
      instrumentWorkerSpawn(worker, "history");
      let settled = false;
      const finish = (error?: Error, statuses?: LiveDetectorStatus[]) => {
        if (settled) return;
        settled = true;
        active.delete(worker);
        clearWriteIntent(writeIntent);
        if (error) reject(error);
        else resolve(statuses ?? []);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "week") onWeek?.(message.progress);
        else if (message.type === "result") {
          // P0-U10: store + log the completed walk's per-detector counters
          // on the MAIN thread (the orchestrator's oracle reads this line).
          recordDetectorPass(message.detectorPass);
          console.log(formatDetectorPass(message.detectorPass));
          finish(undefined, message.statuses);
        } else finish(new Error(message.message));
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`history worker exited with code ${code}`));
      });
    });
  }
  return {
    writeGate: () => writeIntentGate(writeIntent),
    run(now, onWeek, completeThroughMs) {
      if (stopped) return Promise.reject(new Error("history worker runner stopped"));
      if (!gate) return spawn(now, onWeek, completeThroughMs);
      return gate.run("history", () =>
        stopped
          ? Promise.reject(new Error("history worker runner stopped"))
          : spawn(now, onWeek, completeThroughMs),
      );
    },
    stop() {
      stopped = true;
      for (const worker of active) void worker.terminate();
      active.clear();
      clearWriteIntent(writeIntent);
    },
  };
}
