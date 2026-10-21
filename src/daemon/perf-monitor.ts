/**
 * src/daemon/perf-monitor.ts — in-process performance instrumentation (P0-U2,
 * extended by P0-U2b).
 *
 * Turns "feels slow" into numbers. No behavior change to any route:
 *   - Event-loop lag via Node's monitorEventLoopDelay, reset every 60 s window.
 *   - Per-route request duration: a ring of the last 500 durations per route,
 *     summarized as p50/p95/max on read (`GET /api/perf`).
 *   - P0-U2b: worker spawn→first-message/build-total timing per worker kind,
 *     span timing for recommendationsStateKey/expireRecommendationDismissals,
 *     an ingest bytes/s gauge, and WAL-bytes + RSS/heapUsed process samplers.
 *
 * http.ts calls `markRequestStart` once per request (before routing); router.ts's
 * `sendJson` calls `finishRequest` to get the elapsed ms, set `Server-Timing`,
 * and record it into the route's ring. Aggregate-only (SEC-101): route strings
 * and durations, never session/path content.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { detectorBudgetWarnings } from "./job-budgets.js";
import { type JobHandle, type JobStats, getJobStats, scheduleJob } from "./schedule-job.js";
import { getTimerRegistrations } from "./timer-probe.js";

const ROUTE_RING_SIZE = 500;
const LOOP_LAG_RESET_MS = 60_000;
const NS_PER_MS = 1e6;

export interface LoopLag {
  p50: number;
  p99: number;
  max: number;
  /** `?since=` reads only: false when the sampler did not run (or the ring wrapped) since `since`. */
  covered?: boolean;
}

export interface RouteStats {
  p50: number;
  p95: number;
  max: number;
  count: number;
}

/** P0-U2b / M12: spawn→first-message and spawn→build-total timing, latest sample per worker kind. */
export interface WorkerGauge {
  spawnToFirstMessageMs: number;
  buildTotalMs: number;
  count: number;
}

