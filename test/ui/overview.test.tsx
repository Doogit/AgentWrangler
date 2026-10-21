/**
 * test/ui/overview.test.tsx — Overview surface integration tests.
 *
 * Covers:
 *   - Three distinct UI states: loading (skeleton) ≠ error (banner) ≠ ok/empty (data)
 *   - LiveStrip: LIVE row accent class + aria-live="polite"
 *   - BurnForecastCard: each state machine variant renders correctly
 *   - WorkspaceTable: spend column shows real USD (not N/A)
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionRow, WorkspaceSummary } from "../../src/query/api/overview";
import type { LimitRow } from "../../src/query/limits/types";
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
import type { WorkspaceLabelInput } from "../../src/ui/lib/workspace-label";
import BurnForecastCard from "../../src/ui/overview/BurnForecastCard";
import CacheWriteSpikesChart, {
  SPIKE_THRESHOLD_LABEL_POSITION,
} from "../../src/ui/overview/CacheWriteSpikesChart";
import LiveStrip from "../../src/ui/overview/LiveStrip";
import OverviewPage from "../../src/ui/overview/OverviewPage";
import { isQuantified } from "../../src/ui/overview/TopRecommendations";
import UsageLimitsCard from "../../src/ui/overview/UsageLimitsCard";
import VerdictBand from "../../src/ui/overview/VerdictBand";
import WorkspaceTable from "../../src/ui/overview/WorkspaceTable";
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

// @testing-library/react auto-cleanup requires jest globals;
// in vitest with globals:false we must register it explicitly.
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
  // OverviewPage also fetches recommendations, success rate, and trends.
  // Give them safe defaults so auto-mocks always return a Promise;
  // individual tests may still override the other client methods.
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
});

// ---------------------------------------------------------------------------
// Helper: set all client methods to resolve with fixture data
// ---------------------------------------------------------------------------
function setupSuccess() {
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
}

// Overview integration: ranked recommendations, weekly sessions, and dashboard links.
describe("OverviewPage integration", () => {
  it("renders the three new sections and preserves ranked recommendation order", async () => {
    setupSuccess();
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected fixture data");
    response.data.active.reverse();
    // Top-3 eligibility: the first rec with a modeled savings figure is rank 1.
    const first = response.data.active.find(isQuantified);
    if (first === undefined) throw new Error("expected an active recommendation");
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    render(<OverviewPage />);
    await screen.findByRole("link", { name: "Top Usage Recommendations" });
    await screen.findByRole("link", { name: "Most expensive sessions this week" });
    await screen.findByRole("heading", { name: "Across the dashboard" });
    expect(screen.queryByText("What to do next")).toBeNull();
    expect(screen.getByTestId("overview-decision").querySelector("h3")?.textContent).toBe(
      first.title ?? first.lever,
    );
    // P1-U4: the weekly sessions and KPIs arrive in the one 7d page request.
    expect(client.fetchOverviewView).toHaveBeenCalledWith("7d", expect.anything());
  });

  it("counts window sessions and derives every live indicator from the one /api/live poll", async () => {
    setupSuccess();
    const overview = mockGlobalOverview({ preset: "7d" });
    if (overview.data === null) throw new Error("expected overview fixture");
    overview.data.subagent_spend = {
      total_cost_u: 1_000_000,
      sidechain_cost_u: 250_000,
      share: 0.25,
      sessions_with_sidechain_spend: 70,
      sessions_in_window: 83,
      haiku_sidechain_turns: 0,
      by_model_family: [],
    };
    fetchGlobalOverview.mockResolvedValue(overview);
    const workspaces = mockWorkspaces({ preset: "7d" });
    const liveWorkspace = workspaces.data?.items[0];
    if (liveWorkspace === undefined) throw new Error("expected workspace fixture");
    const live = mockLiveSessions();
    if (live.data === null) throw new Error("expected live fixture");
    live.data.items = [
      {
        session_id: "live-1",
        workspace_id: liveWorkspace.workspace_id,
        project_slug: liveWorkspace.project_slug,
        repo_path: null,
        repo_owner: null,
        repo_name: null,
        running_usd_u: 1_000_000,
        current_context_tokens: 50_000,
        model: "claude-opus-4-8",
        started_at: new Date().toISOString(),
      },
    ];
    fetchLiveSessions.mockResolvedValue(live);
    render(<OverviewPage />);

    const tile = await waitFor(() => {
      const el = document.querySelector("[data-metric='sessions.count']");
      if (el === null) throw new Error("sessions tile not rendered");
      return el;
    });
    // Window count (83), not /api/status all-time sessions (574).
    expect(tile.textContent).toContain("83");
    expect(tile.textContent).not.toContain("574");
    await waitFor(() =>
      expect(screen.getByTestId("overview-live-chip").textContent).toBe("● 1 live"),
    );
    // Task 9: the Sessions tile carries no live chip; the header and LiveStrip own live.
    expect(tile.textContent).not.toContain("live");
    // Workspaces payload says has_live=false everywhere; the live poll wins.
    const workspacesSection = screen
      .getByRole("heading", { name: "Workspaces" })
      .closest("section");
    expect(workspacesSection?.querySelectorAll(".chip.live")).toHaveLength(1);
  });

  it("shows a recommendations link when active is empty", async () => {
    setupSuccess();
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected fixture data");
    response.data.active = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    render(<OverviewPage />);
    expect(
      (await screen.findByRole("link", { name: "No active recommendations" })).getAttribute("href"),
    ).toBe("#/recommendations");
  });

  it("links to all recommendations and shows no SCREAMING_SNAKE enum in visible copy", async () => {
    setupSuccess();
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected fixture data");
    const count = response.data.active.length;
    const groups = response.data.active_groups.length;
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    render(<OverviewPage />);
    const all = await screen.findByRole("link", {
      name: `All ${count} recommendations (${groups} groups) →`,
    });
    expect(all.getAttribute("href")).toBe("#/recommendations");
    const section = screen.getByTestId("overview-decision");
    const visible = [...section.querySelectorAll("h3, p, span, a, button")]
      .filter((el) => el.closest("details:not([open])") === null)
      .map((el) => el.textContent ?? "")
      .join(" ");
    expect(visible).not.toMatch(/\b[A-Z]+_[A-Z_]+\b/);
  });
});
// §1 Usage-limits hero — exclusive states + full connected render.
describe("UsageLimitsCard", () => {
  it("connected: renders one meter row per model row with the Exact chip and pace phrasing", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='limit-row-session']")).not.toBeNull();
    });
    expect(container.querySelector("[data-testid='limit-row-weekly']")).not.toBeNull();
    expect(container.querySelectorAll(".meter-row").length).toBe(3);
    expect(screen.getByTestId("usage-limits-card").classList.contains("card-padded")).toBe(true);
    const text = container.textContent ?? "";
    expect(text).toContain("Exact · claude.ai");
    expect(text).toContain("ahead of pace"); // session row is ahead
    expect(text).toContain("On pace"); // weekly row on pace
    expect(container.querySelector("a[href='#/sessions?live=1']")?.textContent).toContain("3 live");
    expect(text).toContain("Our estimate 37%");
    expect(container.querySelector("a[href='#/settings?section=calibration']")).not.toBeNull();
  });

  it("OV-8: utilization thresholds color bar, % and status; pace escalates but never mutes", async () => {
    const model = mockLimits();
    const [session, weekly, perModel] = model.rows as [LimitRow, LimitRow, LimitRow];
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...model,
      rows: [
        // 85% used, on pace → amber from utilization alone
        { ...session, usedPct: 85, pacePct: 90, paceState: "on" },
        // 96% used, on pace → rose from utilization alone
        { ...weekly, usedPct: 96, pacePct: 97, paceState: "on" },
        // 20% used but over pace → rose from pace escalation
        { ...perModel, paceState: "over" },
      ],
    });
    const { container } = render(<UsageLimitsCard />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='limit-row-session']")).not.toBeNull();
    });
    const row = (id: string) =>
      container.querySelector<HTMLElement>(`[data-testid='limit-row-${id}']`);
    expect(row("session")?.dataset.severity).toBe("warn");
    expect(row("session")?.querySelector(".fill")?.className).toBe("fill amber");
    expect(row("session")?.querySelector(".meter-pct")?.classList.contains("warn-t")).toBe(true);
    expect(row("weekly")?.dataset.severity).toBe("bad");
    expect(row("weekly")?.querySelector(".fill")?.className).toBe("fill rose");
    expect(row("weekly")?.querySelector(".rate .bad")?.textContent).toContain("On pace");
    expect(row("weekly:fable")?.dataset.severity).toBe("bad");
    expect(container.querySelector(".meter-grid")?.children.length).toBe(3);
  });

  it("signed-out: labels local history and omits utilization without a denominator", async () => {
    const model = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...model,
      state: "signed-out",
      rows: [],
      localHistory: {
        ...model.localHistory,
        weeklyLimitTokens: null,
        weeklyUtilizationPct: null,
        projectedExhaustionAt: null,
        forecastState: "OFF",
      },
    });
    const { container } = render(<UsageLimitsCard />);
    await screen.findByText(/connect usage tracking/);
    expect(container.querySelectorAll(".meter-row").length).toBe(0);
    const fallback = screen.getByTestId("local-usage-fallback");
    expect(fallback.textContent).toContain("Modeled local history");
    expect(fallback.textContent).toContain("Last 5 hours");
    expect(fallback.textContent).toContain("Rolling 7 days");
    expect(fallback.textContent).toContain("Burn rate");
    expect(fallback.textContent).not.toMatch(/% of (?:the )?weekly limit/i);
    expect(fallback.querySelector("[role='progressbar']")).toBeNull();
  });

  it("degraded state shows calibrated local utilization and forecast when available", async () => {
    const model = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...model,
      state: "error",
      rows: [],
      localHistory: {
        ...model.localHistory,
        sevenDayTokens: 2_500_000,
        weeklyLimitTokens: 10_000_000,
        weeklyUtilizationPct: 25,
        projectedExhaustionAt: "2026-09-19T12:00:00.000Z",
        forecastState: "OK",
      },
    });
    render(<UsageLimitsCard />);
    const fallback = await screen.findByTestId("local-usage-fallback");
    expect(fallback.textContent).toContain("25% of configured weekly limit");
    expect(fallback.textContent).toContain("Projected limit");
  });

  it("rate-limited: shows the retry message and greys last-good rows", async () => {
    const model = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...model,
      state: "rate-limited",
      stale: true,
      retryInSec: 240,
    });
    const { container } = render(<UsageLimitsCard />);
    await screen.findByText(/rate-limited the usage API/);
    const row = container.querySelector<HTMLElement>("[data-testid='limit-row-session']");
    expect(row?.style.opacity).toBe("0.6");
    // REL-FIX bug 4: stale bars are grey whatever their severity.
    expect(screen.getByTestId("limit-fill-session").className).toBe("fill stale");
    expect(screen.getByTestId("limit-fill-weekly").className).toBe("fill stale");
  });

  // REL-FIX bug 4: the header names the real source and its age in every state.
  describe("header source line", () => {
    const asOf = new Date(Date.now() - 16 * 60_000).toISOString();
    const desc = () => screen.getByTestId("usage-limits-card").querySelector(".desc")?.textContent;
    const title = () => screen.getByRole("heading", { level: 2 }).textContent ?? "";

    it("connected via the API: Exact chip, API source, refresh age", async () => {
      vi.mocked(client.fetchLimits).mockResolvedValue({ ...mockLimits(), asOf, source: "api" });
      render(<UsageLimitsCard />);
      await screen.findByTestId("limit-row-session");
      expect(title()).toContain("Exact · claude.ai");
      expect(desc()).toContain("from claude.ai usage API · refreshed 16m ago");
    });

    it("statusline: names the statusline and its age, no claude.ai chip", async () => {
      vi.mocked(client.fetchLimits).mockResolvedValue({
        ...mockLimits(),
        asOf,
        source: "statusline",
      });
      render(<UsageLimitsCard />);
      await screen.findByTestId("limit-row-session");
      expect(title()).not.toContain("claude.ai");
      expect(desc()).toContain("from your Claude Code statusline · updated 16m ago");
    });

    it("rate-limited with last-good rows: Stale chip, last reading age, never 'refreshed'", async () => {
      vi.mocked(client.fetchLimits).mockResolvedValue({
        ...mockLimits(),
        state: "rate-limited",
        stale: true,
        retryInSec: 240,
        asOf,
      });
      render(<UsageLimitsCard />);
      await screen.findByText(/rate-limited the usage API/);
      expect(title()).not.toContain("Exact");
      expect(title()).toContain("Stale · claude.ai");
      expect(desc()).toContain("last claude.ai reading 16m ago · usage API rate-limited");
      expect(desc()).not.toContain("refreshed");
      expect(desc()).not.toContain("from claude.ai usage API");
    });

    it("rate-limited with no rows: local fallback is named, no claude.ai claim", async () => {
      vi.mocked(client.fetchLimits).mockResolvedValue({
        ...mockLimits(),
        state: "rate-limited",
        stale: true,
        retryInSec: 240,
        rows: [],
        asOf,
      });
      render(<UsageLimitsCard />);
      await screen.findByTestId("local-usage-fallback");
      expect(title()).not.toContain("claude.ai");
      expect(desc()).toContain("modeled from local history");
      expect(desc()).not.toContain("refreshed");
    });
  });

  it("REL-FIX bug 3: a stored limit far below this week's usage is flagged, not shown as a %", async () => {
    // The live-DB shape: limit_tokens 120,281 (calibrated mid-backfill) vs ~406M cap-weighted this week.
    const model = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...model,
      state: "error",
      rows: [],
      localHistory: {
        ...model.localHistory,
        sevenDayTokens: 406_126_000,
        weeklyLimitTokens: 120_281,
        weeklyUtilizationPct: 337_649,
        projectedExhaustionAt: null,
        forecastState: "EXCEEDED",
      },
    });
    render(<UsageLimitsCard />);
    const fallback = await screen.findByTestId("local-usage-fallback");
    expect(fallback.textContent).not.toMatch(/\d% of configured weekly limit/);
    const flag = screen.getByTestId("local-limit-implausible");
    expect(flag.textContent).toContain("Configured weekly limit (120K)");
    expect(flag.textContent).toContain("looks wrong");
    expect(flag.querySelector("a")?.getAttribute("href")).toBe("#/settings?section=calibration");
  });

  it("error: renders a Retry button and no meters", async () => {
    const model = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({ ...model, state: "error", rows: [] });
    render(<UsageLimitsCard />);
    await screen.findByRole("button", { name: "Retry" });
  });
});

// ---------------------------------------------------------------------------
// Three distinct UI states
// ---------------------------------------------------------------------------

describe("OverviewPage — three distinct states", () => {
  it("shows aria-busy skeleton while loading (state 1: loading)", () => {
    fetchGlobalOverview.mockReturnValue(new Promise(() => {}));
    vi.mocked(client.fetchWorkspaces).mockReturnValue(new Promise(() => {}));
    fetchLiveSessions.mockReturnValue(new Promise(() => {}));

    const { container } = render(<OverviewPage />);

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelector(".banner-error")).toBeNull();
  });

  it("shows error banner when daemon is unreachable (state 2: error)", async () => {
    // P1-U4: the page is one request; an unreachable daemon fails it (after the query's one retry).
    vi.mocked(client.fetchOverviewView).mockRejectedValue(new Error("ECONNREFUSED"));

    const { container } = render(<OverviewPage />);

    await waitFor(
      () => {
        expect(container.querySelector(".banner-error")).not.toBeNull();
      },
      { timeout: 4_000 },
    );
  });

  it("shows real data on success (state 3: ok) — spend-equivalent in exactly one home", async () => {
    setupSuccess();

    const { container } = render(<OverviewPage />);

    // The spend-equivalent KPI shows the UA11 $3,100 selected window.
    await waitFor(() => {
      const found = Array.from(container.querySelectorAll("*")).some((el) =>
        el.textContent?.includes("$3,100"),
      );
      expect(found).toBe(true);
    });
    expect(container.querySelector(".banner-error")).toBeNull();
    // Guide §0.7: spend-equivalent renders in exactly one place.
    expect(container.querySelectorAll("[data-metric='spend.equiv']").length).toBe(1);
  });

  it("renders the context-per-turn table, price-ordered, with a per-model sessions link", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const section = container.querySelector("[data-testid='context-per-turn-section']");
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain("Fable-5");
    });
    const section = container.querySelector("[data-testid='context-per-turn-section']");
    // Fixture has 4 models; most-expensive tier (Fable-5) renders first.
    const rows = section?.querySelectorAll("tbody tr") ?? [];
    expect(rows.length).toBe(4);
    expect(rows[0]?.textContent).toContain("Fable-5");
    expect(section?.querySelector("table")?.parentElement?.classList.contains("table-wrap")).toBe(
      true,
    );
    expect(section?.querySelector("a[href='#/sessions?model=claude-fable-5']")).not.toBeNull();
  });

  it("does not round a non-zero output share down to 0.0% and names both operands", async () => {
    const response = mockGlobalOverview({ preset: "7d" });
    if (response.data === null) throw new Error("expected overview fixture data");
    response.data.context_per_turn = [
      {
        model: "claude-fable-5",
        n: 2,
        avg_context_per_turn: 250_000,
        avg_output_per_turn: 50,
        usd_per_turn: 1,
      },
    ];
    fetchGlobalOverview.mockResolvedValue(response);
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    fetchLiveSessions.mockResolvedValue(mockLiveSessions());

    const { container } = render(<OverviewPage />);
    expect((await screen.findAllByText("<0.1%")).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("0.0%");
    // The output-share KPI tile was removed (OV-3); the context-per-turn table still names both operands.
    expect(container.textContent).toContain("50 output / 250.0K context");
  });

  it("shows empty / N/A state when the window has no spend (state 3b: ok but no data)", async () => {
    // P1-U4: the daemon's kpis section is never null (getGlobalOverview always builds `data`);
    // an empty window is cost 0. A null section is now a validation error, not "empty".
    const overview = mockGlobalOverview({ preset: "7d" });
    if (overview.data === null) throw new Error("expected overview fixture");
    fetchGlobalOverview.mockResolvedValue({
      ...overview,
      data: { ...overview.data, cost_equiv_u: 0 },
    });
    vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
    fetchLiveSessions.mockResolvedValue(mockLiveSessions());

    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      const banners = Array.from(container.querySelectorAll(".banner-info"));
      expect(banners.some((b) => /No metrics for this window/.test(b.textContent ?? ""))).toBe(
        true,
      );
    });
  });
});

// §3 KPI strip · §5 tokens · §6 spend-by-day · §8 data notes
describe("OverviewPage — v2 sections", () => {
  it("renders the four KPI tiles with subagent spend and the setup grade", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      expect(container.querySelector("[data-metric='spend.equiv']")).not.toBeNull();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Spend-equivalent");
    expect(text).toContain("Sessions");
    expect(text).toContain("Subagent spend");
    expect(text).toContain("Rate my setup");
    expect(text).not.toContain("Cache rebuilds");
    expect(text).not.toContain("Output share of context");
    expect(text).not.toContain("Detector output not available");
  });

  it("renders Where-your-tokens-go with a basis toggle and per-basis weights", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);
    await screen.findByRole("heading", { name: /Where your tokens go/ });
    const buttons = Array.from(container.querySelectorAll(".seg button")).map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Raw tokens", "List price $", "Cap-weighted"]));
    const tokensSection = screen
      .getByRole("heading", { name: /Where your tokens go/ })
      .closest("section");
    expect(
      tokensSection?.querySelector("table")?.parentElement?.classList.contains("table-wrap"),
    ).toBe(true);
    // Published list-price output multiplier is 5×; cap weights carry an unverified chip.
    expect(container.textContent ?? "").toContain("5×");
    expect(container.querySelector(".chip.unv")).not.toBeNull();
  });

  it("renders Spend by day with three tabs", async () => {
    setupSuccess();
    render(<OverviewPage />);
    await screen.findByRole("heading", { name: /Spend by day/ });
    expect(screen.getByRole("button", { name: "Cache writes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cap-weighted tokens" })).toBeTruthy();
  });

  it("renders Data notes with the TTL warning and cache-read caveat, once", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);
    await waitFor(() => {
      expect(container.querySelector("#data-notes")).not.toBeNull();
    });
    const notes = container.querySelector("#data-notes");
    const text = notes?.textContent ?? "";
    expect(text).toContain("Cache TTL unknown");
    expect(text).toContain("Spend-equivalent");
    expect(text).toContain("Provisional turns");
    // TTL warning appears once on the whole page (guide §6.3).
    const ttlHits = (container.textContent ?? "").match(/Cache TTL unknown/g) ?? [];
    expect(ttlHits.length).toBe(1);
  });

  it("links the Workspaces section title and shows the teaser table", async () => {
    setupSuccess();
    render(<OverviewPage />);
    const heading = await screen.findByRole("link", { name: "Workspaces" });
    expect(heading.getAttribute("href")).toBe("#/workspaces");
    expect(await screen.findByTestId("all-workspaces-link")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// LiveStrip — accent + aria-live
// ---------------------------------------------------------------------------

describe("LiveStrip", () => {
  const liveSession: LiveSessionRow & WorkspaceLabelInput = {
    session_id: "sess-1",
    workspace_id: "ws-1",
    project_slug: "orbit-api",
    repo_path: "C:/work/orbit-api",
    repo_owner: "acme",
    repo_name: "orbit-api",
    running_usd_u: 2_450_000, // $2.45
    current_context_tokens: 238_000,
    model: "claude-opus-5",
    started_at: "2026-08-23T14:00:00Z",
  };

  it("renders aria-live='polite' on the live container", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={false} error={null} />);
    expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
  });

  it("LIVE session row gets live-row-live class (orange border accent)", () => {
    const { container } = render(
      <LiveStrip sessions={[liveSession]} isLoading={false} error={null} />,
    );
    const row = container.querySelector("tr.live-row-live");
    expect(row).not.toBeNull();
    // NOT reconciled class
    expect(container.querySelector("tr.live-row-reconciled")).toBeNull();
  });

  it("shows the animated live-dot when sessions are present", () => {
    const { container } = render(
      <LiveStrip sessions={[liveSession]} isLoading={false} error={null} />,
    );
    const dot = container.querySelector(".live-dot.on");
    expect(dot).not.toBeNull();
  });

  it("shows skeleton when loading (distinct from empty state)", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={true} error={null} />);
    // Skeleton present
    expect(container.querySelector(".skeleton")).not.toBeNull();
    // Empty message absent
    expect(container.querySelector(".live-strip-empty")).toBeNull();
  });

  it("shows empty state when loaded with no sessions (distinct from loading)", () => {
    const { container } = render(<LiveStrip sessions={[]} isLoading={false} error={null} />);
    expect(container.querySelector(".live-strip-empty")).not.toBeNull();
    // No skeleton
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  it("shows error state inline when live fetch fails", () => {
    const { container } = render(
      <LiveStrip sessions={[]} isLoading={false} error="ECONNREFUSED" />,
    );
    expect(container.querySelector(".empty-state-text")?.textContent).toMatch(/unavailable/);
    // Neither skeleton nor empty-session text
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(container.querySelector(".live-strip-empty")).toBeNull();
  });

  it("uses mapped and global workspace labels", () => {
    const sessions = [
      {
        ...liveSession,
        workspace_id: "mapped-id",
        project_slug: "raw-mapped",
        repo_owner: "acme",
        repo_name: "console",
      },
      { ...liveSession, session_id: "sess-global", workspace_id: "__global__" },
    ];
    render(<LiveStrip sessions={sessions} isLoading={false} error={null} />);

    expect(screen.getByText("acme/console")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BurnForecastCard — 5+1 state machine
// ---------------------------------------------------------------------------

/** Extra ForecastFromDbResult fields added to every BurnForecastCard test fixture. */
const EXTRA_FORECAST_FIELDS = {
  cap_weighted: true,
  cap_read_coeff: 0.1,
  token_metric: "cap-weighted tokens",
  limit_scale_legacy: false,
  limit_scale_note: null,
  limit_confidence: null,
  limit_resets_at: null,
} as const;

