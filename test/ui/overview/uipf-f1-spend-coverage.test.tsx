/** UIP-F1: selected-window spend coverage disclosure. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
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
} from "../../../src/ui/api/fixtures";
import OverviewPage from "../../../src/ui/overview/OverviewPage";

import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview-view-from-legacy";

vi.mock("../../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);
vi.mock("../../../src/ui/api/esf-client", () => ({
  fetchEsfObservations: vi.fn().mockResolvedValue({ data: null }),
}));

afterEach(() => cleanup());

function setupOverview(unpricedTurns: number) {
  const overview = mockGlobalOverview({ preset: "7d" });
  if (overview.data === null) throw new Error("overview fixture must contain data");
  overview.data = { ...overview.data, unpriced_turns: unpricedTurns };

  fetchGlobalOverview.mockResolvedValue(overview);
  vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 5 }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
}

describe("OverviewPage selected-window spend coverage", () => {
  beforeEach(() => vi.clearAllMocks());

  // "keeps the spend disclosure unchanged when every turn is priced" — DELETED:
  // the "list-equiv · not billing" label and spend-unpriced-caveat badge were removed
  // in overview-v2; spend context now lives in DataNotes §8.

  // "discloses partial coverage when selected-window turns are unpriced" — DELETED:
  // the spend-unpriced-caveat (data-testid="spend-unpriced-caveat") was removed in
  // overview-v2; the unpriced_turns field is no longer surfaced in the Overview UI.

  it("renders the This period KPI section when spend data is present", async () => {
    setupOverview(0);
    render(<OverviewPage />);
    // Verifies the KPI section heading appears when overview data loads.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /This period/i })).toBeTruthy();
    });
  });
});
