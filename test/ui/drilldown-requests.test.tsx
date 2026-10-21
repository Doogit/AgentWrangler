/**
 * test/ui/drilldown-requests.test.tsx — P1-U6a test 4 (UI half): drilldowns paint and fetch
 * without waterfalls.
 *
 * Oracle: the clicked row's own values (rendered by the real list page) and the call record of
 * an auto-mocked client whose reads stay pending, so "before any detail response resolves" is
 * literal. The server half (window parity) is test/daemon/drilldown-window-parity.test.ts.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { seedWorkspaceHeader } from "../../src/ui/api/drilldown-seed";
import { mockHotSessionsPage, mockSession, mockTurnTimeline } from "../../src/ui/api/fixtures";
import HotSessionsPage from "../../src/ui/sessions/HotSessionsPage";
import SessionDetailPage from "../../src/ui/sessions/SessionDetailPage";
import WorkspaceDetailPage from "../../src/ui/workspaces/WorkspaceDetailPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/api/esf-client", () => ({
  fetchSessionEsfObservations: vi.fn(() => new Promise(() => {})),
  fetchEsfObservations: vi.fn(() => new Promise(() => {})),
}));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComposedChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: () => null,
    Scatter: () => null,
    ReferenceLine: () => null,
  };
});

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  // Every read stays pending unless a test resolves it.
  for (const fn of Object.values(client)) {
    if (vi.isMockFunction(fn)) fn.mockImplementation(never as never);
  }
  vi.stubGlobal("fetch", vi.fn(never));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("session drilldown (P1-U6a test 4)", () => {
  it("a Sessions row click seeds the header: it shows the row's values before any detail response", async () => {
    const page = mockHotSessionsPage({});
    const row = page.rows[0];
    if (row === undefined) throw new Error("fixture must have a row");
    vi.mocked(client.fetchHotSessionsPage).mockResolvedValue({ ...page, next_cursor: null });
    window.location.hash = "#/sessions";
    render(<HotSessionsPage onSelectSession={() => {}} />);
    const link = await screen.findByRole("link", { name: `Open session ${row.session_id}` });
    fireEvent.click(link);
    cleanup();

    render(<SessionDetailPage sessionId={row.session_id} onBack={() => {}} />);
    // No detail read has resolved (all pending), yet the header shows the row's values.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      row.session_id.slice(0, 8),
    );
    const usd = `$${(row.cost_equiv_u / 1_000_000).toFixed(2)}`;
    expect(screen.getByText(usd)).toBeTruthy();
    expect(screen.getByText(row.turns.toLocaleString())).toBeTruthy();
  });

  it("the session's four reads start in the same tick (none waits on another)", async () => {
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    // Every read is still pending, so none of these calls can have been chained after another.
    expect(client.fetchSession).toHaveBeenCalledTimes(1);
    expect(client.fetchTurnTimeline).toHaveBeenCalledTimes(1);
    expect(client.fetchSessionDrivers).toHaveBeenCalledTimes(1);
    expect(client.fetchSpendPercentile).toHaveBeenCalledTimes(1);
  });

  it("an anchor deep link makes one turns request with ?anchor=, not a cursor walk", async () => {
    const session = mockSession("session-demo");
    const timeline = mockTurnTimeline("session-demo");
    const anchor = timeline.data?.items.at(-1)?.message_id;
    if (anchor === undefined || timeline.data === null) throw new Error("fixture needs turns");
    vi.mocked(client.fetchSession).mockResolvedValue(session);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue({
      ...timeline,
      data: { ...timeline.data, next_cursor: "MjAw" },
    });
    const { container } = render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} anchorMessageId={anchor} />,
    );
    await screen.findByText("Turn timeline");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(client.fetchTurnTimeline).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.fetchTurnTimeline).mock.calls[0]?.[1]).toEqual({ anchor });
    expect(container.querySelector('[data-diagnostic-anchor="true"]')).not.toBeNull();
  });
});

describe("workspace drilldown (P1-U6a test 4)", () => {
  it("sessions, cost-per-success and delivery are requested before /api/workspaces resolves", async () => {
    window.location.hash = "#/workspaces/ws-1?window=7d";
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.fetchWorkspaces).toHaveBeenCalledTimes(1); // still pending
    expect(client.fetchWorkspaceSessions).toHaveBeenCalledWith("ws-1", { preset: "7d" });
    expect(client.fetchCostPerSuccess).toHaveBeenCalledWith({ preset: "7d" }, "ws-1");
    expect(client.fetchWorkspaceDelivery).toHaveBeenCalledWith("ws-1", { preset: "7d" });
  });

  it("the header is seeded from the clicked Workspaces row for the same window", async () => {
    window.location.hash = "#/workspaces/ws-1?window=7d";
    seedWorkspaceHeader("7d", {
      workspace_id: "ws-1",
      repo_owner: "octo",
      repo_name: "demo",
      repo_path: null,
      cost_equiv_u: 12_340_000,
      turns: 321,
      usd_per_turn: 0.038,
      avg_context_per_turn: 45_000,
      has_live: false,
    });
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    expect(screen.getByText("$12.34")).toBeTruthy();
    expect(screen.getByText("321 reconciled turns")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("octo/demo");
  });

  it("a seed for another window is not used", async () => {
    window.location.hash = "#/workspaces/ws-1?window=30d";
    seedWorkspaceHeader("7d", {
      workspace_id: "ws-1",
      repo_owner: "octo",
      repo_name: "demo",
      repo_path: null,
      cost_equiv_u: 12_340_000,
      turns: 321,
      usd_per_turn: 0.038,
      avg_context_per_turn: 45_000,
      has_live: false,
    });
    render(<WorkspaceDetailPage workspaceId="ws-1" onBack={() => {}} />);
    expect(screen.queryByText("$12.34")).toBeNull();
  });
});
