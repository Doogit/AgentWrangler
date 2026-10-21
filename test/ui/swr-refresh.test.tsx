/**
 * Overview SWR refresh behavior using only aggregate fixture responses.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHeadroomTrend,
  mockHookConfigResponse,
  mockHotSessions,
  mockLimits,
  mockLinkageRate,
  mockLiveSessions,
  mockRecommendations,
  mockStatus,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import { STATUS_POLL_MS } from "../../src/ui/api/status-poller";
import OverviewPage from "../../src/ui/overview/OverviewPage";

import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview/overview-view-from-legacy";

vi.mock("../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
});

describe("OverviewPage SWR refresh", () => {
  it("keeps live data rendered while the next live refetch is pending", async () => {
    vi.useFakeTimers();
    // P2-U5: a status poll whose `live` scope moved refetches the live sections.
    let scopes = { live: 1, ingest: 1, detectors: 1, lifecycle: 0, clock: "d|d" };
    vi.mocked(client.fetchStatus).mockImplementation(async () =>
      mockStatus({ data_scopes: scopes }),
    );
    const firstLiveResponse = mockLiveSessions();
    let resolveSecondFetch: ((value: typeof firstLiveResponse) => void) | undefined;
    const secondFetch = new Promise<typeof firstLiveResponse>((resolve) => {
      resolveSecondFetch = resolve;
    });
    fetchLiveSessions.mockResolvedValueOnce(firstLiveResponse).mockReturnValueOnce(secondFetch);

    const { container } = render(<OverviewPage />);

    // Flush the mount fetches under fake timers (waitFor's own polling would be
    // frozen by fake timers, so drive the clock directly instead).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();

    scopes = { ...scopes, live: 2 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });

    // The live tail refetches `?sections=live,status` once and never the page. The G-P1
    // KPI-first `?sections=kpis,status` subset is a separate one-shot call.
    const calls = vi.mocked(client.fetchOverviewView).mock.calls;
    expect(calls.filter(([, , sections]) => sections === undefined)).toHaveLength(1);
    expect(calls.filter(([, , sections]) => sections?.join(",") === "live,status")).toHaveLength(1);
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();
    expect(container.querySelector(".live-strip .skeleton")).toBeNull();

    await act(async () => {
      resolveSecondFetch?.(firstLiveResponse);
      await Promise.resolve();
    });
  });
});
