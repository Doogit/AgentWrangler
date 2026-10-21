import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy } from "react";
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
  mockStatus,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import DeferredChart from "../../src/ui/shell/DeferredChart";
import LoadBoundary from "../../src/ui/shell/LoadBoundary";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchStatus).mockResolvedValue(mockStatus());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({ configured: false, source: null });
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
});

describe("deferred chart loading", () => {
  it("shows a chart skeleton with an accessible explicit load control before observation", () => {
    const { container } = render(
      <DeferredChart label="trends" ready={false}>
        <p>Chart</p>
      </DeferredChart>,
    );

    expect(container.querySelector(".skeleton-chart")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load trends" }).textContent).toBe("");
  });

  it("waits for the surrounding layout before observing a chart", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    const view = render(
      <DeferredChart label="trends" ready={false}>
        <p>Chart</p>
      </DeferredChart>,
    );
    expect(observe).not.toHaveBeenCalled();
    view.rerender(
      <DeferredChart label="trends" ready>
        <p>Chart</p>
      </DeferredChart>,
    );
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("does not import offscreen charts, then loads once when approaching the viewport", async () => {
    let notify: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const load = vi.fn(async () => ({ default: () => <p>Chart ready</p> }));
    const Chart = lazy(load);
    render(
      <DeferredChart label="trends">
        <Chart />
      </DeferredChart>,
    );
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver),
    );
    expect(await screen.findByText("Chart ready")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it("supports explicit keyboard-accessible loading without intersection", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const Chart = lazy(async () => ({ default: () => <p>Chart ready</p> }));
    render(
      <DeferredChart label="trends">
        <Chart />
      </DeferredChart>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load trends" }));
    expect(await screen.findByText("Chart ready")).toBeTruthy();
  });
});

describe("OverviewPage above-the-fold chart loading", () => {
  it("renders chart sections without an intersection event", async () => {
    // overview-v2: TrendChart removed; SpendByDayCard and TokensGoSection are
    // inline SVG — no DeferredChart/IntersectionObserver needed.
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );

    render(<OverviewPage />);

    await waitFor(
      () => {
        // §5 Where your tokens go
        expect(screen.getByRole("heading", { name: /where your tokens go/i })).toBeTruthy();
        // §6 Spend by day
        expect(screen.getByRole("heading", { name: /spend by day/i })).toBeTruthy();
      },
      { timeout: 5000 },
    );
    // No DeferredChart in the new Overview; observe should never be called.
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("chunk loading boundary", () => {
  it("shows loading feedback until the module resolves", async () => {
    let resolve!: (value: { default: () => JSX.Element }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => JSX.Element }>((done) => {
          resolve = done;
        }),
    );
    render(
      <LoadBoundary label="page">
        <Page />
      </LoadBoundary>,
    );
    const loading = screen.getByRole("status");
    expect(loading.textContent).toContain("Loading page");
    expect(loading.classList.contains("load-boundary-skeleton")).toBe(true);
    await act(async () => resolve({ default: () => <h1>Ready</h1> }));
    expect(screen.getByRole("heading", { name: "Ready" })).toBeTruthy();
  });

  it("rejects an unknown loading label from reader-facing copy", () => {
    const Waiting = lazy(() => new Promise<{ default: () => JSX.Element }>(() => {}));
    render(
      <LoadBoundary label="C:/operator/private-response">
        <Waiting />
      </LoadBoundary>,
    );

    expect(screen.getByRole("status", { name: "Loading content" })).toBeTruthy();
    expect(screen.queryByText(/operator|private-response/i)).toBeNull();
  });

  it("exposes rejected imports and lets navigation to a different route recover", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Failed = lazy(async () => {
      throw new Error("Chunk unavailable");
    });
    const view = render(
      <LoadBoundary key="one" label="page">
        <Failed />
      </LoadBoundary>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload dashboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload dashboard" }).classList).toContain(
      "btn-primary",
    );
    view.rerender(
      <LoadBoundary key="two" label="page">
        <h1>Other route</h1>
      </LoadBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Other route" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
