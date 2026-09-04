/**
 * test/ui/overview/rv7-overview.test.tsx — RV7 Overview tile row tests.
 *
 * Covers:
 *   - Rate-limit gauges: signed-in shows both bars with thresholds; signed-out shows honest empty
 *   - Hook tile: installed state; not-installed shows CTA; both ways reflect real install state
 *   - Hot sessions top-3: rows render and call onSelectSession on click
 *   - SuccessRateCard gone from Overview (demoted to Workspaces in RV1)
 *   - WorkspaceTable shows teaser ("Top Workspaces") + "All workspaces" link
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockBurnStatus,
  mockBurnStatusSignedOut,
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
} from "../../../src/ui/api/fixtures";
import HookTile from "../../../src/ui/overview/HookTile";
import OverviewPage from "../../../src/ui/overview/OverviewPage";
import RateLimitGauges from "../../../src/ui/overview/RateLimitGauges";

vi.mock("../../../src/ui/api/client");

afterEach(() => cleanup());

function setupCommonMocks() {
  vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchFlavorDecomposition).mockResolvedValue(
    mockFlavorDecomposition({ preset: "7d" }),
  );
  vi.mocked(client.fetchCacheWriteTrend).mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setupCommonMocks();
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
});

// ---------------------------------------------------------------------------
// RateLimitGauges — unit tests
// ---------------------------------------------------------------------------

describe("RateLimitGauges — signed-in", () => {
  it("renders both gauges with aria progressbars when signed in", () => {
    const { data } = mockBurnStatus();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    const gauges = container.querySelectorAll("[role='progressbar']");
    expect(gauges.length).toBe(2);
  });

  it("renders 5-hour utilization at 45% (green threshold)", () => {
    const { data } = mockBurnStatus();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    const text = container.textContent ?? "";
    expect(text).toContain("45%");
    expect(text).toContain("5-hour");
  });

  it("renders 7-day utilization at 72% (amber threshold)", () => {
    const { data } = mockBurnStatus();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    const text = container.textContent ?? "";
    expect(text).toContain("72%");
    expect(text).toContain("7-day");
  });

  it("green bar has green fill (< 60%)", () => {
    const { data } = mockBurnStatus();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    // 45% is in the green band; the fill div should use --green color
    const bars = container.querySelectorAll("[aria-hidden='true']");
    const greenBar = bars[0] as HTMLElement;
    expect(greenBar.style.background).toContain("var(--green");
  });

  it("amber bar has amber fill (60-85%)", () => {
    const { data } = mockBurnStatus();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    const bars = container.querySelectorAll("[aria-hidden='true']");
    const amberBar = bars[1] as HTMLElement;
    expect(amberBar.style.background).toContain("var(--amber");
  });
});

describe("RateLimitGauges — signed-out", () => {
  it("shows Settings pointer instead of numbers when not authenticated", () => {
    const { data } = mockBurnStatusSignedOut();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    // No progressbars (no numbers)
    expect(container.querySelectorAll("[role='progressbar']").length).toBe(0);
    // Link to settings
    expect(container.querySelector("a[href='#/settings']")).not.toBeNull();
  });

  it("shows reason text from payload", () => {
    const { data } = mockBurnStatusSignedOut();
    const { container } = render(<RateLimitGauges burnStatus={data} isLoading={false} />);
    expect(container.textContent).toContain("re-login");
  });
});

// ---------------------------------------------------------------------------
// HookTile — unit tests
// ---------------------------------------------------------------------------

describe("HookTile — installed", () => {
  it("shows installed badge when hook is installed", () => {
    const { data } = mockHookConfigResponse(true);
    const { container } = render(<HookTile hookConfig={data} isLoading={false} />);
    expect(container.querySelector("[data-testid='hook-installed-badge']")).not.toBeNull();
    expect(container.textContent).toContain("Installed");
  });

  it("does NOT show CTA when installed", () => {
    const { data } = mockHookConfigResponse(true);
    const { container } = render(<HookTile hookConfig={data} isLoading={false} />);
    expect(container.querySelector("[data-testid='hook-install-cta']")).toBeNull();
  });
});

describe("HookTile — not installed", () => {
  it("shows install CTA link to Settings when not installed", () => {
    const { data } = mockHookConfigResponse(false);
    const { container } = render(<HookTile hookConfig={data} isLoading={false} />);
    const cta = container.querySelector("[data-testid='hook-install-cta']") as HTMLAnchorElement;
    expect(cta).not.toBeNull();
    expect(cta.href).toContain("#/settings");
  });

  it("does NOT show installed badge when not installed", () => {
    const { data } = mockHookConfigResponse(false);
    const { container } = render(<HookTile hookConfig={data} isLoading={false} />);
    expect(container.querySelector("[data-testid='hook-installed-badge']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OverviewPage — integrated tile row
// ---------------------------------------------------------------------------

describe("OverviewPage RV7 tile row", () => {
  it("renders the rv7-tile-row with rate-limit + hook + hot-sessions tiles", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='rv7-tile-row']")).not.toBeNull();
      expect(container.querySelector("[data-testid='rate-limit-gauges']")).not.toBeNull();
      expect(container.querySelector("[data-testid='hook-tile']")).not.toBeNull();
      expect(container.querySelector("[data-testid='hot-sessions-tile']")).not.toBeNull();
    });
  });

  it("hot-sessions tile renders top-3 rows from fixture", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      // Fixture has 3 sessions
      expect(container.querySelectorAll("[data-testid^='hot-session-row-']").length).toBe(3);
    });
  });

  it("hot-sessions rows call onSelectSession on click", async () => {
    const onSelectSession = vi.fn();
    const { container } = render(<OverviewPage onSelectSession={onSelectSession} />);
    await waitFor(() => {
      const firstRow = container.querySelector(
        "[data-testid='hot-session-row-hot-session-1']",
      ) as HTMLButtonElement;
      expect(firstRow).not.toBeNull();
      fireEvent.click(firstRow);
      expect(onSelectSession).toHaveBeenCalledWith("hot-session-1");
    });
  });

  it("SuccessRateCard (SUCCESS RATE label) is NOT present on Overview", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      // Wait for overview data to render
      expect(container.querySelector("[data-testid='rv7-tile-row']")).not.toBeNull();
    });
    // "SUCCESS RATE" label must not appear — it lives on Workspaces now
    const kpiLabels = Array.from(container.querySelectorAll(".kpi-label"));
    const hasSuccessRate = kpiLabels.some((el) => el.textContent?.trim() === "SUCCESS RATE");
    expect(hasSuccessRate).toBe(false);
  });

  it("WorkspaceTable renders as teaser with 'Top Workspaces' heading", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      const headings = Array.from(container.querySelectorAll("h2"));
      const found = headings.some((h) => h.textContent?.includes("Top Workspaces"));
      expect(found).toBe(true);
    });
  });

  it("WorkspaceTable teaser shows 'All workspaces' link to #/workspaces", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      const link = container.querySelector(
        "[data-testid='all-workspaces-link']",
      ) as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.href).toContain("#/workspaces");
    });
  });

  it("WorkspaceTable teaser shows at most 3 workspace rows", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      // Wait for workspaces to render
      expect(container.querySelector("[data-testid='all-workspaces-link']")).not.toBeNull();
    });
    // Fixture has 5 workspaces; teaser should show at most 3
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("rate-limit gauges show both utilization bars when signed in", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      expect(container.querySelectorAll("[role='progressbar']").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("rate-limit gauges show Settings link when signed out", async () => {
    vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatusSignedOut());
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      const settingsLink = container.querySelector("a[href='#/settings']");
      expect(settingsLink).not.toBeNull();
    });
  });
});
