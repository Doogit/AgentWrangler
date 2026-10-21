/**
 * PERF: run the judge-setup / consent / idle-sessions scans on a worker so they never block the
 * daemon event loop (the sync scans pushed /api/perf loop-lag p99 past its 50 ms bar), and the
 * heavy SQL behind direct GET routes (PERF P3-F3, `runQueryOffThread`).
 *
 * Every call is a fresh scan on the worker's own read-only connection: no cache, no staleness. The
 * worker starts on first use, so boot pays nothing. An in-memory DB (tests) or any worker failure
 * runs the same scan inline, so a response is never worse than before.
 */

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { Db } from "../db/open.js";
import {
  type QueryArgs,
  type QueryName,
  type ScanTask,
  type ScanTaskResults,
  runScanTask,
} from "./scan-tasks.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Entry {
  worker: Worker;
  pending: Map<number, Pending>;
}

/** Up to two workers per DB, so one multi-second query does not queue every other offloaded route. */
const POOL_SIZE = 2;
const workers = new Map<string, Entry[]>();
let nextId = 1;

function start(dbPath: string): Entry {
  const builtUrl = new URL("./scan-worker.js", import.meta.url);
  const sourceMode = !existsSync(builtUrl);
  const worker = new Worker(sourceMode ? new URL("./scan-worker.ts", import.meta.url) : builtUrl, {
    workerData: { dbPath },
    ...(sourceMode ? { execArgv: ["--import", "tsx/esm"] } : {}),
  });
  worker.unref();
  const entry: Entry = { worker, pending: new Map() };
  const fail = (error: Error) => {
    const pool = workers.get(dbPath);
    const at = pool?.indexOf(entry) ?? -1;
    if (pool !== undefined && at >= 0) pool.splice(at, 1);
    for (const p of entry.pending.values()) p.reject(error);
    entry.pending.clear();
  };
  worker.on("message", (m: { id: number; ok: boolean; result?: unknown; message?: string }) => {
    const p = entry.pending.get(m.id);
    if (p === undefined) return;
    entry.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.message ?? "scan failed"));
  });
  worker.once("error", (error) => fail(error));
  worker.once("exit", (code) => fail(new Error(`scan worker exited with code ${code}`)));
  return entry;
}

/**
 * Queries go to the least-busy worker. The first query starts the whole pool, so the second worker
 * has booted (seconds, in source mode) before it is needed. The other scans stay on the first
 * worker: agents-liveness keeps its cache and in-flight dedup per worker.
 */
function pick(dbPath: string, task: ScanTask): Entry {
  let pool = workers.get(dbPath);
  if (pool === undefined) {
    pool = [];
    workers.set(dbPath, pool);
  }
  const size = task.kind === "query" ? POOL_SIZE : 1;
  while (pool.length < size) pool.push(start(dbPath));
  if (task.kind !== "query") return pool[0] as Entry;
  return pool.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
}

function onWorker(dbPath: string, task: ScanTask): Promise<unknown> {
  const target = pick(dbPath, task);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    target.pending.set(id, { resolve, reject });
    target.worker.postMessage({ id, task });
  });
}

/** Run `task` off the event loop. `db` is the daemon's DB; the worker opens `db.name` read-only. */
export async function runScanOffThread<K extends ScanTask["kind"]>(
  db: Db,
  task: Extract<ScanTask, { kind: K }>,
): Promise<ScanTaskResults[K]> {
  if (db.name === "" || db.name === ":memory:") return await runScanTask(db, task);
  try {
    return (await onWorker(db.name, task)) as ScanTaskResults[K];
  } catch {
    return await runScanTask(db, task);
  }
}

/**
 * Run a `QUERIES` read off the event loop and resolve with its JSON body (`JSON.stringify` of the
 * same call the route made inline). Fresh on every call: the worker's read-only WAL connection
 * sees every committed transaction, as the main connection does between ingest steps; nothing is
 * cached here. A query that throws on the worker is re-run inline, so the route sees the original
 * error (RangeError, EffectRequestError, ...) and answers exactly as the inline handler did.
 */
export function runQueryOffThread<N extends QueryName>(
  db: Db,
  name: N,
  ...args: QueryArgs<N>
): Promise<string> {
  return runScanOffThread(db, { kind: "query", name, args });
}

/**
 * Terminate the scan workers (daemon shutdown, tests). Resolves once they have exited, so their
 * read connections are closed (a test can then delete its DB file on Windows).
 */
export async function stopScanWorkers(): Promise<void> {
  const exits: Promise<number>[] = [];
  for (const pool of workers.values())
    for (const entry of pool) exits.push(entry.worker.terminate());
  workers.clear();
  await Promise.allSettled(exits);
}
