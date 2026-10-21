import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => cleanup());

function c2Rec(): RecommendationCard {
  return {
    rec_id: "c2-assumption-rec",
    detector_id: "C2",
    category: "TOOLING",
    scope_workspace_id: "ws-c2",
    lever: "Run Glob or Grep to confirm a path exists before retrying a failed content lookup.",
    modeled_savings_u_per_wk: 900_000,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "V2_C2_CONTENT_NOT_FOUND", inputs: {} },
    evidence: {
      metrics: {
        ERROR_COUNT: { kind: "COUNT", value: 12 },
        SESSION_COUNT: { kind: "COUNT", value: 12 },
      },
    },
    confidence_tier: "ESTIMATED",
    target_metric: "content_not_found_count",
    state: "PROPOSED",
    created_at: "2026-09-26T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 1,
    steps: [{ kind: "generic", description: "Confirm the path exists first" }],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
  };
}

describe("RecCard C2 savings basis (review 1 R2.2)", () => {
  it("says the claim is half the cost of the turn that made each failed call, not the error's size", () => {
    const { container } = render(<RecCard rec={c2Rec()} />);
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "button.rec-expand-btn[aria-expanded='false']",
    )) {
      fireEvent.click(button);
    }
    const note = container.querySelector(".rec-unvalidated-note")?.textContent ?? "";
    expect(note).toContain("Unvalidated assumption:");
    expect(note).toContain("half the cost of the turn that made it");
    expect(note).toContain("not the size of the error");
  });
});
