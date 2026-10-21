/**
 * Review 5: "Why this matters". The texts below are the review-5 fix plan's exact strings (U2),
 * not copied from output. The cost explanations that used to sit in What's wrong move here.
 */
import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

const SESSIONS = ["s1", "s2", "s3"];

const TEXTS = {
  D2: "Each model call re-reads the whole conversation so far from the prompt cache, at a fraction of the input price. In a long session that history is large, so every call pays for it again. Anthropic has not published how much a cache read counts against a subscription's usage cap.",
  D8: "The prompt cache keeps the conversation for a limited time, 5 minutes or 1 hour depending on the cache tier a call writes to, counted from the start of each call. After a longer break the next call writes the whole context again at the cache-write price. Writing a handoff and running /clear before the break avoids that; /compact after the break reprocesses the whole history as uncached input.",
  C1: "A failed call usually costs a turn: Claude reads the error and tries something else, and each call re-sends the whole context. A cause that repeats across sessions can often be fixed once.",
  C9_HOOK_BLOCK:
    "Each block makes Claude spend a turn re-planning, re-sending the whole context. Blocks the guard exists to make are worth that turn; blocks of harmless calls are pure cost.",
  C9_DENY_RULE:
    "Each denial makes Claude spend a turn re-planning, re-sending the whole context. A rule that keeps blocking the same command is often one Claude was never told about, or broader than it needs to be.",
  C9_USER_REJECTED:
    "Each rejection makes Claude spend a turn re-planning, re-sending the whole context. One standing instruction in CLAUDE.md usually stops Claude proposing the kind of call you keep rejecting.",
  D11: "When a shell cannot parse a command or does not have it, such as `grep` or `head` in PowerShell, the call fails and Claude spends a turn retrying. Running those commands in the shell that has them avoids the failure.",
  D7_LOOPS:
    // Review 5 residual: the card counts post-compaction re-reads too, so they are not "not a loop".
    "A repeated call adds a turn that re-sends the whole context without moving the task on. Repeats can follow an error Claude did not act on. A file read again after compaction or tool-result clearing dropped it is needed; this card cannot tell those reads apart, so it counts them too.",
  D7_REREADS:
    "A new session starts without the files an earlier session read, so it reads them again; after a /clear that is expected. Pointing each task at the section it needs keeps those reads small.",
  A1: "A tool result stays in the conversation and is re-sent on every later call until /clear, compaction or tool-result clearing removes it. A large result read whole, when the task needs one part, pays for the rest on every call after it.",
};

const c9 = (denialClass: string): CardActionRecommendation => ({
  detector_id: "C9",
  lever: "Review recurring blocked tool requests before repeating the same command shape.",
  facts: { session_ids: SESSIONS, DENIAL_CLASS: denialClass, DENIAL_COUNT: 5 },
});

