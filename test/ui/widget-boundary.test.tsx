/**
 * test/ui/widget-boundary.test.tsx — P0-U6 error isolation (E4).
 *
 * Covers:
 *   1. A throw inside one Overview card's render is isolated to that card;
 *      sibling cards (KPIs, workspaces, recommendations) still render their
 *      seed values.
 *   2. A throw in a root-level sibling (e.g. Sidebar, outside LoadBoundary's
 *      route tree) is caught by RootBoundary, which shows a reload card
 *      instead of leaving the shell blank.
 *   3. WidgetBoundary resets and re-renders its child when `resetKey` changes.
 *   4. A malformed value consumed in a useEffect/async handler (where an
 *      error boundary cannot catch it) is routed into the owning card's own
 *      state instead of crashing the page.
 *
 * Oracle: seed values asserted from the fixtures (../../src/ui/api/fixtures),
 * not from component output.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../src/ui/api/client";
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
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import RootBoundary from "../../src/ui/shell/RootBoundary";
import WidgetBoundary from "../../src/ui/shell/WidgetBoundary";

import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview/overview-view-from-legacy";

vi.mock("../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);

const OK_STATUS: DaemonStatus = {
  sessions: 574,
  files_seen: 600,
  files_parsed: 600,
  scan_state: "complete",
  lines_quarantined: 0,
  invalid_scan_root_count: 0,
};

const writeText = vi.fn().mockResolvedValue(undefined);
let clipboardDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  cleanup();
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
});

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockClear();
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchSuccessRate).mockResolvedValue(mockSuccessRate());
  vi.mocked(client.fetchBurnStatus).mockResolvedValue(mockBurnStatus());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends({ preset: "7d" }));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition({ preset: "7d" }));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend({ preset: "7d" }));
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrend({ preset: "7d" }));
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchStatus).mockResolvedValue(OK_STATUS);
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
    configured: false,
    source: "none",
  } as never);
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
});

// A component that throws on render, standing in for a widget whose data
// arrived malformed (e.g. a `.map` call on a field that came back as a string).
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom");
  return <div>bomb-ok</div>;
}

function ThrowingSidebar(): never {
  throw new Error("sidebar exploded");
}

describe("WidgetBoundary — per-card isolation (P0-U6)", () => {
  it("isolates a malformed trends payload to the Spend-by-day card; KPIs, workspaces and recs still render their seed values", async () => {
    const workspaceFixture = mockWorkspaces({ preset: "7d" });
    if (workspaceFixture.data === null) throw new Error("expected workspace fixture");
    const firstWorkspace = workspaceFixture.data.items[0];
    if (firstWorkspace === undefined) throw new Error("expected a first workspace");

    // A malformed field taken from a real seed response shape: `by_workspace`
    // comes back as a string instead of an array. SpendByDayCard's
    // `trend?.by_workspace.map(...)` throws synchronously during render.
    // (`buckets` is also read at OverviewPage's own top level for the KPI
    // sparkline, so corrupting it there would crash the whole page instead
    // of isolating to the Trends card — `by_workspace` is read only inside
    // SpendByDayCard.)
    const trends = mockTrends({ preset: "7d" });
    if (trends.data === null) throw new Error("expected trends fixture");
    const corruptedTrends = {
      ...trends,
      data: { ...trends.data, by_workspace: "corrupted-not-an-array" },
    } as unknown as typeof trends;
    vi.mocked(client.fetchTrends).mockResolvedValue(corruptedTrends);

    render(<OverviewPage />);

    // Trends card: isolated failure, not a blank app.
    // Card-scoped copy: the failure names the card, never "this page".
    const trendsError = await screen.findByText("Could not load trends.");
    expect(trendsError).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry trends" })).toBeTruthy();
    expect(screen.queryByText("Could not load this page.")).toBeNull();

    // KPIs still render.
    expect(await screen.findByRole("heading", { name: "This period (7d)" })).toBeTruthy();

    // Recommendations still render (seed value from the fixture).
    expect(await screen.findByTestId("overview-decision")).toBeTruthy();

    // Workspaces still render a real seed workspace.
    expect(await screen.findByText(new RegExp(firstWorkspace.project_slug))).toBeTruthy();
  });

  it("isolates a malformed context_per_turn to the kpis section's cards; workspaces still render", async () => {
    const workspaceFixture = mockWorkspaces({ preset: "7d" });
    const firstWorkspace = workspaceFixture.data?.items[0];
    if (firstWorkspace === undefined) throw new Error("expected a first workspace");

    // `context_per_turn` comes back as a string. P1-U4: it is a field of the `kpis` section, so
    // `safeSection` fails that section and every card it feeds (KPIs, context per turn) shows
    // its error card; the other sections still render.
    const overview = mockGlobalOverview({ preset: "7d" });
    if (overview.data === null) throw new Error("expected overview fixture");
    const corrupted = {
      ...overview,
      data: { ...overview.data, context_per_turn: "corrupted-not-an-array" },
    } as unknown as typeof overview;
    fetchGlobalOverview.mockResolvedValue(corrupted);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<OverviewPage />);

    expect(await screen.findByText("Could not load context per turn.")).toBeTruthy();
    expect(screen.queryByText("Could not load this page.")).toBeNull();
    expect(screen.getByText("Could not load this period's totals.")).toBeTruthy();
    warn.mockRestore();
    expect(
      (await screen.findAllByText(new RegExp(firstWorkspace.project_slug))).length,
    ).toBeGreaterThan(0);
  });

  it("catches a Sidebar-level throw at the root and shows a reload card instead of a blank shell", () => {
    const { container } = render(
      <RootBoundary>
        <ThrowingSidebar />
      </RootBoundary>,
    );

    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("resets and re-renders the child when resetKey changes", () => {
    const { rerender } = render(
      <WidgetBoundary label="workspaces" resetKey={1}>
        <Bomb shouldThrow={true} />
      </WidgetBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender(
      <WidgetBoundary label="workspaces" resetKey={2}>
        <Bomb shouldThrow={false} />
      </WidgetBoundary>,
    );
    expect(screen.getByText("bomb-ok")).toBeTruthy();
  });

  it("routes a malformed recommendations section into the card's own error state, not a crash", async () => {
    // `active` comes back as a non-array (a malformed wire shape). P1-U4: `safeSection` rejects
    // the `top_recs` section before any derivation runs, so the malformed `active` never reaches
    // render; the card shows its error state with a Retry (it used to fall back to the empty
    // state, which hid the failure).
    const malformed = mockRecommendations();
    const corrupted = {
      ...malformed,
      data: malformed.data === null ? null : { ...malformed.data, active: "not-an-array" },
    } as unknown as typeof malformed;
    vi.mocked(client.fetchRecommendations).mockResolvedValue(corrupted);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<OverviewPage />);

    // The rest of the page is unaffected.
    expect(await screen.findByRole("heading", { name: "This period (7d)" })).toBeTruthy();

    expect(await screen.findByText("Could not load recommendations.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry recommendations" })).toBeTruthy();
    warn.mockRestore();
  });
});
