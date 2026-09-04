/**
 * test/ui/overview/nu4-activation.test.tsx — NU4 first-run activation CTAs.
 *
 * Covers the conditional-render contract: each activation item appears on the
 * FirstRunWelcome card only while its feature is inactive, carries a working
 * deep link to Settings, and disappears once the feature activates. Also covers
 * the RateLimitGauges empty-state calibrate link.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGithubTokenStatus,
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
import RateLimitGauges from "../../../src/ui/overview/RateLimitGauges";

vi.mock("../../../src/ui/api/client");

afterEach(() => cleanup());

/** Base mocks: first-run (0 sessions), nothing activated. */
function primeFirstRun() {
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
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue(mockGithubTokenStatus());
  vi.mocked(client.fetchStatus).mockResolvedValue(
    mockStatus({ sessions: 0, files_seen: 10, files_parsed: 4 }),
  );
}

/** A calibrated overview forecast (limit set → state OK, not OFF). */
function calibratedOverview() {
  const overview = mockGlobalOverview({ preset: "7d" });
  if (overview.data !== null) {
    overview.data.forecast = {
      ...overview.data.forecast,
      state: "OK",
      limit_tokens: 10_000_000_000,
    };
  }
  return overview;
}

describe("NU4 — first-run activation CTAs", () => {
  beforeEach(primeFirstRun);

  it("renders all three activation items with working Settings links while everything is inactive", async () => {
    render(<OverviewPage />);

    const activation = await screen.findByTestId("first-run-activation");
    expect(activation).toBeTruthy();

    for (const testid of ["first-run-calibrate", "first-run-token", "first-run-hook"]) {
      const item = screen.getByTestId(testid);
      const link = item.querySelector("a");
      expect(link?.getAttribute("href")).toBe("#/settings");
    }

    // The "First session ingested" step gains its one specific sentence.
    expect(screen.getByTestId("first-run-ingest-hint")).toBeTruthy();
  });

  it("hides the calibrate item once the weekly limit is calibrated", async () => {
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue(calibratedOverview());

    render(<OverviewPage />);

    await screen.findByTestId("first-run-token");
    expect(screen.queryByTestId("first-run-calibrate")).toBeNull();
  });

  it("hides the outcomes-sync item once a GitHub token is configured", async () => {
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "env",
    });

    render(<OverviewPage />);

    await screen.findByTestId("first-run-calibrate");
    await waitFor(() => expect(screen.queryByTestId("first-run-token")).toBeNull());
  });

  it("hides the in-session-guards item once the hook is installed", async () => {
    vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(true));

    render(<OverviewPage />);

    await screen.findByTestId("first-run-calibrate");
    await waitFor(() => expect(screen.queryByTestId("first-run-hook")).toBeNull());
  });

  it("omits the activation section entirely when every feature is active", async () => {
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue(calibratedOverview());
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "env",
    });
    vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(true));

    render(<OverviewPage />);

    // Wait for the first-run card itself to appear, then assert no activation block.
    await screen.findByRole("heading", { name: /welcome to agentwrangler/i });
    await waitFor(() => expect(screen.queryByTestId("first-run-activation")).toBeNull());
  });
});

describe("NU4 — RateLimitGauges empty-state calibrate link", () => {
  it("links the calibrate target when rate-limit data is unavailable", () => {
    render(<RateLimitGauges burnStatus={null} isLoading={false} />);
    const link = screen.getByTestId("gauges-calibrate-link");
    expect(link.getAttribute("href")).toBe("#/settings");
  });
});
