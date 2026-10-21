/**
 * test/ui/overview-sessions-tile.test.tsx — Task 9: the Overview Sessions tile shows spend
 * concentration (top 3 share, median vs average, ranked-cost strip) instead of a bare count.
 *
 * Oracle: costs and expected figures are hand-computed below, not derived from the helper.
 * Synthetic data only (SEC-101).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import type { DaemonStatus, OverviewViewResponse } from "../../src/ui/api/client";
import { mockLimits, mockOverviewView } from "../../src/ui/api/fixtures";
import { resetSectionLog } from "../../src/ui/api/parse";
import { queryClient } from "../../src/ui/api/query-client";
import OverviewPage from "../../src/ui/overview/OverviewPage";

vi.mock("../../src/ui/api/client");

const DAY = 86_400_000;

/** One reconciled session row per cost (USD); `cost_equiv_u` is micro-USD. */
function rows(costsUsd: number[]) {
  return costsUsd.map((usd, i) => ({
    session_id: `sess-${i}`,
    workspace_id: "ws-1",
    project_slug: "orbit-api",
    first_turn_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    cost_equiv_u: usd * 1_000_000,
  }));
}

function view(
  preset: "24h" | "7d" | "30d",
  current: number[],
  prior: number[],
  status?: Partial<DaemonStatus>,
): OverviewViewResponse {
  const v = mockOverviewView(preset);
  const trends = v.sections.trends?.data as Record<string, unknown>;
  const trendsPrior = v.sections.trends_prior?.data as Record<string, unknown>;
  v.sections.trends = { status: "ok", ms: 1, data: { ...trends, sessions: rows(current) } };
  v.sections.trends_prior = {
    status: "ok",
    ms: 1,
    data: { ...trendsPrior, sessions: rows(prior) },
  };
  if (status !== undefined) {
    const base = v.sections.status?.data as DaemonStatus;
    v.sections.status = { status: "ok", ms: 1, data: { ...base, ...status } };
  }
  return v;
}

function serve(make: (preset: "24h" | "7d" | "30d") => OverviewViewResponse) {
  vi.mocked(client.fetchOverviewView).mockImplementation(async (preset) =>
    make(preset as "24h" | "7d" | "30d"),
  );
}

async function sessionsTile(): Promise<HTMLElement> {
  await screen.findByTestId("overview-decision");
  const tile = document.querySelector<HTMLElement>('[data-metric="sessions.count"]');
  if (tile === null) throw new Error("expected the Sessions tile");
  return tile;
}

