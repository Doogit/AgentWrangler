/**
 * P3.1-T9: review-2 overlaps and netting that change the card text (register
 * `docs/handoffs/2026-09-26-card-review/review-2-findings.md`, S6).
 */
import { describe, expect, it } from "vitest";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

const SESSIONS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, cardTitle(rec)) };
}

describe("S6: D8 nets what a fresh start writes anyway", () => {
  // 18 resumes, each ≥ the 40K base: 18 × 40K = 720K unavoidable; 2.8M − 720K = 2.08M net.
  const rec: CardActionRecommendation = {
    detector_id: "D8",
    lever: RECOMMENDATION_TEMPLATES.D8_CACHE_WRITE_CHURN.lever,
    facts: {
      session_ids: SESSIONS,
      session_count: 7,
      churn_event_count: 18,
      total_churn_creation_tokens: 2_800_000,
      base_prefix_tokens: 40_000,
      net_churn_creation_tokens: 2_080_000,
      regime: "mixed",
    },
  };

  it("shows written again − fresh-start base = net", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).toContain(
      // Review 3 B6 labels the fresh-start part by D8's own resumes.
      "2.8M written again − 720K a fresh start would write anyway (the 40K base prompt, for each of the 18 resumes) = 2.1M net",
    );
    expect(violations).toEqual([]);
  });

  // Review 5 U4: one number per fact; the sessions count is bookkeeping and left the facts.
  it("shows written again and the net as two facts, without a sessions fact", () => {
    const { facts } = card({ ...rec, facts: { ...rec.facts, longest_gap_min: 300 } }).trigger;
    expect(facts).toContainEqual({ label: "Written again", value: "2.8M" });
    expect(facts).toContainEqual({ label: "Net of a fresh start", value: "2.1M" });
    expect(facts.map((fact) => fact.label)).not.toContain("Sessions");
  });

  it("omits the netting line on a row without the new facts", () => {
    const { base_prefix_tokens, net_churn_creation_tokens, ...old } = rec.facts ?? {};
    expect(card({ ...rec, facts: old }).trigger.problem).not.toContain("net");
  });
});

describe("S6: D2 weighs re-reads only and nets the rebuild", () => {
  // 0.1 × 108,412,595 = 10.8M. Gross $12.00 − rebuild $1.50 = $10.50.
  const rec: CardActionRecommendation = {
    detector_id: "D2",
    lever: RECOMMENDATION_TEMPLATES.D2_LONG_FULL_CONTEXT.lever,
    facts: {
      session_ids: SESSIONS.slice(0, 3),
      qualifying_session_count: 3,
      qualifying_turn_count: 516,
      raw_context_average_tokens_per_turn: 214_000,
      cap_weighted_burn_tokens_per_week: 13_057_635,
      cache_read_tokens_per_week: 108_412_595,
      cap_read_coefficient: 0.1,
      suggested_split_count: 3,
      base_prefix_tokens: 30_000,
      summary_tokens: 2_000,
      gross_savings_u_per_wk: 12_000_000,
      rebuild_u_per_wk: 1_500_000,
    },
  };

  // Review 5 M1: 108,412,595 re-reads → 108.4M; the fixture has no spend, so no "($…)".
  it("states raw cache re-reads, no cap weight, no card nickname", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).toContain("These sessions re-read 108.4M cached tokens a week.");
    expect(trigger.problem).not.toContain("0.1 ×");
    expect(trigger.problem).not.toContain("cache-expiry card");
    expect(trigger.problem).not.toContain("13.1M");
    expect(trigger.facts).toContainEqual({
      label: "Cache re-reads a week",
      value: "108.4M tokens",
    });
    expect(violations).toEqual([]);
  });

  it("shows gross − rebuild = net and labels both assumptions", () => {
    const { problem } = card(rec).trigger;
    expect(problem).toContain("$12.00 − $1.50 = $10.50 a week");
    expect(problem).toContain("3 splits × (30K base + 2K summary)");
    expect(problem).toContain(
      "one split for every 150 model calls after the first, in each session, and a 2K summary are assumptions",
    );
  });

  it("omits the netting line on a row without the new facts", () => {
    const { gross_savings_u_per_wk, rebuild_u_per_wk, ...old } = rec.facts ?? {};
    expect(card({ ...rec, facts: old }).trigger.problem).not.toContain("$");
  });
});

describe("H1: the fix goes into the workspace's existing guard", () => {
  const h1 = (operation: string, guard?: boolean): CardActionRecommendation => ({
    detector_id: "H1",
    lever:
      "Add a confirmation guard (permissions.ask) for this destructive command class before it runs again.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        DESTRUCTIVE_OPERATION: { kind: "ENUM", value: operation },
        OPERATION_COUNT: { kind: "COUNT", value: 14 },
      },
    },
    ...(guard === undefined ? {} : { guard_exists: guard }),
  });

  it("adds a rule to the guard, with no ask-rule alternative (card review F6)", () => {
    const { actions, violations } = card(h1("RM_RF", true));
    expect(actions.primary.option_id).toBe("h1-add-to-guard");
    expect(actions.primary.summary).toMatch(/PreToolUse guard/);
    expect(actions.primary.copy_text).toContain("hooks.PreToolUse");
    for (const shape of ["variable", "absolute path", "home folder", "`..`", "`.`", "`*`"]) {
      expect(actions.primary.copy_text).toContain(shape);
    }
    expect(actions.primary.copy_text).not.toContain('"ask": [');
    // F6 dropped the `Bash(rm -rf:*)` ask rule: it would prompt on every scratch cleanup.
    expect(actions.alternatives).toEqual([]);
    for (const safe of ["scratchpad", "Temp folder", "grep pattern"]) {
      expect(actions.primary.copy_text).toContain(safe);
    }
    // Review 5: H1 has no "Why this matters" text yet (deferred item 11).
    expect(violations).toEqual([NO_WHY]);
  });

  it("titles the card after the guard, not permissions.ask", () => {
    expect(cardTitle(h1("RM_RF", true))).toMatch(/PreToolUse guard/);
    expect(cardTitle(h1("RM_RF", true))).not.toContain("permissions.ask");
  });

  it("says what's wrong in terms of the guard, not an ask rule", () => {
    expect(card(h1("RM_RF", true)).trigger.problem).toMatch(/one more rule in it/);
    expect(card(h1("RM_RF", true)).trigger.problem).not.toMatch(/ask rule/);
    expect(card(h1("RM_RF")).trigger.problem).toMatch(/ask rule/);
  });

  it("keeps the ask rule first when there is no guard, or the command is not rm -rf", () => {
    for (const rec of [h1("RM_RF"), h1("RM_RF", false), h1("GIT_RESET_HARD", true)]) {
      const { actions } = card(rec);
      expect(actions.primary.option_id).not.toBe("h1-add-to-guard");
      expect(actions.alternatives).toEqual([]);
      expect(cardTitle(rec)).toBe(rec.lever);
    }
  });
});
