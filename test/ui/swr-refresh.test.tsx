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
  mockLiveSessions,
  mockRecommendations,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import OverviewPage from "../../src/ui/overview/OverviewPage";

vi.mock("../../src/ui/api/client");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchFlavorDecomposition).mockResolvedValue(
    mockFlavorDecomposition({ preset: "7d" }),
  );
  vi.mocked(client.fetchCacheWriteTrend).mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
});

describe("OverviewPage SWR refresh", () => {
  it("keeps live data rendered while the next interval fetch is pending", async () => {
    vi.useFakeTimers();
    const firstLiveResponse = mockLiveSessions();
    let resolveSecondFetch: ((value: typeof firstLiveResponse) => void) | undefined;
    const secondFetch = new Promise<typeof firstLiveResponse>((resolve) => {
      resolveSecondFetch = resolve;
    });
    vi.mocked(client.fetchLiveSessions)
      .mockResolvedValueOnce(firstLiveResponse)
      .mockReturnValueOnce(secondFetch);

    const { container } = render(<OverviewPage />);

    // Flush the mount fetches under fake timers (waitFor's own polling would be
    // frozen by fake timers, so drive the clock directly instead).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(client.fetchLiveSessions).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();
    expect(container.querySelector(".live-strip .skeleton")).toBeNull();

    await act(async () => {
      resolveSecondFetch?.(firstLiveResponse);
      await Promise.resolve();
    });
  });
});
