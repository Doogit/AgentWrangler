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

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  mockLimits,
  mockLinkageRate,
  mockLiveSessions,
  mockRecommendations,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import HookTile from "../../../src/ui/overview/HookTile";
import OverviewPage from "../../../src/ui/overview/OverviewPage";
import RateLimitGauges from "../../../src/ui/overview/RateLimitGauges";

import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview-view-from-legacy";

vi.mock("../../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);

afterEach(() => cleanup());

function setupCommonMocks() {
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchStatus).mockResolvedValue({
    sessions: 574,
    files_seen: 600,
    files_parsed: 600,
    scan_state: "complete",
    lines_quarantined: 0,
    invalid_scan_root_count: 0,
  });
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
    configured: false,
    source: "none",
  } as never);
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

describe("OverviewPage v2 layout", () => {
  it("mounts the Usage limits hero as the first section and drops the old operational grid", async () => {
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='usage-limits-card']")).not.toBeNull();
    });
    // RV7 operational grid (rate-limit gauges + hook tile) is retired from Overview.
    expect(container.querySelector("[data-testid='rv7-tile-row']")).toBeNull();
    expect(container.querySelector("[data-testid='rate-limit-gauges']")).toBeNull();
    expect(container.querySelector("[data-testid='hook-tile']")).toBeNull();
    // Hot Sessions tile stays gone; LiveStrip is the session surface.
    expect(container.querySelector("[data-testid='hot-sessions-tile']")).toBeNull();
    expect(container.querySelector(".live-strip")).not.toBeNull();
  });

  it("links the Workspaces section title to #/workspaces and shows the teaser table", async () => {
    render(<OverviewPage />);
    const heading = await screen.findByRole("link", { name: "Workspaces" });
    expect(heading.getAttribute("href")).toBe("#/workspaces");
    const link = (await screen.findByTestId("all-workspaces-link")) as HTMLAnchorElement;
    expect(link.href).toContain("#/workspaces");
  });

  it("WorkspaceTable teaser shows at most 3 workspace rows", async () => {
    const { container } = render(<OverviewPage />);
    await screen.findByTestId("all-workspaces-link");
    // Fixture has 5 workspaces; teaser shows at most 3.
    const rows = container.querySelectorAll("[aria-labelledby='workspaces-title'] tbody tr");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
  });
});
