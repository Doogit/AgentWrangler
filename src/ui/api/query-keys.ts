/**
 * src/ui/api/query-keys.ts — TanStack query keys (perf plan P1-U3).
 *
 * Each key family is tagged with the data scopes that change it, so P2-U5's push channel can
 * invalidate by scope:
 *   live       live sessions and their ages
 *   ingest     new transcript rows (ingest commits, walks)
 *   detectors  detector / analysis passes (recs, findings)
 *   lifecycle  user writes (adopt, dismiss, settings, hooks)
 *   clock      rolling windows that move with time alone
 */

export const DATA_SCOPES = ["live", "ingest", "detectors", "lifecycle", "clock"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** The Overview subset a `live` change refetches (never the whole page; review M4). */
export const OVERVIEW_LIVE_SECTIONS = ["live", "status"] as const;

export const queryKeys = {
  overviewView: (preset: string) => ["overview-view", preset] as const,
  /** A `?sections=` subset of the page (same family, so page invalidations reach it). */
  overviewViewSections: (preset: string, sections: readonly string[]) =>
    ["overview-view", preset, sections.join(",")] as const,
  // P1-U6a detail keys: no refetchInterval, 60 s staleTime (query-client.ts), so a prefetch is
  // reused by the click that follows it.
  session: (id: string) => ["session", id] as const,
  /** One turns page: the first page, a cursor page, or the page through an anchor. */
  sessionTurns: (id: string, page: string) => ["session-turns", id, page] as const,
  sessionDrivers: (id: string) => ["session-drivers", id] as const,
  sessionPercentile: (id: string) => ["session-percentile", id] as const,
  sessionStory: (id: string) => ["session-story", id] as const,
  /** A Sessions-list page past the first (the "Load more" cursor). */
  hotSessionsMore: (query: string, cursor: string) => ["hot-sessions-more", query, cursor] as const,
  /** Header values from the clicked list row; written on click, never fetched. */
  sessionSeed: (id: string) => ["session-seed", id] as const,
  workspaceSeed: (id: string, preset: string) => ["workspace-seed", id, preset] as const,
  /** The Overview's setup-grade card. No scopes: each call runs a scan + grade, so it never auto-refetches. */
  judgeSetup: () => ["judge-setup"] as const,
};

/** Data scopes per key family (the key's first element). */
export const queryKeyScopes: Record<string, readonly DataScope[]> = {
  // The page and its other subsets; a `live` change reaches only the live,status subset.
  "overview-view": ["ingest", "detectors", "lifecycle", "clock"],
  session: ["live", "ingest"],
  "session-turns": ["live", "ingest"],
  "session-drivers": ["ingest", "detectors"],
  "session-percentile": ["ingest", "clock"],
  "session-story": ["live", "ingest"],
  "hot-sessions-more": ["live", "ingest", "detectors", "clock"],
};

/** The scopes whose change invalidates this query key (P2-U5 status poller). */
export function scopesForKey(key: readonly unknown[]): readonly DataScope[] {
  if (key[0] === "overview-view" && key[2] === OVERVIEW_LIVE_SECTIONS.join(",")) return ["live"];
  return queryKeyScopes[String(key[0])] ?? [];
}

/** Detail keys keep a fetched or prefetched body this long before a reader refetches it. */
export const DETAIL_STALE_MS = 60_000;
