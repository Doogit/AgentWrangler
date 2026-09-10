import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => cleanup());

function makeRec(): RecommendationCard {
  return {
    rec_id: "chip-tiering-rec",
    detector_id: "D2",
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Use a session boundary between unrelated tasks",
    modeled_savings_u_per_wk: 59_400,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: { reduction_fraction: 0.33 },
      kind: "MODELED",
    },
    evidence: { session_count: 3 },
    target_metric: "sessions_over_threshold",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "generic", description: "Start a new session for unrelated work" }],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
  };
}

describe("RecCard chip tiering", () => {
  it("renders only confidence, category, and scope chips; qualifiers remain in metadata", () => {
    const { container, getByRole } = render(<RecCard rec={makeRec()} />);
    const chipRow = container.querySelector(".rec-chip-row");
    if (chipRow === null) throw new Error("recommendation chip row is missing");

    expect(
      chipRow.querySelectorAll(".rec-confidence-tier, .rec-category-chip, .rec-scope-badge"),
    ).toHaveLength(3);
    expect(chipRow.textContent).toContain("MODELED SAVINGS");
    expect(chipRow.textContent).toContain("Long sessions");
    expect(chipRow.textContent).toContain("workspace");
    expect(chipRow.textContent).not.toContain("LIST_EQUIV · modeled USD");
    expect(container.querySelector(".rec-meta")).toBeNull();

    fireEvent.click(getByRole("button", { name: /show details/i }));
    const details = container.querySelector(".rec-details");
    expect(container.querySelector(".rec-meta")?.textContent).toContain("early estimate");
    expect(details?.querySelectorAll(".chip")).toHaveLength(2);
    expect(details?.textContent).toContain("MODELED");
    expect(details?.textContent).toContain("LIST_EQUIV · modeled USD");
  });
});
