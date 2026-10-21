import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStory, StoryLane, StoryTurn } from "../../../src/query/api/session-story";
import { mockSessionStory } from "../../../src/ui/api/fixtures";
import { ErrorGroupsPanel, MoneyCard, turnTicks } from "../../../src/ui/sessions/SessionStory";
import {
  SessionSwimlane,
  compressedScale,
  laneRows,
} from "../../../src/ui/sessions/SessionSwimlane";

afterEach(() => cleanup());

const MIN = 60_000;

function lane(id: string, minute: number, cost_u: number, isMain = false): StoryLane {
  const ts = new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  return {
    lane_id: id,
    label: isMain ? "Main" : `Agent ${id}`,
    is_main: isMain,
    first_ts: ts,
    last_ts: ts,
    turns: 2,
    cost_u,
    models: [cost_u % 2 === 0 ? "claude-opus-4-8" : "claude-haiku-4-5"],
  };
}

describe("laneRows", () => {
  it("keeps every lane when there are 15 or fewer", () => {
    const lanes = [
      lane("main", 0, 50, true),
      ...Array.from({ length: 14 }, (_, i) => lane(`s${i}`, i, i)),
    ];
    const { rows, rowOf } = laneRows(lanes);
    expect(rows).toHaveLength(15);
    expect(rows.some((r) => r.id === "__other")).toBe(false);
    expect(rowOf("s3")).toBe("s3");
  });

  it("caps at 15 rows: main, the 13 costliest subagents by start time, then one merged row", () => {
    // Subagent sN costs N, so s7..s19 are the 13 costliest and s0..s6 are merged.
    const lanes = [
      lane("main", 0, 50, true),
      ...Array.from({ length: 20 }, (_, i) => lane(`s${i}`, 40 - i, i)),
    ];
    const { rows, rowOf } = laneRows(lanes);
    expect(rows).toHaveLength(15);
    expect(rows[0]?.id).toBe("main");
    // Kept subagents run in start order (s19 starts first).
    expect(rows.slice(1, 14).map((r) => r.id)).toEqual(
      Array.from({ length: 13 }, (_, i) => `s${19 - i}`),
    );
    const other = rows[14];
    expect(other).toMatchObject({
      id: "__other",
      label: "Other subagents (7)",
      merged: 7,
      cost_u: 0 + 1 + 2 + 3 + 4 + 5 + 6,
      turns: 14,
    });
    expect(new Set(other?.models)).toEqual(new Set(["claude-opus-4-8", "claude-haiku-4-5"]));
    expect(rowOf("main")).toBe("main");
    expect(rowOf("s19")).toBe("s19");
    expect(rowOf("s0")).toBe("__other");
  });
});

