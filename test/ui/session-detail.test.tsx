import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionRow, SessionSummary } from "../../src/query/api/overview";
import * as client from "../../src/ui/api/client";
import { fetchSessionEsfObservations } from "../../src/ui/api/esf-client";
import {
  mockRecommendations,
  mockSession,
  mockSessionBreakdown,
  mockSessionDiagnostics,
  mockSessionDrivers,
  mockSessionStory,
  mockTurnTimeline,
} from "../../src/ui/api/fixtures";
import type { WorkspaceLabelInput } from "../../src/ui/lib/workspace-label";
import LiveStrip from "../../src/ui/overview/LiveStrip";
import SessionDetailPage, { ContextGrowthChart } from "../../src/ui/sessions/SessionDetailPage";

vi.mock("../../src/ui/api/client");
// Timeline tests have no observation fixture; observation behavior is covered separately.
vi.mock("../../src/ui/api/esf-client", () => ({
  fetchSessionEsfObservations: vi.fn().mockResolvedValue({ data: null }),
}));
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
    Scatter: ({
      data,
      fill,
      name,
      shape,
    }: {
      data?: unknown[];
      fill?: string;
      name?: string;
      shape?: (props: { cx: number; cy: number; payload: unknown }) => ReactNode;
    }) => (
      <div
        data-testid="rc-scatter"
        data-fill={fill}
        data-name={name}
        data-count={data?.length ?? 0}
      >
        {shape &&
          data?.map((point) => (
            <svg
              key={(point as { message_id: string }).message_id}
              role="img"
              aria-label="Synthetic chart marker"
            >
              <title>Synthetic chart marker</title>
              {shape({ cx: 10, cy: 10, payload: point })}
            </svg>
          ))}
      </div>
    ),
    ReferenceLine: ({
      y,
      x,
      strokeDasharray,
    }: { y?: number; x?: number; strokeDasharray?: string }) => (
      <div data-testid="rc-refline" data-y={y} data-x={x} data-dash={strokeDasharray} />
    ),
  };
});
afterEach(() => cleanup());

/** The raw turn table sits behind "Show all N turns" unless a turn is deep-linked. */
async function openTurns(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /^Show all .* turns$/ }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSessionDiagnostics).mockResolvedValue(
    mockSessionDiagnostics("session-demo"),
  );
  const breakdown = mockSessionBreakdown("session-demo");
  if (breakdown.data !== null) {
    breakdown.data.tool_error_turn_indices = [];
    breakdown.data.loop_turn_indices = [];
  }
  vi.mocked(client.fetchSessionBreakdown).mockResolvedValue(breakdown);
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
});

