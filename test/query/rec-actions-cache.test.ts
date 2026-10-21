import { describe, expect, it } from "vitest";
import { EFFECT_HANDLERS } from "../../src/effects/registry.js";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { cacheHandler } from "../../src/query/api/rec-actions/families/cache.js";
import {
  assertCardActionsGuardrails,
  buildCardActions,
  buildTrigger,
} from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardActions,
} from "../../src/query/api/rec-actions/types.js";
import { validateAction } from "../../src/query/api/rec-actions/validate.js";

const fixtures: Array<{
  rec: CardActionRecommendation;
  token: string;
  kind: "CONFIG" | "HABIT";
  fileRef: string | null;
}> = [
  {
    rec: {
      detector_id: "B1",
      lever: "cache reads collapsed",
      evidence: { metrics: { CURRENT_TO_PREVIOUS_RATIO: { value: 0.08 } } },
      facts: { session_ids: ["b1-session"] },
    },
    token: "8%",
    kind: "HABIT",
    fileRef: null,
  },
  {
    rec: {
      detector_id: "B2",
      lever: "ttl gap",
      evidence: { metrics: { GAP_DURATION_MS: { value: 7_200_000 } } },
      facts: { session_ids: ["b2-session"] },
    },
    token: "the longest here was 120 min",
    kind: "HABIT",
    fileRef: null,
  },
  {
    rec: {
      detector_id: "B3",
      lever: "resume cache miss",
      evidence: { metrics: { GAP_DURATION_MS: { value: 240_000 } } },
      facts: { session_ids: ["b3-session"] },
    },
    token: "4 min resume gap",
    kind: "HABIT",
    fileRef: null,
  },
  {
    rec: {
      detector_id: "B4",
      lever: "prefix break",
      evidence: { metrics: { CURRENT_CACHE_CREATION_TOKENS: { value: 34_500 } } },
      facts: { session_ids: ["b4-session"] },
    },
    token: "34,500",
    kind: "HABIT",
    fileRef: null,
  },
  {
    rec: {
      detector_id: "D8",
      lever: "cache write churn",
      facts: {
        session_ids: ["d8-session"],
        regime: "5m",
        total_churn_creation_tokens: 48_000,
      },
    },
    token: "48,000",
    kind: "CONFIG",
    fileRef: ".claude/settings.json",
  },
  {
    rec: {
      detector_id: "D8",
      lever: "cache write churn",
      facts: {
        session_ids: ["d8-mixed-session"],
        regime: "mixed",
        total_churn_creation_tokens: 12_000,
      },
    },
    token:
      "Before a break longer than the cache lifetime: if the next task is new, run /clear; if it continues, write a handoff, then /clear; use /compact only as a fallback while the cache is still warm.",
    kind: "HABIT",
    fileRef: null,
  },
];

function direct(rec: CardActionRecommendation): CardActions {
  const result = cacheHandler(rec, { trigger: buildTrigger(rec) });
  if (result === null) throw new Error("cache fixture did not produce actions");
  return result;
}

