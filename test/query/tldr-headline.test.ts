/**
 * P3.L-F: the TL;DR quotes the headline $ (spec `docs/plans/Archive/2026-10-03-tldr-headline-spec.md`).
 * Expectations come from the spec's table, not from the implementation.
 */
import { describe, expect, it } from "vitest";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

// D2 headline $28.79 vs standalone $28.95 (the live case in the spec).
const d2 = (): CardActionRecommendation => ({
  detector_id: "D2",
  lever: "split",
  savings_u_per_wk: 28_950_000,
  facts: {
    session_ids: ["s1"],
    qualifying_session_count: 5,
    qualifying_turn_count: 907,
    raw_context_average_tokens_per_turn: 208_000,
  },
});

// C1 headline is the reliability upper bound $10.30; standalone is $1.57.
const c1 = (): CardActionRecommendation => ({
  detector_id: "C1",
  lever: "fix",
  savings_u_per_wk: 1_570_000,
  facts: { session_ids: ["s1"], TOOL_ERROR_COUNT: 37, TOOL_CALL_COUNT: 349 },
});

// D1 with an estimated size shows only a range today.
const d1Estimated = (): CardActionRecommendation => ({
  detector_id: "D1",
  lever: "trim",
  savings_u_per_wk: 195_000,
  savings_range_u_per_wk: [100_000, 400_000],
  facts: {
    component: "CLAUDE_MD",
    source_file_ref: "CLAUDE.md",
    attribution_method: "ESTIMATED",
    source_tokens: 30_000,
    source_target: 20_000,
    delta_context_tokens: 1_000,
    turns_per_week: 1_560,
  },
});

describe("TL;DR $ clause follows the table", () => {
  it("allocated number > $0.00: point $ from allocated, not the standalone figure", () => {
    const t = buildTrigger(d2(), { allocated_u_per_wk: 28_790_000 });
    expect(t.summary).toContain(" Fixing it saves about $28.79 a week.");
    expect(t.summary).not.toContain("$28.95");
  });

  it("allocated number on a D1 estimated card: point, never the range", () => {
    const t = buildTrigger(d1Estimated(), { allocated_u_per_wk: 150_000 });
    expect(t.summary).toContain(" Fixing it saves about $0.15 a week.");
    expect(t.summary).not.toContain("–");
  });

  // Re-review N4 (operator 2026-10-05): above the range the card shows the range only (F1), so the
  // TL;DR and the problem quote the range, not the larger net figure.
  it("allocated above the card's range: TL;DR and problem quote the range", () => {
    const t = buildTrigger(d1Estimated(), { allocated_u_per_wk: 2_590_000 });
    expect(t.summary).toContain(" Fixing it saves about $0.10–$0.40 a week.");
    expect(t.problem).toContain("$0.10–$0.40");
    expect(t.summary).not.toContain("$2.59");
    expect(t.problem).not.toContain("$2.59");
  });

  it("allocated shows as $0.00: no clause", () => {
    const t = buildTrigger(d2(), { allocated_u_per_wk: 4_000 });
    expect(t.summary).not.toMatch(/\$\d/);
    expect(t.summary).not.toContain("saves");
  });

  it("allocated 0 on a rec with a standalone $: no clause", () => {
    const t = buildTrigger(d2(), { allocated_u_per_wk: 0 });
    expect(t.summary).not.toContain("saves about");
  });

  it("allocated null with reliability > $0.00: 'failures cost up to'", () => {
    const t = buildTrigger(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: 10_300_000 });
    expect(t.summary).toContain(" The failures cost up to $10.30 a week.");
    expect(t.summary).not.toContain("saves");
    expect(t.summary).not.toContain("$1.57");
  });

  it("allocated null with reliability that rounds to $0.00: says 'under $0.01', as the card headline does (U9 r6)", () => {
    const t = buildTrigger(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: 3_000 });
    expect(t.summary).toContain(" The failures cost under $0.01 a week.");
    expect(t.summary).not.toContain("$0.00");
    const zero = buildTrigger(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: 0 });
    expect(zero.summary).not.toMatch(/\$\d/);
  });

  it("allocated null with no reliability: no clause", () => {
    const none = buildTrigger(c1(), { allocated_u_per_wk: null });
    expect(none.summary).not.toMatch(/\$\d/);
    const nul = buildTrigger(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: null });
    expect(nul.summary).not.toMatch(/\$\d/);
  });

  it("allocated undefined (legacy): byte-identical to today's output", () => {
    for (const rec of [d2(), c1(), d1Estimated()]) {
      const legacy = buildTrigger(rec);
      expect(buildTrigger(rec, {})).toEqual(legacy);
      expect(buildTrigger(rec, { reliability_u_per_wk: 5_000_000 })).toEqual(legacy);
    }
    expect(buildTrigger(d2()).summary).toContain("saves about $28.95 a week");
    expect(buildTrigger(d1Estimated()).summary).toContain("saves about $0.10–$0.40 a week");
  });
});

describe("What's wrong carries the same number", () => {
  it("appends the overlap sentence when the problem lacks the allocated $", () => {
    const base = buildTrigger(d2()).problem as string;
    const t = buildTrigger(d2(), { allocated_u_per_wk: 28_790_000 });
    expect(t.problem).toBe(
      `${base} After overlap with other cards, this card's share is $28.79 a week.`,
    );
  });

  it("appends the reliability sentence when the problem lacks the reliability $", () => {
    const base = buildTrigger(c1()).problem as string;
    const t = buildTrigger(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: 10_300_000 });
    expect(t.problem).toBe(`${base} The turns after these failures cost up to $10.30 a week.`);
  });

  it("appends nothing when the problem already contains the $", () => {
    // The D1 derivation already says "= $0.20 a week" for a 195,000 standalone.
    const { savings_range_u_per_wk: _range, ...rec } = d1Estimated();
    const base = buildTrigger(rec).problem as string;
    expect(base).toContain("$0.20");
    const t = buildTrigger(rec, { allocated_u_per_wk: 195_000 });
    expect(t.problem).toBe(base);
  });

  it("appends nothing when the TL;DR has no $ clause", () => {
    const base = buildTrigger(d2()).problem;
    expect(buildTrigger(d2(), { allocated_u_per_wk: 0 }).problem).toBe(base);
    expect(buildTrigger(c1(), { allocated_u_per_wk: null }).problem).toBe(
      buildTrigger(c1()).problem,
    );
  });
});

describe("card rule: every TL;DR number is backed", () => {
  const tldrViolations = (rec: CardActionRecommendation, headline: object) => {
    const actions = buildCardActions(rec);
    return cardRuleViolations(actions, buildTrigger(rec, headline)).filter((v) =>
      v.startsWith("TL;DR says"),
    );
  };

  it("D2 with allocated passes", () => {
    expect(tldrViolations(d2(), { allocated_u_per_wk: 28_790_000 })).toEqual([]);
  });

  it("C1 with reliability passes", () => {
    expect(
      tldrViolations(c1(), { allocated_u_per_wk: null, reliability_u_per_wk: 10_300_000 }),
    ).toEqual([]);
  });
});
