import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSession, mockTurnTimeline } from "../../src/ui/api/fixtures";
import SessionDetailPage from "../../src/ui/sessions/SessionDetailPage";

vi.mock("../../src/ui/api/client");
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

describe("SessionDetailPage sidechain turns", () => {
  it("labels only sidechain turns in the Chain column", async () => {
    const timeline = mockTurnTimeline("session-demo");
    if (timeline.data === null || timeline.data.items[0] === undefined) {
      throw new Error("timeline fixture must contain a turn");
    }
    const turn = timeline.data.items[0];
    // The API type is boolean, but the display is intentionally defensive for legacy/nullish data.
    const nullishTurn = {
      ...turn,
      message_id: "nullish-turn",
      model: "nullish-chain-model",
      is_sidechain: null,
    } as unknown as typeof turn;
    timeline.data = {
      items: [
        { ...turn, message_id: "sidechain-turn", model: "sidechain-model", is_sidechain: true },
        { ...turn, message_id: "main-turn", model: "main-chain-model", is_sidechain: false },
        nullishTurn,
      ],
      next_cursor: null,
    };
    vi.mocked(client.fetchSession).mockResolvedValue(mockSession("session-demo"));
    vi.mocked(client.fetchTurnTimeline).mockResolvedValue(timeline);

    render(<SessionDetailPage sessionId="session-demo" onBack={() => {}} />);

    expect(await screen.findByRole("columnheader", { name: "Chain" })).toBeTruthy();
    const sidechainRow = screen.getByText("sidechain-model").closest("tr");
    const mainChainRow = screen.getByText("main-chain-model").closest("tr");
    const nullishChainRow = screen.getByText("nullish-chain-model").closest("tr");
    expect(sidechainRow?.querySelector(".chip-na")?.textContent).toBe("side");
    expect(mainChainRow?.querySelector(".chip-na")).toBeNull();
    expect(nullishChainRow?.querySelector(".chip-na")).toBeNull();
  });
});