/** P0-U2b / M13: call count + duration for a named function span (recs-key spans). */
export interface SpanStats {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

/** P0-U2b / M15: ingest throughput, averaged since the first byte recorded. */
export interface IngestGauge {
  bytesPerSecond: number;
  bytesTotal: number;
}

/** P0-U2b / M15: process memory, sampled every 1 s. */
export interface ProcessGauge {
  rssBytes: number;
  heapUsedBytes: number;
}

/** P0-U2b / M14: WAL file size in bytes, sampled every 1 s. */
export interface WalGauge {
  bytes: number;
  /** P2-U4b: present once the off-main checkpointer has run (src/daemon/wal-checkpointer.ts). */
  checkpoint?: WalCheckpointGauge;
}

/** P2-U4b / M14: worker-side wal_checkpoint(PASSIVE) wall times. */
export interface WalCheckpointGauge {
  count: number;
  lastMs: number;
  maxMs: number;
}

/** P0-U13: the tail loop's errored-file summary (SEC-101: hashed ids, never paths). */
export interface ErroredFilesGauge {
  count: number;
  ids: string[];
}

/** P0-U10: one detector's summed duration/statement/row-read counters for a walk. */
export interface DetectorCounters {
  ms: number;
  stmts: number;
  rows: number;
  /** P0-U14: evaluations summed into ms/stmts/rows (one per walked week). */
  evals?: number;
}

/**
 * P0-U10: a completed history walk's per-detector counters (audit §12.1
 * Stage 1). Built by src/daemon/detector-counters.ts from the audit's
 * detector-bench.mjs counting technique: statements = executed statement
 * count, rows = rows returned by .all/.get/.iterate.
 */
export interface DetectorPassSnapshot {
  totalMs: number;
  totalRows: number;
  totalStmts: number;
  detectorCount: number;
  perDetector: Record<string, DetectorCounters>;
}

/**
 * P0-U4 / O-4: boot-critical-path marks, `performance.now()`-based. Aggregate
 * timestamps only (SEC-101 safe — no session/path content). `process_start`
 * anchors the rest, which are exposed relative to it (ms).
 */
export interface BootMarks {
  process_start: number;
  db_open: number;
  migrations: number;
  weekly_report: number;
  probe: number;
  effect_pass: number;
  listen: number;
  catch_up_start: number;
  /** P2-U4: the floored W0 walk finished — this week's recs exist (M7). */
  w0_walk_end: number;
  catch_up_end: number;
  first_detector_cycle_start: number;
  first_detector_cycle_end: number;
}

export interface PerfSnapshot {
  loop_lag: LoopLag;
  routes: Record<string, RouteStats>;
  /** Present once `process_start` has been recorded (O-4). */
  boot?: Partial<BootMarks>;
  /** P0-U2b: present once at least one worker of that kind has completed. */
  workers?: Record<string, WorkerGauge>;
  /** P0-U2b: present once at least one span has been recorded. */
  spans?: Record<string, SpanStats>;
  /** P0-U2b: present once at least one ingest chunk has been recorded. */
  ingest?: IngestGauge;
  /** P0-U2b: present once the process sampler has run at least once. */
  process?: ProcessGauge;
  /** P0-U2b: present once the WAL sampler has run at least once. */
  wal?: WalGauge;
  /** P0-U10: present once the first history walk's detector pass has completed. */
  detectors?: DetectorPassSnapshot;
  /** P0-U10: timer registrations by period (ms, as a string key), present only under AW_PERF_PROBE=1. */
  timers?: Record<string, number>;
  /** P0-U13: present once the tail loop has recorded at least one errored file. */
  errored?: ErroredFilesGauge;
  /** P0-U14: present once a scheduleJob job has run; run time by job name. */
  jobs?: Record<string, JobStats>;
}

interface RequestStart {
  route: string;
  t0: number;
}

// Review fix (P0-U2): router.ts dispatches many parameterized routes whose id
// (or name) segment is literally part of the path — e.g. /api/sessions/<id>/turns,
// /api/reports/<id>. Keying the ring by the raw pathname would create one
// never-evicted Map entry per distinct id ever requested (unbounded growth in a
// long-running daemon). Collapse each known dynamic segment to a `:id` template
// so the key space is bounded by the number of route definitions below, mirroring
// the regexes router.ts itself uses to dispatch these routes.
const PARAMETERIZED_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/recommendations\/jobs\/[^/]+\/(confirm|rollback)$/, "/api/recommendations/jobs/:id/$1"],
  [/^\/api\/recommendations\/jobs\/[^/]+$/, "/api/recommendations/jobs/:id"],
  [/^\/api\/recommendations\/[^/]+\/apply$/, "/api/recommendations/:id/apply"],
  [/^\/api\/recommendations\/[^/]+\/open-terminal$/, "/api/recommendations/:id/open-terminal"],
  [/^\/api\/esf\/session-observations\/[^/]+$/, "/api/esf/session-observations/:id"],
  [/^\/api\/reports\/[^/]+$/, "/api/reports/:id"],
  [/^\/api\/workspaces\/[^/]+\/delivery$/, "/api/workspaces/:id/delivery"],
  [/^\/api\/workspaces\/[^/]+\/self-churn$/, "/api/workspaces/:id/self-churn"],
  [/^\/api\/workspaces\/[^/]+\/sessions$/, "/api/workspaces/:id/sessions"],
  [/^\/api\/workspaces\/[^/]+\/context$/, "/api/workspaces/:id/context"],
  [/^\/api\/sessions\/[^/]+\/(diagnostics|breakdown)$/, "/api/sessions/:id/$1"],
  [/^\/api\/sessions\/[^/]+\/turns$/, "/api/sessions/:id/turns"],
  [/^\/api\/sessions\/[^/]+\/drivers$/, "/api/sessions/:id/drivers"],
  [/^\/api\/sessions\/[^/]+\/story$/, "/api/sessions/:id/story"],
  [/^\/api\/sessions\/[^/]+$/, "/api/sessions/:id"],
];

