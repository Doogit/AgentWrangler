import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import * as esfClient from "../../../src/ui/api/esf-client";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
});

describe("OverviewPage first-run onboarding", () => {
  it.each(["24h", "30d"] as const)("labels spend with the selected %s window", async (preset) => {
    // In overview-v2 the KPI section header is "This period ({preset})".
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 5 }));
    const response = mockGlobalOverview({ preset });
    if (response.data === null) throw new Error("expected overview fixture");
    response.data.cost_equiv_u = 12_340_000;
    fetchGlobalOverview.mockResolvedValue(response);
    render(<OverviewPage />);
    await screen.findByText("This period (7d)");
    fireEvent.click(screen.getByRole("button", { name: preset }));
    const heading = await screen.findByText(`This period (${preset})`);
    expect(heading.closest("section")?.textContent).toContain("$12.34");
    expect(screen.queryByText("This period (7d)")).toBeNull();
  });

  // "selects a workspace for observations while keeping the global overview scope" — DELETED:
  // the ESF observation workspace selector was removed from OverviewPage in overview-v2.
  it("shows API-derived ingest progress and hides normal KPI cards before any sessions exist", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(
      mockStatus({ sessions: 0, files_seen: 10, files_parsed: 4, scan_state: "scanning" }),
    );

    render(<OverviewPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /welcome/i })).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: /daemon running/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /first session ingested/i })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /first recommendation generated/i })).toBeNull();
    expect(screen.getByText(/\d of 2/)).toBeTruthy();
    expect(screen.getByText(/Scanning.*4 of 10 files/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /spend vs your limit/i })).toBeNull();
  });

  it("renders the normal Overview once sessions exist", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 5 }));

    render(<OverviewPage />);

    // overview-v2: KPI section heading is "This period ({preset})" not "Weekly burn forecast".
    await waitFor(() => expect(screen.getByRole("heading", { name: /This period/i })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: /welcome to agentwrangler/i })).toBeNull();
  });
});

describe("scan recovery and healthy empty findings", () => {
  it.each([
    [{ scan_state: "complete" as const }, /Scan complete.*no readable sessions found/],
    [{ scan_state: "failed" as const }, /Initial scan failed/],
    [{ invalid_scan_root_count: 2 }, /2 scan root.*missing or unreadable/],
    [{ lines_quarantined: 3 }, /3 transcript line.*could not be parsed/],
  ])("distinguishes recovery state %j", async (status, message) => {
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 0, ...status }));
    render(<OverviewPage />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/Scanning.*0 of 0/)).toBeNull();
  });

  it("keeps older daemon completion status unknown", async () => {
    const { scan_state: _scanState, ...status } = mockStatus({ sessions: 0 });
    vi.mocked(client.fetchStatus).mockResolvedValue(status);
    render(<OverviewPage />);
    expect(await screen.findByText(/Scan completion status is unavailable/)).toBeTruthy();
  });

  // "completes setup with history and no recommendations or integrations" — DELETED:
  // the "Setup complete…no recommendations were found" message was removed in overview-v2;
  // an empty recommendations state now shows the KPI section without a decision card.

  it("does not describe a failed recommendations request as no findings", async () => {
    vi.mocked(client.fetchRecommendations).mockRejectedValue(new Error("unavailable"));
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 1 }));
    render(<OverviewPage />);
    // overview-v2: wait for the KPI section heading instead of the removed burn-forecast card.
    await screen.findByRole("heading", { name: /This period/i });
    expect(screen.queryByText(/no recommendations were found/)).toBeNull();
  });
});