// 10 sessions: total $150; top 3 = 50+30+20 = $100 → 67%; sorted
// [5,5,6,7,8,9,10,20,30,50] → median (8+9)/2 = $8.50; average 150/10 = $15.00.
const TEN = [10, 50, 5, 9, 30, 6, 20, 8, 7, 5];
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8];

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  resetSectionLog();
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("Overview Sessions tile — spend concentration (Task 9)", () => {
  it("1. 10 sessions: top 3 share, median and average; the strip has 4 segments", async () => {
    serve((p) => view(p, TEN, EIGHT));
    render(<OverviewPage />);
    const tile = await sessionsTile();

    expect(tile.textContent).toContain("Top 3 = 67% of spend");
    expect(tile.textContent).toContain("median $8.50 (avg $15.00)");
    const strip = within(tile).getByTestId("sessions-cost-strip");
    expect(strip.children).toHaveLength(4);
    // Widths are each segment's cost share: 50/150, 30/150, 20/150, rest 50/150.
    const widths = Array.from(strip.children).map((s) => (s as HTMLElement).style.width);
    expect(widths.map((w) => Math.round(Number.parseFloat(w)))).toEqual([33, 20, 13, 33]);
  });

  it("2. 3 sessions: no strip and no Top 3 clause; median and average still show", async () => {
    // [2,4,9] → median $4.00; average 15/3 = $5.00.
    serve((p) => view(p, [9, 2, 4], EIGHT));
    render(<OverviewPage />);
    const tile = await sessionsTile();

    expect(within(tile).queryByTestId("sessions-cost-strip")).toBeNull();
    expect(tile.textContent).not.toContain("Top 3");
    expect(tile.textContent).toContain("median $4.00 (avg $5.00)");
  });

  it("2b. exactly 4 sessions shows the strip; all-zero costs show none", async () => {
    // [1,2,3,4]: total $10; top 3 = 4+3+2 = $9 → 90%; median (2+3)/2 = $2.50; avg $2.50.
    serve((p) => view(p, [1, 2, 3, 4], EIGHT));
    render(<OverviewPage />);
    let tile = await sessionsTile();
    expect(within(tile).getByTestId("sessions-cost-strip").children).toHaveLength(4);
    expect(tile.textContent).toContain("Top 3 = 90% of spend · median $2.50 (avg $2.50)");

    cleanup();
    queryClient.clear();
    serve((p) => view(p, [0, 0, 0, 0, 0], EIGHT));
    render(<OverviewPage />);
    tile = await sessionsTile();
    expect(within(tile).queryByTestId("sessions-cost-strip")).toBeNull();
    expect(tile.textContent).not.toContain("Top 3");
    expect(tile.textContent).toContain("median $0.00 (avg $0.00)");
  });

  it("3. count delta vs the prior window; empty prior says unavailable", async () => {
    serve((p) => view(p, TEN, EIGHT));
    render(<OverviewPage />);
    let tile = await sessionsTile();
    // (10 - 8) / 8 = +25%.
    expect(tile.textContent).toContain("↑25% vs prior 7d");

    cleanup();
    queryClient.clear();
    serve((p) => view(p, TEN, []));
    render(<OverviewPage />);
    tile = await sessionsTile();
    expect(tile.textContent).toContain("Prior window unavailable");

    // Same count both windows → no arrow.
    cleanup();
    queryClient.clear();
    serve((p) => view(p, EIGHT, EIGHT));
    render(<OverviewPage />);
    tile = await sessionsTile();
    expect(tile.textContent).toContain("Flat vs prior 7d");
    expect(tile.textContent).not.toMatch(/[↑↓]0%/);
  });

  it("4. no live chip and no partial badge while history loads; the header label still shows", async () => {
    const oldest = new Date(Date.now() - 8 * DAY).toISOString().slice(0, 10); // 9 days covered
    serve((p) =>
      view(p, TEN, EIGHT, {
        pipeline: {
          phase: "history",
          weeks_total: 13,
          weeks_done: 2,
          files_total: 10,
          files_completed: 4,
          files_with_new_data: 4,
          detector_runs: 1,
          failed_phase: null,
          events: [],
        },
        history_coverage: {
          weeks_done: 2,
          weeks_total: 13,
          complete_through_ms: Date.now() - 8 * DAY,
          oldest_complete_day: oldest,
          partial_week: false,
        },
      } as Partial<DaemonStatus>),
    );
    render(<OverviewPage />);
    await sessionsTile();
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    await screen.findByRole("heading", { name: "This period (30d)" });
    const tile = await sessionsTile();

    expect(screen.getByTestId("coverage-chip").textContent).toBe("Showing 9 of 30 days");
    expect(within(tile).queryByTestId("partial-badge")).toBeNull();
    expect(tile.querySelector(".chip.live")).toBeNull();
  });

  it("5. Most expensive → scrolls on 7d; on 30d links to Sessions sorted by cost for the window", async () => {
    serve((p) => view(p, TEN, EIGHT));
    const scroll = vi.fn();
    render(<OverviewPage />);
    let tile = await sessionsTile();
    const target = document.getElementById("expensive-sessions-title");
    if (target === null) throw new Error("expected the expensive-sessions table");
    target.scrollIntoView = scroll;
    fireEvent.click(within(tile).getByRole("link", { name: "Most expensive →" }));
    expect(scroll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    await screen.findByRole("heading", { name: "This period (30d)" });
    tile = await sessionsTile();
    const from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    await waitFor(() =>
      expect(
        within(tile).getByRole("link", { name: "Most expensive →" }).getAttribute("href"),
      ).toBe(`#/sessions?from=${from}&sort=cost&direction=desc`),
    );
  });

  it("6. first paint request count is unchanged: the page request + KPI subset, no extra reads", async () => {
    serve((p) => view(p, TEN, EIGHT));
    render(<OverviewPage />);
    await sessionsTile();

    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.fetchHotSessions)).not.toHaveBeenCalled();
    expect(vi.mocked(client.fetchHotSessionsPage)).not.toHaveBeenCalled();
    expect(vi.mocked(client.fetchTrends)).not.toHaveBeenCalled();
    expect(vi.mocked(client.fetchStatus)).toHaveBeenCalledTimes(1);
  });
});
