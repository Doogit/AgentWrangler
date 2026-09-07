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
      mockStatus({ sessions: 0, files_seen: 10, files_parsed: 4, scan_state: "scanning" }),
    );

    render(<OverviewPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /welcome/i })).toBeTruthy());
    expect(screen.getByRole("checkbox", { name: /daemon running/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /first session ingested/i })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /first recommendation generated/i })).toBeNull();
    expect(screen.getByText(/\d of 2/)).toBeTruthy();
    expect(screen.getByText(/Scanning.*4 of 10 files/)).toBeTruthy();
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

  it("completes setup with history and no recommendations or integrations", async () => {
    const recs = mockRecommendations();
    if (!recs.data) throw new Error("missing fixture");
    recs.data = {
      ...recs.data,
      active: [],
      active_groups: [],
      limit_warnings: [],
      adopted: [],
      dismissed: [],
    };
    vi.mocked(client.fetchRecommendations).mockResolvedValue(recs);
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 1 }));
    render(<OverviewPage />);
    expect(await screen.findByText(/Setup complete.*no recommendations were found/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Read an ingested session/ }).getAttribute("href"),
    ).toBe("#/sessions");
    expect(screen.queryByRole("heading", { name: /welcome to agentwrangler/i })).toBeNull();
  });

  it("does not describe a failed recommendations request as no findings", async () => {
    vi.mocked(client.fetchRecommendations).mockRejectedValue(new Error("unavailable"));
    vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus({ sessions: 1 }));
    render(<OverviewPage />);
    await screen.findByRole("heading", { name: /two meters, several tanks/i });
    expect(screen.queryByText(/no recommendations were found/)).toBeNull();
  });
});