/** One fixture per id with enough stored metrics for a full What's wrong. */
const FIXTURES: Array<[keyof typeof TEXTS, CardActionRecommendation]> = [
  [
    "D2",
    {
      detector_id: "D2",
      lever: "split",
      facts: {
        session_ids: SESSIONS,
        qualifying_session_count: 3,
        qualifying_turn_count: 620,
        raw_context_average_tokens_per_turn: 212_345,
        cache_read_tokens_per_week: 108_400_000,
        cap_weighted_burn_tokens_per_week: 14_000_000,
      },
    },
  ],
  [
    "D8",
    {
      detector_id: "D8",
      lever: "cache write churn",
      facts: {
        session_ids: SESSIONS,
        session_count: 3,
        churn_event_count: 18,
        total_churn_creation_tokens: 2_800_000,
        regime: "mixed",
      },
    },
  ],
  [
    "C1",
    {
      detector_id: "C1",
      lever: "errors",
      facts: { session_ids: SESSIONS, TOOL_ERROR_COUNT: 42, TOOL_CALL_COUNT: 404 },
    },
  ],
  ["C9_HOOK_BLOCK", c9("HOOK_BLOCK")],
  ["C9_DENY_RULE", c9("DENY_RULE")],
  ["C9_USER_REJECTED", c9("USER_REJECTED")],
  [
    "D11",
    {
      detector_id: "D11",
      lever: "ROUTE_SHELL_TOOL_V1",
      facts: {
        session_ids: SESSIONS,
        preferred_tool: "Bash",
        higher_error_tool: "PowerShell",
        powershell_error_count: 25,
        powershell_call_count: 100,
        bash_error_count: 5,
        bash_call_count: 100,
      },
    },
  ],
  [
    "D7_LOOPS",
    {
      detector_id: "D7",
      lever: "loops",
      facts: { session_ids: SESSIONS, loop_flagged_turn_count: 12 },
    },
  ],
  [
    "D7_REREADS",
    {
      detector_id: "D7",
      lever: "rereads",
      facts: { session_ids: SESSIONS, redundant_path_count: 4, total_redundant_read_count: 20 },
    },
  ],
  [
    "A1",
    {
      detector_id: "A1",
      lever: "spill",
      facts: {
        session_ids: SESSIONS,
        EVENT_COUNT: 40,
        RESULT_BYTES_TOTAL: 1_500_000,
        MAX_RESULT_BYTES: 64_000,
      },
    },
  ],
];

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean).length;

describe("Why this matters", () => {
  it.each(FIXTURES)("%s carries its exact text", (id, rec) => {
    expect(buildTrigger(rec).why).toBe(TEXTS[id]);
  });

  it.each(FIXTURES)("%s: What's wrong no longer carries the cost explanation", (_id, rec) => {
    expect(buildTrigger(rec).problem).toBeTruthy();
    expect(buildTrigger(rec).problem).not.toMatch(
      /costs a turn|re-sends the whole context|re-reads the whole conversation|\/compact itself costs/,
    );
  });

  it("gives other detectors no text", () => {
    const h1: CardActionRecommendation = {
      detector_id: "H1",
      lever: "ask",
      facts: { session_ids: SESSIONS, DESTRUCTIVE_OPERATION: "RM_RF", OPERATION_COUNT: 3 },
    };
    expect(buildTrigger(h1).why).toBeUndefined();
    expect("why" in buildTrigger(h1)).toBe(false);
  });

  it("keeps every text short, plain and within the card rules", () => {
    // Hand counts: D8 69 words (U9 r5 dropped the plan-rule clause), D2 59 words.
    expect(words(TEXTS.D8)).toBe(69);
    expect(words(TEXTS.D2)).toBe(50);
    for (const text of Object.values(TEXTS)) {
      expect(words(text)).toBeLessThanOrEqual(70);
      expect(sentences(text)).toBeLessThanOrEqual(3);
      expect(text).not.toMatch(/select[\s\S]*from/i);
    }
    expect(TEXTS.D7_REREADS).not.toContain("whole");
    expect(TEXTS.D2).not.toContain("tenth");
    // U9 r8: the reliability claim is not measured on the user's sessions, so it is not stated.
    expect(TEXTS.D2).not.toContain("less reliable");
    expect(TEXTS.D8).toContain("from the start of each call");
    expect(TEXTS.D8).toContain("depending on the cache tier a call writes to");
    expect(TEXTS.D8).not.toContain("usage credits");
  });

  it.each(FIXTURES)("%s: the why passes the card rules' why checks", (_id, rec) => {
    const violations = cardRuleViolations(buildCardActions(rec), buildTrigger(rec));
    expect(violations.filter((v) => /why this matters/i.test(v))).toEqual([]);
  });
});

