/**
 * OV-12 U5 — past limit weeks on the spend card: the "vs last week" line, the "Show past weeks"
 * expander (rows on 11 fixed slots, gaps shown) and the 12-week trend strip. Limits come from a
 * mocked client.fetchLimits (never the real API).
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHookConfigResponse,
  mockHotSessions,
  mockLimitsWithHistory,
  mockLimitsWithWeeklyMax,
  mockLinkageRate,
  mockLiveSessions,
  mockRecommendations,
  mockTrends,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import OverviewPage from "../../../src/ui/overview/OverviewPage";
import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview-view-from-legacy";

vi.mock("../../../src/ui/api/client");

beforeEach(() => {
  vi.clearAllMocks();
  serveOverviewViewFromLegacyMocks();
  const filter = { preset: "7d" as const };
  fetchGlobalOverview.mockResolvedValue(mockGlobalOverview(filter));
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition(filter));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces(filter));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchTrends).mockImplementation(async (f) => mockTrends(f));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend(filter));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
    configured: false,
    source: "none",
  } as never);
  vi.mocked(client.fetchStatus).mockResolvedValue({
    sessions: 3,
    files_seen: 3,
    files_parsed: 3,
    scan_state: "complete",
    lines_quarantined: 0,
    invalid_scan_root_count: 0,
  });
});
afterEach(cleanup);

async function maxLine(limits: ReturnType<typeof mockLimitsWithHistory>): Promise<HTMLElement> {
  vi.mocked(client.fetchLimits).mockResolvedValue(limits);
  const { container } = render(<OverviewPage />);
  await waitFor(() =>
    expect(
      container.querySelector("[data-metric='spend.equiv'] [data-testid='weekly-max']"),
    ).not.toBeNull(),
  );
  return container.querySelector("[data-metric='spend.equiv']") as HTMLElement;
}
const vs = (card: HTMLElement) => within(card).queryByTestId("weekly-max-vs")?.textContent;

describe("U5 past weeks", () => {
  it("live shape, under 10%: no comparison yet; 3 rows incl. the gap; spread sub-line; chips", async () => {
    const card = await maxLine(mockLimitsWithHistory("low-confidence"));
    expect(vs(card)).toBe("vs last week: compare once this week passes 10%");
    const details = within(card).getByTestId("weekly-max-history");
    expect(details.querySelector("summary")?.textContent).toBe("Show past weeks (3)");
    const rows = [...details.querySelectorAll(".pm-week")].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Week to \w{3} \w{3} \d+No reading ≥ 10%$/);
    expect(rows[1]).toMatch(/≈ \$1,156 · 100% Limit hit/);
    expect(rows[1]).toContain("2 readings, 2% apart ($1,156 – $1,180)");
    expect(rows[2]).toMatch(/≈ \$1,130 · 20% Calibration$/);
    expect(details.querySelector(".chip.unv")?.textContent).toBe("Limit hit");
    expect(details.textContent).toContain('Changes under 3% read "no clear change"');
  });

  it("trend strip: 12 slots, 2 filled dots, 1 gap mark, no hollow dot under 10%", async () => {
    const card = await maxLine(mockLimitsWithHistory("low-confidence"));
    const svg = within(card).getByTestId("weekly-max-trend").querySelector("svg") as SVGSVGElement;
    expect(svg.querySelectorAll("rect[fill='transparent']")).toHaveLength(12);
    expect(svg.querySelectorAll("circle")).toHaveLength(2);
    expect(svg.querySelectorAll("line[stroke-dasharray='2 3']")).toHaveLength(1);
    expect(svg.getAttribute("aria-label")).toMatch(/\$1,130; week to .* \$1,156$/);
  });

  it("hover shows the week, max, % and source", async () => {
    const card = await maxLine(mockLimitsWithHistory("low-confidence"));
    const hits = within(card)
      .getByTestId("weekly-max-trend")
      .querySelectorAll("rect[fill='transparent']");
    fireEvent.mouseEnter(hits[9] as Element); // two weeks back
    expect(within(card).getByRole("status").textContent).toMatch(
      /^Week to .* · \$1,156 · read at 100% · Limit hit$/,
    );
    fireEvent.mouseLeave(hits[9] as Element);
    expect(within(card).queryByRole("status")).toBeNull();
  });

  it("ok + clear change: names the week when last week is a gap; this week is a hollow dot", async () => {
    const card = await maxLine(mockLimitsWithHistory("ok", 1290e6));
    expect(vs(card)).toMatch(/^↑12% vs week to \w{3} \d+ \(\$1,156\)$/);
    const circles = within(card).getByTestId("weekly-max-trend").querySelectorAll("circle");
    expect(circles).toHaveLength(3);
    expect(circles[2]?.getAttribute("fill")).toBe("var(--inset)");
  });

  it("a reset time that moved still places past weeks in their nearest slot", async () => {
    const limits = mockLimitsWithHistory("ok", 1290e6);
    const max = limits.weeklyMax as NonNullable<typeof limits.weeklyMax>;
    const shift = (iso: string) => new Date(Date.parse(iso) + 26 * 3_600_000).toISOString();
    max.history = (max.history ?? []).map((h) => ({ ...h, resetsAt: shift(h.resetsAt) }));
    if (max.vsLastWeek)
      max.vsLastWeek = { ...max.vsLastWeek, resetsAt: shift(max.vsLastWeek.resetsAt) };
    const card = await maxLine(limits);
    expect(within(card).getByTestId("weekly-max-trend").querySelectorAll("circle")).toHaveLength(3);
    const rows = [...within(card).getByTestId("weekly-max-history").querySelectorAll(".pm-week")];
    expect(rows[1]?.textContent).toMatch(/≈ \$1,156 · 100% Limit hit/);
    const named = vs(card)?.match(/vs week to (\w{3} \d+)/)?.[1];
    // the row is labelled with the week's own reset, the same date the comparison names
    expect(named).toBeDefined();
    expect(rows[1]?.textContent).toMatch(new RegExp(`^Week to \\w{3} ${named}≈`));
  });

  it("ok + change inside the noise band → no clear change", async () => {
    const card = await maxLine(mockLimitsWithHistory("ok", 1170e6));
    expect(vs(card)).toMatch(/^vs week to \w{3} \d+: no clear change$/);
  });

  it("Tokens tab: same weeks in tokens", async () => {
    const card = await maxLine(mockLimitsWithHistory("ok", 1290e6));
    fireEvent.click(within(card).getByRole("button", { name: "Tokens" }));
    expect(vs(card)).toMatch(/\(578\.0M\)$/);
    expect(within(card).getByTestId("weekly-max-history").textContent).toContain("≈ 565.0M · 20%");
  });

  it("too early: comparison hidden, expander kept", async () => {
    const card = await maxLine(mockLimitsWithHistory("too-early"));
    expect(vs(card)).toBeUndefined();
    expect(within(card).getByTestId("weekly-max-history")).toBeTruthy();
  });

  it("no past weeks: says so, no expander", async () => {
    const card = await maxLine(mockLimitsWithWeeklyMax("ok"));
    expect(vs(card)).toBe("vs last week: no past weeks yet");
    expect(card.textContent).toContain("Past weeks appear once a week's reading reaches 10%.");
    expect(within(card).queryByTestId("weekly-max-history")).toBeNull();
  });

  it("more than 3 rows → Show all / Show fewer", async () => {
    const limits = mockLimitsWithHistory("ok", 1290e6);
    const wm = limits.weeklyMax as NonNullable<typeof limits.weeklyMax>;
    const H = 3_600_000;
    const cur = Math.round(Date.parse(wm.resetsAt ?? "") / H) * H;
    wm.history?.push({
      resetsAt: new Date(cur - 6 * 7 * 24 * H).toISOString(),
      impliedMaxSpendU: 1100e6,
      impliedMaxPwTokens: 550e6,
      usedPctAtSample: 64,
      source: "api",
    });
    const card = await maxLine(limits);
    const details = within(card).getByTestId("weekly-max-history");
    expect(details.querySelector("summary")?.textContent).toBe("Show past weeks (6)");
    expect(details.querySelectorAll(".pm-week")).toHaveLength(3);
    fireEvent.click(within(details).getByRole("button", { name: "Show all 6 weeks" }));
    expect(details.querySelectorAll(".pm-week")).toHaveLength(6);
    expect(details.textContent).toMatch(/≈ \$1,100 · 64% Live/);
    fireEvent.click(within(details).getByRole("button", { name: "Show fewer" }));
    expect(details.querySelectorAll(".pm-week")).toHaveLength(3);
  });
});