describe("SessionDetailPage", () => {
  it("filters recommendations to driver detectors and retries a failed diagnostics fetch", async () => {
    const id = "synthetic-session";
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession(id));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline(id));
    const drivers = mockSessionDrivers(id);
    if (drivers.data === null || drivers.data.drivers[0] === undefined)
      throw new Error("fixture requires a driver");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(drivers);
    const recommendations = mockRecommendations();
    if (recommendations.data?.active[0] === undefined)
      throw new Error("fixture requires a recommendation");
    recommendations.data.active = [
      { ...recommendations.data.active[0], detector_id: "D8", rec_id: "synthetic-rec" },
      ...recommendations.data.active.slice(1),
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(recommendations);
    vi.mocked(client.fetchSessionDiagnostics)
      .mockRejectedValueOnce(new Error("synthetic failure"))
      .mockResolvedValue(mockSessionDiagnostics(id));
    render(<SessionDetailPage sessionId={id} onBack={() => {}} />);
    fireEvent.click(await screen.findByText("Anomalies", { selector: "summary" }));
    await screen.findByText("Couldn't load anomalies");
    await waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: "Recommendations for this pattern" })
          .querySelectorAll('a[href*="?focus="]').length,
      ).toBe(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Turn 2" })).toBeTruthy();
    expect(vi.mocked(client.fetchSessionDiagnostics)).toHaveBeenCalledTimes(2);
  });

  it("ignores a diagnostics retry completed after the session changes", async () => {
    const oldId = "old-session";
    const newId = "new-session";
    let resolveRetry!: (value: ReturnType<typeof mockSessionDiagnostics>) => void;
    const retryPromise = new Promise<ReturnType<typeof mockSessionDiagnostics>>((resolve) => {
      resolveRetry = resolve;
    });
    vi.mocked(client.fetchSession).mockImplementation(async (id) => mockSession(id));
    vi.mocked(client.fetchTurnTimeline).mockImplementation(async (id) => mockTurnTimeline(id));
    vi.mocked(client.fetchSessionDiagnostics)
      .mockRejectedValueOnce(new Error("synthetic failure"))
      .mockImplementationOnce(() => retryPromise)
      .mockResolvedValueOnce({ ...mockSessionDiagnostics(newId), data: [] });

    const { rerender } = render(<SessionDetailPage sessionId={oldId} onBack={() => {}} />);
    await screen.findByText("Couldn't load anomalies");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    rerender(<SessionDetailPage sessionId={newId} onBack={() => {}} />);
    await screen.findByText("No anomalies detected");
    await act(async () => resolveRetry(mockSessionDiagnostics(oldId)));
    expect(screen.getByText("No anomalies detected")).toBeTruthy();
  });
  it("plots only loaded diagnostic markers at one-based chart positions", async () => {
    const first = mockTurnTimeline("synthetic-session").data?.items[0];
    if (first === undefined) throw new Error("fixture requires a turn");
    render(
      <ContextGrowthChart
        turns={[first, { ...first, message_id: "synthetic-turn-two" }]}
        compactionTurnIndices={[0, 1, 4]}
        toolErrorTurnIndices={[1, 3]}
        loopTurnIndices={[0, 7]}
      />,
    );
    // The chart mounts after paint, its series one task later.
    await screen.findAllByTestId("rc-line");
    const compactions = screen
      .getAllByTestId("rc-refline")
      .filter((line) => line.getAttribute("data-x") !== null);
    expect(compactions.map((line) => line.getAttribute("data-x"))).toEqual(["1", "2"]);
    expect(compactions.every((line) => line.getAttribute("data-dash") === "4 4")).toBe(true);
    expect(
      screen
        .getByTestId("rc-composed")
        .querySelector('[data-name="Tool error"]')
        ?.getAttribute("data-count"),
    ).toBe("1");
    expect(
      screen
        .getByTestId("rc-composed")
        .querySelector('[data-name="Loop"]')
        ?.getAttribute("data-count"),
    ).toBe("1");
    expect(
      screen
        .getByTestId("rc-composed")
        .querySelector('[data-kind="tool-error"]')
        ?.getAttribute("data-turn"),
    ).toBe("2");
    expect(
      screen
        .getByTestId("rc-composed")
        .querySelector('[data-kind="loop"]')
        ?.getAttribute("data-turn"),
    ).toBe("1");
  });

  it("separates main and subagent context and names only visible marker types", async () => {
    const first = mockTurnTimeline("synthetic-session").data?.items[0];
    if (first === undefined) throw new Error("fixture requires a turn");
    const { container } = render(
      <ContextGrowthChart
        turns={[first, { ...first, message_id: "subagent-turn", is_sidechain: true }]}
        toolErrorTurnIndices={[1]}
      />,
    );
    expect(
      (await screen.findAllByTestId("rc-line")).map((line) => line.getAttribute("data-datakey")),
    ).toEqual(["main_context_tokens", "subagent_context_tokens"]);
    const caption = container.querySelector(".kpi-fn")?.textContent ?? "";
    expect(caption).toContain("solid: main");
    expect(caption).toContain("dashed violet: subagent");
    expect(caption).toContain("red: tool error");
    expect(caption).not.toContain("compaction");
    expect(caption).not.toContain("loop");
  });
  it("labels workspace-pattern turns and omits weekly driver estimates", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    const drivers = mockSessionDrivers("session-demo");
    if (drivers.data === null) throw new Error("driver fixture must contain data");
    const measuredDriver = drivers.data.drivers[1];
    if (measuredDriver === undefined) throw new Error("driver fixture requires a second driver");
    measuredDriver.measured = { total_turn_count: 210 };
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(drivers);
    render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} backLabel="Back to sessions" />,
    );

    const row = (await screen.findByText(/Turns in workspace pattern/)).closest(
      "[data-testid='cost-driver-row']",
    );
    expect(row?.textContent).toContain("Turns in workspace pattern");
    expect(row?.textContent).toContain("210");
    expect(row?.textContent).not.toContain("/wk");
    fireEvent.click(screen.getByRole("button", { name: "What Turns in workspace pattern counts" }));
    expect(
      screen.getByText(
        "Counts turns across every session in this workspace pattern, not this session's total.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to sessions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "About Estimated cost" }));
    expect(screen.getByText(/Estimated cost at public API list prices/)).toBeTruthy();
  });

  it("uses the supplied back label when a session is missing", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue({ ...mockSession("missing"), data: null });
    render(
      <SessionDetailPage sessionId="missing" onBack={() => {}} backLabel="Back to diagnostics" />,
    );
    expect(await screen.findByRole("button", { name: "Back to diagnostics" })).toBeTruthy();
  });
  it("pages to a diagnostic target beyond the initial timeline page", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    const first = mockTurnTimeline("session-demo");
    const base = first.data?.items[0];
    if (!base) throw new Error("fixture requires a first turn");
    first.data = {
      items: Array.from({ length: 50 }, (_, index) => ({ ...base, message_id: `turn-${index}` })),
      next_cursor: "next",
    };
    const second = mockTurnTimeline("session-demo");
    second.data = { items: [{ ...base, message_id: "target-51" }], next_cursor: null };
    vi.mocked(client.fetchTurnTimeline).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { container } = render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} anchorMessageId="target-51" />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-diagnostic-anchor="true"]')).toBeTruthy(),
    );
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenLastCalledWith("session-demo", {
      after: "next",
    });
  });

  it("honors zero-based diagnostic turn index zero", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    const { container } = render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} anchorTurnIndex={0} />,
    );
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-diagnostic-anchor="true"]')
          ?.getAttribute("data-diagnostic-anchor"),
      ).toBe("true"),
    );
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenCalledTimes(1);
  });

  it("stops paging at exhaustion when a diagnostic anchor is absent", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline)
      .mockResolvedValueOnce(mockTurnTimeline("session-demo"))
      .mockResolvedValueOnce(mockTurnTimeline("session-demo", "mock-page-2"));
    render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} anchorMessageId="missing" />,
    );
    await waitFor(() => expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenCalledTimes(2));
  });

  it("targets a diagnostic message anchor in the turn timeline", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    const { container } = render(
      <SessionDetailPage sessionId="session-demo" onBack={() => {}} anchorMessageId="turn-1" />,
    );
    await screen.findByRole("heading", { level: 1 });
    expect(container.querySelector('[data-diagnostic-anchor="true"]')).toBeTruthy();
  });

  it("renders a header and appends the exact next oldest-first page", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline)
      .mockResolvedValueOnce(mockTurnTimeline("session-demo"))
      .mockResolvedValueOnce(mockTurnTimeline("session-demo", "mock-page-2"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByRole("heading", { level: 1 });
    await openTurns();
    expect(screen.getByRole("columnheader", { name: "Thinking" })).toBeTruthy();
    const timeline = screen.getByTestId("turn-timeline");
    expect(timeline?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getAllByText("LIVE")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(timeline?.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenNthCalledWith(1, "session-demo");
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenNthCalledWith(2, "session-demo", {
      after: "mock-page-2",
    });
    expect(
      Array.from(timeline?.querySelectorAll("tbody tr") ?? [], (row) => row.textContent),
    ).toEqual([expect.stringContaining("400"), expect.stringContaining("420")]);
    expect(screen.getAllByText("400")).toHaveLength(1);
    expect(screen.getAllByText("420")).toHaveLength(1);
    const secondRow = timeline?.querySelectorAll("tbody tr")[1];
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
    const mappedLink = await screen.findByRole("link", { name: "console (acme/console)" });
    expect(mappedLink.getAttribute("href")).toBe("#/workspaces/mapped-id");
    expect(screen.getByRole("button", { name: "Copy session session-mapped" })).toBeTruthy();

    const renamed = mockSession("session-renamed");
    if (renamed.data === null) throw new Error("session fixture must contain data");
    renamed.data = {
      ...renamed.data,
      workspace_id: "renamed-id",
      repo_path: "C:/work/local-project",
      repo_owner: "example-org",
      repo_name: "remote-project",
    } as SessionSummary & WorkspaceLabelInput;
    vi.mocked(client.fetchSession).mockResolvedValue(renamed);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-renamed"));
    rerender(<SessionDetailPage sessionId="session-renamed" onBack={() => {}} />);
    expect(
      await screen.findByRole("link", { name: "local-project (example-org/remote-project)" }),
    ).toBeTruthy();

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
    const globalLink = await screen.findByRole("link", { name: "Global" });
    expect(globalLink.getAttribute("href")).toBe("#/workspaces/__global__");
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
    // Main context uses the shared series palette (series-1 = cyan).
    const line = await screen.findByTestId("rc-line");
    expect(line.getAttribute("data-datakey")).toBe("main_context_tokens");
    expect(line.getAttribute("data-stroke")).toBe("var(--series-1)");
    // The single cache-write turn (cache_write_5m: 41_000) becomes one amber scatter point.
    const scatter = screen.getByTestId("rc-scatter");
    expect(scatter.getAttribute("data-fill")).toBe("var(--amber)");
    expect(scatter.getAttribute("data-count")).toBe("1");
    // 160K warning reference line.
    expect(screen.getByTestId("rc-refline").getAttribute("data-y")).toBe("160000");
    expect(container.querySelector("#session-context-chart .kpi-fn")?.textContent).toContain(
      "solid: main",
    );
    expect(container.querySelector("#session-context-chart .kpi-fn")?.textContent).toContain(
      "amber dots: cache write",
    );
  });

  // P1-U6a: the timeline is now requested in parallel with the detail (no serial chain), so
  // this checks the detail failure alone is shown, not that the timeline was never requested.
  it("shows a detail failure as the page's one error, with no timeline", async () => {
    vi.mocked(client.fetchSession).mockRejectedValueOnce(new Error("detail unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load this session.",
    );
    expect(screen.getByRole("button", { name: "Retry session" })).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Turn timeline")).toBeNull();
  });

  it("keeps a timeline failure distinct after detail succeeds", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockRejectedValueOnce(new Error("timeline unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    await openTurns();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load this session.",
    );
    expect(screen.getByRole("button", { name: "Retry session" })).toBeTruthy();
  });

  it("shows a timeline failure without opening the turn list", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockRejectedValueOnce(new Error("timeline unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    const section = await screen.findByTestId("turn-timeline");
    await waitFor(() =>
      expect(section.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not load this session.",
      ),
    );
    expect(screen.getByRole("button", { name: /^Show all .* turns$/ })).toBeTruthy();
  });

  describe("turn pricing", () => {
    type EsfResponse = Awaited<ReturnType<typeof fetchSessionEsfObservations>>;
    function esf(selected: number, priced: number, unpriced: number): EsfResponse {
      return {
        data: {
          resource: {
            selected_session_count: selected,
            priced_turn_count: priced,
            unpriced_turn_count: unpriced,
          },
        },
      } as unknown as EsfResponse;
    }
    function setup(): void {
      const detail = mockSession("session-demo");
      if (detail.data !== null) detail.data = { ...detail.data, turn_count: 891 };
      vi.mocked(client.fetchSession).mockResolvedValue(detail);
      vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    }
    const promptText = () => screen.getByTestId("investigate-prompt-text").textContent ?? "";
    const copyButton = () => screen.getByTestId("copy-investigate-prompt") as HTMLButtonElement;

    it("shows the priced count and puts the unpriced turns in the prompt", async () => {
      setup();
      vi.mocked(fetchSessionEsfObservations).mockResolvedValueOnce(esf(1, 880, 11));
      render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
      await waitFor(() =>
        expect(screen.getByTestId("observed-priced-turns").textContent).toBe("880 of 891"),
      );
      expect(promptText()).toContain(
        "PRICING: 11 turns have no price; their cost is not in the $ figures.",
      );
    });

    it("shows Unavailable and no PRICING line when the session is not in the observation set", async () => {
      setup();
      vi.mocked(fetchSessionEsfObservations).mockResolvedValueOnce(esf(0, 0, 0));
      render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
      await waitFor(() =>
        expect(screen.getByTestId("observed-priced-turns").textContent).toContain("Unavailable"),
      );
      expect(promptText()).not.toContain("PRICING:");
    });

    it("keeps Copy disabled until pricing loads", async () => {
      setup();
      let resolve: (value: EsfResponse) => void = () => {};
      vi.mocked(fetchSessionEsfObservations).mockReturnValueOnce(
        new Promise<EsfResponse>((r) => {
          resolve = r;
        }),
      );
      render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
      await screen.findByTestId("investigate-prompt-text");
      await waitFor(() =>
        expect(screen.getByTestId("observed-priced-turns").textContent).toBe("Loading…"),
      );
      expect(copyButton().disabled).toBe(true);
      await act(async () => resolve(esf(1, 891, 0)));
      await waitFor(() => expect(copyButton().disabled).toBe(false));
    });

    it("enables Copy with a coverage-unknown PRICING line when pricing fails", async () => {
      setup();
      vi.mocked(fetchSessionEsfObservations).mockRejectedValueOnce(new Error("esf down"));
      render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
      await waitFor(() =>
        expect(screen.getByTestId("observed-priced-turns").textContent).toContain("Unavailable"),
      );
      await waitFor(() => expect(copyButton().disabled).toBe(false));
      expect(promptText()).toContain(
        "PRICING: unknown (price coverage failed to load); the $ figures may leave out unpriced turns.",
      );
    });
  });

  it("points tool errors at What went wrong only when that section renders", async () => {
    const detail = mockSession("session-demo");
    if (detail.data !== null) detail.data = { ...detail.data, tool_error_count: 4 };
    vi.mocked(client.fetchSession).mockResolvedValue(detail);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    vi.mocked(client.fetchSessionStory).mockRejectedValueOnce(new Error("story unavailable"));
    const { unmount } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    const evidence = await screen.findByTestId("session-observed-evidence");
    await waitFor(() => expect(evidence.textContent).toContain("4 tool errors recorded."));
    expect(screen.queryByTestId("error-groups-panel")).toBeNull();
    unmount();

    // The story fixture has one group of 4 errors, so What went wrong renders.
    vi.mocked(client.fetchSessionStory).mockResolvedValueOnce(mockSessionStory("session-demo"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByTestId("error-groups-panel");
    expect(screen.getByTestId("session-observed-evidence").textContent).toContain(
      "4 tool errors: see What went wrong above for them grouped by message.",
    );
  });

  it("orders sections cost, then timeline, then evidence, then Investigate", async () => {
    const id = "session-demo";
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession(id));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline(id));
    vi.mocked(client.fetchSessionStory).mockResolvedValueOnce(mockSessionStory(id));
    const drivers = mockSessionDrivers(id);
    if (drivers.data === null || drivers.data.drivers[0] === undefined)
      throw new Error("fixture requires a driver");
    vi.mocked(client.fetchSessionDrivers).mockResolvedValue(drivers);
    const recommendations = mockRecommendations();
    if (recommendations.data?.active[0] === undefined)
      throw new Error("fixture requires a recommendation");
    recommendations.data.active = [
      { ...recommendations.data.active[0], detector_id: "D8", rec_id: "synthetic-rec" },
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(recommendations);
    render(<SessionDetailPage sessionId={id} onBack={() => {}} />);
    await screen.findByTestId("error-groups-panel");
    await screen.findByRole("region", { name: "Recommendations for this pattern" });
    const order = [
      screen.getByTestId("money-card"),
      screen.getByTestId("cost-drivers-panel"),
      screen.getByRole("region", { name: "Cost breakdown" }),
      screen.getByTestId("session-swimlane"),
      screen.getByTestId("error-groups-panel"),
      screen.getByTestId("friction-strip"),
      screen.getByTestId("session-observed-evidence"),
      screen.getByRole("region", { name: "Anomalies" }),
      screen.getByTestId("investigate-card"),
      screen.getByRole("region", { name: "Recommendations for this pattern" }),
      screen.getByTestId("turn-timeline"),
    ];
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1];
      const next = order[i];
      if (prev === undefined || next === undefined) throw new Error("missing section");
      expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("renders an explicit empty timeline after detail succeeds", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    const empty = mockTurnTimeline("session-demo");
    if (empty.data === null) throw new Error("timeline fixture must contain data");
    empty.data = { items: [], next_cursor: null };
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(empty);
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await openTurns();
    expect(await screen.findByText("No turns have been recorded for this session.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the loaded timeline visible and offers a retry when load more fails", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline)
      .mockResolvedValueOnce(mockTurnTimeline("session-demo"))
      .mockRejectedValueOnce(new Error("next page unavailable"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    await screen.findByRole("heading", { level: 1 });
    await openTurns();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load this session.",
    );
    const timeline = screen.getByTestId("turn-timeline");
    expect(timeline?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading turns" })).toBeTruthy();
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
    const chip = await screen.findByText("top 8% by estimated value"); // (1 - 0.92) → 8%
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
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/by spend/)).toBeNull();
    expect(await screen.findByText("Fewer than 20 sessions in this workspace")).toBeTruthy();
  });

  it("does not claim too few sessions while the percentile is unknown (OV-11 review)", async () => {
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(mockTurnTimeline("session-demo"));
    vi.mocked(client.fetchSpendPercentile).mockRejectedValue(new Error("offline"));
    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(client.fetchSpendPercentile).toHaveBeenCalled());
    expect(screen.queryByText("Fewer than 20 sessions in this workspace")).toBeNull();
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
