import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpendPercentileChip } from "../../../src/ui/sessions/SpendPercentileChip";

afterEach(() => cleanup());

describe("SpendPercentileChip honesty boundaries", () => {
  it("renders nothing when the percentile is withheld (null or undefined)", () => {
    const { container: a } = render(<SpendPercentileChip percentile={null} n={5} />);
    expect(a.textContent).toBe("");
    const { container: b } = render(<SpendPercentileChip percentile={undefined} n={0} />);
    expect(b.textContent).toBe("");
  });

  it("clamps the priciest session to 'top 1%' rather than 'top 0%'", () => {
    render(<SpendPercentileChip percentile={1} n={25} />);
    const chip = screen.getByText("top 1% by spend");
    expect(chip.getAttribute("title")).toContain("at or above 100%");
  });

  it("never renders 'top 100%' for a cheap session in a large workspace", () => {
    // n=200, unique-cheapest → percentile = 1/200 = 0.005 (the pre-fix bug rounded to 100%).
    render(<SpendPercentileChip percentile={0.005} n={200} />);
    expect(screen.queryByText(/top 100% by spend/)).toBeNull();
    const chip = screen.getByText("top 99% by spend");
    expect(chip.getAttribute("title")).toContain("at or above 1%");
  });

  it("keeps the label and tooltip complementary at a .5 rounding boundary", () => {
    render(<SpendPercentileChip percentile={0.925} n={40} />);
    // Both derive from one rounded value → 7 + 93 = 100 (no 1-point drift).
    const chip = screen.getByText("top 7% by spend");
    expect(chip.getAttribute("title")).toContain("at or above 93%");
  });

  it("carries n and the window into the tooltip", () => {
    render(<SpendPercentileChip percentile={0.9} n={30} windowDays={90} />);
    const chip = screen.getByText("top 10% by spend");
    expect(chip.getAttribute("title")).toContain("30 sessions");
    expect(chip.getAttribute("title")).toContain("90 days");
  });
});
