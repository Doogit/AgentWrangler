import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HotSessionRow } from "../../../src/query/spend";
import { ExpensiveSessions } from "../../../src/ui/overview/ExpensiveSessions";

afterEach(cleanup);

const session = (id: string, peak: number, title?: string): HotSessionRow =>
  ({
    session_id: id,
    workspace_id: "workspace",
    title,
    model: "Opus",
    turns: 10,
    avg_context_tokens: 100_000,
    max_context_tokens: peak,
    cost_equiv_u: 25_000_000,
  }) as unknown as HotSessionRow;

describe("ExpensiveSessions", () => {
  it("renders titles, detail links, cost share, and the strict amber threshold", () => {
    const { container } = render(
      <ExpensiveSessions
        sessions={[session("first-id", 200_001, "Named session"), session("second-id", 200_000)]}
        windowCostU={100_000_000}
      />,
    );
    expect(screen.getByRole("link", { name: "Named session" }).getAttribute("href")).toBe(
      "#/sessions/first-id",
    );
    expect(screen.getByRole("link", { name: /second-i/ })).toBeTruthy();
    expect(screen.getAllByText("25%")).toHaveLength(2);
    expect(screen.getByTestId("session-share-first-id").style.width).toBe("25%");
    expect(container.querySelectorAll(".overview-peak-high")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "All sessions by cost →" }).getAttribute("href")).toBe(
      "#/sessions?sort=cost&direction=desc",
    );
  });

  it("shows an empty state", () => {
    render(<ExpensiveSessions sessions={[]} windowCostU={0} />);
    expect(screen.getByText(/No sessions in the past seven days/)).toBeTruthy();
  });
});
