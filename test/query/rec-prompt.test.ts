import { describe, expect, it } from "vitest";
import { buildSeededPrompt } from "../../src/query/api/rec-prompt.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";

function makeRecommendation(category: string): RecommendationCard {
  return {
    rec_id: "rec-prompt-test",
    detector_id: "D2",
    category,
    scope_workspace_id: null,
    lever: "Shorten long sessions",
    modeled_savings_u_per_wk: 2_000_000,
    run_cost_u: null,
    modeled_formula: { model: "TEST", inputs: {} },
    evidence: {},
    target_metric: "avg_context_per_turn",
    state: "PROPOSED",
    created_at: "2026-08-31T00:00:00Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
  };
}

describe("buildSeededPrompt", () => {
  it.each(["CONTEXT", "LIMIT", "CACHE"])(
    "does not serialize the raw %s category enum",
    (category) => {
      const prompt = buildSeededPrompt(makeRecommendation(category));

      expect(prompt).not.toContain('"category"');
      expect(prompt).not.toContain(`"${category}"`);
    },
  );
});
