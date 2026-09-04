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
  mockLiveSessions,
  mockRecommendations,
  mockStatus,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import OverviewPage from "../../../src/ui/overview/OverviewPage";

vi.mock("../../../src/ui/api/client");

afterEach(() => cleanup());

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

describe("OverviewPage first-run onboarding", () => {
  it("shows API-derived ingest progress and hides normal KPI cards before any sessions exist", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(
      mockStatus({ sessions: 0, files_seen: 10, files_parsed: 4 }),
    );

    render(<OverviewPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /welcome/i })).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: /daemon running/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /first session ingested/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /first recommendation generated/i })).toBeTruthy();
    expect(screen.getByText(/\d of 3/)).toBeTruthy();
    expect(screen.getByText("ingesting… 4 of 10 files")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /two meters, several tanks/i })).toBeNull();
  });

  it("renders the normal Overview once sessions exist", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 5 }));

    render(<OverviewPage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /two meters, several tanks/i })).toBeTruthy(),
    );
    expect(screen.queryByRole("heading", { name: /welcome to agentwrangler/i })).toBeNull();
  });
});