describe("BurnForecastCard", () => {
  it("OFF: shows configure prompt and PROXY chip", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OFF",
          limit_tokens: null,
          tokens_used: 2_450_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/OFF/);
    expect(container.textContent).toMatch(/Weekly token limit/);
    expect(container.textContent).not.toMatch(/:limit_tokens/);
    expect(container.querySelector("[title=':limit_tokens']")).not.toBeNull();
    // PROXY chip present
    expect(container.querySelector(".chip-proxy")).not.toBeNull();
    // LIST_EQUIV chip NOT present (visually distinct)
    expect(container.querySelector(".chip-list-equiv")).toBeNull();
  });

  it("COLD_START: shows pct + baseline hint", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "COLD_START",
          limit_tokens: 10_000_000_000,
          tokens_used: 500_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 500M / 10B = 5%
    expect(container.textContent).toMatch(/5%/);
    expect(container.textContent).toMatch(/Building baseline/);
  });

  it("EXCEEDED: shows EXCEEDED chip and pct", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "EXCEEDED",
          limit_tokens: 10_000_000_000,
          tokens_used: 11_000_000_000,
          tokens_per_day: 1_500_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/EXCEEDED/);
    // 11B / 10B = 110% (headline not clamped)
    expect(container.textContent).toMatch(/110%/);
  });

  it("WARNING: shows WARN chip and pct", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "WARNING",
          limit_tokens: 10_000_000_000,
          tokens_used: 9_000_000_000,
          tokens_per_day: 1_500_000_000,
          projected_exhaustion_jd: 2461000.5,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/WARN/);
    // 9B / 10B = 90%
    expect(container.textContent).toMatch(/90%/);
  });

  it("OK: renders pct + used/limit, not the bare string 'OK'", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_000_000_000,
          tokens_per_day: 500_000_000,
          projected_exhaustion_jd: 2461020.5,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 3B / 10B = 30%
    expect(container.textContent).toMatch(/30%/);
    // Shows used / limit in sub-line
    expect(container.textContent).toMatch(/3\.0B/);
    expect(container.textContent).toMatch(/10\.0B/);
    // State chip says ON TRACK, not a raw text "OK"
    expect(container.textContent).toMatch(/ON TRACK/);
    expect(container.querySelector(".chip-proxy")).not.toBeNull();
  });

  it("NO_BURN: shows pct and ON TRACK chip", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "NO_BURN",
          limit_tokens: 10_000_000_000,
          tokens_used: 1_000_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    // 1B / 10B = 10%
    expect(container.textContent).toMatch(/10%/);
    expect(container.textContent).toMatch(/ON TRACK/);
  });

  it("prefers live burnStatus utilization over calibrated fraction", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 2_000_000_000, // 20% calibrated
          tokens_per_day: 300_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
          limit_resets_at: null,
        }}
        burnStatus={{
          available: true,
          seven_day: { utilization: 0.45, resets_at: "2026-09-09T00:00:00Z" },
        }}
      />,
    );
    // Live says 45%; calibrated would say 20%
    expect(container.textContent).toMatch(/45%/);
    // Should NOT show 20% as the headline fraction
    const headline = container.querySelector(".bfc-headline");
    expect(headline?.textContent).not.toMatch(/20%/);
  });

  it("falls back to calibrated fraction when burnStatus unavailable", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_500_000_000, // 35% calibrated
          tokens_per_day: 500_000_000,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/35%/);
    // No reset-day shown (no resetsAt)
    expect(container.textContent).not.toMatch(/resets/);
  });

  it("shows LOW CONFIDENCE chip when limit_confidence === 'low'", () => {
    const { container } = render(
      <BurnForecastCard
        forecast={{
          state: "OK",
          limit_tokens: 10_000_000_000,
          tokens_used: 3_000_000_000,
          tokens_per_day: null,
          projected_exhaustion_jd: null,
          warn_threshold_days: 2,
          ...EXTRA_FORECAST_FIELDS,
          limit_confidence: "low",
        }}
        burnStatus={null}
      />,
    );
    expect(container.textContent).toMatch(/LOW CONFIDENCE/);
    expect(container.querySelector(".bfc-chip-low-confidence")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkspaceTable — spend is always real USD
// ---------------------------------------------------------------------------

describe("OverviewPage WorkspaceTable", () => {
  it("workspace spend column shows real USD, never N/A", async () => {
    setupSuccess();

    const { container } = render(<OverviewPage />);

    // orbit-api cost from the coherent fixture = $1,350.00.
    await waitFor(() => {
      const found = Array.from(container.querySelectorAll("td")).some(
        (td) => td.textContent?.trim() === "$1,350.00",
      );
      expect(found).toBe(true);
    });
    // At least one workspace row rendered
    const rows = container.querySelectorAll("tbody tr:not([aria-hidden='true'])");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("uses mapped and global workspace labels", () => {
    const workspaces = [
      {
        workspace_id: "mapped-id",
        project_slug: "raw-mapped",
        repo_path: "C:/work/console",
        repo_owner: "acme",
        repo_name: "console",
        cost_equiv_u: 1,
        turns: 1,
        cost_share: 0.5,
        has_live: false,
        usd_per_turn: 0.000001,
      },
      {
        workspace_id: "__global__",
        project_slug: "raw-global",
        repo_path: null,
        repo_owner: null,
        repo_name: null,
        cost_equiv_u: 1,
        turns: 1,
        cost_share: 0.5,
        has_live: false,
        usd_per_turn: 0.000001,
      },
    ];
    render(
      <WorkspaceTable workspaces={workspaces} globalCostU={2} globalTurns={2} isLoading={false} />,
    );

    expect(screen.getByText("acme/console")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Section headings — the v2 section order (spec section-order table)
// ---------------------------------------------------------------------------

describe("OverviewPage — section headings", () => {
  it("renders the v2 sentence-case section headings in order", async () => {
    setupSuccess();
    const { container } = render(<OverviewPage />);

    await waitFor(() => {
      // Section headings carry a trailing InfoTip glyph / chip; match on the label prefix.
      const headings = Array.from(container.querySelectorAll("h2")).map((h) =>
        (h.textContent ?? "").trim(),
      );
      for (const label of [
        "Usage limits",
        "Top Usage Recommendations",
        "This period",
        "Most expensive sessions this week",
        "Context per turn by model",
        "Where your tokens go",
        "Spend by day",
        "Workspaces",
        "Data notes",
        "Across the dashboard",
      ]) {
        expect(headings.some((h) => h.startsWith(label))).toBe(true);
      }
      // Retired letterspaced-caps Overview labels are gone.
      expect(headings.some((h) => h === "SUMMARY" || h === "Summary")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// CacheWriteSpikesChart — standalone unit (component retained, moved off Overview)
// ---------------------------------------------------------------------------

describe("CacheWriteSpikesChart", () => {
  it("renders the writes-only chart branch (LIST_EQUIV chip + TTL caveat) when data is present", () => {
    const { container } = render(
      <CacheWriteSpikesChart
        state={{ status: "ok", value: mockCacheWriteTrend({ preset: "7d" }) }}
      />,
    );
    expect(container.querySelector(".chip-list-equiv")).not.toBeNull();
    expect(container.textContent ?? "").toMatch(/TTL 5m\/1h volatile/);
    expect(container.textContent ?? "").toMatch(/Cache writes over time/);
  });

  it("keeps the spike-threshold label inside the plot area", () => {
    expect(SPIKE_THRESHOLD_LABEL_POSITION).toBe("insideTopLeft");
  });
});

// ---------------------------------------------------------------------------
// VerdictBand — UIC-3a/O4 headline stability
// ---------------------------------------------------------------------------

describe("VerdictBand — headline does not flip while loading (O4)", () => {
  const trend = mockTrends({ preset: "7d" }).data;
  const priorTrend = mockTrends({ preset: "7d" }).data;

  it("withholds the delta and shows a loading trend placeholder while loading", () => {
    const { container } = render(
      <VerdictBand preset="7d" trend={trend} priorTrend={null} isLoading={true} />,
    );
    // No premature delta badge to flip from once the prior window resolves.
    expect(container.querySelector(".window-delta")).toBeNull();
    expect(container.textContent ?? "").not.toContain("Prior window unavailable");
    expect(container.textContent ?? "").toContain("Loading trend");
  });

  it("shows the resolved delta once both windows have loaded", () => {
    const { container } = render(
      <VerdictBand preset="7d" trend={trend} priorTrend={priorTrend} isLoading={false} />,
    );
    const delta = container.querySelector(".window-delta");
    expect(delta).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Loading trend");
  });

  it("still shows a terminal 'Prior window unavailable' when the prior window is genuinely absent", () => {
    const { container } = render(
      <VerdictBand preset="7d" trend={trend} priorTrend={null} isLoading={false} />,
    );
    expect(container.textContent ?? "").toContain("Prior window unavailable");
  });
});
