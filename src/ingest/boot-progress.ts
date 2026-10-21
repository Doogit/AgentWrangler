/**
 * src/ingest/boot-progress.ts — in-memory boot-scan progress for the loading page (BOOT-1).
 *
 * Running counters + a small event ring buffer published by the initial
 * back-scan and surfaced on /api/status ONLY while the daemon is not ready
 * (the router gates on isReady()). Everything here is process-memory; no DB,
 * no filesystem access (readiness.ts already stat-loops roots per poll —
 * this module must never add per-event fs work).
 *
 * SEC-101: event text carries workspace ids/slugs and counts only — callers
 * must never pass file paths or transcript content.
 */

export type BootEventKind = "root" | "workspace" | "stage";

export interface BootScanEvent {
  /** Monotonic sequence number so the loading page renders only new events. */
  seq: number;
  ts: string;
  kind: BootEventKind;
  text: string;
}

export interface BootProgress {
  boot_sessions_found: number;
  boot_tokens_counted: number;
  boot_files_per_sec: number;
  /**
   * Total files the boot scan discovered up front — the progress-bar
   * denominator. parser_health.files_seen only counts files VISITED so far,
   * which tracks files_parsed and would pin a determinate bar at ~100%.
   */
  boot_files_total: number;
  files_skipped: number;
  boot_scan_events: BootScanEvent[];
}

const MAX_EVENTS = 50;
const RATE_WINDOW_MS = 5_000;

const state = {
  sessionsFound: 0,
  tokensCounted: 0,
  filesTotal: 0,
  filesSkipped: 0,
  nextSeq: 1,
  events: [] as BootScanEvent[],
  /** Epoch-ms timestamps of recent fileParsed calls (pruned to the rate window). */
  parseTicks: [] as number[],
};

function pruneTicks(nowMs: number): void {
  const cutoff = nowMs - RATE_WINDOW_MS;
  let drop = 0;
  while (drop < state.parseTicks.length && (state.parseTicks[drop] as number) < cutoff) drop++;
  if (drop > 0) state.parseTicks.splice(0, drop);
}

/** A session row was inserted for the first time during the scan. */
export function bootSessionFound(): void {
  state.sessionsFound++;
}

/** Tokens attributed by a newly ingested turn (all token classes summed). */
export function bootTokensCounted(tokens: number): void {
  if (Number.isFinite(tokens) && tokens > 0) state.tokensCounted += tokens;
}

/** Total files discovered at boot-scan start (the progress denominator). */
export function bootFilesTotal(total: number): void {
  if (Number.isFinite(total) && total >= 0) state.filesTotal = Math.floor(total);
}

/**
 * A fully caught-up file was skipped by its matching in-memory or persisted version.
 */
export function bootFileSkipped(): void {
  state.filesSkipped++;
}

/** A file finished parsing; feeds the derived files/s rate. */
export function bootFileParsed(nowMs: number = Date.now()): void {
  pruneTicks(nowMs);
  state.parseTicks.push(nowMs);
}

