/**
 * Task 8: the Overview "All" preset — every recorded turn, no prior window to compare against.
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

/** The daemon's "all" response: an epoch-start window and an empty prior window. */
function allView(status?: Partial<DaemonStatus>): OverviewViewResponse {
  const v = mockOverviewView("30d");
  v.window = { ...v.window, from: "1970-01-01T00:00:00.000Z" };
  const prior = v.sections.trends_prior?.data as Record<string, unknown>;
  v.sections.trends_prior = { status: "ok", ms: 1, data: { ...prior, buckets: [], sessions: [] } };
  if (status !== undefined) {
    const base = v.sections.status?.data as DaemonStatus;
    v.sections.status = { status: "ok", ms: 1, data: { ...base, ...status } };
  }
  return v;
}

function serve(status?: Partial<DaemonStatus>) {
  vi.mocked(client.fetchOverviewView).mockImplementation(async (preset) =>
    preset === "all" ? allView(status) : mockOverviewView(preset as "24h" | "7d" | "30d"),
  );
}

function tile(metric: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-metric="${metric}"]`);
  if (el === null) throw new Error(`expected the ${metric} tile`);
  return el;
}

async function pickAll() {
  render(<OverviewPage />);
  await screen.findByTestId("overview-decision");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await screen.findByRole("heading", { name: "This period (all time)" });
}

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

describe("Overview All preset (Task 8)", () => {
  it("1. requests preset=all and says there is no prior window, not 'unavailable'", async () => {
    serve();
    await pickAll();
    expect(vi.mocked(client.fetchOverviewView).mock.calls.some(([p]) => p === "all")).toBe(true);
    await waitFor(() => expect(tile("spend.equiv").textContent).toContain("All recorded history"));
    for (const metric of ["spend.equiv", "sessions.count"]) {
      expect(tile(metric).textContent).not.toContain("vs prior");
      expect(tile(metric).textContent).not.toContain("Prior window unavailable");
    }
    expect(tile("spend.equiv").textContent).not.toContain("dashed = prior");
  });

  it("2. Most expensive → opens Sessions by cost with no date bound", async () => {
    serve();
    await pickAll();
    await waitFor(() =>
      expect(
        within(tile("sessions.count"))
          .getByRole("link", { name: "Most expensive →" })
          .getAttribute("href"),
      ).toBe("#/sessions?sort=cost&direction=desc"),
    );
  });

  it("4. Spend by day over 90 days labels every 3rd day (at most 31 labels)", async () => {
    vi.mocked(client.fetchOverviewView).mockImplementation(async (preset) => {
      if (preset !== "all") return mockOverviewView(preset as "24h" | "7d" | "30d");
      const v = allView();
      const trends = v.sections.trends?.data as { buckets: Array<{ bucket: string }> };
      const template = trends.buckets[0] as { bucket: string };
      const end = new Date(Date.parse(v.window.to));
      // 90 consecutive local days ending on the server's today: fill-days adds none.
      const buckets = Array.from({ length: 90 }, (_, i) => {
        const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 89 + i);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return { ...template, bucket: day };
      });
      v.sections.trends = { status: "ok", ms: 1, data: { ...trends, buckets } };
      return v;
    });
    await pickAll();
    const chart = await screen.findByRole("img", { name: "Spend by day" });
    await waitFor(() => expect(chart.querySelectorAll("[data-day]")).toHaveLength(90));
    // ceil(90 / 31) = 3 → days 0, 3, …, 87 → 30 labels.
    expect(chart.querySelectorAll("[data-day] > text")).toHaveLength(30);
  });

  it("3. while history loads, the coverage chip counts days against the planned history", async () => {
    // oldest complete day 8 days ago → 9 days covered; 13 planned weeks = ~91 days.
    serve({
      history_coverage: {
        weeks_done: 2,
        weeks_total: 13,
        complete_through_ms: Date.now() - 8 * DAY,
        oldest_complete_day: new Date(Date.now() - 8 * DAY).toISOString().slice(0, 10),
        partial_week: false,
      },
    } as Partial<DaemonStatus>);
    await pickAll();
    await waitFor(() =>
      expect(screen.getByTestId("coverage-chip").textContent).toBe("Showing 9 of ~91 days"),
    );
  });
});
