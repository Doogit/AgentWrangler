/**
 * P3.1-T1: the operator's review-1 findings that live in the card layer, one block per finding id
 * (register `docs/handoffs/2026-09-26-card-review/review-1-findings.md`, triage note
 * `.claude/audits/certification/p3-1/2026-09-26-review-1-triage.md`).
 */
import { describe, expect, it } from "vitest";
import { c7FindingDescriptor as C7_DESCRIPTOR } from "../../src/detector/detectors/c7_bash_failure_cluster.js";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { ERROR_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/errors.js";
import { PERMISSIONS_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/permissions.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const WINDOW = { from: "2026-09-19T00:00:00.000Z", to: "2026-09-26T00:00:00.000Z" };
const SESSIONS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

function metrics(values: Record<string, number | string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}

function call(tool: string, target: string, result: string, calls = 1): CardToolCall {
  return {
    target,
    kind: "command",
    tool,
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result,
  };
}

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, rec.lever) };
}

const H1: CardActionRecommendation = {
  detector_id: "H1",
  lever:
    "Add a confirmation guard (permissions.ask) for this destructive command class before it runs again.",
  evidence: {
    session_ids: ["s1", "s2"],
    window: WINDOW,
    metrics: metrics({ DESTRUCTIVE_OPERATION: "RM_RF", OPERATION_COUNT: 4 }),
  },
};

describe("R1.3 + R4.5: H1 asks instead of denying", () => {
  it("proposes a permissions.ask entry, never a deny entry", () => {
    const { actions, trigger, violations } = card(H1);
    expect(actions.primary.option_id).toBe("h1-ask-destructive-operation");
    expect(actions.primary.summary).toContain("ask");
    expect(actions.primary.summary).not.toMatch(/deny/i);
    expect(actions.primary.copy_text).toContain('"ask": ["Bash(rm -rf:*)"]');
    expect(actions.primary.copy_text).not.toContain('"deny"');
    expect(trigger.problem).not.toMatch(/deny/i);
    // Review 5: H1 has no "Why this matters" text yet (deferred item 11), so it fails only on that.
    expect(violations).toEqual([NO_WHY]);
  });

  it("says a prefix rule misses rm -rf variants, which stay with a guard", () => {
    const { actions } = card(H1);
    expect(actions.primary.copy_text).toContain("`rm -fr`");
    expect(actions.primary.copy_text).toContain("`rm -r -f`");
  });
});

describe("R1.3: card-rules checks the title against the action", () => {
  const actions = {
    primary: {
      option_id: "x",
      kind: "INVESTIGATE" as const,
      summary: "Deny it.",
      detail: [],
      copy_text:
        '## Context\n## Findings\n## Fix\n{ "permissions": { "deny": ["Bash(x:*)"] } }\n## Steps\n1. Ask me to confirm.\n2. Verify: done.',
      file_ref: null,
    },
    alternatives: [],
  };
  const trigger = {
    session_ids: [],
    window: null,
    facts: [{ label: "Runs", value: "2" }],
    problem: "It ran.",
    why: "It matters.",
  };

  it("flags a title naming one permissions rule while the action proposes another", () => {
    expect(cardRuleViolations(actions, trigger, "Add a guard (permissions.ask).")).toEqual([
      "title names permissions.ask but the action proposes deny",
    ]);
  });

  it("flags a title naming a permissions rule the action never proposes", () => {
    const none = {
      ...actions,
      primary: {
        ...actions.primary,
        copy_text: actions.primary.copy_text.replace(/\{.*\}/, "Fix it."),
      },
    };
    expect(cardRuleViolations(none, trigger, "Add it to permissions.allow.")).toEqual([
      "title names permissions.allow but the action proposes no permissions rule",
    ]);
  });

  it("passes when they agree, or when the title names no rule", () => {
    expect(cardRuleViolations(actions, trigger, "Deny it (permissions.deny).")).toEqual([]);
    expect(cardRuleViolations(actions, trigger, "Stop the calls.")).toEqual([]);
    expect(cardRuleViolations(actions, trigger)).toEqual([]);
  });

  it("C7's title no longer offers permissions.allow, which its card rejects", () => {
    expect(C7_DESCRIPTOR.presentation.lever).not.toContain("permissions");
    const { violations } = card({
      detector_id: "C7",
      lever: C7_DESCRIPTOR.presentation.lever,
      evidence: {
        session_ids: ["s1"],
        window: WINDOW,
        metrics: metrics({ BASH_FAILURE_COUNT: 6, BASH_COMMAND_FAMILY: "BASH_GIT" }),
      },
    });
    // Review 5: C7 has no "Why this matters" text yet (deferred item 11).
    expect(violations).toEqual([NO_WHY]);
  });
});

