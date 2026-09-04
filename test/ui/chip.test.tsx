/**
 * test/ui/chip.test.tsx — Chip component: distinctness + accessibility.
 *
 * Covers:
 *   - Each claim kind gets the correct CSS class (visually distinct)
 *   - LIST_EQUIV is DISTINCT from OBS_PROXY and PROXY (different class + label)
 *   - Every chip pairs a color accent with a text label (WCAG 1.4.1)
 *   - role="status" + aria-label are present for screen readers
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Chip, { KIND_TOOLTIP } from "../../src/ui/shell/Chip";
import ChipLegend from "../../src/ui/shell/ChipLegend";

describe("Chip", () => {
  it("renders LIST_EQUIV with chip-list-equiv class and label", () => {
    const { container } = render(<Chip kind="LIST_EQUIV" />);
    const el = container.querySelector(".chip-list-equiv");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("LIST_EQUIV");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.getAttribute("aria-label")).toBe("LIST_EQUIV");
  });

  it("renders OBS_PROXY with chip-obs-proxy class (distinct from LIST_EQUIV)", () => {
    const { container } = render(<Chip kind="OBS_PROXY" />);
    const el = container.querySelector(".chip-obs-proxy");
    expect(el).not.toBeNull();
    // Label includes BPE note — not empty, satisfies WCAG color-not-only-signal
    expect(el?.textContent).toContain("OBS PROXY");
    // Confirm it does NOT have the LIST_EQUIV class
    expect(container.querySelector(".chip-list-equiv")).toBeNull();
  });

  it("renders PROXY with chip-proxy class (distinct from LIST_EQUIV and OBS_PROXY)", () => {
    const { container } = render(<Chip kind="PROXY" />);
    const el = container.querySelector(".chip-proxy");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("PROXY");
    expect(container.querySelector(".chip-list-equiv")).toBeNull();
    expect(container.querySelector(".chip-obs-proxy")).toBeNull();
  });

  it("LIST_EQUIV and OBS_PROXY have different CSS classes (visual distinction)", () => {
    const { container: c1 } = render(<Chip kind="LIST_EQUIV" />);
    const { container: c2 } = render(<Chip kind="OBS_PROXY" />);
    const cls1 = c1.querySelector(".chip")?.className ?? "";
    const cls2 = c2.querySelector(".chip")?.className ?? "";
    expect(cls1).not.toBe(cls2);
  });

  it("LIST_EQUIV and PROXY have different CSS classes (visual distinction)", () => {
    const { container: c1 } = render(<Chip kind="LIST_EQUIV" />);
    const { container: c2 } = render(<Chip kind="PROXY" />);
    const cls1 = c1.querySelector(".chip")?.className ?? "";
    const cls2 = c2.querySelector(".chip")?.className ?? "";
    expect(cls1).not.toBe(cls2);
  });

  it("renders EXPERIMENTAL with chip-experimental class", () => {
    const { container } = render(<Chip kind="EXPERIMENTAL" />);
    expect(container.querySelector(".chip-experimental")).not.toBeNull();
  });

  it("renders N_A with chip-na class", () => {
    const { container } = render(<Chip kind="N_A" />);
    expect(container.querySelector(".chip-na")).not.toBeNull();
    expect(container.querySelector(".chip")?.textContent).toBe("N/A");
  });

  it("renders LIVE with chip-live class", () => {
    const { container } = render(<Chip kind="LIVE" />);
    expect(container.querySelector(".chip-live")).not.toBeNull();
  });

  it("renders MODELED with chip-modeled class and label (distinct from EXPERIMENTAL)", () => {
    const { container } = render(<Chip kind="MODELED" />);
    const el = container.querySelector(".chip-modeled");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("MODELED");
    // Distinct from the page-level EXPERIMENTAL chip.
    expect(container.querySelector(".chip-experimental")).toBeNull();
  });

  it("accepts a custom label override", () => {
    const { container } = render(<Chip kind="LIVE" label="LIVE" />);
    expect(container.querySelector(".chip")?.textContent).toBe("LIVE");
  });

  it("ChipLegend lists every chip kind with its shared explanation", () => {
    const { container } = render(<ChipLegend />);
    const toggle = container.querySelector(".chip-legend-toggle");
    expect(toggle).not.toBeNull();
    if (toggle === null) throw new Error("ChipLegend toggle is missing");
    fireEvent.click(toggle);

    const panel = container.querySelector(".chip-legend-panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelectorAll(".chip")).toHaveLength(Object.keys(KIND_TOOLTIP).length);
    for (const explanation of Object.values(KIND_TOOLTIP)) {
      expect(panel?.textContent).toContain(explanation);
    }
  });

  it("every chip has a non-empty text label (color not sole signal)", () => {
    const kinds = [
      "LIST_EQUIV",
      "LIST_EQUIV_STALE",
      "PROXY",
      "OBS_PROXY",
      "EXPERIMENTAL",
      "N_A",
      "EXACT",
      "LIVE",
      "MODELED",
    ] as const;
    for (const kind of kinds) {
      const { container } = render(<Chip kind={kind} />);
      const text = container.querySelector(".chip")?.textContent ?? "";
      expect(text.trim().length, `${kind} chip label is empty`).toBeGreaterThan(0);
    }
  });
});
