/**
 * test/ui/infotip.test.tsx — InfoTip accessibility and visibility behavior.
 *
 * Covers mounting only while open, pointer and keyboard activation, dismissal,
 * and the trigger-to-tooltip accessible description relationship.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import InfoTip from "../../src/ui/shell/InfoTip";

const label = "What is Cache-write %?";
const content = "Cache writes are reusable prompt tokens stored for later requests.";

function renderInfoTip() {
  return render(<InfoTip content={content} label={label} />);
}

afterEach(cleanup);

describe("InfoTip", () => {
  it("does not mount the tooltip content at rest", () => {
    const { container } = renderInfoTip();

    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("opens when the trigger receives a mouseenter event", () => {
    const { getByRole } = renderInfoTip();
    const trigger = getByRole("button", { name: label });

    fireEvent.mouseEnter(trigger);

    const tooltip = getByRole("tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip.textContent).toBe(content);
  });

  it("opens when the trigger receives focus", () => {
    const { getByRole } = renderInfoTip();
    const trigger = getByRole("button", { name: label });

    fireEvent.focus(trigger);

    expect(getByRole("tooltip")).not.toBeNull();
  });

  it("closes an open tooltip on Escape", () => {
    const { queryByRole, getByRole } = renderInfoTip();
    const trigger = getByRole("button", { name: label });
    fireEvent.focus(trigger);

    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(queryByRole("tooltip")).toBeNull();
  });

  it("closes an open tooltip on blur", () => {
    const { queryByRole, getByRole } = renderInfoTip();
    const trigger = getByRole("button", { name: label });
    fireEvent.focus(trigger);

    fireEvent.blur(trigger);

    expect(queryByRole("tooltip")).toBeNull();
  });

  it("describes the trigger with the open tooltip id", () => {
    const { getByRole } = renderInfoTip();
    const trigger = getByRole("button", { name: label });
    fireEvent.focus(trigger);
    const tooltip = getByRole("tooltip");

    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
  });
});