/**
 * Collapses a request pathname's known parameterized segments to a fixed
 * template (e.g. `/api/sessions/abc123/turns` → `/api/sessions/:id/turns`) so
 * it is safe to use as a bounded aggregate key. Paths with no known dynamic
 * segment (static routes) pass through unchanged.
 */
export function normalizeRoute(pathname: string): string {
  for (const [pattern, template] of PARAMETERIZED_ROUTES) {
    if (pattern.test(pathname)) return pathname.replace(pattern, template);
  }
  return pathname;
}

const BOOT_MARK_ORDER: readonly (keyof BootMarks)[] = [
  "process_start",
  "db_open",
  "migrations",
  "weekly_report",
  "probe",
  "effect_pass",
  "listen",
  "catch_up_start",
  "w0_walk_end",
  "catch_up_end",
  "first_detector_cycle_start",
  "first_detector_cycle_end",
];

let starts = new WeakMap<http.ServerResponse, RequestStart>();
let routeRings = new Map<string, number[]>();
let bootMarks: Partial<Record<keyof BootMarks, number>> = {};
// Benchmark-only escape hatch (scripts/*, never called from production code):
// lets the P0-U2 overhead A/B measure createHandler with vs. without the
// monitor without needing two separate handler builds.
let enabled = true;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const resetTimer = scheduleJob("perf.loop-lag-reset", LOOP_LAG_RESET_MS, () => histogram.reset(), {
  unref: true,
});

// P0-U2b state (M12–M15). Same shape as the route rings above: in-memory,
// aggregate-only, cleared on process exit.
let workerGauges = new Map<string, WorkerGauge>();
let spans = new Map<string, SpanStats>();
let ingestBytesTotal = 0;
let ingestFirstRecordMs: number | undefined;
let ingestLastRecordMs: number | undefined;
let processGauge: ProcessGauge | undefined;
let walGauge: WalGauge | undefined;
let walCheckpoint: WalCheckpointGauge | undefined;
let detectorPass: DetectorPassSnapshot | undefined;
let erroredFilesGauge: ErroredFilesGauge | undefined;
let samplerTimer: JobHandle | undefined;
const SAMPLER_INTERVAL_MS = 1_000;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

/** Called once per request (http.ts), before routing. */
export function markRequestStart(res: http.ServerResponse, route: string): void {
  if (!enabled) return;
  starts.set(res, { route: normalizeRoute(route), t0: Date.now() });
}

/** Benchmark-only: toggles instrumentation on/off (default: on). See `enabled` above. */
export function setPerfMonitorEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Called by router.ts's sendJson. Returns the elapsed ms since
 * markRequestStart and records it into the route's ring, or null if the
 * response was never marked (e.g. a non-API/static request).
 */
export function finishRequest(
  res: http.ServerResponse,
): { route: string; durationMs: number } | null {
  const start = starts.get(res);
  if (!start) return null;
  const durationMs = Date.now() - start.t0;
  let ring = routeRings.get(start.route);
  if (!ring) {
    ring = [];
    routeRings.set(start.route, ring);
  }
  ring.push(durationMs);
  if (ring.length > ROUTE_RING_SIZE) ring.shift();
  return { route: start.route, durationMs };
}

/**
 * P3-U1: timestamped loop-delay samples (a 10 ms ticker, same resolution as the histogram) so a
 * caller can ask for the lag over its own time span (`/api/perf?since=<epoch ms>`). A ring of
 * LOOP_SAMPLE_CAPACITY (10 min at 100/s) — far longer than any gate attempt, so no in-span sample
 * is ever evicted.
 */
