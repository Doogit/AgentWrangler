import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
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
});

describe("Overview caveat banner", () => {
  it("renders inside page-top below the date-preset row", async () => {
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const pageTop = container.querySelector(".page-top");
      expect(pageTop?.querySelector(".date-range")).not.toBeNull();
      expect(pageTop?.querySelector(".banner-info")?.textContent).toContain(
        "List-price equivalents only",
      );
    });
  });

  it("hides on dismiss and persists the dismissal", async () => {
    const { container } = render(<OverviewPage />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss usage caveat" });
    fireEvent.click(dismiss);

    expect(container.querySelector(".page-top .banner-info")).toBeNull();
    expect(window.localStorage.getItem("aw-caveat-dismissed")).toBe("1");
  });

  it("does not render when the dismissal is already stored", () => {
    window.localStorage.setItem("aw-caveat-dismissed", "1");

    const { container } = render(<OverviewPage />);

    expect(container.querySelector(".page-top .banner-info")).toBeNull();
  });

  it("still renders when localStorage getItem throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    const { container } = render(<OverviewPage />);

    expect(container.querySelector(".page-top .banner-info")).not.toBeNull();
  });
});
