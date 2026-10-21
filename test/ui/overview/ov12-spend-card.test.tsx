/**
 * OV-12 Phase 1 — spend card $ / Tokens tabs + weekly max line (U2), day dividers and
 * zero-filled days (U3b). Limits come from a mocked client.fetchLimits (never the real API).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHookConfigResponse,
  mockHotSessions,
  mockLimits,
  mockLimitsWithWeeklyMax,
  mockLinkageRate,
  mockLiveSessions,
  mockRecommendations,
  mockTrends,
  mockWorkspaces,
} from "../../../src/ui/api/fixtures";
import { METRIC_COPY } from "../../../src/ui/lib/metric-copy";
import OverviewPage from "../../../src/ui/overview/OverviewPage";
import {
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGlobalOverview,
  fetchLiveSessions,
  serveOverviewViewFromLegacyMocks,
} from "./overview-view-from-legacy";

vi.mock("../../../src/ui/api/client");

/** Server "now" for the page response (local noon, so local calendar days are unambiguous). */
const NOW = new Date(2026, 7, 23, 12, 0);
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysBack = (n: number) =>
  localDay(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n));

beforeEach(() => {
  vi.clearAllMocks();
  serveOverviewViewFromLegacyMocks();
  // The legacy adapter leaves window.to empty; give the page a real server clock.
  const compose = vi.mocked(client.fetchOverviewView).getMockImplementation();
  vi.mocked(client.fetchOverviewView).mockImplementation(async (...args) => {
    const view = await (compose as NonNullable<typeof compose>)(...args);
    return { ...view, window: { ...view.window, to: NOW.toISOString() } };
  });
  const filter = { preset: "7d" as const };
  const overview = mockGlobalOverview(filter);
  if (overview.data) overview.data.cost_equiv_u = 1_214_000_000;
  fetchGlobalOverview.mockResolvedValue(overview);
  fetchFlavorDecomposition.mockResolvedValue(mockFlavorDecomposition(filter));
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces(filter));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchTrends).mockImplementation(async (f) => mockTrends(f));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend(filter));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimitsWithWeeklyMax("ok"));
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

async function spendCard(): Promise<HTMLElement> {
  const { container } = render(<OverviewPage />);
  await waitFor(() =>
    expect(container.querySelector("[data-metric='spend.equiv']")).not.toBeNull(),
  );
  return container.querySelector("[data-metric='spend.equiv']") as HTMLElement;
}

