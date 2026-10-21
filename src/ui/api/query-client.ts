/**
 * src/ui/api/query-client.ts — the app's one TanStack `QueryClient` (perf plan P1-U3).
 *
 * Coexists with client.ts's `responseCache`: migrated pages read through TanStack (their query
 * functions pass `{ fresh: true }` so they never get a responseCache entry), unmigrated callers
 * keep the old cache. Every client write helper calls `clearResponseCache()`, which also
 * invalidates every query here.
 */

import { QueryClient } from "@tanstack/react-query";
import { DETAIL_STALE_MS } from "./query-keys";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Page keys do not poll: the status poller (P2-U5) invalidates them when a data scope they read
// moves. staleTime stays 0, so a remounted page refetches as it does today (the Recommendations
// page's adopt/dismiss POSTs bypass client.ts, so a cached page key would otherwise show
// pre-write recs after navigating back, until the next poll sees `lifecycle` move).
// networkMode "always": the daemon is on 127.0.0.1, so navigator.onLine says nothing about
// reaching it; "online" would pause the first fetch while offline and leave an endless skeleton
// (O3/O6).
queryClient.setQueryDefaults(["overview-view"], {
  networkMode: "always",
});

// P1-U6a detail keys: no polling and a 60 s staleTime, so a hover/in-view prefetch is reused by
// the click; the status poller invalidates them by scope.
for (const family of [
  "session",
  "session-turns",
  "session-drivers",
  "session-percentile",
  "hot-sessions-more",
]) {
  // retry: false keeps the pre-U6a behavior (each panel shows its own error and Retry at once).
  queryClient.setQueryDefaults([family], {
    staleTime: DETAIL_STALE_MS,
    networkMode: "always",
    retry: false,
  });
}
