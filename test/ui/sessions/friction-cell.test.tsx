import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FrictionCell, THRESHOLDS, frictionBand } from "../../../src/ui/sessions/FrictionCell";
import type { FrictionCounts } from "../../../src/ui/sessions/FrictionCell";

afterEach(() => cleanup());

const base: FrictionCounts = {
  api_error_count: 0,
  tool_error_count: 0,
  test_fail_count: 0,
  compaction_count: 0,
  interrupt_count: 0,
  user_turn_count: 0,
  turn_count: 10,
};

describe("frictionBand", () => {
  it("returns LOW when all counts are zero", () => {
    expect(frictionBand(base)).toBe("LOW");
  });

  it("returns ELEVATED when api_error_count meets elevated threshold", () => {
    expect(frictionBand({ ...base, api_error_count: THRESHOLDS.api_errors.elevated })).toBe(
      "ELEVATED",
    );
  });

  it("returns HIGH when api_error_count meets high threshold", () => {
    expect(frictionBand({ ...base, api_error_count: THRESHOLDS.api_errors.high })).toBe("HIGH");
  });

  it("returns ELEVATED when tool_error_count meets elevated threshold", () => {
    expect(frictionBand({ ...base, tool_error_count: THRESHOLDS.tool_errors.elevated })).toBe(
      "ELEVATED",
    );
  });

  it("returns HIGH when tool_error_count meets high threshold", () => {
    expect(frictionBand({ ...base, tool_error_count: THRESHOLDS.tool_errors.high })).toBe("HIGH");
  });

  it("returns ELEVATED when test_fail_count meets elevated threshold", () => {
    expect(frictionBand({ ...base, test_fail_count: THRESHOLDS.test_fails.elevated })).toBe(
      "ELEVATED",
    );
  });

  it("returns HIGH when test_fail_count meets high threshold", () => {
    expect(frictionBand({ ...base, test_fail_count: THRESHOLDS.test_fails.high })).toBe("HIGH");
  });

  it("returns ELEVATED when compaction_count meets elevated threshold", () => {
    expect(frictionBand({ ...base, compaction_count: THRESHOLDS.compactions.elevated })).toBe(
      "ELEVATED",
    );
  });

  it("returns HIGH when compaction_count meets high threshold", () => {
    expect(frictionBand({ ...base, compaction_count: THRESHOLDS.compactions.high })).toBe("HIGH");
  });

  it("returns ELEVATED when interrupt_count meets elevated threshold", () => {
    expect(frictionBand({ ...base, interrupt_count: THRESHOLDS.interrupts.elevated })).toBe(
      "ELEVATED",
    );
  });

  it("returns HIGH when interrupt_count meets high threshold", () => {
    expect(frictionBand({ ...base, interrupt_count: THRESHOLDS.interrupts.high })).toBe("HIGH");
  });

  it("returns ELEVATED when reprompt density meets elevated threshold", () => {
    // user_turn_count / turn_count = 0.4 (elevated)
    expect(frictionBand({ ...base, user_turn_count: 4, turn_count: 10 })).toBe("ELEVATED");
  });

  it("returns HIGH when reprompt density meets high threshold", () => {
    // user_turn_count / turn_count = 0.6 (high)
    expect(frictionBand({ ...base, user_turn_count: 6, turn_count: 10 })).toBe("HIGH");
  });

  it("returns LOW when turn_count is 0 (no divide by zero)", () => {
    expect(frictionBand({ ...base, turn_count: 0, user_turn_count: 0 })).toBe("LOW");
  });

  it("HIGH dominates ELEVATED — HIGH wins when multiple thresholds fire", () => {
    expect(
      frictionBand({
        ...base,
        api_error_count: THRESHOLDS.api_errors.elevated,
        tool_error_count: THRESHOLDS.tool_errors.high,
      }),
    ).toBe("HIGH");
  });
});

describe("FrictionCell compact variant", () => {
  it("renders with data-testid and data-band attributes", () => {
    render(<FrictionCell counts={base} />);
    const cell = screen.getByTestId("friction-cell");
    expect(cell).toBeTruthy();
    expect(cell.dataset.band).toBe("LOW");
  });

  it("shows DIRECTIONAL chip", () => {
    render(<FrictionCell counts={base} />);
    // Chip renders the label text
    expect(screen.getByText("LOW")).toBeTruthy();
  });

  it("shows non-zero counts as inline text", () => {
    render(<FrictionCell counts={{ ...base, api_error_count: 2, test_fail_count: 1 }} />);
    const cell = screen.getByTestId("friction-cell");
    expect(cell.textContent).toContain("api-err 2");
    expect(cell.textContent).toContain("fail 1");
  });

  it("omits zero-value counts from compact text", () => {
    render(<FrictionCell counts={base} />);
    const cell = screen.getByTestId("friction-cell");
    // No counts text when all zero
    expect(cell.textContent).not.toContain("api-err");
    expect(cell.textContent).not.toContain("compact");
    expect(cell.textContent).not.toContain("intr");
  });

  it("interrupt renders 0 gracefully — not shown in compact text", () => {
    render(<FrictionCell counts={{ ...base, interrupt_count: 0 }} />);
    const cell = screen.getByTestId("friction-cell");
    expect(cell.textContent).not.toContain("intr");
  });

  it("shows data-band=ELEVATED when a threshold is met", () => {
    render(<FrictionCell counts={{ ...base, api_error_count: 1 }} />);
    expect(screen.getByTestId("friction-cell").dataset.band).toBe("ELEVATED");
  });

  it("shows data-band=HIGH when a high threshold is met", () => {
    render(<FrictionCell counts={{ ...base, api_error_count: 3 }} />);
    expect(screen.getByTestId("friction-cell").dataset.band).toBe("HIGH");
  });

  it("tooltip names every threshold (FRICTION_TOOLTIP present on element)", () => {
    render(<FrictionCell counts={base} />);
    const cell = screen.getByTestId("friction-cell");
    const tip = cell.getAttribute("title") ?? "";
    expect(tip).toContain("API errors");
    expect(tip).toContain("Tool errors");
    expect(tip).toContain("Test fails");
    expect(tip).toContain("Compactions");
    expect(tip).toContain("Interrupts");
    expect(tip).toContain("Re-prompt density");
    expect(tip).toContain("ELEVATED");
    expect(tip).toContain("HIGH");
  });
});

describe("FrictionCell strip variant", () => {
  it("renders all six components with labels", () => {
    render(<FrictionCell counts={base} variant="strip" />);
    const cell = screen.getByTestId("friction-cell");
    expect(cell.textContent).toContain("API errors");
    expect(cell.textContent).toContain("Tool errors");
    expect(cell.textContent).toContain("Test fails");
    expect(cell.textContent).toContain("Compactions");
    expect(cell.textContent).toContain("Interrupts");
    expect(cell.textContent).toContain("Re-prompt density");
  });

  it("renders interrupt count of 0 without crashing", () => {
    render(<FrictionCell counts={{ ...base, interrupt_count: 0 }} variant="strip" />);
    expect(screen.getByTestId("friction-cell")).toBeTruthy();
  });

  it("shows data-band attribute in strip mode", () => {
    render(<FrictionCell counts={{ ...base, compaction_count: 2 }} variant="strip" />);
    expect(screen.getByTestId("friction-cell").dataset.band).toBe("HIGH");
  });
});
