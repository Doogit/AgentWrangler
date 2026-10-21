/**
 * src/ui/api/prefetch.ts — prefetch on intent (P1-U6a).
 *
 * - Row triggers: pointer-enter held 80 ms, or keyboard focus. Leaving the row aborts its client
 *   fetch (a handler the daemon already dispatched still runs, which is why triggers stay narrow
 *   and only the cheap first read is prefetched).
 * - In-view: only the "Load more" row, for the next cursor (one request).
 * - At most 2 prefetch requests in flight per page; a key still inside its staleTime is skipped.
 * - Paused while /api/status reports backfill (pre-ready boot scan or a pipeline phase) or loop
 *   lag p99 over M1 (50 ms). StatusChip feeds the shell's one status poll in here.
 */

import type { QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryClient } from "./query-client";
import { DETAIL_STALE_MS } from "./query-keys";

export interface PrefetchQuery {
  queryKey: QueryKey;
  queryFn: (signal: AbortSignal) => Promise<unknown>;
}

const HOVER_DELAY_MS = 80;
const MAX_IN_FLIGHT = 2;
const LOOP_LAG_P99_MAX_MS = 50; // M1
const BACKFILL_PHASES = new Set(["reading", "detecting", "history"]);

let inFlight = 0;
let paused = false;

/** Called with every /api/status body; odd bodies (test mocks) leave the gate open. */
export function notePrefetchStatus(status: unknown): void {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    paused = false;
    return;
  }
  const s = status as {
    boot_files_total?: unknown;
    pipeline?: { phase?: unknown; failed_phase?: unknown };
    loop_lag?: { p99?: unknown };
  };
  const phase = s.pipeline?.phase;
  const p99 = s.loop_lag?.p99;
  paused =
    s.boot_files_total !== undefined ||
    (typeof phase === "string" && BACKFILL_PHASES.has(phase) && !s.pipeline?.failed_phase) ||
    (typeof p99 === "number" && p99 > LOOP_LAG_P99_MAX_MS);
}

function isFresh(queryKey: QueryKey): boolean {
  const state = queryClient.getQueryState(queryKey);
  if (state === undefined) return false;
  if (state.fetchStatus === "fetching") return true;
  return (
    state.data !== undefined &&
    !state.isInvalidated &&
    Date.now() - state.dataUpdatedAt < DETAIL_STALE_MS
  );
}

/** Start each query that is not fresh, within the in-flight cap. */
function start(queries: PrefetchQuery[], controllers: Set<AbortController>): void {
  if (paused) return;
  for (const query of queries) {
    if (inFlight >= MAX_IN_FLIGHT) return;
    if (isFresh(query.queryKey)) continue;
    const controller = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      controllers.delete(controller);
    };
    inFlight += 1;
    controllers.add(controller);
    controller.signal.addEventListener("abort", release, { once: true });
    void queryClient
      .prefetchQuery({
        queryKey: query.queryKey,
        queryFn: () => query.queryFn(controller.signal),
        staleTime: DETAIL_STALE_MS,
      })
      .finally(release);
  }
}

export interface IntentHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/** Spread on a row's link: prefetches `queries()` on hover ≥ 80 ms or focus. */
export function usePrefetchOnIntent(queries: () => PrefetchQuery[]): IntentHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controllers = useRef(new Set<AbortController>());
  const latest = useRef(queries);
  latest.current = queries;
  // Unmount (the click navigated away) keeps the prefetch: the detail page reads it.
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    for (const c of [...controllers.current]) c.abort();
  }, []);
  return {
    onPointerEnter: useCallback(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => start(latest.current(), controllers.current),
        HOVER_DELAY_MS,
      );
    }, []),
    onPointerLeave: leave,
    onFocus: useCallback(() => start(latest.current(), controllers.current), []),
    onBlur: leave,
  };
}

/**
 * A ref for the "Load more" row: prefetches `queries()` once when it is in view. A new `depKey`
 * (the next cursor) observes again, without remounting the button (keyboard focus stays).
 */
export function useInViewPrefetch(
  queries: () => PrefetchQuery[] | null,
  depKey = "",
): (element: Element | null) => void {
  const latest = useRef(queries);
  latest.current = queries;
  const [element, setElement] = useState<Element | null>(null);
  useEffect(() => {
    void depKey;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      const list = latest.current();
      if (list === null || paused) return; // stays observed: a later scroll can still prefetch
      io.disconnect();
      start(list, new Set());
    });
    io.observe(element);
    return () => io.disconnect();
  }, [element, depKey]);
  return setElement;
}
