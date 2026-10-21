/**
 * src/ui/api/status-poller.ts — the dashboard's one /api/status poller (perf plan P2-U5, D6).
 *
 * Poll-first, no SSE: one tab per browser polls /api/status every 15 s (2 s while boot or the
 * pipeline is busy), and never while hidden. The leader is elected with `navigator.locks` and
 * rebroadcasts each result on a BroadcastChannel; a hidden leader gives the lock up so a visible
 * tab takes over. Without `navigator.locks`, every tab polls for itself.
 *
 * Each tab compares the status's `data_scopes` counters with the last ones it saw and
 * invalidates only the query keys tagged with a scope that moved (`scopesForKey`), so a live
 * tail refetches the live/status sections and never the heavy Overview page (review M4). A
 * `data_version` drop means the daemon restarted: everything is invalidated once, after 0–2 s
 * of jitter so tabs do not herd it.
 *
 * Degraded state: 2 missed polls → `paused` (the shell shows "Live updates paused —
 * reconnecting" and active keys refetch every 30 s); a network failure on a tab that never
 * connected, or 4 missed polls, → `unreachable` (App's full "Local daemon unavailable" card).
 */

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { type DaemonStatus, fetchStatus } from "./client";
import { isDaemonUnreachableError } from "./daemon-fetch";
import { queryClient } from "./query-client";
import { DATA_SCOPES, type DataScope, scopesForKey } from "./query-keys";

export const STATUS_POLL_MS = 15_000;
export const STATUS_BUSY_POLL_MS = 2_000;
export const PAUSED_FALLBACK_MS = 30_000;
const PAUSED_AFTER_MISSES = 2;
const UNREACHABLE_AFTER_MISSES = 4;
const RESTART_JITTER_MS = 2_000;
const LOCK_NAME = "aw-status";

/** The slice of `navigator.locks` the poller uses. */
export interface StatusLocks {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

/** The slice of `BroadcastChannel` the poller uses. */
export interface StatusChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export interface StatusPollerState {
  status: DaemonStatus | null;
  /** When the leader received `status` (ms since epoch). */
  fetchedAt: number | undefined;
  /** null until the first poll settles. */
  connected: boolean | null;
  paused: boolean;
  unreachable: boolean;
}

type Message =
  | { kind: "status"; status: DaemonStatus; at: number }
  | { kind: "error"; unreachable: boolean }
  | { kind: "hello" };

export interface StatusPoller {
  start(): void;
  stop(): void;
  /** Poll at once (the unreachable card's Retry). */
  pollNow(): void;
  getState(): StatusPollerState;
  subscribe(listener: () => void): () => void;
}

/** Boot (pre-ready fields present), a cold background build, or a running, unfailed pipeline. */
function isBusy(status: DaemonStatus): boolean {
  if (status.boot_files_total !== undefined) return true;
  if (status.jobs !== undefined && status.jobs.length > 0) return true;
  const pipeline = status.pipeline;
  return pipeline !== undefined && pipeline.phase !== "done" && !pipeline.failed_phase;
}

export function createStatusPoller(options: {
  queryClient: QueryClient;
  fetchStatus: (signal: AbortSignal) => Promise<DaemonStatus>;
  /** undefined → `navigator.locks`; null → no leader election (every tab polls). */
  locks?: StatusLocks | null;
  channel?: () => StatusChannel;
  random?: () => number;
}): StatusPoller {
  const client = options.queryClient;
  const locks =
    options.locks === undefined
      ? ((navigator as { locks?: StatusLocks }).locks ?? null)
      : options.locks;
  const openChannel =
    options.channel ??
    ((): StatusChannel => {
      const broadcast = new BroadcastChannel(LOCK_NAME);
      const wrapped: StatusChannel = {
        onmessage: null,
        postMessage: (data) => broadcast.postMessage(data),
        close: () => broadcast.close(),
      };
      broadcast.onmessage = (event) => wrapped.onmessage?.(event);
      return wrapped;
    });
  const random = options.random ?? Math.random;

  let state: StatusPollerState = {
    status: null,
    fetchedAt: undefined,
    connected: null,
    paused: false,
    unreachable: false,
  };
  const listeners = new Set<() => void>();
  let running = false;
  let leader = false;
  let lockPending = false;
  let attempted = false;
  let misses = 0;
  let everConnected = false;
  let lastVersion: number | undefined;
  let lastScopes: DaemonStatus["data_scopes"];
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let jitterTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseLock: (() => void) | undefined;
  let channel: StatusChannel | undefined;

  const set = (next: Partial<StatusPollerState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const hidden = () => document.visibilityState === "hidden";
  /** Does this tab fetch (rather than listen to the leader)? */
  const polls = () => locks === null || leader;

  const invalidateFor = (status: DaemonStatus) => {
    const version = status.data_version;
    const scopes = status.data_scopes;
    if (typeof version === "number") {
      const restarted = lastVersion !== undefined && version < lastVersion;
      lastVersion = version;
      if (restarted) {
        lastScopes = scopes;
        clearTimeout(jitterTimer);
        jitterTimer = setTimeout(
          () => void client.invalidateQueries(),
          random() * RESTART_JITTER_MS,
        );
        return;
      }
    }
    if (scopes === undefined) return;
    const previous = lastScopes;
    lastScopes = scopes;
    if (previous === undefined) return;
    const moved = new Set(DATA_SCOPES.filter((scope) => scopes[scope] !== previous[scope]));
    if (moved.size === 0) return;
    void client.invalidateQueries({
      predicate: (query) => scopesForKey(query.queryKey).some((scope) => moved.has(scope)),
    });
  };

  const stopFallback = () => {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  };
  const startFallback = () => {
    if (fallbackTimer !== undefined) return;
    const tick = () => {
      void client.invalidateQueries();
      fallbackTimer = setTimeout(tick, PAUSED_FALLBACK_MS);
    };
    fallbackTimer = setTimeout(tick, PAUSED_FALLBACK_MS);
  };

  const applyStatus = (status: DaemonStatus, at: number) => {
    const recovered = state.paused;
    misses = 0;
    everConnected = true;
    stopFallback();
    invalidateFor(status);
    // Reads that failed during the outage stay failed until refetched, even if nothing moved.
    if (recovered) void client.invalidateQueries();
    set({ status, fetchedAt: at, connected: true, paused: false, unreachable: false });
  };
  const applyError = (unreachable: boolean) => {
    misses++;
    const paused = misses >= PAUSED_AFTER_MISSES;
    if (paused) startFallback();
    set({
      connected: false,
      paused,
      unreachable: unreachable && (!everConnected || misses >= UNREACHABLE_AFTER_MISSES),
    });
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), ms);
  };