describe("U2 tabbed spend card", () => {
  it("$ tab by default: title, one spend.equiv card, max line", async () => {
    const card = await spendCard();
    expect(document.querySelectorAll("[data-metric='spend.equiv']")).toHaveLength(1);
    expect(card.querySelector(".lbl")?.textContent).toContain("Spend-equivalent");
    expect(card.querySelector(".v")?.textContent).toBe("$1,214");
    const max = await within(card).findByTestId("weekly-max");
    expect(max.textContent).toMatch(/Max spend this week ≈ \$160/);
    expect(max.querySelector(".wmax-v b")?.textContent).toBe("≈ $160");
    expect(max.textContent).toMatch(/25% used · resets \S+ /);
  });

  it("link scrolls to Spend by day on the spend tab, not to Workspaces", async () => {
    const card = await spendCard();
    const link = within(card).getByRole("link", { name: "Spend by day ↓" });
    const target = document.getElementById("spend-by-day") as HTMLElement;
    target.scrollIntoView = vi.fn();
    fireEvent.click(link);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(window.location.hash).not.toContain("workspaces");
  });

  it.each(["spend.equiv", "spend.weekly_max"] as const)("%s tooltip is short", (id) => {
    const { what, read, act } = METRIC_COPY[id];
    expect(`${what} ${read} ${act}`.length).toBeLessThanOrEqual(160);
  });

  it("Tokens tab: title, value in price-weighted tokens, token max, footnote", async () => {
    const card = await spendCard();
    fireEvent.click(within(card).getByRole("button", { name: "Tokens" }));
    expect(card.querySelector(".lbl")?.textContent).toContain("Token Spend");
    expect(card.querySelector(".lbl")?.textContent).not.toContain("Spend-equivalent");
    expect(card.querySelector(".v")?.textContent).toBe("607.0M");
    expect(within(card).getByTestId("weekly-max").textContent).toMatch(/≈ 80\.0M tokens/);
    expect(card.textContent).toContain("Daily · weighted by model price");
    expect(card.textContent).not.toContain("Sonnet-equivalent");
    // Still the spend.equiv card (verify-app and overview.test read it on the default tab).
    expect(card.getAttribute("data-metric")).toBe("spend.equiv");
  });

  it.each([
    ["low-confidence", /Low confidence/],
    ["stale", /Stale · as of \d/],
    ["too-early", /Too early in the week to estimate a max/],
  ] as const)("state %s", async (state, text) => {
    vi.mocked(client.fetchLimits).mockResolvedValue(mockLimitsWithWeeklyMax(state));
    const card = await spendCard();
    const max = await within(card).findByTestId("weekly-max");
    expect(max.textContent).toMatch(text);
    if (state === "too-early") expect(max.querySelector(".wmax-v")).toBeNull();
  });

  it("unavailable → no max line", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(mockLimitsWithWeeklyMax("unavailable"));
    const card = await spendCard();
    await waitFor(() => expect(client.fetchLimits).toHaveBeenCalled());
    expect(within(card).queryByTestId("weekly-max")).toBeNull();
  });

  it("weeklyMax absent (older daemon) → no max line, no crash", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
    const card = await spendCard();
    await waitFor(() => expect(client.fetchLimits).toHaveBeenCalled());
    expect(within(card).queryByTestId("weekly-max")).toBeNull();
    expect(card.querySelector(".v")?.textContent).toBe("$1,214");
  });

  it("per-model expander lists per-model rows; absent when perModel is empty", async () => {
    const card = await spendCard();
    const details = await within(card).findByTestId("weekly-max-per-model");
    expect(details.querySelector("summary")?.textContent).toContain("per-model max (2)");
    expect(details.textContent).toMatch(/Weekly · Fable.*≈ \$50 · 20%/);
    expect(details.textContent).toMatch(/Weekly · Opus.*Too early \(1%\)/);
    cleanup();

    const noModels = mockLimitsWithWeeklyMax("ok");
    if (noModels.weeklyMax) noModels.weeklyMax.perModel = [];
    vi.mocked(client.fetchLimits).mockResolvedValue(noModels);
    const card2 = await spendCard();
    await within(card2).findByTestId("weekly-max");
    expect(within(card2).queryByTestId("weekly-max-per-model")).toBeNull();
  });

  it("tabs are buttons with aria-pressed and keyboard focus", async () => {
    const card = await spendCard();
    const usd = within(card).getByRole("button", { name: "$" });
    const tokens = within(card).getByRole("button", { name: "Tokens" });
    expect(usd.getAttribute("aria-pressed")).toBe("true");
    expect(tokens.getAttribute("aria-pressed")).toBe("false");
    tokens.focus();
    expect(document.activeElement).toBe(tokens);
    fireEvent.click(tokens);
    expect(tokens.getAttribute("aria-pressed")).toBe("true");
    expect(usd.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("U3b day dividers + zero-filled days", () => {
  const MISSING = [5, 16, 20]; // days back from NOW with no turns
  /** A 30d trend: every local day NOW−30 … NOW except MISSING, $1·(i+1) each, one workspace. */
  function trend30(): ReturnType<typeof mockTrends> {
    const base = mockTrends({ preset: "30d" });
    const days = Array.from({ length: 31 }, (_, i) => daysBack(30 - i)).filter(
      (_, i) => !MISSING.includes(30 - i),
    );
    if (base.data) {
      base.data.buckets = days.map((bucket, i) => ({
        bucket,
        cost_equiv_u: (i + 1) * 1e6,
        turns: 1,
      })) as typeof base.data.buckets;
      base.data.by_workspace = days.map((bucket, i) => ({
        bucket,
        workspace_id: "ws-a",
        project_slug: "ws-a",
        cost_equiv_u: (i + 1) * 1e6,
        turns: 1,
      }));
      base.data.cap_weighted = days.map((bucket) => ({
        bucket,
        cap_weighted_tokens: 8_000,
        turns: 1,
      }));
      base.data.adoption_markers = [];
    }
    return base;
  }

  async function page(preset: "24h" | "7d" | "30d"): Promise<HTMLElement> {
    const { container } = render(<OverviewPage />);
    await waitFor(() => expect(container.querySelector("#spend-by-day svg")).not.toBeNull());
    if (preset !== "7d") {
      fireEvent.click(screen.getByRole("button", { name: preset }));
      await waitFor(() =>
        expect(container.querySelector("#this-period-title")?.textContent).toContain(preset),
      );
      await waitFor(() => expect(client.fetchTrends).toHaveBeenCalledWith({ preset }));
    }
    return container;
  }
  const sparkline = (c: HTMLElement) =>
    c.querySelector("[data-metric='spend.equiv'] svg") as SVGSVGElement;
  const dividers = (svg: Element) => svg.querySelectorAll("line[stroke-dasharray='2 3']");
  const barGroups = (c: HTMLElement) => c.querySelectorAll("#spend-by-day svg g[data-day]");

  it("7d sparkline: n−1 dotted dividers midway between points; none on 24h/30d", async () => {
    const c = await page("7d");
    const svg = sparkline(c);
    const n = (svg.querySelector("polyline[stroke='var(--cyan)']")?.getAttribute("points") ?? "")
      .trim()
      .split(" ").length;
    expect(n).toBe(8); // rolling 7d = 8 calendar days, one zero-filled
    const lines = dividers(svg);
    expect(lines).toHaveLength(n - 1);
    const first = lines[0] as Element;
    expect(first.getAttribute("stroke")).toBe("var(--muted)");
    expect(first.getAttribute("stroke-opacity")).toBe("0.35");
    expect(Number(first.getAttribute("x1"))).toBeCloseTo((0.5 * 200) / (n - 1), 1);
    cleanup();
    for (const p of ["24h", "30d"] as const) {
      const other = await page(p);
      await waitFor(() => expect(sparkline(other)).not.toBeNull());
      expect(dividers(sparkline(other))).toHaveLength(0);
      cleanup();
    }
  });

  it("30d with 3 missing days → 31 bar groups, the missing ones at height 0", async () => {
    vi.mocked(client.fetchTrends).mockImplementation(async (f) =>
      f.preset === "30d" ? trend30() : mockTrends(f),
    );
    const c = await page("30d");
    await waitFor(() => expect(barGroups(c)).toHaveLength(31));
    for (const g of barGroups(c)) {
      const day = g.getAttribute("data-day") ?? "";
      const height = [...g.querySelectorAll("rect")].reduce(
        (sum, r) => sum + Number(r.getAttribute("height")),
        0,
      );
      if (MISSING.map(daysBack).includes(day)) expect(height).toBe(0);
      else expect(height).toBeGreaterThan(0);
    }
  });

  it("Spend by day dividers: bars − 1 on 7d and 30d, none on 24h", async () => {
    for (const p of ["7d", "30d", "24h"] as const) {
      const c = await page(p);
      await waitFor(() => expect(barGroups(c).length).toBeGreaterThan(0));
      const bars = barGroups(c).length;
      const svg = c.querySelector("#spend-by-day svg") as Element;
      expect(dividers(svg)).toHaveLength(p === "24h" ? 0 : bars - 1);
      cleanup();
    }
  });
});
