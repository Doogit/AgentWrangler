/**
 * test/ui/trend-chart.test.tsx — TrendChart component render tests.
 *
 * Covers three UI states: loading (aria-busy skeleton), error (banner), ok (chart).
 * Does NOT assert on recharts internals — tests the section structure + classes.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrendData } from "../../src/query/api/trends";
import * as client from "../../src/ui/api/client";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHeadroomTrend,
  mockHeadroomTrendNoLimit,
  mockHookConfigResponse,
  mockHotSessions,
  mockLiveSessions,
  mockRecommendations,
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import TrendChart, {
  buildSessionScatterData,
  markerLabel,
  xAxisInterval,
} from "../../src/ui/overview/TrendChart";

vi.mock("../../src/ui/api/client");
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const { cloneElement } = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children, height }: { children: ReactElement; height?: number }) => (
      <div>{cloneElement(children, { width: 800, height: height ?? 240 })}</div>
    ),
  };
});

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchFlavorDecomposition).mockResolvedValue(
    mockFlavorDecomposition({ preset: "7d" }),
  );
  vi.mocked(client.fetchCacheWriteTrend).mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
});

// ---------------------------------------------------------------------------
// TrendChart — direct component tests
// ---------------------------------------------------------------------------

describe("TrendChart — three distinct UI states", () => {
  it("loading: shows aria-busy skeleton, no error banner", () => {
    const { container } = render(<TrendChart state={{ status: "loading" }} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelector(".banner-error")).toBeNull();
  });

  it("error: shows banner-error with role=alert", () => {
    const { container } = render(
      <TrendChart state={{ status: "error", message: "ECONNREFUSED" }} />,
    );
    const banner = container.querySelector(".banner-error");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toMatch(/ECONNREFUSED/);
    // No loading skeleton
    expect(container.querySelector("[aria-label='Loading trend data']")).toBeNull();
  });

  it("ok with data: renders section heading", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);
    expect(container.textContent).toMatch(/Spend Over Time/);
    // No error banner
    expect(container.querySelector(".banner-error")).toBeNull();
    // The spend chart is ready; the additive headroom panel may still be loading independently.
    expect(container.querySelector("[aria-label='Loading trend data']")).toBeNull();
  });

  it("ok with null data: shows empty banner-info", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    const nullResponse = { ...trendResponse, data: null };
    const { container } = render(<TrendChart state={{ status: "ok", value: nullResponse }} />);
    expect(container.querySelector(".banner-info")).not.toBeNull();
    expect(container.querySelector(".banner-info")?.textContent).toMatch(/No spend data/);
  });

  it("ok: renders LIST_EQUIV chip", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);
    expect(container.querySelector(".chip-list-equiv")).not.toBeNull();
  });

  it("renders bounded adoption marker labels on the trend charts", async () => {
    const trendResponse = mockTrends({ preset: "7d" });
    if (!trendResponse.data) throw new Error("fixture must have data");
    trendResponse.data.adoption_markers = [
      {
        rec_id: "rec-marker-test",
        detector_id: "D8",
        lever: "Adopt cache cleanup",
        adopted_at: "2026-08-24T09:00:00.000Z",
        bucket: "2026-08-24",
      },
    ];

    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);

    await waitFor(() =>
      expect(container.querySelectorAll(".recharts-reference-line-line")).toHaveLength(3),
    );
    expect(screen.getAllByText("Adopt cache cleanup").length).toBeGreaterThanOrEqual(3);
  });

  it("truncates long adopted-rec labels and exposes the full label in a tooltip", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    if (!trendResponse.data) throw new Error("fixture must have data");
    const fullLabel = "Adopt cache cleanup across stale sessions before expiry";
    trendResponse.data.adoption_markers = [
      {
        rec_id: "rec-long-marker-test",
        detector_id: "D8",
        lever: fullLabel,
        adopted_at: "2026-08-24T09:00:00.000Z",
        bucket: "2026-08-24",
      },
    ];

    render(<TrendChart state={{ status: "ok", value: trendResponse }} />);

    const truncated = markerLabel(fullLabel);
    const label = screen.getByTitle(fullLabel);
    expect(truncated).toHaveLength(36);
    expect(truncated).toMatch(/\.\.\.$/);
    expect(label.textContent).toBe(truncated);
    expect(label.textContent).not.toContain(fullLabel);
    expect(label.getAttribute("title")).toBe(fullLabel);
    expect(label.getAttribute("style")).toContain("max-width: 36ch");
    expect(label.getAttribute("style")).toContain("overflow: hidden");
    expect(label.getAttribute("style")).toContain("text-overflow: ellipsis");
  });

  it("sorts session scatter points by their source date", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    if (!trendResponse.data) throw new Error("fixture must have data");
    const sessions = [...trendResponse.data.sessions].reverse();
    const points = buildSessionScatterData({ ...trendResponse.data, sessions });

    expect(points.map((point) => point.x)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("thins x-axis ticks only after the chart has more than eight points", () => {
    expect(xAxisInterval(8)).toBe(0);
    expect(xAxisInterval(9)).toBe(1);
    expect(xAxisInterval(32)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TrendChart — empty data edge cases
// ---------------------------------------------------------------------------

describe("TrendChart — empty data shapes", () => {
  it("empty buckets and sessions: shows no-data banner inside TrendChartInner", () => {
    const emptyData: TrendData = {
      bucket: "day",
      buckets: [],
      by_model: [],
      by_workspace: [],
      sessions: [],
      cap_weighted: [],
      cap_read_coeff: 0.1,
      adoption_markers: [],
    };
    const response = { data: emptyData, meta: mockTrends({ preset: "7d" }).meta };
    const { container } = render(<TrendChart state={{ status: "ok", value: response }} />);
    // Should show banner-info for no data
    expect(container.querySelector(".banner-info")).not.toBeNull();
  });

  it("renders adoption markers on all three charts when the window has no activity", async () => {
    const markerOnlyData: TrendData = {
      bucket: "day",
      buckets: [],
      by_model: [],
      by_workspace: [],
      sessions: [],
      cap_weighted: [],
      cap_read_coeff: 0.1,
      adoption_markers: [
        {
          rec_id: "rec-marker-only",
          detector_id: "D8",
          lever: "Adopt cache cleanup",
          adopted_at: "2026-08-24T09:00:00.000Z",
          bucket: "2026-08-24",
        },
      ],
    };
    const response = { data: markerOnlyData, meta: mockTrends({ preset: "7d" }).meta };

    const { container } = render(<TrendChart state={{ status: "ok", value: response }} />);

    await waitFor(() =>
      expect(container.querySelectorAll(".recharts-reference-line-line")).toHaveLength(3),
    );
  });
});

// ---------------------------------------------------------------------------
// TrendChart — cap-weighted section
// ---------------------------------------------------------------------------

describe("TrendChart - cap-weighted section", () => {
  it("renders cap-weighted chart section and caveat text when data is present", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);
    expect(container.textContent).toMatch(/Cap-weighted/);
    expect(container.textContent).toMatch(/unverified/);
    expect(container.textContent).toMatch(/Anthropic has not published a cap coefficient/);
  });

  it("does not render cap-weighted caveat when cap activity and markers are empty", () => {
    const trendResponse = mockTrends({ preset: "7d" });
    if (!trendResponse.data) throw new Error("fixture must have data");
    const emptyCapData: TrendData = {
      ...trendResponse.data,
      cap_weighted: [],
      adoption_markers: [],
    };
    const response = { ...trendResponse, data: emptyCapData };
    const { container } = render(<TrendChart state={{ status: "ok", value: response }} />);
    expect(container.textContent).toMatch(/Spend Over Time/);
    expect(container.textContent).not.toMatch(/unverified/);
  });
});

describe("TrendChart - headroom section", () => {
  it("renders both headroom bands with the unverified coefficient caveat", async () => {
    const trendResponse = mockTrends({ preset: "7d" });
    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);

    await waitFor(() =>
      expect(container.querySelector("[data-testid='headroom-trend-panel']")).not.toBeNull(),
    );
    expect(container.textContent).toMatch(/0\.1x headline/);
    expect(container.textContent).toMatch(/1\.0x upper-bound/);
    expect(container.textContent).toMatch(/unverified cap coefficient/);
    expect(container.textContent).toMatch(/no absolute-cap denominator/);
  });

  it("renders NO_LIMIT as a calibrate-first info state, not an error", async () => {
    vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrendNoLimit());
    const trendResponse = mockTrends({ preset: "7d" });
    const { container } = render(<TrendChart state={{ status: "ok", value: trendResponse }} />);

    await waitFor(() =>
      expect(container.querySelector("[data-testid='headroom-no-limit']")).not.toBeNull(),
    );
    expect(container.textContent).toMatch(/calibrate first/i);
    expect(container.querySelector(".banner-error")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OverviewPage integration — TrendChart is rendered in the page
// ---------------------------------------------------------------------------

describe("OverviewPage — TrendChart integration", () => {
  it("renders Spend Over Time section when trends resolve", async () => {
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
    vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));

    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const matches = Array.from(container.querySelectorAll("*"));
      const found = matches.some((el) => el.textContent?.includes("Spend Over Time"));
      expect(found).toBe(true);
    });
  });

  it("TrendChart shows error state when fetchTrends rejects (non-fatal to page)", async () => {
    vi.mocked(client.fetchGlobalOverview).mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    vi.mocked(client.fetchLiveSessions).mockResolvedValue(mockLiveSessions());
    vi.mocked(client.fetchTrends).mockRejectedValue(new Error("trends-unavailable"));

    const { container } = render(<OverviewPage />);

    // The overview KPI data still renders (trends error is non-fatal)
    await waitFor(() => {
      expect(container.querySelector(".kpi-grid")).not.toBeNull();
    });

    // TrendChart section shows error banner
    await waitFor(() => {
      const banners = container.querySelectorAll(".banner-error");
      expect(banners.length).toBeGreaterThan(0);
    });
  });
});