const LOOP_SAMPLE_MS = 10;
export const LOOP_SAMPLE_CAPACITY = 60_000;
const loopSampleTs = new Float64Array(LOOP_SAMPLE_CAPACITY);
const loopSampleLag = new Float64Array(LOOP_SAMPLE_CAPACITY);
let loopSampleCount = 0;
let loopSampleNext = 0;

/** Records one loop-delay sample (ms) taken at `tsMs` (epoch ms). Exported for the ticker and tests. */
export function recordLoopSample(tsMs: number, lagMs: number): void {
  loopSampleTs[loopSampleNext] = tsMs;
  loopSampleLag[loopSampleNext] = lagMs;
  loopSampleNext = (loopSampleNext + 1) % LOOP_SAMPLE_CAPACITY;
  if (loopSampleCount < LOOP_SAMPLE_CAPACITY) loopSampleCount += 1;
}

/**
 * The ticker runs only while a `?since=` reader is active: a read starts it (or extends it) for
 * LOOP_SAMPLE_ARM_MS. Always-on, 100 JS wakeups/s cost +0.2–0.3 % of one core at idle (M18 budget
 * is < 1 %). `loopSampleFrom` is when the current continuous run began; a span starting before it
 * is reported `covered: false`, never as a p99 over a partial span.
 */
const LOOP_SAMPLE_ARM_MS = 600_000;
let loopSampler: JobHandle | null = null;
let loopSampleFrom = Number.POSITIVE_INFINITY;
let loopSampleArmedUntil = 0;
let loopLastTick = 0;

function stopLoopSampler(): void {
  loopSampler?.cancel();
  loopSampler = null;
  loopSampleFrom = Number.POSITIVE_INFINITY;
}

function armLoopSampler(): void {
  const nowMs = Date.now();
  loopSampleArmedUntil = nowMs + LOOP_SAMPLE_ARM_MS;
  if (loopSampler) return;
  loopSampleFrom = nowMs;
  loopLastTick = performance.now();
  loopSampler = scheduleJob(
    "perf.loop-sample",
    LOOP_SAMPLE_MS,
    () => {
      const now = performance.now();
      const tsMs = Date.now();
      recordLoopSample(tsMs, now - loopLastTick);
      loopLastTick = now;
      if (tsMs > loopSampleArmedUntil) stopLoopSampler();
    },
    { unref: true },
  );
}

/**
 * Current event-loop-delay percentiles (ms). No `since`: the histogram, reset every 60 s window.
 * With `since` (epoch ms): every sample taken at/after it, nothing dropped or trimmed, and
 * `covered` says whether the sampler ran (and the ring kept every sample) since then. The read
 * arms the sampler, so a caller primes it with one read before its span starts.
 */
export function getLoopLag(since?: number): LoopLag {
  if (since !== undefined) {
    const oldest =
      loopSampleCount < LOOP_SAMPLE_CAPACITY
        ? Number.NEGATIVE_INFINITY
        : (loopSampleTs[loopSampleNext] as number);
    const covered = since >= loopSampleFrom && since >= oldest;
    armLoopSampler();
    const xs: number[] = [];
    for (let i = 0; i < loopSampleCount; i++) {
      if ((loopSampleTs[i] as number) >= since) xs.push(loopSampleLag[i] as number);
    }
    xs.sort((a, b) => a - b);
    return {
      p50: percentile(xs, 0.5),
      p99: percentile(xs, 0.99),
      max: xs[xs.length - 1] ?? 0,
      covered,
    };
  }
  return {
    p50: histogram.percentile(50) / NS_PER_MS,
    p99: histogram.percentile(99) / NS_PER_MS,
    max: histogram.max / NS_PER_MS,
  };
}

/**
 * Records a boot-critical-path mark (P0-U4 / O-4). Idempotent per name — only
 * the first call for a given mark is kept, so a retried boot phase (e.g. the
 * background pipeline) never overwrites the *first* cycle's marks. Returns
 * whether this call actually recorded the mark (false if already set).
 */