/** Append a scan event to the ring buffer (oldest entries drop past 50). */
export function pushBootEvent(
  kind: BootEventKind,
  text: string,
  ts: string = new Date().toISOString(),
): void {
  state.events.push({ seq: state.nextSeq++, ts, kind, text });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

/** Snapshot for the pre-ready /api/status surface. */
export function getBootProgress(nowMs: number = Date.now()): BootProgress {
  pruneTicks(nowMs);
  return {
    boot_sessions_found: state.sessionsFound,
    boot_tokens_counted: state.tokensCounted,
    boot_files_per_sec: Math.round((state.parseTicks.length / (RATE_WINDOW_MS / 1000)) * 10) / 10,
    boot_files_total: state.filesTotal,
    files_skipped: state.filesSkipped,
    boot_scan_events: [...state.events],
  };
}

/** Test-only reset. */
export function resetBootProgress(): void {
  state.sessionsFound = 0;
  state.tokensCounted = 0;
  state.filesTotal = 0;
  state.filesSkipped = 0;
  state.nextSeq = 1;
  state.events = [];
  state.parseTicks = [];
}

// ── Post-ready pipeline status (U4) ─────────────────────────────────────────
//
// NOTE: ingestor.ts already imports from boot-progress.js, so importing
// BackgroundPipelineProgress from ./ingestor.js would create a circular
// dependency. We define a local structural type instead.

/** Local structural match for ingestor.ts:BackgroundPipelinePhase. */
type PipelinePhase = "reading" | "detecting" | "history" | "done";

/** Local structural match for ingestor.ts:BackgroundPipelineProgress. */
interface PipelineProgressSnapshot {
  phase: PipelinePhase;
  files_total: number;
  files_completed: number;
  files_skipped: number;
  files_with_new_data: number;
  detector_runs: number;
}

const PIPELINE_MAX_EVENTS = 50;

/** Aggregate-only post-ready pipeline state (exposed on /api/status). */
export interface PipelineStatus {
  phase: PipelinePhase;
  weeks_total: number;
  weeks_done: number;
  files_total: number;
  files_completed: number;
  files_skipped: number;
  files_with_new_data: number;
  detector_runs: number;
  failed_phase: "reading" | "detecting" | null;
  events: string[];
}

const pipelineState = {
  latest: null as PipelineProgressSnapshot | null,
  failedPhase: null as "reading" | "detecting" | null,
  events: [] as string[],
  weeksTotal: 0,
  weeksDone: 0,
};

export interface HistoryWeekReport {
  weeksDone: number;
  weeksTotal: number;
  newFindings: number;
}

/**
 * Build a SEC-101-safe log line: phase + integer counts only.
 * Format: "reading — 4210 / 9000 files"
 */
function makePipelineLogLine(p: PipelineProgressSnapshot): string {
  if (p.phase === "done") {
    return `done — ${p.files_completed} files, ${p.detector_runs} detector runs`;
  }
  return `${p.phase} — ${p.files_completed} / ${p.files_total} files`;
}

function appendPipelineEvent(line: string): void {
  pipelineState.events.push(line);
  if (pipelineState.events.length > PIPELINE_MAX_EVENTS) {
    pipelineState.events.splice(0, pipelineState.events.length - PIPELINE_MAX_EVENTS);
  }
}

/** Store the latest pipeline snapshot and append a SEC-101-safe log line. */
export function setPipelineProgress(p: PipelineProgressSnapshot): void {
  pipelineState.latest = { ...p };
  pipelineState.failedPhase = null;
  if (p.phase === "reading" || p.phase === "detecting") {
    pipelineState.weeksTotal = 0;
    pipelineState.weeksDone = 0;
  }
  appendPipelineEvent(makePipelineLogLine(p));
}

/** Record aggregate-only progress for one history-walk week (SEC-101). */
export function reportHistoryWeek({
  weeksDone,
  weeksTotal,
  newFindings,
}: HistoryWeekReport): string {
  const line = `history — week ${weeksDone} / ${weeksTotal} (${newFindings} new findings)`;
  pipelineState.latest = {
    files_total: 0,
    files_completed: 0,
    files_skipped: 0,
    files_with_new_data: 0,
    detector_runs: 0,
    ...pipelineState.latest,
    phase: "history",
  };
  pipelineState.weeksDone = weeksDone;
  pipelineState.weeksTotal = weeksTotal;
  pipelineState.failedPhase = null;
  appendPipelineEvent(line);
  return line;
}

/**
 * Close a history phase that no later snapshot will close: the post-ingest walk
 * reports weeks but, unlike the boot pass, never reports "done" afterwards.
 */
export function endHistoryPhase(): void {
  if (pipelineState.latest?.phase !== "history") return;
  pipelineState.latest = { ...pipelineState.latest, phase: "done" };
}

/** Record that the pipeline failed at the given phase (SEC-101: phase label only). */
export function setPipelineFailed(phase: "reading" | "detecting"): void {
  pipelineState.failedPhase = phase;
}

/** Return current pipeline status, or null if no snapshot has been recorded yet. */
export function getPipelineStatus(): PipelineStatus | null {
  if (pipelineState.latest === null) return null;
  return {
    phase: pipelineState.latest.phase,
    weeks_total: pipelineState.weeksTotal,
    weeks_done: pipelineState.weeksDone,
    files_total: pipelineState.latest.files_total,
    files_completed: pipelineState.latest.files_completed,
    files_skipped: pipelineState.latest.files_skipped,
    files_with_new_data: pipelineState.latest.files_with_new_data,
    detector_runs: pipelineState.latest.detector_runs,
    failed_phase: pipelineState.failedPhase,
    events: [...pipelineState.events],
  };
}

/** Local structural match for ingestor.ts:HistoryCoverage (P2-U4; aggregate only). */
export interface HistoryCoverageStatus {
  weeks_done: number;
  weeks_total: number;
  complete_through_ms: number | null;
  oldest_complete_day: string | null;
  partial_week: boolean;
}

let historyCoverage: HistoryCoverageStatus | null = null;

/** P2-U4: how much history the slice loop has ingested (exposed on /api/status). */
export function setHistoryCoverage(coverage: HistoryCoverageStatus): void {
  historyCoverage = { ...coverage };
}

export function getHistoryCoverage(): HistoryCoverageStatus | null {
  return historyCoverage === null ? null : { ...historyCoverage };
}

/** Test-only reset for pipeline state. */
export function resetPipelineStatus(): void {
  pipelineState.latest = null;
  pipelineState.failedPhase = null;
  pipelineState.events = [];
  pipelineState.weeksTotal = 0;
  pipelineState.weeksDone = 0;
  historyCoverage = null;
}

// ── Pipeline retry hook seam ─────────────────────────────────────────────────

let _retryHook: (() => void) | null = null;

/** Wire the pipeline retry hook (daemon boot). */
export function setPipelineRetryHook(fn: () => void): void {
  _retryHook = fn;
}

/** Retrieve the pipeline retry hook (router). */
export function getPipelineRetryHook(): (() => void) | null {
  return _retryHook;
}
