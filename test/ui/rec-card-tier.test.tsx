import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => cleanup());

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "tier-card",
    detector_id: "D2",
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Use a session boundary between unrelated tasks",
    modeled_savings_u_per_wk: 500_000,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "synthetic", inputs: {}, kind: "MODELED" },
    evidence: {},
    target_metric: "sessions_over_threshold",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    weeks_ago: 0,
    estimate: { basis: "E", rank_value_u_per_wk: 500_000 } as NonNullable<
      RecommendationCard["estimate"]
    >,
    ...overrides,
  };
}

describe("RecCard confidence tier", () => {
  it("shows a D1 chars/4 trim range and an explicit unmeasured token caveat", () => {
    const { container } = render(
      <RecCard
        rec={makeRec({
          detector_id: "D1",
          category: "CONTEXT",
          evidence: {
            component: "CLAUDE_MD",
            source_tokens: 5000,
            source_target: 2000,
            delta_context_tokens: 3000,
            attribution_method: "CHARS4_ESTIMATE",
          },
          range_u_per_wk: [330_000, 700_000],
          pct_of_weekly_spend: 5,
          estimate: {
            basis: "P",
            rank_value_u_per_wk: 500_000,
            summable: true,
            label: "synthetic",
          },
        })}
      />,
    );
    const meter = container.querySelector(".rec-savings-meter");
    expect(meter?.textContent).toContain("$0.33–$0.70");
    expect(meter?.textContent).toContain("range only · no point estimate");
    expect(meter?.textContent).not.toContain("$0.50/wk");
    expect(container.textContent).toContain("estimated file size");
    const expand = container.querySelector("button[aria-expanded='false']");
    if (expand) fireEvent.click(expand);
    expect(container.textContent).toContain("chars/4 heuristic");
    expect(container.textContent).toContain("does not bound token-count uncertainty");
    expect(container.textContent).not.toContain("5.0% of weekly spend");
  });

  it("keeps a point display for settled D1 measured content", () => {
    const { container } = render(
      <RecCard
        rec={makeRec({
          detector_id: "D1",
          category: "CONTEXT",
          evidence: {
            component: "CLAUDE_MD",
            source_tokens: 5000,
            source_target: 2000,
            delta_context_tokens: 3000,
            attribution_method: "MEASURED_CONTENT",
          },
          range_u_per_wk: [330_000, 700_000],
          estimate: {
            basis: "P",
            rank_value_u_per_wk: 500_000,
            summable: true,
            label: "synthetic",
          },
        })}
      />,
    );
    expect(container.querySelector(".rec-savings-meter")?.textContent).toContain("$0.50/wk");
    expect(container.textContent).toContain("measured file size");
  });

  it("shows the estimated weekly range and no tier badge", () => {
    const { container } = render(
      <RecCard
        rec={makeRec({ confidence_tier: "ESTIMATED", range_u_per_wk: [330_000, 700_000] })}
      />,
    );
    expect(container.querySelector(".rec-savings-meter")?.textContent).toContain("$0.50/wk");
    expect(container.querySelector(".rec-savings-meter")?.textContent).toContain("up to $0.70");
    expect(container.querySelector(".rec-confidence-tier")).toBeNull();
    expect(container.querySelector(".rec-chip-row")?.textContent).not.toMatch(
      /unverified|certified|verified|estimated/i,
    );
  });

  it("R6-50: names the low end when the estimate sits at the top of its range", () => {
    const { container } = render(
      <RecCard
        rec={makeRec({
          detector_id: "D8",
          confidence_tier: "ESTIMATED",
          modeled_savings_u_per_wk: 7_198_330,
          range_u_per_wk: [3_393_498, 7_198_330],
        })}
      />,
    );
    const meter = container.querySelector(".rec-savings-meter")?.textContent;
    expect(meter).toContain("as low as $3.39");
    expect(meter).not.toContain("point estimate");
  });

  it.each([
    ["explicit", "UNVERIFIED" as const],
    ["missing", undefined],
  ])("shows no Unverified chip when the tier is %s", (_name, confidence_tier) => {
    const rec = confidence_tier === undefined ? makeRec() : makeRec({ confidence_tier });
    const { container } = render(<RecCard rec={rec} />);
    expect(container.querySelector(".rec-confidence-tier")).toBeNull();
    expect(container.querySelector(".rec-chip-row")?.textContent ?? "").not.toMatch(
      /unverified|certified|verified/i,
    );
  });
});
