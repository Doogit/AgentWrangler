import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { mockRecommendations } from "../../src/ui/api/fixtures";
import RecCard from "../../src/ui/recommendations/RecCard";

function fixture(kind: "HABIT" | "INVESTIGATE" | "CONFIG" | "EDIT" = "HABIT"): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base?.actions) throw new Error("Missing recommendation fixture");
  return {
    ...base,
    rec_id: "ov9-fixture",
    category: "MODEL",
    state: "PROPOSED",
    modeled_savings_u_per_wk: 7_450_000,
    range_u_per_wk: [5_000_000, 9_000_000],
    actions: {
      ...base.actions,
      primary: {
        ...base.actions.primary,
        kind,
        copy_text: "OV9 validated instruction",
        option_id: "primary",
      },
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
    effect_capability: { mode: "TRACKABLE", reason: null },
  };
}

afterEach(cleanup);

describe("OV-9 recommendation head", () => {
  it.each([
    ["HABIT", "Copy instruction"],
    ["INVESTIGATE", "Copy prompt"],
    ["CONFIG", "Review config"],
    ["EDIT", "Review edit"],
  ] as const)("labels the %s primary %s", (kind, label) => {
    const { container } = render(<RecCard rec={fixture(kind)} />);
    const head = container.querySelector(".rec-card-head");
    expect(head).toBeTruthy();
    expect(head?.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(within(head as HTMLElement).getByRole("button", { name: label })).toBeTruthy();
    expect(container.querySelector(".rec-card")?.getAttribute("data-category")).toBe("model");
  });

  it("withholds invalid copy and opens details without touching the clipboard", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const rec = {
      ...fixture(),
      action_validation: {
        primary: { ok: false as const, reason: "target metric mismatch" },
        alternatives: {},
      },
    };
    render(<RecCard rec={rec} />);
    expect(screen.queryByRole("button", { name: "Copy instruction" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review evidence" }));
    expect(
      screen.getByText(/Action withheld — failed validation: target metric mismatch/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recommendation details" })).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies validated text and presents track availability", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { rerender } = render(<RecCard rec={fixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instruction" }));
    expect(writeText).toHaveBeenCalledWith("OV9 validated instruction");
    expect(screen.getByRole("button", { name: "Track" }).hasAttribute("disabled")).toBe(false);
    rerender(
      <RecCard
        rec={{ ...fixture(), effect_capability: { mode: "MANUAL", reason: "HANDLER_UNAVAILABLE" } }}
      />,
    );
    expect(screen.getByRole("button", { name: "Track" }).hasAttribute("disabled")).toBe(true);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Why Track is unavailable" }));
    expect(screen.getByText(/no effect handler/)).toBeTruthy();
    expect(screen.getByText(/can't measure this change yet/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/HANDLER_UNAVAILABLE|SOURCE_UNAVAILABLE/);
  });

  it("shows range-only and point savings using the shared meter", () => {
    const { container, rerender } = render(
      <RecCard rec={{ ...fixture(), modeled_savings_u_per_wk: null }} />,
    );
    expect(container.textContent).toContain("$5.00–$9.00");
    expect(container.textContent).toContain("range only · no point estimate");
    rerender(<RecCard rec={fixture()} />);
    expect(container.querySelector(".rec-savings-estimate")?.textContent).toBe("$7.45/wk");
  });
});