describe("M1: D2 states raw cache re-reads, never a cap weight", () => {
  // 291,100,000 tokens → 291.1M; 78,350,000 µUSD → $78.35.
  const rec: CardActionRecommendation = {
    detector_id: "D2",
    lever: "split",
    facts: {
      session_ids: SESSIONS,
      qualifying_session_count: 3,
      qualifying_turn_count: 620,
      raw_context_average_tokens_per_turn: 212_345,
      cache_read_tokens_per_week: 291_100_000,
      cache_read_spend_u_per_wk: 78_350_000,
      cap_weighted_burn_tokens_per_week: 40_000_000,
      cap_read_coefficient: 0.1,
      suggested_split_count: 3,
      base_prefix_tokens: 30_000,
      summary_tokens: 2_000,
      gross_savings_u_per_wk: 12_000_000,
      rebuild_u_per_wk: 1_500_000,
      reduction_fraction: 0.153,
    },
  };

  it("fact 4 is the weekly re-reads with their spend", () => {
    const trigger = buildTrigger(rec);
    expect(trigger.facts).toContainEqual({
      label: "Cache re-reads a week",
      value: "291.1M tokens ($78.35)",
    });
    expect(trigger.problem).toContain("These sessions re-read 291.1M cached tokens a week.");
    expect(trigger.problem).not.toMatch(/usage cap|0\.1 ×|cache-expiry card/);
    expect(cardRuleViolations(buildCardActions(rec), trigger)).toEqual([]);
  });

  it("drops the spend when it is absent", () => {
    const { cache_read_spend_u_per_wk, ...facts } = rec.facts ?? {};
    expect(buildTrigger({ ...rec, facts }).facts).toContainEqual({
      label: "Cache re-reads a week",
      value: "291.1M tokens",
    });
  });

  it("omits the fact on an older row without re-reads", () => {
    const { cache_read_tokens_per_week, ...facts } = rec.facts ?? {};
    const trigger = buildTrigger({ ...rec, facts });
    const labels = trigger.facts.map((fact) => fact.label);
    expect(labels).not.toContain("Cache re-reads a week");
    expect(labels.some((label) => /usage cap/.test(label))).toBe(false);
    expect(trigger.problem).not.toMatch(/usage cap/);
  });
});

describe("card rules: Why this matters", () => {
  const actions = {
    primary: {
      option_id: "x",
      kind: "HABIT" as const,
      summary: "Do it",
      detail: [],
      copy_text: "## Context\n## Findings\n## Fix\n## Steps\n1. Ask me to confirm.\n2. Verify: ok.",
      file_ref: null,
    },
    alternatives: [],
  };
  const trigger = (why?: string) => ({
    session_ids: [],
    window: null,
    facts: [{ label: "Runs", value: "2" }],
    problem: "It ran 2 times.",
    ...(why === undefined ? {} : { why }),
  });

  it("passes a short why", () => {
    expect(cardRuleViolations(actions, trigger("A. B."))).toEqual([]);
  });

  it("flags a card with no why (operator 2026-09-26)", () => {
    expect(NO_WHY).toBe("no Why this matters text");
    expect(cardRuleViolations(actions, trigger())).toEqual([NO_WHY]);
  });

  it("flags a 4-sentence why", () => {
    expect(cardRuleViolations(actions, trigger("A. B. C. D."))).toEqual([
      "Why this matters has 4 sentences (at most 3)",
    ]);
  });

  it("flags a why over 70 words", () => {
    const long = `${Array.from({ length: 71 }, () => "word").join(" ")}.`;
    expect(cardRuleViolations(actions, trigger(long))).toEqual([
      "Why this matters has 71 words (at most 70)",
    ]);
  });

  it("flags a detector code or a SQL fragment in the why", () => {
    expect(cardRuleViolations(actions, trigger("D4 fired."))).toEqual([
      'detector code "D4" in Why this matters',
    ]);
    expect(cardRuleViolations(actions, trigger("It ran `D4` fine."))).toEqual([]);
    expect(cardRuleViolations(actions, trigger("Select rows from the table."))).toEqual([
      "Why this matters contains a query (select … from)",
    ]);
  });
});
