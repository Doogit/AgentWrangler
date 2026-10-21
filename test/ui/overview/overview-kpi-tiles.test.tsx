import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockCacheWriteTrend,
  mockFlavorDecomposition,
  mockGlobalOverview,
  mockHookConfigResponse,
  mockHotSessions,
  mockJudgeSetup,
  mockLimits,
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
beforeEach(serveOverviewViewFromLegacyMocks);
const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  vi.clearAllMocks();
  const filter = { preset: "7d" as const };
  const overview = mockGlobalOverview(filter);
  if (overview.data)
    overview.data.subagent_spend = {
      total_cost_u: 20_000_000,
      sidechain_cost_u: 5_000_000,
      share: 0.25,
      sessions_with_sidechain_spend: 2,
      sessions_in_window: 3,
      haiku_sidechain_turns: 1,
      by_model_family: [
        { family: "Sonnet", cost_u: 3_000_000 },
        { family: "Opus", cost_u: 2_000_000 },
      ],
    };
  const flavor = mockFlavorDecomposition(filter);
  for (const row of flavor.data?.flavors ?? []) {
    if (row.flavor === "cache_write_5m") row.weighted_share = 0.14;
    if (row.flavor === "cache_write_1h") row.weighted_share = 0.08;
    if (row.flavor === "cache_write_other") row.weighted_share = 0.01;
  }
  fetchGlobalOverview.mockResolvedValue(overview);
  fetchFlavorDecomposition.mockResolvedValue(flavor);
  vi.mocked(client.fetchWorkspaces).mockResolvedValue(mockWorkspaces(filter));
  fetchLiveSessions.mockResolvedValue(mockLiveSessions());
  vi.mocked(client.fetchTrends).mockResolvedValue(mockTrends(filter));
  fetchCacheWriteTrend.mockResolvedValue(mockCacheWriteTrend(filter));
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchHotSessions).mockResolvedValue(mockHotSessions());
  vi.mocked(client.fetchLinkageRate).mockResolvedValue(mockLinkageRate());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  vi.mocked(client.fetchJudgeSetup).mockResolvedValue(mockJudgeSetup());
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

it("renders payload values and switches the spend chart to cache writes", async () => {
  const { container } = render(<OverviewPage />);
  await waitFor(() =>
    expect(container.querySelector("[data-metric='subagent.spend']")).not.toBeNull(),
  );
  expect(container.querySelector("[data-metric='subagent.spend']")?.textContent).toContain("25.0%");
  expect(container.querySelector("[data-metric='subagent.spend']")?.textContent).toContain(
    "$5.00 of $20.00 · in 2 of 3 sessions",
  );
  expect(
    screen.getByRole("link", { name: "Sessions by subagent cost →" }).getAttribute("href"),
  ).toBe("#/sessions?sort=subagent&direction=desc");
  expect(container.querySelector("[data-metric='cache.rebuilds']")).toBeNull();
  await waitFor(() =>
    expect(container.querySelector("[data-metric='setup.grade'] .v")?.textContent).toBe("66/100"),
  );
  expect(screen.getByRole("link", { name: "Rate my setup →" }).getAttribute("href")).toBe(
    "#/judge-setup",
  );
  fireEvent.click(await screen.findByRole("button", { name: "Cache writes" }));
  expect(screen.getByRole("button", { name: "Cache writes" }).className).toContain("on");
  expect(document.getElementById("spend-by-day")?.textContent).not.toContain("Fix worth");
});

/** The D8 chip shows on the spend-by-day card's Cache writes tab only. */
async function d8ChipText(container: HTMLElement): Promise<string> {
  fireEvent.click(await screen.findByRole("button", { name: "Cache writes" }));
  return container.querySelector("#spend-by-day")?.textContent ?? "";
}

it("shows the D8 chip only on the Cache writes tab", async () => {
  const response = mockRecommendations();
  const rec = response.data?.active[0];
  if (!rec) throw new Error("missing fixture recommendation");
  rec.detector_id = "D8";
  rec.allocated_u_per_wk = 2_000_000;
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<OverviewPage />);
  await screen.findByRole("button", { name: "Spend $" });
  await waitFor(() => expect(container.querySelector("#spend-by-day")).not.toBeNull());
  expect(container.querySelector("#spend-by-day")?.textContent).not.toContain("Fix worth");
  await waitFor(async () =>
    expect(await d8ChipText(container)).toContain("Fix worth up to $2.00/wk"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Spend $" }));
  expect(container.querySelector("#spend-by-day")?.textContent).not.toContain("Fix worth");
});

it("L6: the D8 chip uses the D8 with the largest net headline, not the first at $0", async () => {
  const response = mockRecommendations();
  const first = response.data?.active[0];
  if (!first || !response.data) throw new Error("missing fixture recommendation");
  first.detector_id = "D8";
  first.allocated_u_per_wk = 0;
  first.modeled_savings_u_per_wk = 9_000_000;
  const second = { ...structuredClone(first), rec_id: "d8-second", allocated_u_per_wk: 3_000_000 };
  response.data.active.splice(1, 0, second);
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<OverviewPage />);
  await waitFor(async () =>
    expect(await d8ChipText(container)).toContain("Fix worth up to $3.00/wk"),
  );
});

it("shows a savings chip only for an active D8 recommendation with savings", async () => {
  const response = mockRecommendations();
  const rec = response.data?.active[0];
  if (!rec) throw new Error("missing fixture recommendation");
  rec.detector_id = "D8";
  rec.modeled_savings_u_per_wk = null;
  rec.range_u_per_wk = [1_000_000, 4_000_000];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<OverviewPage />);
  await waitFor(async () =>
    expect(await d8ChipText(container)).toContain("Fix worth up to $4.00/wk"),
  );
});
