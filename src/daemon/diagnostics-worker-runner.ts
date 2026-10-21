import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { WindowDays } from "../query/api/diagnostics-census.js";
import type { DiagnosticsTriageView } from "../query/api/diagnostics-triage.js";
import type { CallTarget } from "../query/api/tool-calls.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import { instrumentWorkerSpawn } from "./perf-monitor.js";

type WorkerMessage =
  | { type: "stage"; stage: string; ms: number }
  | {
      type: "result";
      view: DiagnosticsTriageView;
      toolCallTargets: Array<[string, CallTarget | null]>;
    }
  | { type: "error"; message: string };

export function createDiagnosticsWorkerRunner(
  dbPath: string,
  gate?: HeavyJobGate,
): {
  run: (
    windowDays: WindowDays,
    asOf: string,
    onStage: (stage: string, ms: number) => void,
    onStart?: () => void,
  ) => Promise<DiagnosticsTriageView>;
  stop: () => void;
} {
  const active = new Set<Worker>();
  let stopped = false;
  // Each build is a fresh worker; this carries its transcript lookups to the next build,
  // so only the first build pays the cold transcript read-back behind top_commands.
  let toolCallTargets: Array<[string, CallTarget | null]> = [];
  function spawn(
    windowDays: WindowDays,
    asOf: string,
    onStage: (stage: string, ms: number) => void,
  ): Promise<DiagnosticsTriageView> {
    return new Promise<DiagnosticsTriageView>((resolve, reject) => {
      const builtUrl = new URL("./diagnostics-worker.js", import.meta.url);
      const sourceMode = !existsSync(builtUrl);
      const worker = new Worker(
        sourceMode ? new URL("./diagnostics-worker.ts", import.meta.url) : builtUrl,
        {
          workerData: { dbPath, windowDays, asOf, toolCallTargets },
          ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
        },
      );
      active.add(worker);
      instrumentWorkerSpawn(worker, "diagnostics");
      let settled = false;
      const finish = (error?: Error, value?: DiagnosticsTriageView) => {
        if (settled) return;
        settled = true;
        active.delete(worker);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "stage") onStage(message.stage, message.ms);
        else if (message.type === "result") {
          // Merge, so a concurrent build of another window doesn't drop this one's lookups.
          toolCallTargets = [...new Map([...toolCallTargets, ...message.toolCallTargets])];
          finish(undefined, message.view);
        } else finish(new Error(message.message));
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`diagnostics worker exited with code ${code}`));
      });
    });
  }
  return {
    run(windowDays, asOf, onStage, onStart) {
      if (stopped) return Promise.reject(new Error("diagnostics worker runner stopped"));
      if (!gate) {
        onStart?.();
        return spawn(windowDays, asOf, onStage);
      }
      return gate.run("diagnostics", () => {
        if (stopped) return Promise.reject(new Error("diagnostics worker runner stopped"));
        onStart?.();
        return spawn(windowDays, asOf, onStage);
      });
    },
    stop() {
      stopped = true;
      for (const worker of active) void worker.terminate();
      active.clear();
    },
  };
}
