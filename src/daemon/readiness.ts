/**
 * src/daemon/readiness.ts — Shared readiness flag for the daemon boot sequence.
 *
 * Set to true by index.ts after the initial back-scan completes.
 * Read by http.ts to decide whether to serve the loading page or the real SPA.
 */

import * as fs from "node:fs";

export type ScanState = "scanning" | "complete" | "failed";
const state = { ready: false, scan: "scanning" as ScanState, scanRoots: [] as string[] };

/** Snapshot the roots actually used by the running ingestor, not pending settings. */
export function setScanRoots(roots: readonly string[]): void {
  state.scanRoots = [...roots];
}

export function setScanState(scan: ScanState): void {
  state.scan = scan;
}

/** Aggregate-only diagnostics; never exposes a local path or filesystem error. */
export function getScanStatus(): { scan_state: ScanState; invalid_scan_root_count: number } {
  let invalid = 0;
  for (const root of state.scanRoots) {
    try {
      if (!fs.statSync(root).isDirectory()) {
        invalid += 1;
        continue;
      }
      fs.accessSync(root, fs.constants.R_OK);
    } catch {
      invalid += 1;
    }
  }
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
