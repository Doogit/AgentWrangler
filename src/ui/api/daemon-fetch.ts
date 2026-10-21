/**
 * src/ui/api/daemon-fetch.ts — `fetch` to the local daemon with a timeout, mapping transport
 * failures to `DaemonUnreachableError` (the shell's unreachable card keys on it). Its own module
 * so session-token.ts and esf-client.ts can use it without importing all of client.ts, which
 * re-exports these names.
 */

// 15s: /api/recommendations builds the decision-view evidence packet, which pays
// a ~7s cold cost over the live corpus on the first request after an ingest tick
// (memoized thereafter — see decision-view.ts). 8s aborted that first load and
// surfaced a false "daemon unreachable"; 15s clears the cold build with headroom.
const DAEMON_REQUEST_TIMEOUT_MS = 15_000;

/** A transport failure distinct from daemon HTTP or data errors. */
export class DaemonUnreachableError extends Error {
  readonly code = "DAEMON_UNREACHABLE";

  constructor() {
    super("The local daemon could not be reached.");
    this.name = "DaemonUnreachableError";
  }
}

export function isDaemonUnreachableError(error: unknown): error is DaemonUnreachableError {
  return error instanceof DaemonUnreachableError;
}

export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), DAEMON_REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  if (init?.signal?.aborted) controller.abort();

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch {
    throw new DaemonUnreachableError();
  } finally {
    globalThis.clearTimeout(timeoutId);
    init?.signal?.removeEventListener("abort", abort);
  }
}
