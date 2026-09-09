/**
 * Reproducible, synthetic-only daemon-route profile.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/synthetic-history.ts
 *
 * Each scale gets a new temporary SQLite database and a separate loopback child
 * server. The parent is only the client/controller, so child CPU, RSS, and
 * event-loop samples exclude HTTP-client work. No operator config, credentials,
 * transcripts, scan roots, network clients, or src/daemon/index.ts are used.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";
import {
  SYNTHETIC_WINDOW_FROM,
  SYNTHETIC_WINDOW_TO,
  seedSyntheticHistory,
} from "./synthetic-fixture.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const WARM_SAMPLES = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;
const IDLE_MS = 1_000;
const CONCURRENT_READS = 2;

const WINDOW_FROM = SYNTHETIC_WINDOW_FROM;
const WINDOW_TO = SYNTHETIC_WINDOW_TO;
const encodedWindow = `from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`;
const MOVING_WINDOW_DAYS = 7;
const MOVING_WINDOW_STEPS = 7;

type ChildEvent = Record<string, unknown> & { event: string };
type Pending = {
  resolve: (event: ChildEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface ChildHarness {
  port: number;
  startupToReadyMs: number;
  command(command: Record<string, unknown>): Promise<ChildEvent>;
  close(): Promise<void>;
}

interface HttpResult {
  status: number;
  body: string;
  responseBytes: number;
  elapsedMs: number;
}

interface EventLoopDelaySample {
  p50Ms: number;
  p95Ms: number;
}

interface RouteSample extends HttpResult {
  controllerCpuMs: number;
  controllerRssMb: number;
  controllerEventLoopDelay: EventLoopDelaySample;
}

export type RoutePhase =
  | "cold_process"
  | "cold_query"
  | "warm_explicit_window"
  | "moving_window";

export interface PhaseSummary {
  count: number;
  p50_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  stddev_ms: number;
}

export interface ResponseByteSummary {
  count: number;
  p50_bytes: number;
  p95_bytes: number;
  min_bytes: number;
  max_bytes: number;
  mean_bytes: number;
  stddev_bytes: number;
}

export interface RoutePhaseSamples {
  elapsed_ms: readonly number[];
  response_bytes: readonly number[];
}

export interface RoutePhaseSummary {
  elapsed_ms: PhaseSummary;
  response_bytes: ResponseByteSummary;
}

/** Pure nearest-rank distribution summary for benchmark samples in milliseconds. */
export function summarizePhase(samples: readonly number[]): PhaseSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const mean = count ? sorted.reduce((sum, sample) => sum + sample, 0) / count : 0;
  const variance = count
    ? sorted.reduce((sum, sample) => sum + Math.pow(sample - mean, 2), 0) / count
    : 0;
  const nearestRank = (quantile: number): number =>
    sorted[Math.min(count - 1, Math.ceil(count * quantile) - 1)] ?? 0;
  return {
    count,
    p50_ms: Number(nearestRank(0.5).toFixed(3)),
    p95_ms: Number(nearestRank(0.95).toFixed(3)),
    min_ms: Number((sorted[0] ?? 0).toFixed(3)),
    max_ms: Number((sorted[count - 1] ?? 0).toFixed(3)),
    mean_ms: Number(mean.toFixed(3)),
    stddev_ms: Number(Math.sqrt(variance).toFixed(3)),
  };
}

/** Pure nearest-rank distribution summary for HTTP response-body sizes. */
export function summarizeResponseBytes(samples: readonly number[]): ResponseByteSummary {
  const summary = summarizePhase(samples);
  return {
    count: summary.count,
    p50_bytes: summary.p50_ms,
    p95_bytes: summary.p95_ms,
    min_bytes: summary.min_ms,
    max_bytes: summary.max_ms,
    mean_bytes: summary.mean_ms,
    stddev_bytes: summary.stddev_ms,
  };
}

