import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionRow, SessionSummary } from "../../src/query/api/overview";
import * as client from "../../src/ui/api/client";
import { mockSession, mockTurnTimeline } from "../../src/ui/api/fixtures";
import type { WorkspaceLabelInput } from "../../src/ui/lib/workspace-label";
import LiveStrip from "../../src/ui/overview/LiveStrip";
import SessionDetailPage from "../../src/ui/sessions/SessionDetailPage";

vi.mock("../../src/ui/api/client");
// Stub the chart subtree used by ContextGrowthChart. Real recharts emits no
// SVG geometry under jsdom (no layout), so assert the props the component
// passes to each primitive instead of unrenderable `.recharts-*` DOM.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComposedChart: ({ children }: { children?: ReactNode }) => (
      <div data-testid="rc-composed">{children}</div>
    ),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: ({ dataKey, stroke }: { dataKey?: string; stroke?: string }) => (
      <div data-testid="rc-line" data-datakey={String(dataKey)} data-stroke={stroke} />
    ),
    Scatter: ({ data, fill }: { data?: unknown[]; fill?: string }) => (
      <div data-testid="rc-scatter" data-fill={fill} data-count={data?.length ?? 0} />
    ),
    ReferenceLine: ({ y }: { y?: number }) => <div data-testid="rc-refline" data-y={y} />,
  };
});
afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("SessionDetailPage", () => {
  it("renders a header and appends the exact next oldest-first page", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline)
      .mockResolvedValueOnce(mockTurnTimeline("session-demo"))
      .mockResolvedValueOnce(mockTurnTimeline("session-demo", "mock-page-2"));
    const { container } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByText("Session detail");
    expect(screen.getByRole("columnheader", { name: "Thinking" })).toBeTruthy();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getAllByText("LIVE")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenNthCalledWith(1, "session-demo");
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenNthCalledWith(2, "session-demo", {
      after: "mock-page-2",
    });
    expect(Array.from(container.querySelectorAll("tbody tr"), (row) => row.textContent)).toEqual([
      expect.stringContaining("400"),
      expect.stringContaining("420"),
    ]);
    expect(screen.getAllByText("400")).toHaveLength(1);
    expect(screen.getAllByText("420")).toHaveLength(1);
    const secondRow = container.querySelectorAll("tbody tr")[1];
    // Thinking column shifted from td[4] to td[5]: the new "Chain" column (SES-2) is inserted after Model.
    expect(secondRow?.querySelectorAll("td")[5]?.textContent).toBe("N/A");
  });

  it("uses mapped and global workspace labels in the session header", async () => {
    const mapped = mockSession("session-mapped");
    if (mapped.data === null) throw new Error("session fixture must contain data");
    mapped.data = {
      ...mapped.data,
      workspace_id: "mapped-id",
      repo_path: "C:/work/console",
      repo_owner: "acme",
      repo_name: "console",
    } as SessionSummary & WorkspaceLabelInput;
    vi.mocked(client.fetchSession).mockResolvedValue(mapped);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-mapped"));
    const { rerender } = render(<SessionDetailPage sessionId="session-mapped" onBack={() => {}} />);
    expect(await screen.findByText(/acme\/console ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy session session-mapped" })).toBeTruthy();

    const global = mockSession("session-global");
    if (global.data === null) throw new Error("session fixture must contain data");
    global.data = {
      ...global.data,
      workspace_id: "__global__",
      repo_path: null,
      repo_owner: null,
      repo_name: null,
    } as SessionSummary & WorkspaceLabelInput;
    vi.mocked(client.fetchSession).mockResolvedValue(global);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-global"));
    rerender(<SessionDetailPage sessionId="session-global" onBack={() => {}} />);
    expect(await screen.findByText(/Global ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy session session-global" })).toBeTruthy();
  });

  it("renders context growth with a line and amber cache-write dot", async () => {
    const timeline = mockTurnTimeline("session-demo");
    if (timeline.data === null || timeline.data.items[0] === undefined) {
      throw new Error("timeline fixture must contain a first row");
    }
    timeline.data = {
      ...timeline.data,
      items: [{ ...timeline.data.items[0], cache_write_5m: 41_000 }],
    };
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(timeline);

    const { container } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await screen.findByText("Context per turn");
    expect(container.querySelector("[data-testid='context-growth-chart']")).not.toBeNull();
    // Context line plots context_tokens in the shared series palette (series-1 = cyan).
    const line = screen.getByTestId("rc-line");
    expect(line.getAttribute("data-datakey")).toBe("context_tokens");
    expect(line.getAttribute("data-stroke")).toBe("var(--series-1)");
    // The single cache-write turn (cache_write_5m: 41_000) becomes one amber scatter point.
    const scatter = screen.getByTestId("rc-scatter");
    expect(scatter.getAttribute("data-fill")).toBe("var(--amber)");
    expect(scatter.getAttribute("data-count")).toBe("1");
    // 160K warning reference line.
    expect(screen.getByTestId("rc-refline").getAttribute("data-y")).toBe("160000");
    expect(
      screen.getByText(
        "Context per turn · amber dots = cache write event (potential miss) · red line = 80% of 200K window",
      ),
    ).toBeTruthy();
  });

  it("shows a detail failure without requesting the timeline", async () => {
    vi.mocked(client.fetchSession).mockRejectedValueOnce(new Error("detail unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load session: Error: detail unavailable",
    );
    expect(client.fetchTurnTimeline).not.toHaveBeenCalled();
  });

  it("keeps a timeline failure distinct after detail succeeds", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockRejectedValueOnce(new Error("timeline unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect(await screen.findByText("Session detail")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load turns: Error: timeline unavailable",
    );
  });

  it("renders an explicit empty timeline after detail succeeds", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    const empty = mockTurnTimeline("session-demo");
    if (empty.data === null) throw new Error("timeline fixture must contain data");
    empty.data = { items: [], next_cursor: null };
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(empty);
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect(await screen.findByText("No turns have been recorded for this session.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the loaded timeline visible and offers a retry when load more fails", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline)
      .mockResolvedValueOnce(mockTurnTimeline("session-demo"))
      .mockRejectedValueOnce(new Error("next page unavailable"));
    const { container } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await screen.findByText("Session detail");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("next page unavailable");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("keeps not-found separate from loading and errors", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue({ ...mockSession("missing"), data: null });
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("missing"));
    render(<SessionDetailPage sessionId="missing" onBack={() => {}} />);
    expect(await screen.findByText("Session not found.")).toBeTruthy();
  });

  it("renders the self-percentile chip with n and window in its tooltip (BM3)", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    vi.mocked(client.fetchSpendPercentile).mockResolvedValue({
      percentile: 0.92,
      n: 40,
      window_days: 90,
    });
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    const chip = await screen.findByText("top 8% by spend"); // (1 - 0.92) → 8%
    expect(chip.getAttribute("title")).toContain("40 sessions");
    expect(chip.getAttribute("title")).toContain("90 days");
  });

  it("omits the self-percentile chip when the percentile is withheld (n<20)", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    vi.mocked(client.fetchSpendPercentile).mockResolvedValue({
      percentile: null,
      n: 5,
      window_days: 90,
    });
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByText("Session detail");
    expect(screen.queryByText(/by spend/)).toBeNull();
  });
});

describe("LiveStrip activation", () => {
  it("opens a live row through its accessible button", () => {
    const onSelectSession = vi.fn();
    const session = {
      session_id: "sess-live",
      workspace_id: "C--Users-dev-repo",
      project_slug: "raw-workspace-slug",
      repo_path: null,
      repo_owner: "acme",
      repo_name: "console",
      running_usd_u: 1,
      current_context_tokens: 1,
      model: "claude-sonnet-5",
      started_at: null,
    } as LiveSessionRow;
    render(
      <LiveStrip
        sessions={[session]}
        isLoading={false}
        error={null}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "acme/console" }));
    expect(onSelectSession).toHaveBeenCalledWith("sess-live");
  });
});
