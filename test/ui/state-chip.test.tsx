import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StateChip, { type StateChipKind } from "../../src/ui/shell/StateChip";

describe("StateChip", () => {
  it("renders every measurement state as a named, visually distinct status", () => {
    const states: StateChipKind[] = [
      "UNKNOWN",
      "UNREPORTED",
      "UNAVAILABLE",
      "PENDING",
      "INSUFFICIENT",
      "LIVE_EXCLUDED",
    ];
    const classes = states.map((kind) => {
      const { container } = render(
        <StateChip kind={kind} reason="recorded reason" n={2} gate={3} />,
      );
      const chip = container.querySelector('[role="status"]');
      expect(chip?.textContent?.trim()).not.toBe("");
      expect(chip?.getAttribute("aria-label")).toBe(chip?.textContent);
      expect(chip?.className).toContain(`state-chip-${kind.toLowerCase().replaceAll("_", "-")}`);
      return chip?.className;
    });

    expect(new Set(classes).size).toBe(states.length);
  });

  it("states the unavailable reason and count thresholds inline", () => {
    const { container } = render(<StateChip kind="UNAVAILABLE" reason="source did not report" />);
    expect(container.textContent).toBe("UNAVAILABLE — source did not report");

    const pending = render(<StateChip kind="PENDING" n={2} gate={5} />);
    expect(pending.container.textContent).toBe("PENDING — 2 of 5 gate");

    const insufficient = render(<StateChip kind="INSUFFICIENT" n={2} gate={5} />);
    expect(insufficient.container.textContent).toBe("INSUFFICIENT — 2 < 5 gate");
  });
});
