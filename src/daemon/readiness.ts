/**
 * src/daemon/readiness.ts — Shared readiness flag for the daemon boot sequence.
 *
 * Set to true by index.ts after the initial back-scan completes.
 * Read by http.ts to decide whether to serve the loading page or the real SPA.
 */

export type ScanState = "scanning" | "complete" | "failed";
const state = {
  ready: false,
  scan: "scanning" as ScanState,
  scanRoots: [] as string[],
  unreadableRoots: new Set<string>(),
};

/** Snapshot the roots actually used by the running ingestor, not pending settings. */
export function setScanRoots(roots: readonly string[]): void {
  state.scanRoots = [...roots];
}

export function setScanState(scan: ScanState): void {
  state.scan = scan;
}

/** Recorded by ingest discovery each time it stats/reads a scan root. */
export function noteScanRootReadable(root: string, readable: boolean): void {
  if (readable) state.unreadableRoots.delete(root);
  else state.unreadableRoots.add(root);
}

/**
 * Aggregate-only diagnostics; never exposes a local path or filesystem error.
 * PERF G-P3 M11: no disk access here. A sync stat per status poll stalled the loop by up to 2.4 s
 * under load; the root count is what ingest discovery last saw (operator 2026-10-19).
 */
export function getScanStatus(): { scan_state: ScanState; invalid_scan_root_count: number } {
  const invalid = state.scanRoots.filter((root) => state.unreadableRoots.has(root)).length;
  return { scan_state: state.scan, invalid_scan_root_count: invalid };
}

/** Returns true after the initial back-scan + detector pass have finished. */
export function isReady(): boolean {
  return state.ready;
}

/** Called by index.ts once the back-scan is done. Idempotent. */
export function setReady(): void {
  state.ready = true;
}
