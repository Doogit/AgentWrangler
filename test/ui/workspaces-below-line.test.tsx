import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextComposition } from "../../src/query/api/context-composition";
import ContextCompositionPanel from "../../src/ui/workspaces/ContextCompositionPanel";
import WorkspaceOutcomeTable from "../../src/ui/workspaces/WorkspaceOutcomeTable";

afterEach(cleanup);

const outcomeRows = [
  {
    workspace_id: "ws-spend",
    project_slug: "Spend workspace",
    total_n: 2,
    in_progress_n: 0,
    terminal_n: 2,
    success_n: 1,
    failure_n: 1,
    success_rate: 0.5,
    linkage_rate: 0.5,
    adherence_score: 80,
  },
  {
    workspace_id: "ws-no-spend",
    project_slug: "No-spend workspace",
    total_n: 1,
    in_progress_n: 0,
    terminal_n: 1,
    success_n: 1,
    failure_n: 0,
    success_rate: 1,
    linkage_rate: 1,
    adherence_score: 100,
  },
  {
    workspace_id: "ws-missing-spend",
    project_slug: "Missing-spend workspace",
    total_n: 1,
    in_progress_n: 0,
    terminal_n: 1,
    success_n: 0,
    failure_n: 1,
    success_rate: 0,
    linkage_rate: 1,
    adherence_score: 0,
  },
];

function contextData(residualShare: number): ContextComposition {
  return {
    workspace_id: "ws-1",
    observed_context_tokens: 10_000,
    observed_turns: 2,
    inventory_rows: 1,
    rows: [
      {
        key: "always_loaded" as const,
        label: "always loaded",
        tokens: 10_000 * (1 - residualShare),
        share: 1 - residualShare,
      },
      {
        key: "session_residual" as const,
        label: "session residual",
        tokens: 10_000 * residualShare,
        share: residualShare,
      },
    ],
  };
}

describe("workspaces below-the-line UI", () => {
  it("joins per-workspace spend into the outcome table", () => {
    render(
      <WorkspaceOutcomeTable
        rows={outcomeRows}
        workspaceSpendById={
          new Map([
            ["ws-spend", 0.04],
            ["ws-no-spend", null],
          ])
        }
      />,
    );

    expect(screen.getByRole("columnheader", { name: "$/turn" })).toBeTruthy();
    expect(screen.getByText("$0.04")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows in-segment percentages for shares wider than 20%", () => {
    render(<ContextCompositionPanel data={contextData(0.75)} />);

    expect(screen.getByText("25%").closest(".context-composition-segment")).not.toBeNull();
    expect(screen.getByText("75%").closest(".context-composition-segment")).not.toBeNull();
  });

  it("shows the /clear interpretation only above the residual threshold", () => {
    const interpretation =
      "Session history is >70% of context — use /clear more often at task boundaries to reset accumulated conversation and reduce per-turn cost.";
    const { rerender } = render(<ContextCompositionPanel data={contextData(0.71)} />);

    expect(screen.getByText(interpretation)).toBeTruthy();

    rerender(<ContextCompositionPanel data={contextData(0.7)} />);
    expect(screen.queryByText(interpretation)).toBeNull();
  });
});
