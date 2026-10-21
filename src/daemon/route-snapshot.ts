import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { getDataVersion } from "./data-version.js";
import { instrumentWorkerSpawn } from "./perf-monitor.js";
import { type RouteSnapshotSpec, buildRouteSnapshot } from "./route-snapshot-build.js";

export { type RouteSnapshotSpec, buildRouteSnapshot };

export type RouteSnapshotBuilder = (spec: RouteSnapshotSpec) => Promise<unknown>;

export interface RouteSnapshotService {
  /**
   * The body for `key` (route + window filter). Only a cold key waits for its build; `spec`
   * resolves the window when the build starts.
   */
  get(key: string, spec: (now: Date) => RouteSnapshotSpec): Promise<unknown>;
  stop(): void;
}

/** Most distinct windows kept; the oldest build is dropped past this. */
const MAX_KEYS = 64;

/**
 * P1-U8: /api/delivery, /api/workspaces/:id/delivery and /api/practices served from worker
 * builds. A data change (data_version) or a new 10-minute bucket serves the snapshot stale while
 * one rebuild runs. A small dedicated builder; P3-U4's unified snapshot service absorbs it.
 */
export function createRouteSnapshotService(
  options: { dbPath: string } | { builder: RouteSnapshotBuilder },
): RouteSnapshotService {
  const active = new Set<Worker>();
  const builder: RouteSnapshotBuilder =
    "builder" in options ? options.builder : (spec) => runInWorker(options.dbPath, active, spec);
  const snapshots = new Map<string, { body: unknown; version: number; builtAtMs: number }>();
  const pending = new Map<string, Promise<unknown>>();
  /** After a failed rebuild behind a snapshot, don't retry before this time. */
  const retryAt = new Map<string, number>();
  let stopped = false;

  function start(key: string, spec: (now: Date) => RouteSnapshotSpec): Promise<unknown> {
    const existing = pending.get(key);
    if (existing) return existing;
    const version = getDataVersion();
    const builtAtMs = Date.now();
    const task = builder(spec(new Date(builtAtMs))).then((body) => {
      if (!stopped) {
        snapshots.delete(key);
        snapshots.set(key, { body, version, builtAtMs });
        if (snapshots.size > MAX_KEYS) snapshots.delete(snapshots.keys().next().value as string);
        retryAt.delete(key);
      }
      return body;
    });
    pending.set(key, task);
    void task
      .finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      })
      .catch(() => {
        if (snapshots.has(key)) retryAt.set(key, Date.now() + 60_000);
      });
    return task;
  }

  return {
    get(key, spec) {
      if (stopped) return Promise.reject(new Error("route snapshot service stopped"));
      const snapshot = snapshots.get(key);
      if (!snapshot) return start(key, spec);
      const stale =
        snapshot.version !== getDataVersion() ||
        Math.floor(snapshot.builtAtMs / 600_000) !== Math.floor(Date.now() / 600_000);
      if (stale && Date.now() >= (retryAt.get(key) ?? 0)) void start(key, spec).catch(() => {});
      return Promise.resolve(snapshot.body);
    },
    stop() {
      stopped = true;
      for (const worker of active) void worker.terminate();
      active.clear();
      snapshots.clear();
    },
  };
}

function runInWorker(
  dbPath: string,
  active: Set<Worker>,
  spec: RouteSnapshotSpec,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const builtUrl = new URL("./route-snapshot-worker.js", import.meta.url);
    const sourceMode = !existsSync(builtUrl);
    const worker = new Worker(
      sourceMode ? new URL("./route-snapshot-worker.ts", import.meta.url) : builtUrl,
      {
        workerData: { dbPath, spec },
        ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
      },
    );
    active.add(worker);
    instrumentWorkerSpawn(worker, "route-snapshot");
    let settled = false;
    const finish = (error?: Error, body?: unknown) => {
      if (settled) return;
      settled = true;
      active.delete(worker);
      if (error) reject(error);
      else resolve(body);
    };
    worker.on(
      "message",
      (message: { type: "result"; body: unknown } | { type: "error"; message: string }) => {
        if (message.type === "result") finish(undefined, message.body);
        else finish(new Error(message.message));
      },
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`route snapshot worker exited with code ${code}`));
    });
  });
}
