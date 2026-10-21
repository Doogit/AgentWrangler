import { describe, expect, it } from "vitest";
import { buildTrigger } from "../../src/query/api/rec-actions/trigger.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

const metrics = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));

describe("U9 r4 money: one $ figure per card", () => {
  it("C2 quotes only the headline figure (the turns after each failure) and says how it is worked out", () => {
    // Real shape: a standalone estimate of $0.63 (main + subagents) beside a $0.29 main-chain headline.
    const c2: CardActionRecommendation = {
      detector_id: "C2",
      lever: "Fix where Claude gets the paths that do not exist.",
      evidence: {
        session_ids: ["s1", "s2"],
        metrics: metrics({ ERROR_COUNT: 16, SESSION_COUNT: 11 }),
      },
      savings_u_per_wk: 634_067,
    };
    const trigger = buildTrigger(c2, { allocated_u_per_wk: null, reliability_u_per_wk: 290_000 });
    const text = `${trigger.summary}\n${trigger.problem}`;
    expect(text).toContain("$0.29");
    expect(text).not.toContain("$0.63");
    expect(trigger.problem).toMatch(/upper bound/);
    expect(trigger.problem).toMatch(/subagent/);
  });
});