export function recordBootMark(name: keyof BootMarks, atMs: number): boolean {
  if (bootMarks[name] !== undefined) return false;
  bootMarks[name] = atMs;
  return true;
}

/**
 * Boot marks relative to `process_start` (ms), or undefined until
 * `process_start` itself has been recorded. Aggregate-only (SEC-101).
 */
export function getBootMarks(): Partial<BootMarks> | undefined {
  const start = bootMarks.process_start;
  if (start === undefined) return undefined;
  const relative: Partial<Record<keyof BootMarks, number>> = {};
  for (const name of BOOT_MARK_ORDER) {
    const v = bootMarks[name];
    if (v !== undefined) relative[name] = Math.round(v - start);
  }
  return relative;
}

/** One compact, boot-ordered log line of every mark recorded so far. */
export function formatBootMarks(): string {
  const marks = getBootMarks();
  if (marks === undefined) return "";
  return BOOT_MARK_ORDER.filter((name) => marks[name] !== undefined)
    .map((name) => `${name}=${marks[name]}`)
    .join(" ");
}

/** Test-only: clear recorded boot marks between tests. */
export function resetBootMarks(): void {
  bootMarks = {};
}

// ── P0-U2b: worker spawn/build timing (M12) ─────────────────────────────────

/** Records one worker's spawn→first-message and spawn→build-total timing. */
export function recordWorkerTiming(
  kind: string,
  spawnToFirstMessageMs: number,
  buildTotalMs: number,
): void {
  const prev = workerGauges.get(kind);
  workerGauges.set(kind, { spawnToFirstMessageMs, buildTotalMs, count: (prev?.count ?? 0) + 1 });
}

/** Structural subset of worker_threads' Worker that spawn timing needs. */
interface SpawnedWorkerLike {
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}

/**
 * Attaches spawn→first-message and spawn→exit ("build-total") timing to a
 * freshly-created worker_threads Worker, recorded under `kind` once the
 * worker exits. Call this immediately after `new Worker(...)`.
 */
export function instrumentWorkerSpawn(worker: SpawnedWorkerLike, kind: string): void {
  const spawnStart = performance.now();
  let firstMessageMs: number | undefined;
  worker.once("message", () => {
    if (firstMessageMs === undefined) firstMessageMs = performance.now() - spawnStart;
  });
  worker.once("exit", () => {
    const buildTotalMs = performance.now() - spawnStart;
    recordWorkerTiming(kind, firstMessageMs ?? buildTotalMs, buildTotalMs);
  });
}

/** Latest spawn/build-total sample per worker kind. */
export function getWorkerGauges(): Record<string, WorkerGauge> {
  return Object.fromEntries(workerGauges);
}

/** Test-only: clear recorded worker gauges between tests. */
export function resetWorkerGauges(): void {
  workerGauges = new Map();
}

// ── P0-U2b: named function spans (M13 — recs-key timing) ───────────────────

/** Records one call's duration into the named span's running stats. */
export function recordSpan(name: string, durationMs: number): void {
  const prev = spans.get(name);
  spans.set(name, {
    count: (prev?.count ?? 0) + 1,
    totalMs: (prev?.totalMs ?? 0) + durationMs,
    lastMs: durationMs,
    maxMs: Math.max(prev?.maxMs ?? 0, durationMs),
  });
}

/** Times `fn` and records its duration under `name`. Synchronous only. */
export function withSpan<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordSpan(name, performance.now() - start);
  }
}

/** Recorded span stats, by name. */
export function getSpans(): Record<string, SpanStats> {
  return Object.fromEntries(spans);
}

/** Test-only: clear recorded spans between tests. */
export function resetSpans(): void {
  spans = new Map();
}

// ── P0-U2b: ingest bytes/s gauge (M15) ──────────────────────────────────────

/**
 * Records bytes tailed from a transcript file (ingest/ingestor.ts, once per
 * `tailFileChunk` call). `nowMs` defaults to `performance.now()`; tests pass
 * an explicit clock so the bytes/s window is deterministic. O(1), no allocation.
 */
