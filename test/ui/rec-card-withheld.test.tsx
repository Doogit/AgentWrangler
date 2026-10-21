import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { mockRecommendations } from "../../src/ui/api/fixtures";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture(): RecommendationCard {
  const card = mockRecommendations().data?.active[0];
  if (!card?.actions) throw new Error("Fixture has no actions");
  return {
    ...card,
    actions: {
      ...card.actions,
      alternatives: [
        {
          ...card.actions.primary,
          option_id: "safe-option",
          summary: "Use the safe option",
          copy_text: "Safe alternative text",
        },
      ],
    },
    action_validation: {
      primary: { ok: false as const, reason: "target metric mismatch or missing" },
      alternatives: { "safe-option": { ok: true as const } },
    },
  };
}

it("withholds an invalid primary while retaining a passing alternative", async () => {
  vi.useFakeTimers();
  const onAdopt = vi.fn();
  const card = fixture();
  const { container } = render(<RecCard rec={card} onAdopt={onAdopt} />);
  const decisions = container.querySelector(".rec-decision-actions");
  if (!decisions) throw new Error("Decision controls missing");
  const controls = within(decisions as HTMLElement);
  expect(
    controls.getByText("Action withheld — failed validation: target metric mismatch or missing"),
  ).toBeTruthy();
  expect(controls.queryByRole("button", { name: "Adopt" })).toBeNull();
  expect(controls.getAllByRole("button", { name: /^Copy$/ })).toHaveLength(1);
  expect(controls.getByRole("button", { name: "Adopt this option" })).toBeTruthy();
  fireEvent.click(controls.getByRole("button", { name: "Adopt this option" }));
  expect(onAdopt).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(onAdopt).toHaveBeenCalledWith(card.rec_id, "safe-option");
});

it("shows an unmeasured primary with its Adopt button and an Effect not tracked label", () => {
  const card = fixture();
  card.action_validation = { primary: { ok: true, measured: false }, alternatives: {} };
  const { container } = render(<RecCard rec={card} onAdopt={vi.fn()} />);
  const chips = container.querySelector(".rec-chip-row");
  if (!chips) throw new Error("Chip row missing");
  expect(chips.textContent).toContain("Effect not tracked");
  expect(
    within(chips as HTMLElement).getByRole("button", { name: "Effect not tracked" }),
  ).toBeTruthy();
  expect(container.textContent).not.toContain("Action withheld");
  expect(within(container).getByRole("button", { name: "Adopt" })).toBeTruthy();
});

it("shows no Effect not tracked label on a measured or withheld primary", () => {
  const withheld = fixture();
  const measured = {
    ...fixture(),
    action_validation: { primary: { ok: true as const }, alternatives: {} },
  };
  for (const card of [withheld, measured]) {
    const { container } = render(<RecCard rec={card} onAdopt={vi.fn()} />);
    expect(container.textContent).not.toContain("Effect not tracked");
    cleanup();
  }
});

it("withholds alternatives without passing validation", () => {
  const card = fixture();
  if (!card.action_validation) throw new Error("Fixture has no validation");
  card.action_validation.alternatives = {};
  const { container } = render(<RecCard rec={card} onAdopt={vi.fn()} />);
  const decisions = container.querySelector(".rec-decision-actions");
  if (!decisions) throw new Error("Decision controls missing");
  expect(within(decisions as HTMLElement).queryByText("Other ways to fix this")).toBeNull();
});

it("fails closed when a legacy card omits validation", () => {
  const { action_validation: _validation, ...card } = fixture();
  const { container } = render(<RecCard rec={card} onAdopt={vi.fn()} />);
  const decisions = container.querySelector(".rec-decision-actions");
  if (!decisions) throw new Error("Decision controls missing");
  const controls = within(decisions as HTMLElement);
  expect(
    controls.getByText("Action withheld — failed validation: validation result unavailable"),
  ).toBeTruthy();
  expect(controls.queryByRole("button", { name: "Adopt" })).toBeNull();
  expect(controls.queryByRole("button", { name: /^Copy$/ })).toBeNull();
  expect(controls.queryByText("Other ways to fix this")).toBeNull();
});

it("does not offer a hook for a card without an action or validation", () => {
  const card = { ...fixture(), detector_id: "D2", actions: null, action_validation: null };
  const { container } = render(<RecCard rec={card} />);
  expect(container.querySelector(".rec-primary-action")).toBeNull();
  expect(container.querySelector(".rec-generated-snippet")).toBeNull();
});
