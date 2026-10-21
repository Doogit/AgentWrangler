/**
 * test/ui/overview-sections.test.tsx — P1-U4 Overview on `overview-view` + TanStack.
 *
 * Covers (perf plan P1-U4, tests first):
 *   1. A malformed `flavor` section (through the `safeSection` parse path) blanks only the
 *      token-breakdown card; KPIs, recommendations and workspaces keep their seed values.
 *   2. `top_recs: pending` renders a sized skeleton while the other cards show seed values, and
 *      the page refetches `?sections=top_recs` until it resolves.
 *   3. First paint is one overview-view page request plus its KPI-first `?sections=kpis,status`
 *      subset (+ limits): no legacy per-card reads.
 *   5. G-P1: the KPI strip renders from the KPI-first subset while the page request is pending.
 *   4. A section `error` renders that card's error state; a page-request failure shows the
 *      daemon banner.
 *
 * Oracle: values from the fixtures (`mockOverviewView`), not from component output.
 * Synthetic data only (SEC-101).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockLimits, mockOverviewView } from "../../src/ui/api/fixtures";
import { resetSectionLog } from "../../src/ui/api/parse";
import { queryClient } from "../../src/ui/api/query-client";
import OverviewPage from "../../src/ui/overview/OverviewPage";

vi.mock("../../src/ui/api/client");

const LEGACY_READS = [
  "fetchWorkspaces",
  "fetchTrends",
  "fetchHotSessions",
  "fetchRecommendations",
  "fetchLinkageRate",
  "fetchHookConfig",
  "fetchGithubTokenStatus",
] as const;

function firstWorkspaceSlug(): string {
  const data = mockOverviewView().sections.workspaces?.data as
    | { items: { project_slug: string }[] }
    | undefined;
  const slug = data?.items[0]?.project_slug;
  if (slug === undefined) throw new Error("expected a fixture workspace");
  return slug;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  resetSectionLog();
  vi.mocked(client.fetchLimits).mockResolvedValue(mockLimits());
  vi.mocked(client.fetchOverviewView).mockResolvedValue(mockOverviewView("7d"));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("Overview on overview-view (P1-U4)", () => {
  it("1. a malformed flavor section blanks only the token-breakdown card", async () => {
    const view = mockOverviewView("7d");
    const flavor = view.sections.flavor?.data as Record<string, unknown>;
    view.sections.flavor = { status: "ok", ms: 1, data: { ...flavor, flavors: "not-an-array" } };
    vi.mocked(client.fetchOverviewView).mockResolvedValue(view);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<OverviewPage />);

    expect(await screen.findByText("Could not load the token breakdown.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry token breakdown" })).toBeTruthy();
    expect(screen.queryByText("Could not load this page.")).toBeNull();
    expect(screen.getByRole("heading", { name: "This period (7d)" })).toBeTruthy();
    expect(screen.getByTestId("overview-decision")).toBeTruthy();
    expect(screen.getAllByText(new RegExp(firstWorkspaceSlug())).length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[aw:section\] flavor: /));
    warn.mockRestore();
  });

  it("2. top_recs pending shows a skeleton, the other cards render, and top_recs is refetched", async () => {
    const pending = mockOverviewView("7d");
    const resolved = mockOverviewView("7d");
    const topRecs = resolved.sections.top_recs;
    if (topRecs === undefined) throw new Error("expected a top_recs fixture");
    pending.sections.top_recs = { status: "pending", ms: 0 };
    // The top_recs poll is held until the skeleton has been checked (no race with the poll).
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(client.fetchOverviewView).mockImplementation(async (_preset, _signal, sections) => {
      if (sections === undefined) return pending;
      if (sections.includes("top_recs")) await held;
      return { ...resolved, sections: { top_recs: topRecs } };
    });

    render(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "This period (7d)" })).toBeTruthy();
    expect(screen.getByLabelText("Loading recommendations")).toBeTruthy();
    expect(screen.getAllByText(new RegExp(firstWorkspaceSlug())).length).toBeGreaterThan(0);
    release();

    // The tail refetch asks for top_recs only, then the cards render.
    expect(await screen.findByTestId("overview-decision", {}, { timeout: 4_000 })).toBeTruthy();
    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledWith("7d", expect.anything(), [
      "top_recs",
    ]);
    expect(screen.queryByLabelText("Loading recommendations")).toBeNull();
  });

  it("2b. OV-13: a running build shows what it is building and for how long", async () => {
    const pending = mockOverviewView("7d");
    const building = {
      status: "pending" as const,
      ms: 0,
      progress: { started_at: new Date(Date.now() - 5_000).toISOString(), expected_ms: 20_000 },
    };
    pending.sections.top_recs = building;
    vi.mocked(client.fetchOverviewView).mockImplementation(async (_preset, _signal, sections) =>
      sections === undefined ? pending : { ...pending, sections: { top_recs: building } },
    );

    render(<OverviewPage />);

    const line = (await screen.findByText("Building recommendations")).closest("output");
    expect(line?.textContent).toMatch(/^Building recommendations\d+ s · usually ~20 s$/);
    expect(screen.getByLabelText("Loading recommendations")).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it("2c. OV-13: a rebuild behind the served snapshot shows 'Updating', polled until ready", async () => {
    const recomputing = mockOverviewView("7d");
    const topRecs = recomputing.sections.top_recs;
    if (topRecs === undefined) throw new Error("expected a top_recs fixture");
    const asOf = new Date(Date.now() - 3 * 60_000).toISOString();
    recomputing.sections.top_recs = {
      ...topRecs,
      freshness: { status: "recomputing", computed_at: asOf, inputs_as_of: asOf },
    };
    const ready = {
      ...recomputing,
      sections: {
        top_recs: {
          ...topRecs,
          freshness: { status: "ready" as const, computed_at: asOf, inputs_as_of: asOf },
        },
      },
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(client.fetchOverviewView).mockImplementation(async (_preset, _signal, sections) => {
      if (sections === undefined) return recomputing;
      if (sections.includes("top_recs")) await held;
      return ready;
    });

    render(<OverviewPage />);

    expect(await screen.findByText("Updating · as of 3m ago")).toBeTruthy();
    expect(screen.getByTestId("top-rec-1")).toBeTruthy(); // rows stay while it updates
    release();
    await waitFor(() => expect(screen.queryByText(/Updating · as of/)).toBeNull(), {
      timeout: 4_000,
    });
    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledWith("7d", expect.anything(), [
      "top_recs",
    ]);
  });

  it("3. first paint is the overview-view page request + its KPI-first subset, plus limits, with no legacy per-card reads", async () => {
    render(<OverviewPage />);

    expect(await screen.findByTestId("overview-decision")).toBeTruthy();
    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledWith("7d", expect.anything());
    expect(vi.mocked(client.fetchOverviewView)).toHaveBeenCalledWith("7d", expect.anything(), [
      "kpis",
      "status",
    ]);
    for (const name of LEGACY_READS) {
      expect(vi.mocked(client[name]), name).not.toHaveBeenCalled();
    }
    // P2-U5: /api/status is the shared status poller's one first poll (LiveStrip mounts it),
    // not a per-card read, and the `live,status` subset is seeded from the page, not fetched.
    expect(vi.mocked(client.fetchStatus)).toHaveBeenCalledTimes(1);
  });

  it("5. G-P1 KPI-first: the KPI strip renders from ?sections=kpis,status while the page request is still pending", async () => {
    const view = mockOverviewView("7d");
    const kpiSection = view.sections.kpis;
    const statusSection = view.sections.status;
    if (kpiSection === undefined || statusSection === undefined)
      throw new Error("expected fixtures");
    const kpis = kpiSection.data as {
      cost_equiv_u: number;
      subagent_spend?: { sessions_in_window: number };
    };
    const sessionsText = kpis.subagent_spend?.sessions_in_window.toLocaleString() ?? "—";
    const fmtUsd0 = (usd: number) => {
      const digits = usd >= 1000 ? 0 : 2;
      return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    };
    let releasePage: (v: typeof view) => void = () => {};
    const page = new Promise<typeof view>((resolve) => {
      releasePage = resolve;
    });
    vi.mocked(client.fetchOverviewView).mockImplementation(async (_preset, _signal, sections) =>
      sections === undefined
        ? page
        : { ...view, sections: { kpis: kpiSection, status: statusSection } },
    );

    const { container } = render(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "This period (7d)" })).toBeTruthy();
    const kpi = (id: string) =>
      container.querySelector(`[data-metric="${id}"] .v`)?.textContent ?? null;
    expect(kpi("spend.equiv")).toBe(fmtUsd0(kpis.cost_equiv_u / 1_000_000));
    expect(kpi("sessions.count")).toBe(sessionsText);
    // Only the strip is early: no other card renders (and none as an error) until the page lands.
    expect(screen.queryByLabelText("Loading overview metrics")).toBeNull();
    expect(screen.queryByTestId("overview-decision")).toBeNull();
    expect(screen.queryByText(/^Could not load/)).toBeNull();
    expect(screen.queryByText("Prior window unavailable")).toBeNull();

    releasePage(view);
    expect(await screen.findByTestId("overview-decision")).toBeTruthy();
    expect(kpi("spend.equiv")).toBe(fmtUsd0(kpis.cost_equiv_u / 1_000_000));
  });

  it("4a. a section error renders that card's error state; the rest render", async () => {
    const view = mockOverviewView("7d");
    view.sections.weekly_sessions = { status: "error", ms: 1 };
    vi.mocked(client.fetchOverviewView).mockResolvedValue(view);

    render(<OverviewPage />);

    expect(await screen.findByText("Could not load this week's expensive sessions.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This period (7d)" })).toBeTruthy();
    expect(screen.getByTestId("overview-decision")).toBeTruthy();
  });

  it("4b. a failed page request shows the daemon banner, and Retry refetches", async () => {
    vi.mocked(client.fetchOverviewView).mockRejectedValue(new Error("connection refused"));

    render(<OverviewPage />);

    const retry = await screen.findByRole("button", { name: "Retry" }, { timeout: 4_000 });
    expect(screen.getByRole("alert").textContent).toContain("Daemon unreachable");
    const before = vi.mocked(client.fetchOverviewView).mock.calls.length;
    vi.mocked(client.fetchOverviewView).mockResolvedValue(mockOverviewView("7d"));
    retry.click();
    await waitFor(() =>
      expect(vi.mocked(client.fetchOverviewView).mock.calls.length).toBeGreaterThan(before),
    );
    expect(await screen.findByRole("heading", { name: "This period (7d)" })).toBeTruthy();
  });
});