/** Purely shape phase-tagged route samples; no process, database, or network work occurs here. */
export function summarizeRoutePhases(
  phases: Record<RoutePhase, RoutePhaseSamples>,
): Record<RoutePhase, RoutePhaseSummary> {
  const summarize = (phase: RoutePhase): RoutePhaseSummary => ({
    elapsed_ms: summarizePhase(phases[phase].elapsed_ms),
    response_bytes: summarizeResponseBytes(phases[phase].response_bytes),
  });
  return {
    cold_process: summarize("cold_process"),
    cold_query: summarize("cold_query"),
    warm_explicit_window: summarize("warm_explicit_window"),
    moving_window: summarize("moving_window"),
  };
}

function request(port: number, route: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get(
      { hostname: "127.0.0.1", port, path: route, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            body: body.toString("utf8"),
            responseBytes: body.byteLength,
            elapsedMs: performance.now() - started,
          });
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`${route} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    );
    req.on("error", reject);
  });
}

function eventLoopDelaySample(loop: ReturnType<typeof monitorEventLoopDelay>): EventLoopDelaySample {
  return {
    p50Ms: Number((loop.percentile(50) / 1e6).toFixed(3)),
    p95Ms: Number((loop.percentile(95) / 1e6).toFixed(3)),
  };
}

/** Measure controller-side resource use while an isolated child serves one HTTP request. */
async function sampleRouteRequest(port: number, route: string): Promise<RouteSample> {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const beforeCpu = process.cpuUsage();
  try {
    const result = await request(port, route);
    const cpu = process.cpuUsage(beforeCpu);
    return {
      ...result,
      controllerCpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
      controllerRssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
      controllerEventLoopDelay: eventLoopDelaySample(loop),
    };
  } finally {
    loop.disable();
  }
}

function requireRouteSuccess(route: string, result: HttpResult, expectedTurns: number): void {
  if (result.status !== 200) throw new Error(`${route} returned HTTP ${result.status}`);
  const body = JSON.parse(result.body) as Record<string, unknown>;
  const data = body.data ?? body;
  if (route === "overview" && (data as { turns?: number } | undefined)?.turns !== expectedTurns)
    throw new Error("Overview returned an unexpected synthetic turn count");
  if (
    [
      "workspaces",
      "hot_sessions",
      "workspace_sessions",
      "session_turns",
      "session_drivers",
    ].includes(route) &&
    !JSON.stringify(data).includes(
      route === "workspaces" ? "synthetic-ws-0" : "synthetic-session-0",
    )
  )
    throw new Error(`${route} response did not retain the expected synthetic identity`);
  if (
    ["trends", "cache_write"].includes(route) &&
    (!data ||
      !Array.isArray((data as { buckets?: unknown }).buckets) ||
      !(data as { buckets: unknown[] }).buckets.length)
  )
    throw new Error(`${route} response did not include populated synthetic buckets`);
  if (route === "flavor" && (!data || Object.keys(data as Record<string, unknown>).length === 0))
    throw new Error("flavor response was unexpectedly empty for synthetic history");
}

function removeSyntheticDirectory(tempDir: string): void {
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("agent-wrangler-synthetic-")
  )
    throw new Error("Refusing cleanup outside the synthetic temporary directory");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

function startChild(dbPath: string, claudeDir: string): Promise<ChildHarness> {
  return new Promise((resolve, reject) => {
    const startupStarted = performance.now();
    const childScript = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "synthetic-daemon-child.ts",
    );
    const child = childProcess.spawn(
      process.execPath,
      ["--import", "tsx/esm", childScript, "--db", dbPath, "--claude-dir", claudeDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const pending: Pending[] = [];
    let ready = false;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let stderr = "";
    let resolveExited: (() => void) | undefined;
    const exitedPromise = new Promise<void>((resolveExitedPromise) => {
      resolveExited = resolveExitedPromise;
    });
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      if (exited) return true;
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), timeoutMs);
        void exitedPromise.then(() => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
    };
    const terminate = async (): Promise<void> => {
      if (exited) return;
      child.kill();
      await exitedPromise;
    };
    const rejectPending = (error: Error): void => {
      while (pending.length) {
        const current = pending.shift();
        if (current) {
          clearTimeout(current.timer);
          current.reject(error);
        }
      }
    };
    const failStartup = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      rejectPending(error);
      await terminate();
      reject(error);
    };
    const startupTimer = setTimeout(() => {
      void failStartup(new Error("Synthetic daemon child did not become ready within 30 seconds"));
    }, 30_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: ChildEvent;
        try {
          event = JSON.parse(line) as ChildEvent;
        } catch {
          continue;
        }
        if (event.event === "ready") {
          const port = Number(event.port);
          if (!Number.isInteger(port) || port <= 0) {
            void failStartup(new Error("Synthetic daemon child reported an invalid port"));
            return;
          }
          ready = true;
          settled = true;
          clearTimeout(startupTimer);
          resolve({
            port,
            startupToReadyMs: performance.now() - startupStarted,
            command(command): Promise<ChildEvent> {
              return new Promise((commandResolve, commandReject) => {
                const timer = setTimeout(() => {
                  const index = pending.findIndex((entry) => entry.reject === commandReject);
                  if (index >= 0) pending.splice(index, 1);
                  void terminate().then(
                    () =>
                      commandReject(
                        new Error(
                          `Child command ${String(command.command)} timed out after ${COMMAND_TIMEOUT_MS}ms`,
                        ),
                      ),
                    (error: unknown) =>
                      commandReject(error instanceof Error ? error : new Error(String(error))),
                  );
                }, COMMAND_TIMEOUT_MS);
                pending.push({ resolve: commandResolve, reject: commandReject, timer });
                child.stdin.write(`${JSON.stringify(command)}\n`);
              });
            },
            async close(): Promise<void> {
              if (!exited) child.stdin.write('{"command":"shutdown"}\n');
              if (!(await waitForExit(10_000))) {
                await terminate();
                throw new Error("Child shutdown timed out and was terminated");
              }
              if (exitCode !== 0) throw new Error(`Child exited ${exitCode}; ${stderr}`);
            },
          });
          continue;
        }
        const next = pending.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve(event);
        }
      }
    });
    child.on("error", (error) => {
      if (!ready) void failStartup(error);
      else rejectPending(error);
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolveExited?.();
      if (!ready) void failStartup(new Error(`Synthetic daemon child exited ${code}; ${stderr}`));
      else if (code !== 0)
        rejectPending(new Error(`Synthetic daemon child exited ${code}; ${stderr}`));
    });
    child.on("close", (code) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      resolveExited?.();
      if (!ready) void failStartup(new Error(`Synthetic daemon child closed ${code}; ${stderr}`));
      else if (code !== 0)
        rejectPending(new Error(`Synthetic daemon child closed ${code}; ${stderr}`));
    });
  });
}

const routes = (workspaceId: string, sessionId: string): Array<{ name: string; path: string }> => [
  { name: "overview", path: `/api/overview?${encodedWindow}` },
  { name: "workspaces", path: `/api/workspaces?${encodedWindow}` },
  { name: "trends", path: `/api/trends?${encodedWindow}&bucket=day` },
  { name: "flavor", path: `/api/overview/flavor?${encodedWindow}` },
  { name: "cache_write", path: `/api/trends/cache-write?${encodedWindow}` },
  { name: "recommendations", path: "/api/recommendations" },
  { name: "live", path: "/api/live" },
  { name: "hot_sessions", path: `/api/hot-sessions?${encodedWindow}` },
  { name: "status", path: "/api/status" },
  { name: "workspace_sessions", path: `/api/workspaces/${workspaceId}/sessions?${encodedWindow}` },
  { name: "session_turns", path: `/api/sessions/${sessionId}/turns?limit=100` },
  { name: "session_drivers", path: `/api/sessions/${sessionId}/drivers` },
];

/**
 * Advance a fixed-width window through the fixture's known time range.
 *
 * This deliberately uses the daemon's supported explicit `from`/`to` API:
 * real-time presets resolve against the host clock, so they cannot represent
 * this fixed historical fixture once wall-clock time has moved past it.
 */
export function movingWindowPath(routePath: string, step = 0): string {
  const url = new URL(routePath, "http://127.0.0.1");
  const start = new Date(
    Date.parse(SYNTHETIC_WINDOW_FROM) + (step % MOVING_WINDOW_STEPS) * 24 * 60 * 60 * 1_000,
  );
  const end = new Date(start.getTime() + MOVING_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
  url.searchParams.delete("preset");
  url.searchParams.set("from", start.toISOString());
  url.searchParams.set("to", end.toISOString());
  return `${url.pathname}${url.search}`;
}

function requireHttpSuccess(route: string, result: HttpResult): void {
  if (result.status !== 200) throw new Error(`${route} returned HTTP ${result.status}`);
}

function summarizeRouteMetric(
  phases: Record<RoutePhase, readonly RouteSample[]>,
  sample: (value: RouteSample) => number,
  unit: string,
): Record<RoutePhase, Record<string, number>> {
  const summarize = (samples: readonly RouteSample[]): Record<string, number> => {
    const summary = summarizePhase(samples.map(sample));
    return {
      count: summary.count,
      [`p50_${unit}`]: summary.p50_ms,
      [`p95_${unit}`]: summary.p95_ms,
      [`min_${unit}`]: summary.min_ms,
      [`max_${unit}`]: summary.max_ms,
      [`mean_${unit}`]: summary.mean_ms,
      [`stddev_${unit}`]: summary.stddev_ms,
    };
  };
  return {
    cold_process: summarize(phases.cold_process),
    cold_query: summarize(phases.cold_query),
    warm_explicit_window: summarize(phases.warm_explicit_window),
    moving_window: summarize(phases.moving_window),
  };
}

async function sampleConcurrentReads(
  port: number,
  route: { name: string; path: string },
): Promise<Record<string, unknown>> {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  try {
    const reads = await Promise.all(
      Array.from({ length: CONCURRENT_READS }, () => request(port, route.path)),
    );
    for (const read of reads) requireHttpSuccess(route.name, read);
    const cpu = process.cpuUsage(beforeCpu);
    return {
      clients: CONCURRENT_READS,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      response_bytes: summarizeResponseBytes(reads.map((read) => read.responseBytes)),
      controller_cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
      controller_rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
      controller_event_loop_delay: eventLoopDelaySample(loop),
    };
  } finally {
    loop.disable();
  }
}

async function sampleChildCommand(
  child: ChildHarness,
  command: Record<string, unknown>,
): Promise<{ event: ChildEvent; controller: Record<string, number> }> {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  try {
    const event = await child.command(command);
    const cpu = process.cpuUsage(beforeCpu);
    return {
      event,
      controller: {
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
        cpu_ms: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
        rss_mb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
        event_loop_p50_ms: Number((loop.percentile(50) / 1e6).toFixed(3)),
        event_loop_p95_ms: Number((loop.percentile(95) / 1e6).toFixed(3)),
      },
    };
  } finally {
    loop.disable();
  }
}

async function sampleColdProcess(
  dbPath: string,
  claudeDir: string,
  route: { name: string; path: string },
  expectedTurns: number,
): Promise<{ request: RouteSample; startupToReadyMs: number }> {
  let child: ChildHarness | undefined;
  let sampleError: unknown;
  let sample: { request: RouteSample; startupToReadyMs: number } | undefined;
  try {
    child = await startChild(dbPath, claudeDir);
    const requestResult = await sampleRouteRequest(child.port, route.path);
    requireRouteSuccess(route.name, requestResult, expectedTurns);
    sample = { request: requestResult, startupToReadyMs: child.startupToReadyMs };
  } catch (error) {
    sampleError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    if (child) await child.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (sampleError && cleanupErrors.length)
    throw new AggregateError([sampleError, ...cleanupErrors], "Cold-process sample and cleanup failed");
  if (sampleError) throw sampleError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Cold-process sample cleanup failed");
  if (!sample) throw new Error("Cold-process sample completed without a result");
  return sample;
}

async function profile(scale: number): Promise<Record<string, unknown>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  const dbPath = path.join(tempDir, "synthetic.sqlite");
  const claudeDir = path.join(tempDir, "empty-claude");
  fs.mkdirSync(claudeDir);
  let db: ReturnType<typeof openDb> | undefined;
  let child: ChildHarness | undefined;
  let result: Record<string, unknown> | undefined;
  let profileError: unknown;
  try {
    db = openDb(dbPath);
    runMigrations(db);
    const seedStarted = performance.now();
    seedSyntheticHistory(db, scale);
    const seedElapsedMs = performance.now() - seedStarted;
    db.close();
    db = undefined;
    child = await startChild(dbPath, claudeDir);
    const routeResults: Record<string, unknown>[] = [];
    for (const route of routes("synthetic-ws-0", "synthetic-session-0")) {
      const coldProcess = await sampleColdProcess(dbPath, claudeDir, route, scale);
      const coldQuery = await sampleRouteRequest(child.port, route.path);
      requireRouteSuccess(route.name, coldQuery, scale);
      const warmExplicit: RouteSample[] = [];
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        const sample = await sampleRouteRequest(child.port, route.path);
        requireRouteSuccess(route.name, sample, scale);
        warmExplicit.push(sample);
      }
      const movingWindow: RouteSample[] = [];
      for (let index = 0; index < WARM_SAMPLES; index += 1) {
        const sample = await sampleRouteRequest(child.port, movingWindowPath(route.path, index));
        requireHttpSuccess(route.name, sample);
        movingWindow.push(sample);
      }
      const phaseSamples: Record<RoutePhase, readonly RouteSample[]> = {
        cold_process: [coldProcess.request],
        cold_query: [coldQuery],
        warm_explicit_window: warmExplicit,
        moving_window: movingWindow,
      };
      routeResults.push({
        name: route.name,
        phases: summarizeRoutePhases({
          cold_process: {
            elapsed_ms: phaseSamples.cold_process.map((sample) => sample.elapsedMs),
            response_bytes: phaseSamples.cold_process.map((sample) => sample.responseBytes),
          },
          cold_query: {
            elapsed_ms: phaseSamples.cold_query.map((sample) => sample.elapsedMs),
            response_bytes: phaseSamples.cold_query.map((sample) => sample.responseBytes),
          },
          warm_explicit_window: {
            elapsed_ms: phaseSamples.warm_explicit_window.map((sample) => sample.elapsedMs),
            response_bytes: phaseSamples.warm_explicit_window.map((sample) => sample.responseBytes),
          },
          moving_window: {
            elapsed_ms: phaseSamples.moving_window.map((sample) => sample.elapsedMs),
            response_bytes: phaseSamples.moving_window.map((sample) => sample.responseBytes),
          },
        }),
        response_bytes: summarizeRouteMetric(phaseSamples, (sample) => sample.responseBytes, "bytes"),
        controller_cpu: summarizeRouteMetric(phaseSamples, (sample) => sample.controllerCpuMs, "ms"),
        controller_rss: summarizeRouteMetric(phaseSamples, (sample) => sample.controllerRssMb, "mb"),
        controller_event_loop_p50: summarizeRouteMetric(
          phaseSamples,
          (sample) => sample.controllerEventLoopDelay.p50Ms,
          "ms",
        ),
        controller_event_loop_p95: summarizeRouteMetric(
          phaseSamples,
          (sample) => sample.controllerEventLoopDelay.p95Ms,
          "ms",
        ),
        startup_to_ready_ms: Number(coldProcess.startupToReadyMs.toFixed(3)),
        concurrent_reads: await sampleConcurrentReads(child.port, route),
        query_instrumentation: {
          available: false,
          query_count: null,
          query_plan: null,
          reason: "The existing child protocol does not expose SQLite trace or EXPLAIN output.",
        },
      });
    }
    const safeJobs = await sampleChildCommand(child, { command: "safe-jobs" });
    const idle = await child.command({ command: "idle", durationMs: IDLE_MS });
    const childJobs = Array.isArray(safeJobs.event.jobs) ? safeJobs.event.jobs : [];
    result = {
      scale_turns: scale,
      routes: routeResults,
      safe_jobs: childJobs.map((job) => ({
        ...(job && typeof job === "object" ? job : { value: job }),
        controller_event_loop_delay_during_safe_jobs_batch: {
          p50_ms: safeJobs.controller.event_loop_p50_ms,
          p95_ms: safeJobs.controller.event_loop_p95_ms,
        },
        controller_cpu_ms_during_safe_jobs_batch: safeJobs.controller.cpu_ms,
        controller_rss_mb_during_safe_jobs_batch: safeJobs.controller.rss_mb,
      })),
      safe_job_dispatch: safeJobs.event.dispatch,
      safe_job_batch_controller_metrics: {
        ...safeJobs.controller,
        measurement_scope:
          "The existing child protocol emits all safe jobs in one command, so this controller event-loop sample covers the batch and is repeated on each child-reported job.",
      },
      seed_insert_throughput: {
        available: true,
        method: "seedSyntheticHistory writes into the fresh temporary SQLite database; this does not measure a daemon HTTP ingest path",
        turns_per_second: Number(((scale / seedElapsedMs) * 1_000).toFixed(3)),
        elapsed_ms: Number(seedElapsedMs.toFixed(3)),
      },
      idle: idle.sample,
    };
  } catch (error) {
    profileError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    if (child) await child.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (db) db.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeSyntheticDirectory(tempDir);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (profileError && cleanupErrors.length)
    throw new AggregateError(
      [profileError, ...cleanupErrors],
      "Synthetic profile and cleanup failed",
    );
  if (profileError) throw profileError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Synthetic profile cleanup failed");
  if (!result) throw new Error("Synthetic profile completed without a result");
  return result;
}

async function main(): Promise<void> {
  const results: Record<string, unknown>[] = [];
  for (const scale of SCALES) results.push(await profile(scale));
  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        synthetic_only: true,
        cold_definition:
          "cold_process is a first route request after a dedicated fresh child boot; cold_query is the first request in the shared child",
        warm_definition: `${WARM_SAMPLES} sequential full-fixture explicit-window and fixture-anchored advancing ${MOVING_WINDOW_DAYS}-day explicit-window requests per route; p50/p95 use nearest-rank`,
        moving_window_limitation:
          "This benchmark does not measure real-time preset resolution: presets resolve against the host clock while the fixture is fixed historical data. Some routes do not accept window filters, so their moving-window samples measure the unchanged route contract.",
        measurement_vantage:
          "Route timings and bytes are controller-observed HTTP metrics. Safe-job CPU/RSS and idle delay are child-reported. Concurrent-read event-loop delay is controller-observed.",
        idle_definition: `${IDLE_MS}ms after safe jobs complete; no production interval timers are started`,
        excluded: [
          "src/daemon/index.ts",
          "ingestion/tailers and scan roots",
          "credential discovery and GitHub outcomes",
          "git churn collector",
          "operator settings/config",
          "operator Claude transcript/history paths",
          "external network",
        ],
        results,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
