/**
 * test/ui/overview/overview-view-from-legacy.ts — serve the mocked `fetchOverviewView` from a
 * test file's legacy fetcher mocks (P1-U4).
 *
 * The daemon builds each overview-view section from the same query function the legacy route
 * calls (`overviewSectionFns`, src/query/api/overview-view.ts). This adapter does the same with
 * the mocked client: a resolved legacy mock becomes that section's `ok` data (the envelope's
 * `.data`), a rejected one becomes that section's `error`. Existing Overview tests keep their
 * per-card overrides; only the transport moved. Assertions about which requests the page makes
 * must target `fetchOverviewView`, never the legacy fetchers this adapter calls.
 * Requires `vi.mock(".../src/ui/api/client")` in the test file.
 */

import { vi } from "vitest";
import type {
  GlobalOverview,
  LiveSessionRow,
  PagedList,
  WindowFilter,
} from "../../../src/query/api/overview";
import type { OverviewSection } from "../../../src/query/api/overview-view";
import type { FlavorDecomposition } from "../../../src/query/api/spend-flavor";
import type { CacheWriteTrend } from "../../../src/query/api/trends";
import type { ApiResponse } from "../../../src/query/envelope";
import type { OverviewSectionName } from "../../../src/shared/schemas/overview-view";
import * as client from "../../../src/ui/api/client";

type Preset = "24h" | "7d" | "30d";

// The standalone client fetchers for these four reads were deleted (PZ): the page only calls
// `fetchOverviewView`. These test-local mocks keep the per-card override seam: tests set them,
// and `serveOverviewViewFromLegacyMocks` turns them into the matching overview-view sections.
export const fetchGlobalOverview =
  vi.fn<(filter: WindowFilter) => Promise<ApiResponse<GlobalOverview>>>();
export const fetchFlavorDecomposition =
  vi.fn<(filter: WindowFilter) => Promise<ApiResponse<FlavorDecomposition>>>();
export const fetchCacheWriteTrend =
  vi.fn<(filter: WindowFilter) => Promise<ApiResponse<CacheWriteTrend>>>();
export const fetchLiveSessions =
  vi.fn<(signal?: AbortSignal) => Promise<ApiResponse<PagedList<LiveSessionRow>>>>();

async function section(read: () => Promise<unknown>): Promise<OverviewSection> {
  try {
    return { status: "ok", data: await read(), ms: 0 };
  } catch {
    return { status: "error", ms: 0 };
  }
}

async function compose(
  preset: string,
  only?: OverviewSectionName[],
): Promise<client.OverviewViewResponse> {
  const filter = { preset: preset as Preset };
  const trends = () => client.fetchTrends(filter);
  const fns: Record<OverviewSectionName, () => Promise<unknown>> = {
    kpis: async () => (await fetchGlobalOverview(filter)).data,
    workspaces: async () => (await client.fetchWorkspaces(filter)).data,
    trends: async () => (await trends()).data,
    trends_prior: async () => {
      const { from, to } = (await trends()).meta.window;
      const span = Date.parse(to) - Date.parse(from);
      const prior = { from: new Date(Date.parse(from) - span).toISOString(), to: from };
      return (await client.fetchTrends(prior)).data;
    },
    flavor: async () => (await fetchFlavorDecomposition(filter)).data,
    cache_write: async () => (await fetchCacheWriteTrend(filter)).data,
    weekly_sessions: async () => {
      const [rows, week] = await Promise.all([
        client.fetchHotSessions({ preset: "7d" }),
        fetchGlobalOverview({ preset: "7d" }),
      ]);
      if (week.data === null) throw new Error("seven-day overview is empty");
      return { rows: rows.slice(0, 5), cost_equiv_u: week.data.cost_equiv_u };
    },
    live: async () => (await fetchLiveSessions()).data,
    status: () => client.fetchStatus(),
    top_recs: async () => {
      const view = (await client.fetchRecommendations()).data;
      return {
        active: view?.active ?? [],
        adopted: view?.adopted ?? [],
        ...(view?.active_groups === undefined ? {} : { active_groups: view.active_groups }),
      };
    },
    linkage: async () => (await client.fetchLinkageRate()).data,
    hook_config: async () => (await client.fetchHookConfig()).data,
  };
  const names = only ?? (Object.keys(fns) as OverviewSectionName[]);
  const sections = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await section(fns[name])] as const)),
  );
  return { data_version: 1, consistent: true, window: { from: "", to: "", preset }, sections };
}

export function serveOverviewViewFromLegacyMocks(): void {
  vi.mocked(client.fetchOverviewView).mockImplementation((preset, _signal, sections) =>
    compose(preset, sections),
  );
}
