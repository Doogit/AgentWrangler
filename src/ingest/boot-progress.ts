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
  boot_scan_events: BootScanEvent[];
}

const MAX_EVENTS = 50;
const RATE_WINDOW_MS = 5_000;

const state = {
  sessionsFound: 0,
  tokensCounted: 0,
  filesTotal: 0,
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
    boot_scan_events: [...state.events],
  };
}

/** Test-only reset. */
export function resetBootProgress(): void {
  state.sessionsFound = 0;
  state.tokensCounted = 0;
  state.filesTotal = 0;
  state.nextSeq = 1;
  state.events = [];
  state.parseTicks = [];
}