export function recordIngestBytes(bytes: number, nowMs: number = performance.now()): void {
  if (bytes < 0) return;
  ingestBytesTotal += bytes;
  if (ingestFirstRecordMs === undefined) ingestFirstRecordMs = nowMs;
  ingestLastRecordMs = nowMs;
}

/** Average ingest throughput since the first recorded byte, or undefined until then. */
export function getIngestGauge(): IngestGauge | undefined {
  if (ingestFirstRecordMs === undefined || ingestLastRecordMs === undefined) return undefined;
  const elapsedMs = ingestLastRecordMs - ingestFirstRecordMs;
  const bytesPerSecond = elapsedMs > 0 ? (ingestBytesTotal / elapsedMs) * 1000 : 0;
  return { bytesPerSecond: Math.round(bytesPerSecond), bytesTotal: ingestBytesTotal };
}

/** Test-only: clear the ingest gauge between tests. */
export function resetIngestGauge(): void {
  ingestBytesTotal = 0;
  ingestFirstRecordMs = undefined;
  ingestLastRecordMs = undefined;
}

// ── P0-U2b: WAL bytes + process memory samplers (M14/M15) ──────────────────

/**
 * Samples process.memoryUsage() and, when `dbPath` is given, the sidecar
 * `<dbPath>-wal` file's size. Exported so tests can call it directly instead
 * of waiting on the real 1 s interval.
 * PERF G-P3 M11: the WAL stat is async; a sync one blocked the main thread 4.3 s under disk load.
 * At most one stat is in flight, so a stalled disk cannot pile them up on the libuv pool.
 */
let walStatInFlight: Promise<void> | undefined;
export function sampleProcessGauges(dbPath?: string): Promise<void> {
  const mem = process.memoryUsage();
  processGauge = { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed };
  if (dbPath === undefined) return Promise.resolve();
  walStatInFlight ??= fs.promises
    .stat(`${dbPath}-wal`)
    .then(
      (s) => {
        walGauge = { bytes: s.size };
      },
      () => {
        walGauge = { bytes: 0 };
      },
    )
    .finally(() => {
      walStatInFlight = undefined;
    });
  return walStatInFlight;
}

/** Starts the 1 s unref'd sampler interval (daemon boot). Stopped by `stopPerfMonitor`. */
export function startProcessSamplers(dbPath: string): void {
  void sampleProcessGauges(dbPath);
  samplerTimer = scheduleJob(
    "perf.process-sampler",
    SAMPLER_INTERVAL_MS,
    () => void sampleProcessGauges(dbPath),
    { unref: true },
  );
}

/** Latest process memory sample, or undefined until sampled once. */
export function getProcessGauge(): ProcessGauge | undefined {
  return processGauge;
}

/** P2-U4b: records one off-main WAL checkpoint's wall time. */
export function recordWalCheckpoint(ms: number): void {
  walCheckpoint = {
    count: (walCheckpoint?.count ?? 0) + 1,
    lastMs: ms,
    maxMs: Math.max(walCheckpoint?.maxMs ?? 0, ms),
  };
}

/** Latest WAL-bytes sample (with checkpoint times once any ran), or undefined until sampled once. */
export function getWalGauge(): WalGauge | undefined {
  if (walGauge === undefined || walCheckpoint === undefined) return walGauge;
  return { ...walGauge, checkpoint: walCheckpoint };
}

/** Test-only: clear sampled process/WAL gauges between tests. */
export function resetProcessSamplers(): void {
  processGauge = undefined;
  walGauge = undefined;
  walCheckpoint = undefined;
}

// ── P0-U10: per-detector history-walk counters ──────────────────────────────