describe("R1.4: D7's two templates have their own titles", () => {
  it("the cross-session reads title is about re-reading files, not delegation", () => {
    const lever = RECOMMENDATION_TEMPLATES.D7_CROSS_SESSION_REREAD.lever;
    expect(lever).toMatch(/re-?read/i);
    expect(lever).not.toMatch(/delegat/i);
    expect(lever).not.toBe(RECOMMENDATION_TEMPLATES.D7_RETRY_LOOP.lever);
  });
});

describe("R1.7: C1 names the tool and states its basis", () => {
  const rec: CardActionRecommendation = {
    detector_id: "C1",
    lever: "Inspect the failures before retrying or replacing the affected tool.",
    evidence: {
      session_ids: SESSIONS,
      window: WINDOW,
      metrics: metrics({
        TOOL_CALL_COUNT: 782,
        TOOL_ERROR_COUNT: 80,
        TOOL_ERROR_RATE: 80 / 782,
        CORPUS_CALL_COUNT: 11_459,
        CORPUS_ERROR_RATE: 0.041,
      }),
    },
    tool_calls: [call("PowerShell", "taskkill /PID 1", "Exit code 128", 5)],
  };

  it("says 782 is one tool's calls, out of all tool calls", () => {
    const { trigger, actions, violations } = card(rec);
    expect(trigger.problem).toContain("80 of 782 PowerShell calls failed");
    expect(trigger.problem).toContain("11,459 tool calls");
    expect(trigger.problem).not.toContain("782 tool calls");
    expect(actions.primary.summary).toContain("80 of 782 PowerShell calls");
    expect(violations).toEqual([]);
  });
});

describe("R1.7: D11 states its basis", () => {
  it("says the counts are all shell calls in the workspace, subagents included", () => {
    const { trigger } = card({
      detector_id: "D11",
      lever: "Prefer the measured lower-error shell for repository and file operations.",
      facts: {
        session_ids: SESSIONS,
        bash_error_count: 900,
        bash_call_count: 10_513,
        powershell_error_count: 300,
        powershell_call_count: 1_200,
        preferred_tool: "Bash",
        higher_error_tool: "PowerShell",
      },
    });
    expect(trigger.problem).toMatch(/including subagents/);
  });
});

describe("R1.9: B2 labels summed cache reads and keeps the break apart from the session count", () => {
  it("does not narrate a sum across resumes as one event", () => {
    const { trigger } = card({
      detector_id: "B2",
      lever: "Before a long break, end the task with /clear or run /compact.",
      evidence: {
        session_ids: SESSIONS.slice(0, 5),
        window: WINDOW,
        metrics: metrics({
          GAP_DURATION_MS: 36.5 * 3_600_000,
          PREVIOUS_CACHE_READ_TOKENS: 1_500_000,
          CURRENT_CACHE_READ_TOKENS: 64_000,
        }),
      },
    });
    expect(trigger.problem).toContain("longest break");
    expect(trigger.problem).toMatch(/summed over/);
    expect(trigger.problem).not.toMatch(/^A session resumed/);
    const reads = trigger.facts.find((fact) => fact.label.startsWith("Cache reads"));
    expect(reads?.label).toMatch(/summed/);
  });
});

