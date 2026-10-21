import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
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
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
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
});

describe("Overview caveat banner", () => {
  it("renders caveat text in the Data notes section (overview-v2 §8)", async () => {
    // In overview-v2 the dismissible CAVEAT_COPY banner in page-top was removed;
    // caveat text now lives in the always-visible §8 Data notes section.
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      // Date-range control is still in page-top.
      const pageTop = container.querySelector(".page-top");
      expect(pageTop?.querySelector(".date-range")).not.toBeNull();
    });

    // Caveat text is in the data-notes section (§8), not in a page-top banner.
    const dataNote = await screen.findByText(/tokens × API list price/);
    expect(dataNote).toBeTruthy();
    expect(container.querySelector(".page-top .banner-info")).toBeNull();
  });

  // "hides on dismiss and persists the dismissal" — DELETED: the CAVEAT_COPY
  // dismissible banner was removed in overview-v2 (spec §8 replaces it).

  it("does not render when the dismissal is already stored", () => {
    // Banner is gone in overview-v2; localStorage key has no effect.
    window.localStorage.setItem("aw-caveat-dismissed", "1");

    const { container } = render(<OverviewPage />);

    expect(container.querySelector(".page-top .banner-info")).toBeNull();
  });

  // "still renders when localStorage getItem throws" — DELETED: the banner that
  // used localStorage for dismissal was removed in overview-v2 (spec §8).
});
