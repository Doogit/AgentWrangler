import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { EfficiencyHeadroom } from "../query/api/efficiency-headroom.js";
import type { ApiResponse } from "../query/envelope.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import { instrumentWorkerSpawn } from "./perf-monitor.js";

type WorkerMessage =
  | { type: "result"; response: ApiResponse<EfficiencyHeadroom> }
  | { type: "error"; message: string };

export interface HeadroomWindow {
  from: string;
  to: string;
}

export function createHeadroomWorkerRunner(
  dbPath: string,
  gate?: HeavyJobGate,
): {
  run: (
    window: HeadroomWindow | (() => HeadroomWindow),
    onStart?: () => void,
  ) => Promise<ApiResponse<EfficiencyHeadroom>>;
  stop: () => void;
} {
  const active = new Set<Worker>();
  let stopped = false;
  function spawn(from: string, to: string): Promise<ApiResponse<EfficiencyHeadroom>> {
    return new Promise((resolve, reject) => {
      const builtUrl = new URL("./headroom-worker.js", import.meta.url);
      const sourceMode = !existsSync(builtUrl);
      const worker = new Worker(
        sourceMode ? new URL("./headroom-worker.ts", import.meta.url) : builtUrl,
        {
          workerData: { dbPath, from, to },
          ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
        },
      );
      active.add(worker);
      instrumentWorkerSpawn(worker, "headroom");
      let settled = false;
      const finish = (error?: Error, value?: ApiResponse<EfficiencyHeadroom>) => {
        if (settled) return;
        settled = true;
        active.delete(worker);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "result") finish(undefined, message.response);
        else finish(new Error(message.message));
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`headroom worker exited with code ${code}`));
      });
    });
  }
  return {
    run(window, onStart) {
      if (stopped) return Promise.reject(new Error("headroom worker runner stopped"));
      // A function window is resolved when the build starts, after any gate wait.
      const start = () => {
        onStart?.();
        const { from, to } = typeof window === "function" ? window() : window;
        return spawn(from, to);
      };
      if (!gate) return start();
      return gate.run("headroom", () => {
        if (stopped) return Promise.reject(new Error("headroom worker runner stopped"));
        return start();
      });
    },
    stop() {
      stopped = true;
      for (const worker of active) void worker.terminate();
      active.clear();
    },
  };
}
