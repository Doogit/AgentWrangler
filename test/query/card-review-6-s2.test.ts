/**
 * P3.1-T11 S2: review-6 P1 findings that live in `rec-actions/trigger.ts`
 * (register `docs/handoffs/2026-09-26-card-review/review-6-fix-plan.md`).
 *
 * In scope: R6-03 (text part), R6-05, R6-15 (text part), R6-25 (label/text part).
 * R6-10's "(subagent)" tag was already correct on current code (see report); not reproduced here.
 */
import { describe, expect, it } from "vitest";
import { buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

function metrics(values: Record<string, number | string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}

describe("R6-03: A1 keeps the total carry as a fact when the range covers only the lead", () => {
  const rec = (allCarry: number, savings: number): CardActionRecommendation => ({
    detector_id: "A1",
    lever: "spill",
    savings_u_per_wk: savings,
    evidence: {
      metrics: metrics({
        EVENT_COUNT: 362,
        MAX_RESULT_BYTES: 62_000,
        RESULT_BYTES_TOTAL: 13_400_000,
        ALL_RESULTS_CARRY_U_PER_WK: allCarry,
      }),
    },
  });

  it("shows the all-results carry as a fact when it exceeds the lead-only rank", () => {
    const trigger = buildTrigger(rec(16_920_000, 7_980_000));
    expect(trigger.facts).toContainEqual({ label: "All large results", value: "$16.92/wk" });
  });

  it("omits the fact when the rank already covers all the results", () => {
    const trigger = buildTrigger(rec(7_980_000, 7_980_000));
    expect(trigger.facts.some((fact) => fact.label === "All large results")).toBe(false);
  });
});

describe("R6-05: D1 problem text shows the avoidance fraction behind its $ figure", () => {
  const d1 = (delta: number, turns: number, savings: number, component = "CLAUDE_MD") => ({
    detector_id: "D1",
    lever: "trim",
    savings_u_per_wk: savings,
    facts: {
      component,
      source_file_ref: "CLAUDE.md",
      attribution_method: "MEASURED_CONTENT",
      source_tokens: 30_000,
      source_target: 20_000,
      delta_context_tokens: delta,
      turns_per_week: turns,
    },
  });

  it("names the 50% fraction and the derived $ saving", () => {
    // 22,387 x 2,799 = 62,657,013 tokens/wk; x 50% x ~$0.25/M = $7.86/wk.
    const problem = buildTrigger(d1(22_387, 2_799, 7_860_000)).problem;
    expect(problem).toContain("62.7M tokens a week");
    expect(problem).toContain("× 50%");
    expect(problem).toContain("$7.86 a week");
    expect(problem).toContain("no trim has been observed yet (0 of 10 probes)");
  });

  it("shows the same derivation for the MEMORY component, not a bare $0.20", () => {
    // 1,000 x 1,560 = 1,560,000 tokens/wk; x 50% x $0.25/M = $0.195 -> $0.20/wk.
    const problem = buildTrigger(d1(1_000, 1_560, 195_000, "MEMORY")).problem;
    expect(problem).toContain("× 50%");
    expect(problem).toContain("$0.20 a week");
  });
});

describe("R6-15: A1 copy names Claude Code's own tool-result clearing, not just /clear or compaction", () => {
  const rec: CardActionRecommendation = {
    detector_id: "A1",
    lever: "spill",
    evidence: {
      metrics: metrics({
        EVENT_COUNT: 38,
        MAX_RESULT_BYTES: 62_000,
        RESULT_BYTES_TOTAL: 1_400_000,
      }),
    },
  };

  it("the TL;DR names tool-result clearing", () => {
    expect(buildTrigger(rec).summary).toContain("tool-result clearing");
  });

  it("the full problem names tool-result clearing", () => {
    expect(buildTrigger(rec).problem).toContain("tool-result clearing");
  });
});

describe("R6-25: D7 loops note the $ is priced at the turn that made the call; C1 states its headline basis", () => {
  it("D7 loops", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D7",
      lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
      savings_u_per_wk: 5_060_000,
      facts: {
        loop_flagged_turn_count: 224,
        repeat_excess_turn_count: 224,
        repeat_excess_read_u: 6_000_000,
        repeat_excess_write_u: 2_000_000,
        repeat_excess_io_u: 2_000_000,
        repeat_excess_cost_u: 10_000_000,
      },
    };
    expect(buildTrigger(rec).problem).toMatch(/priced at the turn that made the call/i);
  });

  it("C1", () => {
    const rec: CardActionRecommendation = {
      detector_id: "C1",
      lever: "Find the causes behind the failed tool calls before retrying or replacing the tool.",
      savings_u_per_wk: 3_000_000,
      evidence: {
        metrics: metrics({
          TOOL_ERROR_COUNT: 10,
          TOOL_CALL_COUNT: 100,
          CLAIMED_TURN_COUNT: 8,
        }),
      },
    };
    // Rule 10: C1 no longer claims a price basis; U9: it states that the headline prices other turns.
    expect(buildTrigger(rec).problem).toMatch(/different, smaller set of turns/i);
    expect(buildTrigger(rec).problem).not.toMatch(/priced at the turn that made the call/i);
  });
});
