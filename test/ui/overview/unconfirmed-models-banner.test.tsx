import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockLimits, mockOverviewView } from "../../../src/ui/api/fixtures";
import { queryClient } from "../../../src/ui/api/query-client";
import OverviewPage from "../../../src/ui/overview/OverviewPage";

vi.mock("../../../src/ui/api/client");
afterEach(() => {
  cleanup();
  queryClient.clear();
});

// The Overview reads the KPI data from overview-view's `kpis` section (perf plan P1-U4).
function setup(unconfirmed?: { model: string; tier: string | null; first_seen: string }[]) {
  vi.clearAllMocks();
  queryClient.clear();
  const view = mockOverviewView("7d");
  const kpis = view.sections.kpis?.data as Record<string, unknown> | undefined;
  if (kpis && unconfirmed) kpis.unconfirmed_models = unconfirmed;
  vi.mocked(client.fetchOverviewView).mockResolvedValue(view);
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
}

beforeEach(() => {
  setup();
});

it("shows one info note naming each unconfirmed model and its tier", async () => {
  setup([
    { model: "claude-opus-9", tier: "opus", first_seen: "2026-10-01T00:00:00.000Z" },
    { model: "claude-zeta-1", tier: null, first_seen: "2026-10-01T00:00:00.000Z" },
  ]);
  render(<OverviewPage />);
  const banner = await screen.findByTestId("unconfirmed-models-banner");
  expect(banner.getAttribute("role")).toBe("note");
  expect(banner.className).toContain("banner-info");
  expect(banner.textContent).toContain(
    "New model claude-opus-9 priced as opus: prices not confirmed.",
  );
  expect(banner.textContent).toContain(
    "New model claude-zeta-1 is not priced: prices not confirmed.",
  );
  expect(screen.getAllByTestId("unconfirmed-models-banner")).toHaveLength(1);
});

it("renders no banner when the field is absent or empty", async () => {
  const { container } = render(<OverviewPage />);
  await waitFor(() =>
    expect(container.querySelector("[data-metric='subagent.spend']")).not.toBeNull(),
  );
  expect(screen.queryByTestId("unconfirmed-models-banner")).toBeNull();
  cleanup();
  setup([]);
  const second = render(<OverviewPage />);
  await waitFor(() =>
    expect(second.container.querySelector("[data-metric='subagent.spend']")).not.toBeNull(),
  );
  expect(screen.queryByTestId("unconfirmed-models-banner")).toBeNull();
});
