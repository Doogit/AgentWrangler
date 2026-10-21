/**
 * test/ui/partial-data.test.tsx — U5 partial-data honesty affordances.
 *
 * Covers ALL spec §U5 scenarios against the STEP-1 finalized card list:
 *
 *   Full-history-dependent cards (the SC6 enumeration):
 *     1. TopRecommendations — cross-session detector recommendations (may-change)
 *     2. §7 Workspaces       — "Best next improvement" column (CEU/modeled-savings)   (may-change)
 *     3. §3 Sessions KPI     — global session count climbs as the reading phase backfills
 *                              the historical remainder outside the ready window       (incomplete)
 *
 *   G11 and W1 are NOT rendered in OverviewPage and have no badge here.
 *
 * Test scenarios:
 *   SC6 happy:         badge present on each full-history card while pipeline is incomplete
 *   SC6 completion:    badge absent after pipeline becomes null / done
 *   Reduced-motion:    data-partial="false" on fade wrappers (no opacity dim)
 *   SWR revalidation:  no skeleton re-flash when already-populated card re-fetches
 *   Copy correctness:  cross-session cards show "may-change"; the Sessions KPI shows no badge (Task 9)
 *   Negative SC6:      enumerate all full-history cards and assert each has badge while incomplete
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus, PipelineStatus } from "../../src/ui/api/client";
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
  mockSuccessRate,
  mockTrends,
  mockWorkspaces,
} from "../../src/ui/api/fixtures";
import { STATUS_BUSY_POLL_MS } from "../../src/ui/api/status-poller";
import OverviewPage from "../../src/ui/overview/OverviewPage";

import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview/overview-view-from-legacy";

vi.mock("../../src/ui/api/client");
beforeEach(serveOverviewViewFromLegacyMocks);

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const READING_PIPELINE: PipelineStatus = {
  phase: "reading",
  files_total: 5000,
  files_completed: 1200,
  files_with_new_data: 0,
  detector_runs: 0,
  failed_phase: null,
  events: ["reading — 1200 / 5000 files"],
};

const DONE_PIPELINE: PipelineStatus = {
  phase: "done",
  files_total: 5000,
  files_completed: 5000,
  files_with_new_data: 80,
  detector_runs: 7,
  failed_phase: null,
  events: ["done — 5000 files, 7 detector runs"],
};

// P2-U5: the page refetches only when a status poll shows a data scope moved. The pipeline
// finishes with a detector walk, which bumps `detectors`.
const SCOPES_READING = { live: 1, ingest: 1, detectors: 0, lifecycle: 0, clock: "d|d" };
const SCOPES_DONE = { ...SCOPES_READING, detectors: 1 };

/** DaemonStatus with a partial pipeline (incomplete). */
const PARTIAL_STATUS: DaemonStatus = mockStatus({
  pipeline: READING_PIPELINE,
  data_scopes: SCOPES_READING,
});

/** DaemonStatus without pipeline (complete / caught-up). */
const COMPLETE_STATUS: DaemonStatus = mockStatus({ data_scopes: SCOPES_DONE });

/** DaemonStatus with pipeline.phase === "done". */
const DONE_STATUS: DaemonStatus = mockStatus({ pipeline: DONE_PIPELINE, data_scopes: SCOPES_DONE });

/** The busy pipeline polls every STATUS_BUSY_POLL_MS; allow one poll plus the page refetch. */
const NEXT_POLL = { timeout: STATUS_BUSY_POLL_MS + 2_000 };

// ---------------------------------------------------------------------------
// matchMedia helpers
// ---------------------------------------------------------------------------

function setupMatchMedia(prefersReducedMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersReducedMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  setupMatchMedia(false);

  // Defaults that OverviewPage always needs.
  vi.mocked(client.fetchStatus).mockResolvedValue(COMPLETE_STATUS);
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
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
    configured: false,
    source: "none",
  } as never);
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview({ preset: "7d" }));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces({ preset: "7d" }));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
});

// ---------------------------------------------------------------------------
// SC6 happy path — badge present while pipeline is incomplete
// ---------------------------------------------------------------------------

