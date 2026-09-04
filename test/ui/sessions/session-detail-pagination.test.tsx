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
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(timeline);

    const { container } = render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);
    await screen.findByText("showing 100 of 1000 turns");
    expect(container.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(100);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(200));
  });
});
