/**
 * test/ui/sessions/esf-timeline-markers.test.tsx — ESFV-8: observed
 * completed-test failure/pass markers on the session context-per-turn chart.
 *
 * Markers are observations, not task-quality labels; the legend names the
 * glyphs and every marker tooltip carries the method caveat.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnRow } from "../../../src/query/api/overview";
import { ContextGrowthChart } from "../../../src/ui/sessions/SessionDetailPage";

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
    ReferenceLine: () => null,
    Scatter: ({
      data,
      shape,
    }: {
      data?: Array<Record<string, unknown>>;
      shape?: (props: { cx: number; cy: number; payload: Record<string, unknown> }) => ReactNode;
    }) => <>{data?.map((payload, index) => shape?.({ cx: index * 10, cy: 10, payload }))}</>,
  };
});

afterEach(cleanup);

function turn(index: number, overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    message_id: `turn-${index}`,
    session_id: "session-observed-tests",
    ts: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    model: "claude-sonnet-5",
    is_sidechain: false,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: null,
    cache_read_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_write_other: 0,
    context_tokens: index * 1_000,
    cost_equiv_u: 0,
    cost_claim: "LIST_EQUIV",
    provisional: false,
    effort: null,
    test_fail_events: 0,
    test_pass_events: 0,
    ...overrides,
  };
}

describe("ESF timeline observation markers", () => {
  it("marks completed-test failures and passes at their turn positions without task-quality styling", () => {
    // The audited session shape: failures, then an observed later pass.
    const turns = [
      turn(1),
      turn(2, { test_fail_events: 1 }),
      turn(3),
      turn(4, { test_fail_events: 2 }),
      turn(5, { test_pass_events: 1 }),
    ];

    const { container } = render(<ContextGrowthChart turns={turns} />);

    const markers = screen.getAllByTestId("timeline-observation-marker");
    expect(
      markers.map((marker) => [
        marker.getAttribute("data-turn"),
        marker.getAttribute("data-observation-kind"),
      ]),
    ).toEqual([
      ["2", "failure"],
      ["4", "failure"],
      ["5", "pass"],
    ]);
    // Legend names the glyphs and frames them as observations.
    const legend = screen.getByTestId("timeline-observation-legend");
    expect(legend.textContent).toContain("◆ observed completed-test failure");
    expect(legend.textContent).toContain("◇ observed completed-test pass");
    expect(legend.textContent).toContain("observations, not task outcomes");
    // No marker implies success/failure of the task.
    expect(
      container.querySelectorAll(".task-success, .task-failure, [data-task-outcome]"),
    ).toHaveLength(0);
    expect(
      markers.every((marker) => marker.getAttribute("aria-label")?.startsWith("Observed")),
    ).toBe(true);
  });

  it("renders no markers or legend when no completed-test events are observed", () => {
    render(<ContextGrowthChart turns={[turn(1), turn(2)]} />);
    expect(screen.queryByTestId("timeline-observation-marker")).toBeNull();
    expect(screen.queryByTestId("timeline-observation-legend")).toBeNull();
  });

  it("renders no markers for turns lacking the observation fields (older fixtures)", () => {
    const { test_fail_events: _fail, test_pass_events: _pass, ...bare } = turn(1);
    render(<ContextGrowthChart turns={[bare]} />);
    expect(screen.queryByTestId("timeline-observation-marker")).toBeNull();
  });

  it("puts the completed-test method caveat in every marker tooltip", () => {
    render(<ContextGrowthChart turns={[turn(1, { test_fail_events: 1 })]} />);

    expect(
      screen.getByTestId("timeline-observation-marker").querySelector("title")?.textContent,
    ).toBe(
      "Test outcomes are separate from task success or failure. 'Failed then passed' only means a later test pass was observed; it does not link the tests.",
    );
  });
});