describe("R1.10: D8 says how many sessions in total and how many are listed", () => {
  // Review 5 U4: the count stays in what's wrong; the "Sessions" fact was bookkeeping and is gone.
  it("writes 'N sessions (M listed)' in what's wrong, with no sessions fact", () => {
    const { trigger } = card({
      detector_id: "D8",
      lever: "Keep related work within a stable cache window and avoid repeated cache rebuilds.",
      facts: {
        session_ids: SESSIONS,
        session_count: 15,
        churn_event_count: 40,
        total_churn_creation_tokens: 2_700_000,
        regime: "mixed",
      },
    });
    expect(trigger.session_ids).toHaveLength(5);
    expect(trigger.problem).toContain("15 sessions (5 listed)");
    expect(trigger.facts.map((fact) => fact.label)).not.toContain("Sessions");
  });
});

describe("R1.11: D7 retry-loop breakdown", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D7",
    lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
    facts: {
      session_ids: SESSIONS,
      loop_flagged_turn_count: 863,
      loop_flagged_turn_share: 0.055,
      // U9 r7: the share is stated against the loop sessions' own turns.
      total_turn_count: 15_691,
      session_count: 7,
      repeat_excess_event_count: 358,
      identical_call_event_count: 48,
      test_fail_event_count: 12,
      redundant_read_event_count: 300,
      three_gram_loop_event_count: 20,
      error_loop_event_count: 86,
      edit_without_prior_read_event_count: 9,
    },
  };

  it("lists all five loop kinds and says they overlap", () => {
    const { trigger, actions } = card(rec);
    for (const text of [trigger.problem ?? "", actions.primary.copy_text]) {
      expect(text).toContain("48 identical calls");
      expect(text).toContain("12 failing test runs");
      expect(text).toContain("300 repeated reads");
      expect(text).toContain("20 repeated call sequences");
      expect(text).toContain("86 repeats of the same error");
      // Review 2 D7a1: an edit without a prior read is not a loop.
      expect(text).not.toContain("edits without a fresh read");
      expect(text).toMatch(/overlap/);
    }
  });

  it("rounds the share the same way on the card and in the prompt", () => {
    const { trigger, actions } = card(rec);
    expect(trigger.problem).toContain("5.5% of the 15,691 turns in these 7 sessions");
    expect(actions.primary.copy_text).toContain("5.5% of the 15,691 turns in these 7 sessions");
    expect(trigger.problem).not.toContain("of all turns");
    expect(actions.primary.copy_text).not.toContain("6%");
  });
});

describe("R1.12: D4's title does not promise usage limits", () => {
  it("drops 'Check usage limits'", () => {
    expect(RECOMMENDATION_TEMPLATES.D4_MODEL_MISMATCH.lever).not.toMatch(/usage limit/i);
  });
});