  const poll = async () => {
    if (!running || controller) return;
    // The first poll runs even in a hidden tab, so a fresh tab reaches data or an error (O3/O6).
    if (attempted && hidden()) return;
    attempted = true;
    const current = new AbortController();
    controller = current;
    let next = STATUS_POLL_MS;
    try {
      const status = await options.fetchStatus(current.signal);
      if (!running || current.signal.aborted) return;
      if (status === null || typeof status !== "object") throw new Error("/api/status: bad body");
      const at = Date.now();
      applyStatus(status, at);
      channel?.postMessage({ kind: "status", status, at } satisfies Message);
      if (isBusy(status)) next = STATUS_BUSY_POLL_MS;
    } catch (error) {
      if (!running || current.signal.aborted) return;
      const unreachable = isDaemonUnreachableError(error);
      applyError(unreachable);
      channel?.postMessage({ kind: "error", unreachable } satisfies Message);
    } finally {
      if (controller === current) controller = undefined;
      if (running && polls() && !hidden()) schedule(next);
    }
  };

  const acquire = () => {
    if (locks === null || lockPending || leader || !running) return;
    lockPending = true;
    void locks.request(LOCK_NAME, () => {
      lockPending = false;
      if (!running || hidden()) return Promise.resolve();
      leader = true;
      clearTimeout(timer);
      void poll();
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
  };
  const resign = () => {
    leader = false;
    releaseLock?.();
    releaseLock = undefined;
  };

  const onMessage = (event: { data: unknown }) => {
    const message = event.data as Message;
    if (message.kind === "hello") {
      if (leader && state.status !== null && state.fetchedAt !== undefined) {
        channel?.postMessage({
          kind: "status",
          status: state.status,
          at: state.fetchedAt,
        } satisfies Message);
      }
      return;
    }
    if (polls()) return;
    if (message.kind === "status") applyStatus(message.status, message.at);
    else applyError(message.unreachable);
  };

  const onVisibility = () => {
    if (hidden()) {
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
      resign();
    } else if (locks === null) {
      clearTimeout(timer);
      void poll();
    } else {
      acquire();
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      // A restart begins as a fresh tab: no remembered counters, misses or connection.
      attempted = false;
      misses = 0;
      everConnected = false;
      lastVersion = undefined;
      lastScopes = undefined;
      state = {
        status: null,
        fetchedAt: undefined,
        connected: null,
        paused: false,
        unreachable: false,
      };
      document.addEventListener("visibilitychange", onVisibility);
      if (locks !== null) {
        const opened = openChannel();
        opened.onmessage = onMessage;
        opened.postMessage({ kind: "hello" } satisfies Message);
        channel = opened;
      }
      if (locks === null || hidden()) void poll();
      else acquire();
    },
    stop() {
      running = false;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(timer);
      clearTimeout(jitterTimer);
      stopFallback();
      controller?.abort();
      controller = undefined;
      resign();
      channel?.close();
      channel = undefined;
    },
    pollNow() {
      if (!running) return;
      clearTimeout(timer);
      void poll();
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ── the app's shared poller: starts with its first reader, stops with its last ──────────────

let shared: StatusPoller | undefined;
let readers = 0;

function sharedPoller(): StatusPoller {
  shared ??= createStatusPoller({ queryClient, fetchStatus });
  return shared;
}

function subscribeShared(listener: () => void): () => void {
  const poller = sharedPoller();
  const unsubscribe = poller.subscribe(listener);
  readers++;
  if (readers === 1) poller.start();
  return () => {
    unsubscribe();
    if (shared !== poller) return;
    readers--;
    if (readers === 0) poller.stop();
  };
}

const getSharedState = () => sharedPoller().getState();

/** The shared /api/status poller's state; mounting the first reader starts it. */
export function useStatusPoller(): StatusPollerState {
  return useSyncExternalStore(subscribeShared, getSharedState);
}

/** Poll the shared status now (the unreachable card's Retry). */
export function pollStatusNow(): void {
  sharedPoller().pollNow();
}

/** Tests only: drop the shared poller so the next reader starts a fresh one. */
export function _resetStatusPoller(): void {
  shared?.stop();
  shared = undefined;
  readers = 0;
}
