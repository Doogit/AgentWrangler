import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockSession, mockTurnTimeline } from "../../../src/ui/api/fixtures";
import SessionDetailPage from "../../../src/ui/sessions/SessionDetailPage";

vi.mock("../../../src/ui/api/client");
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

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

/** The raw turn table sits behind "Show all N turns" unless a turn is deep-linked. */
async function openTurns(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /^Show all .* turns$/ }));
}

describe("SessionDetailPage turn pagination", () => {
  it("renders only the first 100 turns until Load more is clicked", async () => {
    const timeline = mockTurnTimeline("session-demo");
    if (timeline.data === null || timeline.data.items[0] === undefined) {
      throw new Error("timeline fixture must contain a turn");
    }
    const firstTurn = timeline.data.items[0];
    timeline.data = {
      items: Array.from({ length: 1_000 }, (_, index) => ({
        ...firstTurn,
        message_id: `message-${index}`,
        ts: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      })),
      next_cursor: null,
    };
    const session = mockSession("session-demo");
    if (session.data === null) throw new Error("session fixture must contain data");
    session.data.turn_count = 1_000;
    vi.mocked(client.fetchSession).mockResolvedValue(session);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(timeline);

    const { container } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await openTurns();
    await screen.findByText("showing 100 of 1000 turns");
    expect(screen.queryByText(/Chart covers/)).toBeNull();
    expect(container.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(100);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(200));
    expect(screen.getByText("showing 200 of 1000 turns")).toBeTruthy();
  });

  it("marks the chart and timeline partial until the last page loads", async () => {
    const session = mockSession("session-demo");
    if (session.data === null) throw new Error("session fixture must contain data");
    session.data.turn_count = 2;
    const first = mockTurnTimeline("session-demo");
    if (first.data === null || first.data.items[0] === undefined) {
      throw new Error("timeline fixture must contain a turn");
    }
    const turn = first.data.items[0];
    first.data = { items: [turn], next_cursor: "second" };
    const second = mockTurnTimeline("session-demo");
    second.data = { items: [{ ...turn, message_id: "synthetic-second" }], next_cursor: null };
    vi.mocked(client.fetchSession).mockResolvedValue(session);
    vi.mocked(client.fetchTurnTimeline).mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    // No /story mock, so the fallback context chart renders and carries the partial note.
    expect(await screen.findByText("Chart covers 1 of 2 turns")).toBeTruthy();
    await openTurns();
    expect(screen.getByText("showing 1 of 2 turns — load more below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByText(/Chart covers/)).toBeNull());
    expect(screen.queryByText(/load more below/)).toBeNull();
    expect(vi.mocked(client.fetchTurnTimeline)).toHaveBeenLastCalledWith("session-demo", {
      after: "second",
    });
  });
});
