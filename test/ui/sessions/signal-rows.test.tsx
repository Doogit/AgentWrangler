import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockSession } from "../../../src/ui/api/fixtures";
import { FrictionCell, type FrictionCounts } from "../../../src/ui/sessions/FrictionCell";
import { ObservedEvidenceCard } from "../../../src/ui/sessions/SessionOverview";

afterEach(() => cleanup());

const base: FrictionCounts = {
  api_error_count: 0,
  tool_error_count: 0,
  test_fail_count: 0,
  compaction_count: 0,
  interrupt_count: 0,
  user_turn_count: 1,
  turn_count: 10,
};

/** Row labels top to bottom, plus each row's level tag. */
function rows(container: HTMLElement): Array<[string, string]> {
  return [...container.querySelectorAll("details.signal-row")].map((row) => [
    row.querySelector(".signal-label")?.textContent ?? "",
    row.querySelector(".signal-level")?.textContent ?? "",
  ]);
}

describe("Friction signals rows", () => {
  it("ranks high, then elevated, then normal, then context-only rows", () => {
    // compactions 2 → High (≥2); tool errors 1 → Elevated (≥1); the rest are under threshold.
    const { container } = render(
      <FrictionCell
        counts={{
          ...base,
          compaction_count: 2,
          tool_error_count: 1,
          gap_n: 3,
          gap_median_s: 45,
          gap_p90_s: 320,
          long_gap_count: 1,
        }}
        variant="strip"
      />,
    );
    expect(rows(container)).toEqual([
      ["Context: compactions", "High"],
      ["Operational: tool errors", "Elevated"],
      ["Operational: API errors", "Normal"],
      ["Recorded test failure signals", "Normal"],
      ["Interaction: user-message share", "Normal"],
      ["Time between your messages", ""],
    ]);
  });

  it("each row expands to what was found and why it matters", () => {
    const { container } = render(
      <FrictionCell counts={{ ...base, compaction_count: 2 }} variant="strip" />,
    );
    const first = container.querySelector("details.signal-row");
    assert(first !== null);
    expect(first.querySelector("summary")?.textContent).toContain("Context: compactions2");
    const body = first.querySelector(".signal-body")?.textContent ?? "";
    expect(body).toContain("What we found");
    expect(body).toContain("2 compactions");
    expect(body).toContain("Why it matters");
  });

  it("shows the threshold that set the level", () => {
    const { container } = render(
      <FrictionCell counts={{ ...base, tool_error_count: 1 }} variant="strip" />,
    );
    const toolRow = [...container.querySelectorAll("details.signal-row")].find((row) =>
      row.textContent?.includes("Operational: tool errors"),
    );
    // THRESHOLDS.tool_errors: elevated 1, high 3.
    expect(toolRow?.querySelector(".signal-body")?.textContent).toContain(
      "Elevated at 1 or more, high at 3 or more.",
    );
  });
});

describe("Friction signals edge cases", () => {
  it("never shows a share at the threshold while the level is Normal", () => {
    // 99/250 = 39.6%: rounding would read "40%" next to "Normal".
    const { container } = render(
      <FrictionCell counts={{ ...base, user_turn_count: 99, turn_count: 250 }} variant="strip" />,
    );
    const share = [...container.querySelectorAll("details.signal-row")].find((row) =>
      row.textContent?.includes("user-message share"),
    );
    expect(share?.querySelector(".signal-value")?.textContent).toBe("39%");
    expect(share?.querySelector(".signal-level")?.textContent).toBe("Normal");
  });

  it("hides the gap row when there is no median", () => {
    const { container } = render(
      <FrictionCell
        counts={{ ...base, gap_n: 3, gap_median_s: null, gap_p90_s: null, long_gap_count: 0 }}
        variant="strip"
      />,
    );
    expect(container.textContent).not.toContain("Time between your messages");
  });

  it("uses the singular for one long gap", () => {
    const { container } = render(
      <FrictionCell
        counts={{ ...base, gap_n: 3, gap_median_s: 45, gap_p90_s: 320, long_gap_count: 1 }}
        variant="strip"
      />,
    );
    expect(container.textContent).toContain("1 gap longer than 300s.");
  });
});

describe("Observed evidence rows", () => {
  const fixture = mockSession("synthetic-session").data;
  assert(fixture !== null);

  it("puts facts that need a look first", () => {
    const { container } = render(
      <ObservedEvidenceCard
        session={{
          ...fixture,
          turn_count: 891,
          tool_error_count: 80,
          test_pass_count: 2,
          test_outcome: "FAILED_THEN_PASSED",
        }}
        pricing={{ status: "ok", value: { priced_turn_count: 880, unpriced_turn_count: 11 } }}
        onRetry={() => {}}
      />,
    );
    expect(rows(container)).toEqual([
      ["Priced turns", "Look"],
      ["Tool errors", "Look"],
      ["Test sequence", "OK"],
    ]);
  });

  it("ranks a failed test run with no later pass first when pricing and tools are clean", () => {
    const { container } = render(
      <ObservedEvidenceCard
        session={{
          ...fixture,
          turn_count: 10,
          tool_error_count: 0,
          test_fail_count: 2,
          test_outcome: "FAILURES_OBSERVED",
        }}
        pricing={{ status: "ok", value: { priced_turn_count: 10, unpriced_turn_count: 0 } }}
        onRetry={() => {}}
      />,
    );
    expect(rows(container)).toEqual([
      ["Test sequence", "Look"],
      ["Priced turns", "OK"],
      ["Tool errors", "OK"],
    ]);
    expect(screen.getByTestId("observed-test-sequence").textContent).toBe(
      "Tests failed; no later pass seen",
    );
  });
});