/** Records the latest completed history walk's per-detector counters. */
export function recordDetectorPass(pass: DetectorPassSnapshot): void {
  detectorPass = pass;
  // P0-U14: warn-only per-detector budget check (never throws, never blocks).
  try {
    for (const line of detectorBudgetWarnings(pass.perDetector)) console.warn(line);
  } catch {
    /* budget reporting is best-effort */
  }
}

/** Latest recorded detector-pass counters, or undefined until one completes. */
export function getDetectorPass(): DetectorPassSnapshot | undefined {
  return detectorPass;
}

/** Test-only: clear the recorded detector pass between tests. */
export function resetDetectorPass(): void {
  detectorPass = undefined;
}

// ── P0-U13: tail-loop errored-files gauge ───────────────────────────────────

/** Records the tail loop's current errored-file count and a bounded id list. */
export function setErroredFiles(count: number, ids: string[]): void {
  erroredFilesGauge = { count, ids: [...ids] };
}

/** Latest recorded errored-files summary, or undefined until one is set. */
export function getErroredFilesGauge(): ErroredFilesGauge | undefined {
  return erroredFilesGauge;
}

/** Test-only: clear the recorded errored-files gauge between tests. */
export function resetErroredFiles(): void {
  erroredFilesGauge = undefined;
}

/**
 * One compact, boot-log-style line summarizing a completed detector pass,
 * ranked by the top 5 detectors by duration. The orchestrator's oracle reads
 * this line to compare against the audit's W0 pass.
 */
export function formatDetectorPass(pass: DetectorPassSnapshot): string {
  const top = Object.entries(pass.perDetector)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 5)
    .map(([id, c]) => `${id}=${Math.round(c.ms)}ms/${c.rows}r`)
    .join(", ");
  return (
    `Detector pass: ${Math.round(pass.totalMs)} ms, ${pass.totalRows} rows, ` +
    `${pass.totalStmts} stmts, ${pass.detectorCount} detectors; top: ${top}`
  );
}

/** Aggregate-only snapshot served by GET /api/perf. */
export function getPerfSnapshot(since?: number): PerfSnapshot {
  const routes: Record<string, RouteStats> = {};
  for (const [route, ring] of routeRings) {
    const sorted = [...ring].sort((a, b) => a - b);
    routes[route] = {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? 0,
      count: ring.length,
    };
  }
  const boot = getBootMarks();
  const workers = getWorkerGauges();
  const spanStats = getSpans();
  const ingest = getIngestGauge();
  const processSnapshot = getProcessGauge();
  const wal = getWalGauge();
  const detectorSnapshot = getDetectorPass();
  const timers = getTimerRegistrations();
  const errored = getErroredFilesGauge();
  const jobStats = getJobStats();
  return {
    loop_lag: getLoopLag(since),
    routes,
    ...(boot !== undefined ? { boot } : {}),
    ...(Object.keys(workers).length > 0 ? { workers } : {}),
    ...(Object.keys(spanStats).length > 0 ? { spans: spanStats } : {}),
    ...(ingest !== undefined ? { ingest } : {}),
    ...(processSnapshot !== undefined ? { process: processSnapshot } : {}),
    ...(wal !== undefined ? { wal } : {}),
    ...(detectorSnapshot !== undefined ? { detectors: detectorSnapshot } : {}),
    ...(timers !== undefined ? { timers } : {}),
    ...(errored !== undefined ? { errored } : {}),
    ...(Object.keys(jobStats).length > 0 ? { jobs: jobStats } : {}),
  };
}

/** Test-only: clear all recorded state (route rings + request marks). Does not reset the loop-lag histogram (process-wide truth). */
export function resetPerfMonitor(): void {
  starts = new WeakMap<http.ServerResponse, RequestStart>();
  routeRings = new Map<string, number[]>();
}

/** Stops the reset-interval and sampler timers and disables the histogram (daemon shutdown). */
export function stopPerfMonitor(): void {
  resetTimer.cancel();
  stopLoopSampler();
  samplerTimer?.cancel();
  histogram.disable();
}