describe("R3.1: every card with a problem statement has facts", () => {
  const cards: CardActionRecommendation[] = [
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
        cap_read_coefficient: 0.1,
      },
    },
    {
      detector_id: "D4",
      lever: "route",
      facts: {
        session_ids: SESSIONS,
        mismatch_turns_per_week: 400,
        total_opus_turns_per_week: 1000,
        avg_output_tokens: 210,
        opus_subagent_count: 30,
        lookup_subagent_count: 12,
      },
    },
    {
      detector_id: "D6",
      lever: "range",
      facts: {
        session_ids: SESSIONS,
        session_count: 3,
        tool_result_bytes: 2_400_000,
        bloat_share: 0.41,
      },
    },
    {
      detector_id: "D7",
      lever: "reads",
      facts: {
        session_ids: SESSIONS,
        redundant_path_count: 40,
        total_redundant_read_count: 400,
        total_redundant_result_bytes: 9_600_000,
        max_path_read_count: 69,
        max_path_session_count: 31,
      },
    },
    {
      detector_id: "D7",
      lever: "loops",
      facts: {
        session_ids: SESSIONS,
        loop_flagged_turn_count: 863,
        loop_flagged_turn_share: 0.055,
      },
    },
    {
      detector_id: "D10",
      lever: "catalog",
      facts: { catalog_tokens: 62_000, catalog_target_tokens: 40_000 },
    },
    {
      detector_id: "D12",
      lever: "compact",
      facts: {
        session_ids: SESSIONS,
        sidechain_result_bytes: 163_000,
        sidechain_turn_count: 84,
        sidechain_session_count: 6,
      },
    },
    {
      detector_id: "D14",
      lever: "stop",
      evidence: {
        session_ids: SESSIONS,
        window: WINDOW,
        metrics: metrics({ INTERRUPT_KIND: "PURE_INTERRUPT", INTERRUPT_COUNT: 3 }),
      },
    },
    {
      detector_id: "C1",
      lever: "failures",
      evidence: {
        session_ids: SESSIONS,
        window: WINDOW,
        metrics: metrics({ TOOL_CALL_COUNT: 782, TOOL_ERROR_COUNT: 80, CORPUS_ERROR_RATE: 0.04 }),
      },
    },
    {
      detector_id: "C7",
      lever: "commands",
      evidence: {
        session_ids: SESSIONS,
        window: WINDOW,
        metrics: metrics({ BASH_FAILURE_COUNT: 6, BASH_COMMAND_FAMILY: "BASH_GIT" }),
      },
    },
    {
      detector_id: "C9",
      lever: "blocks",
      evidence: {
        session_ids: SESSIONS,
        window: WINDOW,
        metrics: metrics({ DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 5 }),
      },
    },
    H1,
    {
      detector_id: "A2",
      lever: "compact",
      evidence: {
        session_ids: SESSIONS,
        window: WINDOW,
        metrics: metrics({ EVENT_COUNT: 6, RESULT_BYTES_TOTAL: 180_000, MAX_RESULT_BYTES: 52_000 }),
      },
    },
  ];

  it.each(cards)("$detector_id ($lever) states facts", (rec) => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).toBeTruthy();
    expect(trigger.facts.length).toBeGreaterThan(0);
    // Review 5: cards without a "Why this matters" text yet fail only on that (deferred item 11).
    const hasWhy = ["D2", "D7", "C1", "C9"].includes(rec.detector_id);
    expect(violations).toEqual(hasWhy ? [] : [NO_WHY]);
  });

  it("card-rules flags a problem statement without facts", () => {
    const actions = buildCardActions(H1);
    const trigger = { ...buildTrigger(H1), facts: [] };
    expect(cardRuleViolations(actions, trigger)).toContain("no facts behind what's wrong");
  });
});

describe("R3.3 + review 5 M1: D2 shows raw cache re-reads, no cap weight", () => {
  it("states the weekly re-reads, never a usage-cap figure", () => {
    const { trigger } = card({
      detector_id: "D2",
      lever: "split",
      facts: {
        session_ids: SESSIONS,
        qualifying_session_count: 3,
        qualifying_turn_count: 620,
        raw_context_average_tokens_per_turn: 212_345,
        cache_read_tokens_per_week: 108_400_000,
        cap_weighted_burn_tokens_per_week: 14_000_000,
        cap_read_coefficient: 0.1,
      },
    });
    // Review 5 M1: Anthropic has not published a cache read's weight on the cap, so the card
    // states the raw 108,400,000 re-reads (108.4M) and no cap figure; the fixture has no spend.
    expect(trigger.problem).toContain("108.4M");
    expect(trigger.problem).not.toMatch(/usage cap|0\.1 ×/);
    expect(trigger.facts).toContainEqual({
      label: "Cache re-reads a week",
      value: "108.4M tokens",
    });
  });
});

describe("R3.4: D11 moves to the errors lane", () => {
  it("is built by the errors family, not permissions", () => {
    expect(ERROR_DETECTOR_IDS).toContain("D11");
    expect(PERMISSIONS_DETECTOR_IDS).not.toContain("D11");
  });
});

describe("R4.4: C9 drops the bare-Bash-allow line", () => {
  it.each(["DENY_RULE", "USER_REJECTED"])(
    "%s detail does not forbid a bare Bash allow rule",
    (denialClass) => {
      const { actions } = card({
        detector_id: "C9",
        lever: "Review recurring blocked tool requests before repeating the same command shape.",
        evidence: {
          session_ids: ["s1"],
          window: WINDOW,
          metrics: metrics({ DENIAL_CLASS: denialClass, DENIAL_COUNT: 3 }),
        },
      });
      expect(actions.primary.detail.join(" ")).not.toMatch(/bare Bash/i);
      if (denialClass === "USER_REJECTED")
        expect(actions.primary.copy_text).not.toMatch(/never a bare/i);
    },
  );
});