describe("cache recommendation actions", () => {
  it.each(fixtures)("builds $rec.detector_id directly and through the registry", (fixture) => {
    const handlerActions = direct(fixture.rec);
    const builtActions = buildCardActions(fixture.rec);

    expect(handlerActions.primary.kind).toBe(fixture.kind);
    expect(handlerActions.primary.file_ref).toBe(fixture.fileRef);
    expect(handlerActions.primary.summary).toContain(fixture.token);
    expect(() =>
      assertCardActionsGuardrails(handlerActions, fixture.rec.detector_id),
    ).not.toThrow();
    expect(builtActions.alternatives).toEqual(handlerActions.alternatives);
  });

  it("keeps every B-series option advisory", () => {
    for (const fixture of fixtures.filter((fixture) => fixture.rec.detector_id.startsWith("B"))) {
      for (const option of [direct(fixture.rec).primary, ...direct(fixture.rec).alternatives]) {
        expect(option.kind).toBe("HABIT");
        expect(option.file_ref).toBeNull();
      }
    }
  });

  it("rounds a non-round B1 ratio", () => {
    const actions = direct({
      detector_id: "B1",
      lever: "cache reads collapsed",
      evidence: { metrics: { CURRENT_TO_PREVIOUS_RATIO: { value: 0.333 } } },
    });
    expect(actions.primary.summary).toContain("to 33% of the previous turn");
  });

  it("R6-11: D8's habit tells you to /clear before your first message after a break for a new task", () => {
    const fixture = fixtures.find(
      (fixture) => fixture.rec.detector_id === "D8" && fixture.rec.facts?.regime === "mixed",
    );
    if (fixture === undefined) throw new Error("D8 mixed fixture is missing");
    const actions = direct(fixture.rec);
    expect(actions.primary.summary).toContain("before your first message");
    expect(actions.primary.copy_text).toContain("before your first message");
  });

  it("offers the one-hour caching env block for D8's 5m regime", () => {
    const fixture = fixtures.find(
      (fixture) => fixture.rec.detector_id === "D8" && fixture.rec.facts?.regime === "5m",
    );
    if (fixture === undefined) throw new Error("D8 5m fixture is missing");
    expect(direct(fixture.rec).primary.copy_text).toContain("ENABLE_PROMPT_CACHING_1H");
  });

  it("gives every option its detector's target metric", () => {
    const expected: Record<string, string> = {
      B1: "cache_read_tokens",
      B2: "cache_read_tokens",
      B3: "cache_creation_tokens",
      B4: "cache_creation_tokens",
      D8: "cache_read_to_creation_ratio",
    };
    for (const fixture of fixtures) {
      const actions = direct(fixture.rec);
      for (const option of [actions.primary, ...actions.alternatives]) {
        expect(option.target_metric).toBe(expected[fixture.rec.detector_id]);
      }
    }
  });

  it("passes validation for D8 and B2 and marks B1 unmeasured", () => {
    const d8 = fixtures.find((f) => f.rec.facts?.regime === "mixed");
    const b1 = fixtures.find((f) => f.rec.detector_id === "B1");
    const b2 = fixtures.find((f) => f.rec.detector_id === "B2");
    if (d8 === undefined || b1 === undefined || b2 === undefined)
      throw new Error("fixture missing");
    expect(
      validateAction(direct(d8.rec).primary, "cache_read_to_creation_ratio", EFFECT_HANDLERS, {
        detectorId: "D8",
      }),
    ).toEqual({ ok: true });
    expect(
      validateAction(direct(b2.rec).primary, "cache_read_tokens", EFFECT_HANDLERS, {
        detectorId: "B2",
      }),
    ).toEqual({ ok: true });
    // B1 shares B2's metric name but has no handler of its own.
    expect(
      validateAction(direct(b1.rec).primary, "cache_read_tokens", EFFECT_HANDLERS, {
        detectorId: "B1",
      }),
    ).toEqual({ ok: true, measured: false });
  });

  it("shows long breaks in hours and D8's full session count", () => {
    const b2 = direct({
      detector_id: "B2",
      lever: "ttl gap",
      evidence: { metrics: { GAP_DURATION_MS: { value: 131_460_000 } } },
      facts: { session_ids: ["b2-session"] },
    });
    expect(b2.primary.summary).toContain("the longest here was 36.5 hours");
    const d8 = direct({
      detector_id: "D8",
      lever: "cache write churn",
      facts: {
        session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"],
        session_count: 9,
        regime: "mixed",
      },
    });
    expect(d8.primary.summary).toContain("in 9 sessions");
    expect(d8.primary.copy_text).toContain("(9 in total; 5 listed)");
  });

  it("U9: D8 lists its biggest resumes as a table, shows the price basis and writes the CLAUDE.md line", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D8",
      lever: "cache write churn",
      savings_u_per_wk: 16_809_547,
      facts: {
        session_ids: ["s1", "s2"],
        session_count: 2,
        regime: "mixed",
        churn_event_count: 3,
        longest_gap_min: 2312,
        total_churn_creation_tokens: 5_097_701,
        net_churn_creation_tokens: 3_367_297,
        base_prefix_tokens: 66_554,
        gap_5_15_min_count: 0,
        gap_15_60_min_count: 0,
        gap_60_240_min_count: 2,
        gap_240_plus_min_count: 1,
        top_resumes: [
          "s1|2026-10-03T18:26:51.000Z|2312|300000|233446",
          "s2|2026-10-04T09:00:00.000Z|90|120000|53446",
        ],
      },
    };
    const text = direct(rec).primary.copy_text;
    expect(text).toContain("| s1 | 2026-10-03 18:26 | 38.5 hours | 300,000 | 233,446 |");
    expect(text.indexOf("| s1 |")).toBeLessThan(text.indexOf("| s2 |"));
    expect(text).toContain("Break lengths: 2 of 1 to 4 hours, 1 of 4 hours or more");
    expect(text).toContain("× 64% assumed avoidable × $7.80 per million");
    expect(text).toContain("= $16.81 a week");
    // U9 r4: a habit the user types before leaving, not a CLAUDE.md line Claude cannot act on.
    expect(text).toContain("Before you step away for more than 1 hour, paste this line");
    expect(text).toContain("If this task continues, write a handoff");
    expect(text).not.toContain("<branch>");
    expect(text).toContain("only about breaks");
    const problem = buildTrigger(rec).problem ?? "";
    expect(problem).toContain("read under 20% of what they wrote");
    expect(problem).not.toContain("50K");
  });

  // R2.8 led D8 with B2's longest break; review 3 B6 uses D8's own resumes' longest gap instead.
  it("R2.8: D8 leads with its own longest break; /compact after a break reprocesses uncached", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D8",
      lever: "cache write churn",
      facts: {
        session_ids: ["s1", "s2"],
        session_count: 2,
        churn_event_count: 15,
        total_churn_creation_tokens: 1_655_214,
        regime: "mixed",
        longest_gap_min: 2_190,
      },
    };
    const trigger = buildTrigger(rec);
    expect(trigger.problem).toContain("The longest break before one was 36.5 hours.");
    // Review 5 U2: the sentence moved to "Why this matters" (the copy_text copy is U4's).
    expect(trigger.problem).not.toContain("/compact itself costs");
    expect(trigger.facts).toContainEqual({
      label: "Longest break before a resume",
      value: "36.5 hours",
    });
    const { primary } = direct(rec);
    expect(primary.summary).toContain("the longest break was 36.5 hours");
    expect(primary.copy_text).toContain("- Longest break before one of them: 36.5 hours");
    // Review 5 U4 (R KF 3): the old "full-context turn" claim was wrong.
    expect(primary.copy_text).not.toContain("/compact itself costs");
    expect(primary.copy_text).toContain("reprocesses the whole history as uncached input");
    expect(cardRuleViolations(direct(rec), trigger)).toEqual([]);
  });

  it("drops the 1h-caching suggestion from B2 and the prefix-edit option from idle D8", () => {
    const b2 = fixtures.find((f) => f.rec.detector_id === "B2");
    const d8 = fixtures.find((f) => f.rec.facts?.regime === "mixed");
    if (b2 === undefined || d8 === undefined) throw new Error("fixture missing");
    for (const rec of [b2.rec, d8.rec]) {
      const actions = direct(rec);
      expect(actions.alternatives).toEqual([]);
      expect(actions.primary.copy_text).not.toMatch(/1h caching|ENABLE_PROMPT_CACHING_1H/);
    }
  });

  it.each(fixtures.filter((f) => f.kind === "HABIT"))(
    "$rec.detector_id copy prompt is a complete Claude Code task",
    (fixture) => {
      const prompt = direct(fixture.rec).primary.copy_text;
      for (const section of ["## Context", "## Findings", "## Fix", "## Steps", "## Notes"]) {
        expect(prompt).toContain(section);
      }
      expect(prompt).toContain((fixture.rec.facts?.session_ids as string[])[0]);
      expect(prompt).toContain("~/.claude/projects/");
      expect(prompt).toMatch(/Ask me to confirm/);
    },
  );

  it("points B1 at an in-cache prefix change, not idle expiry, starting at the collapse turn", () => {
    const prompt = direct({
      detector_id: "B1",
      lever: "cache reads collapsed",
      evidence: {
        anchors: [
          { timestamp: "2026-09-22T16:48:36.075Z" },
          { timestamp: "2026-09-22T16:49:59.282Z" },
        ],
        metrics: {
          PREVIOUS_CACHE_READ_TOKENS: { value: 240_000 },
          CURRENT_CACHE_READ_TOKENS: { value: 12_000 },
          CURRENT_TO_PREVIOUS_RATIO: { value: 0.05 },
        },
      },
      facts: { session_ids: ["b1-session"] },
    }).primary.copy_text;
    expect(prompt).toContain("Start with the turn at 2026-09-22T16:49:59.282Z");
    expect(prompt).toContain("240,000 to 12,000");
    expect(prompt).toMatch(/idle break is not the cause/);
    // 0 of 12 real collapses were a /model switch, so the copy no longer lists it as a cause.
    expect(prompt).toMatch(/CLAUDE\.md or memory edit/);
    expect(prompt).not.toMatch(/model switch/);
  });

  it.each([
    {
      rec: {
        detector_id: "B1",
        lever: "x",
        evidence: {
          metrics: {
            PREVIOUS_CACHE_READ_TOKENS: { value: 240_000 },
            CURRENT_CACHE_READ_TOKENS: { value: 12_000 },
          },
        },
      },
      text: "Cache reads fell from 240K to 12K tokens",
    },
    {
      rec: {
        detector_id: "B2",
        lever: "x",
        evidence: {
          metrics: {
            GAP_DURATION_MS: { value: 7_200_000 },
            PREVIOUS_CACHE_READ_TOKENS: { value: 90_000 },
            CURRENT_CACHE_READ_TOKENS: { value: 0 },
          },
        },
      },
      text: "the longest break was 120 min",
    },
    {
      rec: {
        detector_id: "B3",
        lever: "x",
        evidence: {
          metrics: {
            GAP_DURATION_MS: { value: 240_000 },
            CURRENT_CACHE_CREATION_TOKENS: { value: 64_000 },
            BASE_PREFIX_TOKENS: { value: 21_000 },
          },
        },
      },
      text: "started 4 min after the previous one and wrote 64K tokens (a fresh start here is about 21K)",
    },
    {
      rec: {
        detector_id: "B4",
        lever: "x",
        evidence: { metrics: { CURRENT_CACHE_CREATION_TOKENS: { value: 34_500 } } },
      },
      text: "write 35K tokens of context again",
    },
    {
      rec: {
        detector_id: "D8",
        lever: "x",
        facts: { churn_event_count: 15, total_churn_creation_tokens: 1_655_214, session_count: 8 },
      },
      // No session ids are stored, so none are listed (review 3 B8: "N listed" is the real list).
      text: "15 main-conversation turns in 8 sessions came after the prompt cache had expired",
    },
  ] as Array<{ rec: CardActionRecommendation; text: string }>)(
    "states what is wrong on the $rec.detector_id card",
    ({ rec, text }) => {
      expect(buildTrigger(rec).problem).toContain(text);
    },
  );

  it.each([
    { kind: "CONFIG" as const, file_ref: null },
    { kind: "HABIT" as const, file_ref: ".claude/settings.json" },
  ])("rejects a B-series CONFIG or file action", (override) => {
    const fixture = fixtures.find((fixture) => fixture.rec.detector_id === "B1");
    if (fixture === undefined) throw new Error("B1 fixture is missing");
    const invalid = direct(fixture.rec);
    invalid.primary = {
      ...invalid.primary,
      ...override,
    };
    expect(() => assertCardActionsGuardrails(invalid, "B1")).toThrow(/advise-only/);
  });
});
