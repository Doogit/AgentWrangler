/**
 * src/ingest/detector-hook.ts — post-ingest hook seam.
 *
 * Mirrors the setRuntimeResetHook pattern (query/settings-store.ts): a
 * module-level callback the daemon wires at boot so the Ingestor can trigger a
 * detector pass WITHOUT `ingest/**` statically importing `detector/**` or the
 * query layer (no ingest→query import cycle). Zero-op when unset (tests that do
 * not wire it, e.g. the WP1 ingestion suite, are unaffected).
 *
 * Determinism (NFR-107 / Review F4): the hook is invoked with the ingestor's
 * injected clock, never new Date() — see Ingestor.runPostIngest().
 */

import type { Db } from "../db/open.js";

/** Post-ingest callback: (db, injected now). */
export type PostIngestHook = (db: Db, now: Date) => void;

let _hook: PostIngestHook | null = null;

/** Wire the post-ingest hook (daemon boot / tests). */
export function setPostIngestHook(fn: PostIngestHook): void {
  _hook = fn;
}

/** Clear the post-ingest hook (tests, between cases). */
export function clearPostIngestHook(): void {
  _hook = null;
}

/** Invoke the hook if wired; a thrown hook never breaks the ingest loop. */
export function runPostIngestHook(db: Db, now: Date): void {
  if (_hook === null) return;
  try {
    _hook(db, now);
  } catch (e) {
    console.warn(`post-ingest hook failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Post-probe seam (W4): the daemon wires the Impact Ledger measurement pass so
// the probe run can trigger it WITHOUT ingest/** statically importing
// detector/** (same decoupling rationale as the post-ingest seam above).
// ---------------------------------------------------------------------------

/** Post-probe callback: (db, injected now — matches the probe's probed_at clock). */
export type PostProbeHook = (db: Db, now: Date) => void;

let _probeHook: PostProbeHook | null = null;

/** Wire the post-probe hook (daemon boot / tests). */
export function setPostProbeHook(fn: PostProbeHook): void {
  _probeHook = fn;
}

/** Clear the post-probe hook (tests, between cases). */
export function clearPostProbeHook(): void {
  _probeHook = null;
}

/** Invoke the post-probe hook if wired; a thrown hook never breaks the probe pass. */
export function runPostProbeHook(db: Db, now: Date): void {
  if (_probeHook === null) return;
  try {
    _probeHook(db, now);
  } catch (e) {
    console.warn(`post-probe hook failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