describe("SC6 happy path — partial badge while incomplete", () => {
  it("shows partial badge on TopRecommendations while pipeline is reading", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    const badges = screen.getAllByTestId("partial-badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("shows partial badge on §7 Workspaces section while pipeline is reading", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("all-workspaces-link");
    const badges = screen.getAllByTestId("partial-badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("badge transitions away when pipeline becomes null (complete)", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    expect(screen.getAllByTestId("partial-badge").length).toBeGreaterThanOrEqual(1);

    // Pipeline completes. The next busy-cadence status poll sees `detectors` move and
    // invalidates the page (P2-U5; the page no longer refetches on focus).
    vi.mocked(client.fetchStatus).mockResolvedValue(COMPLETE_STATUS);
    await waitFor(() => {
      expect(screen.queryAllByTestId("partial-badge")).toHaveLength(0);
    }, NEXT_POLL);
  });

  it("badge transitions away when pipeline.phase becomes done", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    expect(screen.getAllByTestId("partial-badge").length).toBeGreaterThanOrEqual(1);

    vi.mocked(client.fetchStatus).mockResolvedValue(DONE_STATUS);
    await waitFor(() => {
      expect(screen.queryAllByTestId("partial-badge")).toHaveLength(0);
    }, NEXT_POLL);
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion: no fade class applied (data-partial="false")
// ---------------------------------------------------------------------------

describe("prefers-reduced-motion: reduce — no opacity fade", () => {
  // OV-13: the partial-value fade was dropped; partial values stay full strength with the badge.
  it("partial values are never dimmed: no fade wrappers, the badge alone marks them", async () => {
    setupMatchMedia(true); // prefers-reduced-motion: reduce
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    const { container } = render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    await screen.findByTestId("all-workspaces-link");

    expect(screen.getAllByTestId("partial-badge").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("[data-partial]")).toBeNull();
  });

  it("values update immediately (badge disappears) after completion under reduced-motion", async () => {
    setupMatchMedia(true);
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    expect(screen.getAllByTestId("partial-badge").length).toBeGreaterThanOrEqual(1);

    vi.mocked(client.fetchStatus).mockResolvedValue(COMPLETE_STATUS);
    await waitFor(() => {
      expect(screen.queryAllByTestId("partial-badge")).toHaveLength(0);
    }, NEXT_POLL);
  });
});

// ---------------------------------------------------------------------------
// SWR revalidation — no skeleton re-flash on already-populated card
// ---------------------------------------------------------------------------

describe("SWR revalidation — no skeleton re-flash", () => {
  it("retains populated workspace table after initial load (no skeleton present)", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);

    // Wait for workspace table to load.
    await screen.findByTestId("all-workspaces-link");

    // No skeleton should be present: retainDataWhileRefreshing keeps
    // workspacesState at "ok" during any loadMain re-invocation.
    expect(screen.queryByLabelText("Loading workspace data")).toBeNull();
    expect(screen.getByTestId("all-workspaces-link")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Copy correctness — cross-session cards show "may change", not "incomplete"
// ---------------------------------------------------------------------------

describe("Copy correctness — variant per card", () => {
  it("cross-session sections (TopRecommendations, Workspaces) show the 'may change' variant", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    await screen.findByTestId("all-workspaces-link");

    for (const sel of ["top-recommendations-title", "workspaces-title"]) {
      const badge = screen
        .getAllByTestId("partial-badge")
        .find((el) => el.closest(`[aria-labelledby='${sel}']`) !== null);
      expect(badge?.getAttribute("data-variant")).toBe("may-change");
      expect(badge?.textContent).toContain("May change until full parse");
    }
  });
});

// ---------------------------------------------------------------------------
// Negative enumeration (SC6 guarantee) — every full-history card has a badge
// ---------------------------------------------------------------------------

describe("SC6 negative enumeration — every full-history card has badge while incomplete", () => {
  it("TopRecommendations has partial badge while pipeline is incomplete", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    const decisionBadge = screen
      .getAllByTestId("partial-badge")
      .find((el) => el.closest("[aria-labelledby='top-recommendations-title']") !== null);
    expect(decisionBadge).toBeDefined();
  });

  it("§7 Workspaces section has partial badge while pipeline is incomplete", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("all-workspaces-link");
    const workspacesBadge = screen
      .getAllByTestId("partial-badge")
      .find((el) => el.closest("[aria-labelledby='workspaces-title']") !== null);
    expect(workspacesBadge).toBeDefined();
  });

  it("§3 Sessions KPI has no partial badge; the 'This period' coverage chip carries the caveat (Task 9)", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    const sessionsCard = document.querySelector("[data-metric='sessions.count']");
    expect(sessionsCard).not.toBeNull();
    expect(sessionsCard?.querySelector("[data-testid='partial-badge']")).toBeNull();
  });

  it("no partial badge renders when pipeline is complete", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(COMPLETE_STATUS);
    render(<OverviewPage />);
    await screen.findByTestId("top-rec-1");
    expect(screen.queryAllByTestId("partial-badge")).toHaveLength(0);
  });

  it("window-bounded KPI cards (§3) do NOT have a partial badge", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(PARTIAL_STATUS);
    render(<OverviewPage />);
    await waitFor(() => {
      expect(document.querySelector("[data-metric='spend.equiv']")).not.toBeNull();
    });
    // Spend-equiv KPI must have NO partial badge inside it.
    const spendCard = document.querySelector("[data-metric='spend.equiv']");
    expect(spendCard?.querySelector("[data-testid='partial-badge']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2-U7 test 3 — "This period" says how many of the preset's days history covers
// ---------------------------------------------------------------------------

describe("P2-U7 completeness chip on This period", () => {
  const covered9 = mockStatus({
    pipeline: { ...READING_PIPELINE, phase: "history", weeks_total: 13, weeks_done: 2 },
    data_scopes: SCOPES_READING,
    history_coverage: {
      weeks_done: 2,
      weeks_total: 13,
      complete_through_ms: Date.now() - 8 * 86_400_000,
      oldest_complete_day: new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10),
      partial_week: false,
    },
  } as Partial<DaemonStatus>);

  it("30d with 9 covered days → 'Showing 9 of 30 days'; 7d → no chip", async () => {
    vi.mocked(client.fetchStatus).mockResolvedValue(covered9);
    render(<OverviewPage />);
    await screen.findByText(/This period \(7d\)/);
    await waitFor(() => expect(client.fetchStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("coverage-chip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    const chip = await screen.findByTestId("coverage-chip");
    expect(chip.textContent).toBe("Showing 9 of 30 days");
  });
});
