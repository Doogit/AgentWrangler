/**
 * src/daemon/readiness.ts — Shared readiness flag for the daemon boot sequence.
 *
 * Set to true by index.ts after the initial back-scan completes.
 * Read by http.ts to decide whether to serve the loading page or the real SPA.
 */

const state = { ready: false };

/** Returns true after the initial back-scan + detector pass have finished. */
export function isReady(): boolean {
  return state.ready;
}

/** Called by index.ts once the back-scan is done. Idempotent. */
export function setReady(): void {
  state.ready = true;
}
