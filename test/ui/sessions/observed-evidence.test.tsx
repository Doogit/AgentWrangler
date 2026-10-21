import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSession } from "../../../src/ui/api/fixtures";
import { ObservedEvidenceCard } from "../../../src/ui/sessions/SessionOverview";

afterEach(() => cleanup());

const fixture = mockSession("synthetic-session").data;
assert(fixture !== null);
const session = {
  ...fixture,
  turn_count: 891,
  test_pass_count: 2,
  tool_error_count: 80,
  test_fail_count: 3,
  test_outcome: "FAILED_THEN_PASSED" as const,
};
const priced = {
  status: "ok" as const,
  value: { priced_turn_count: 880, unpriced_turn_count: 11 },
};

function card(): HTMLElement {
  return screen.getByTestId("session-observed-evidence");
}

describe("ObservedEvidenceCard", () => {
  it("states pricing, the test sequence and points errors at What went wrong", () => {
    render(<ObservedEvidenceCard session={session} pricing={priced} onRetry={() => {}} />);
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("880 of 891");
    expect(card().textContent).toContain(
      "11 turns have no price; their cost is not in the $ figures.",
    );
    expect(screen.getByTestId("observed-test-sequence").textContent).toBe(
      "Tests failed, then passed later",
    );
    expect(card().textContent).toContain("3 test failure signals recorded");
    expect(card().textContent).toContain(
      "80 tool errors: see What went wrong above for them grouped by message.",
    );
  });

  it("drops the session id, state and cohort wording", () => {
    render(<ObservedEvidenceCard session={session} pricing={priced} onRetry={() => {}} />);
    const text = card().textContent ?? "";
    expect(text).not.toContain(session.session_id);
    expect(text).not.toContain("RECONCILED");
    expect(text).not.toMatch(/cohort|window contract/i);
  });

  it("shows no caveat when every turn is priced", () => {
    render(
      <ObservedEvidenceCard
        session={session}
        pricing={{ status: "ok", value: { priced_turn_count: 891, unpriced_turn_count: 0 } }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("891 of 891");
    expect(card().textContent).not.toContain("no price");
  });

  it.each([
    ["FAILURES_OBSERVED", 2, "Tests failed; no later pass seen"],
    ["NO_FAILURES_OBSERVED", 0, "Tests passed; no failures"],
    ["NO_TEST_OUTCOMES", 0, "No completed tests"],
    [undefined, 0, "No completed tests"],
  ] as const)("test outcome %s reads %s", (outcome, fails, expected) => {
    const { test_outcome: _omit, ...rest } = session;
    render(
      <ObservedEvidenceCard
        session={{
          ...rest,
          test_fail_count: fails,
          ...(outcome === undefined ? {} : { test_outcome: outcome }),
        }}
        pricing={priced}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-test-sequence").textContent).toBe(expected);
    if (fails === 0) expect(card().textContent).not.toContain("failure signal");
  });

  it("says so when no tool errors were recorded", () => {
    render(
      <ObservedEvidenceCard
        session={{ ...session, tool_error_count: 0 }}
        pricing={priced}
        onRetry={() => {}}
      />,
    );
    expect(card().textContent).toContain("No tool errors recorded.");
  });

  it("only points at What went wrong when that section is on the page", () => {
    render(
      <ObservedEvidenceCard
        session={session}
        pricing={priced}
        errorGroupsShown={false}
        onRetry={() => {}}
      />,
    );
    expect(card().textContent).toContain("80 tool errors recorded.");
    expect(card().textContent).not.toContain("What went wrong");
  });

  it("counts finished turns only and says how many are still in progress", () => {
    render(
      <ObservedEvidenceCard
        session={{ ...session, turn_count: 120 }}
        pricing={{ status: "ok", value: { priced_turn_count: 112, unpriced_turn_count: 0 } }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("112 of 112");
    expect(card().textContent).toContain("8 turns still in progress are not counted here yet.");
    expect(card().textContent).not.toContain("not priced");
  });

  it("says in progress when no turn has finished yet", () => {
    render(
      <ObservedEvidenceCard
        session={{ ...session, turn_count: 1 }}
        pricing={{ status: "ok", value: { priced_turn_count: 0, unpriced_turn_count: 0 } }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("In progress");
    expect(card().textContent).toContain("1 turn still in progress is not counted here yet.");
  });

  it("shows Unavailable with no Retry when the session has no pricing data", () => {
    render(
      <ObservedEvidenceCard
        session={session}
        pricing={{ status: "ok", value: null }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("Unavailable");
    expect(screen.queryByRole("button", { name: "Retry price coverage" })).toBeNull();
    expect(card().textContent).toContain("Price coverage is not available for this session.");
  });

  it("does not claim tests passed when no test run passed", () => {
    render(
      <ObservedEvidenceCard
        session={{ ...session, test_outcome: "NO_FAILURES_OBSERVED", test_pass_count: 0 }}
        pricing={priced}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("observed-test-sequence").textContent).toBe(
      "Tests ran; no failures seen",
    );
  });

  it("shows loading, and a Retry when pricing fails", () => {
    const { rerender } = render(
      <ObservedEvidenceCard session={session} pricing={{ status: "loading" }} onRetry={() => {}} />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("Loading…");
    expect(card().textContent).toContain("Checking price coverage…");
    expect(card().textContent).not.toContain("not available");
    const onRetry = vi.fn();
    rerender(
      <ObservedEvidenceCard session={session} pricing={{ status: "error" }} onRetry={onRetry} />,
    );
    expect(screen.getByTestId("observed-priced-turns").textContent).toBe("Unavailable");
    expect(card().textContent).toContain("Price coverage failed to load.");
    const retry = screen.getByRole("button", { name: "Retry price coverage" });
    // Not inside a <summary>: nested interactive content toggles the row instead of retrying.
    expect(retry.closest("summary")).toBeNull();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