describe("compressedScale", () => {
  it("leaves a session with no idle gap on the plain wall clock", () => {
    const scale = compressedScale([0, 10 * MIN, 25 * MIN]);
    expect(scale.gaps).toEqual([]);
    expect(scale.span).toBe(25 * MIN);
    expect(scale.at(12 * MIN)).toBe(12 * MIN);
  });

  it("squeezes a gap over 30 minutes to a fixed width and keeps the rest linear", () => {
    const t0 = 1_000_000;
    const idle = 2 * 60 * MIN;
    const times = [t0, t0 + MIN, t0 + 2 * MIN, t0 + 2 * MIN + idle, t0 + 3 * MIN + idle];
    const scale = compressedScale(times);
    // 3 active minutes → 3% is under the 1-minute floor, so the gap draws 1 minute wide.
    expect(scale.gaps).toEqual([{ from: 2 * MIN, to: 3 * MIN, ms: idle }]);
    expect(scale.span).toBe(4 * MIN);
    expect(scale.at(t0)).toBe(0);
    expect(scale.at(t0 + 2 * MIN + idle / 2)).toBe(2.5 * MIN);
    expect(scale.at(t0 + 3 * MIN + idle)).toBe(4 * MIN);
    // Positions stay monotonic across the gap.
    const xs = times.map(scale.at);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("treats exactly 30 minutes as active time, not a gap", () => {
    expect(compressedScale([0, 30 * MIN]).gaps).toEqual([]);
  });
});

describe("SessionSwimlane", () => {
  const T0 = Date.UTC(2026, 9, 1, 12, 0);
  function turn(lane_id: string, model: string, sec: number, error = false): StoryTurn {
    return {
      ts: new Date(T0 + sec * 1000).toISOString(),
      lane_id,
      model,
      context: 10_000,
      cost_u: 100_000,
      compaction: false,
      error,
    };
  }
  // Main: four back-to-back Sonnet turns (two at 60s), then an Opus turn, then Sonnet after a
  // 2h idle gap. One Haiku subagent turn at 30s on its own row.
  const turns = [
    turn("main", "claude-sonnet-5", 0, true),
    turn("agent-x", "claude-haiku-4-5", 30),
    turn("main", "claude-sonnet-5", 60, true),
    turn("main", "claude-sonnet-5", 60, true),
    turn("main", "claude-sonnet-5", 120),
    turn("main", "claude-opus-4-8", 130),
    turn("main", "claude-sonnet-5", 7_200),
  ];
  const story: SessionStory = {
    ...mockSessionStory("session-demo"),
    lanes: [lane("main", 0, 600_000, true), lane("agent-x", 0, 100_000)],
    turns,
    commits: [{ sha: "abcdef0123456789", ts: new Date(T0 + 125_000).toISOString() }],
  };

  function bars(): SVGElement[] {
    return screen.getAllByTestId("swimlane-turn") as unknown as SVGElement[];
  }

  it("merges back-to-back turns of one model and row into one bar", () => {
    render(<SessionSwimlane story={story} />);
    const labels = bars().map((b) => b.getAttribute("aria-label") ?? "");
    // Sonnet block, Haiku row, Opus turn, Sonnet after the gap.
    expect(labels).toHaveLength(4);
    expect(labels[0]).toMatch(/Sonnet 5 · 4 turns · \$0\.40 · 3 tool errors$/);
    expect(labels[1]).toMatch(/Haiku 4\.5 · 1 turn · \$0\.10$/);
    expect(labels[2]).toMatch(/Opus 4\.8 · 1 turn · \$0\.10$/);
    expect(labels[3]).toMatch(/Sonnet 5 · 1 turn · \$0\.10$/);
    expect(new Set(bars().map((b) => b.getAttribute("y")))).toEqual(new Set(["5", "27"]));
  });

  it("draws one error tick per turn start, not one per error", () => {
    render(<SessionSwimlane story={story} />);
    // Errors at 0s and twice at 60s → two distinct ticks.
    expect(screen.getAllByTestId("swimlane-error")).toHaveLength(2);
  });

  it("lets the keyboard reach each bar and commit and shows the same text as hover", () => {
    render(<SessionSwimlane story={story} />);
    const bar = bars()[0];
    assert(bar !== undefined);
    expect(bar.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(bar);
    expect(screen.getByRole("tooltip").textContent).toBe(bar.getAttribute("aria-label"));
    fireEvent.blur(bar);
    expect(screen.queryByRole("tooltip")).toBeNull();

    const commit = screen.getByTestId("swimlane-commit");
    expect(commit.getAttribute("tabindex")).toBe("0");
    expect(commit.getAttribute("aria-label")).toMatch(/^Commit abcdef0 · /);
    fireEvent.focus(commit);
    expect(screen.getByRole("tooltip").textContent).toBe(commit.getAttribute("aria-label"));
  });
});

describe("MoneyCard", () => {
  it("labels the savings figure as an estimate", () => {
    render(<MoneyCard story={mockSessionStory("session-demo")} />);
    expect(screen.getByTestId("money-headline").textContent).toBe(
      "Opus subagents were 31% of this session's cost.",
    );
    expect(screen.getByTestId("money-savings").textContent).toContain("≈ $0.67 less (estimate)");
  });

  it("drops the savings line when there is no estimate", () => {
    const story = mockSessionStory("session-demo");
    story.headline = { text: "Main chat drove the cost.", detail: null, savings_u: null };
    render(<MoneyCard story={story} />);
    expect(screen.getByTestId("money-headline")).toBeTruthy();
    expect(screen.queryByTestId("money-savings")).toBeNull();
  });
});

describe("ErrorGroupsPanel", () => {
  it("shows the group and expands its example on demand", () => {
    render(<ErrorGroupsPanel story={mockSessionStory("session-demo")} />);
    const row = screen.getByTestId("error-group-row");
    expect(row.textContent).toContain("npm run test");
    expect(row.textContent).toContain("+2 others");
    expect(row.textContent).toContain("Error: exit code N");
    expect(screen.queryByText("Error: exit code 1")).toBeNull();

    const toggle = within(row).getByRole("button", { name: "Show example" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Error: exit code 1")).toBeTruthy();
    expect(screen.getByText("npm run test -- --run")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Hide example" }));
    expect(screen.queryByText("Error: exit code 1")).toBeNull();
  });

  it("says what share of recorded errors the groups cover", () => {
    // The fixture has one group of 4 errors.
    const story = mockSessionStory("session-demo");
    const { rerender } = render(<ErrorGroupsPanel story={story} toolErrorCount={10} />);
    const coverage = () => screen.getByTestId("error-groups-coverage").textContent;
    expect(coverage()).toBe("Top group · 4 of 10 tool errors");
    rerender(<ErrorGroupsPanel story={story} toolErrorCount={4} />);
    expect(coverage()).toBe("4 tool errors in 1 group");
    rerender(<ErrorGroupsPanel story={story} />);
    expect(coverage()).toBe("4 tool errors in 1 group");
    const two = mockSessionStory("session-demo");
    const first = two.error_groups[0];
    assert(first !== undefined);
    two.error_groups = [first, { ...first, signature: "other", count: 1 }];
    two.errors_without_text = 3;
    rerender(<ErrorGroupsPanel story={two} toolErrorCount={80} />);
    expect(coverage()).toBe(
      "Top 2 groups · 5 of 80 tool errors · 3 older errors have no stored text; see the tool breakdown below",
    );
    const single = mockSessionStory("session-demo");
    const only = single.error_groups[0];
    assert(only !== undefined);
    single.error_groups = [{ ...only, count: 1 }];
    single.errors_without_text = 1;
    rerender(<ErrorGroupsPanel story={single} />);
    expect(coverage()).toBe(
      "1 tool error in 1 group · 1 older error has no stored text; see the tool breakdown below",
    );
  });

  it("renders nothing when no errors were grouped", () => {
    const story = mockSessionStory("session-demo");
    story.error_groups = [];
    const { container } = render(<ErrorGroupsPanel story={story} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("turnTicks", () => {
  it("labels every turn of a short session", () => {
    expect(turnTicks(1, 800)).toEqual([1]);
    expect(turnTicks(2, 800)).toEqual([1, 2]);
  });

  it("steps by a round number, about one tick per 100 px", () => {
    expect(turnTicks(1000, 800)).toEqual([1, 200, 400, 600, 800, 1000]);
    expect(turnTicks(37, 400)).toEqual([1, 10, 20, 30]);
    for (const [turns, width] of [
      [5000, 1200],
      [73, 300],
      [12, 900],
    ] as const) {
      const ticks = turnTicks(turns, width);
      expect(ticks[0]).toBe(1);
      expect(Math.max(...ticks)).toBeLessThanOrEqual(turns);
      expect(ticks.length).toBeLessThanOrEqual(Math.max(2, Math.floor(width / 100)) + 1);
    }
  });
});
