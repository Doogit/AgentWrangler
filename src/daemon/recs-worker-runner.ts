import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { CachedAggregate } from "../query/api/ledger-aggregate.js";
import type { RecommendationsView } from "../query/api/recommendations.js";
import type { CallTarget } from "../query/api/tool-calls.js";
import type { ApiResponse } from "../query/envelope.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import { instrumentWorkerSpawn } from "./perf-monitor.js";

export interface RecsBuildResult {
  result: ApiResponse<RecommendationsView>;
  /** Set by the worker; the snapshot service no longer reads it (P3-U4 uses an inputs token). */
  stateKey?: string;
  builtAtMs: number;
}

type WorkerMessage =
  | ({
      type: "result";
      toolCallTargets: Array<[string, CallTarget | null]>;
      ledgerAggregates: Array<[string, CachedAggregate]>;
    } & RecsBuildResult)
  | { type: "error"; message: string };

export function createRecsWorkerRunner(
  dbPath: string,
  gate?: HeavyJobGate,
): {
  run: (scope?: string, now?: Date, onStart?: () => void) => Promise<RecsBuildResult>;
  cancel: () => void;
  stop: () => void;
} {
  const active = new Set<Worker>();
  let stopped = false;
  // Bumped by cancel(): a job queued behind the gate before a cancel never spawns.
  let generation = 0;
  // Each build is a fresh worker; this carries its transcript lookups to the next build.
  let toolCallTargets: Array<[string, CallTarget | null]> = [];
  // Closed-window ledger aggregates the last build used or built; each build replaces the set, so
  // keys whose window or fingerprint no longer matches drop out.
  let ledgerAggregates: Array<[string, CachedAggregate]> = [];
  function spawn(scope?: string, now?: Date): Promise<RecsBuildResult> {
    return new Promise<RecsBuildResult>((resolve, reject) => {
      const builtUrl = new URL("./recs-worker.js", import.meta.url);
      const sourceMode = !existsSync(builtUrl);
      const worker = new Worker(
        sourceMode ? new URL("./recs-worker.ts", import.meta.url) : builtUrl,
        {
          workerData: {
            dbPath,
            scope,
            nowIso: now?.toISOString(),
            toolCallTargets,
            ledgerAggregates,
          },
          ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
        },
      );
      active.add(worker);
      instrumentWorkerSpawn(worker, "recs");
      let settled = false;
      const finish = (error?: Error, value?: RecsBuildResult) => {
        if (settled) return;
        settled = true;
        active.delete(worker);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "result") {
          const { toolCallTargets: targets, ledgerAggregates: aggregates, ...built } = message;
          toolCallTargets = targets;
          ledgerAggregates = aggregates;
          finish(undefined, built);
        } else finish(new Error(message.message));
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`recommendations worker exited with code ${code}`));
      });
    });
  }
  return {
    run(scope, now, onStart) {
      if (stopped) return Promise.reject(new Error("recommendations worker runner stopped"));
      if (!gate) return spawn(scope, now);
      const queuedAt = generation;
      return gate.run("recs", () => {
        if (stopped) return Promise.reject(new Error("recommendations worker runner stopped"));
        if (generation !== queuedAt) {
          return Promise.reject(new Error("recommendations build cancelled before it started"));
        }
        onStart?.();
        return spawn(scope, now);
      });
    },
    cancel() {
      generation++;
      for (const worker of active) void worker.terminate();
    },
    stop() {
      stopped = true;
      for (const worker of active) void worker.terminate();
      active.clear();
    },
  };
}
