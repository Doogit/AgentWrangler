/**
 * P3.1-T7: the operator's review-2 findings that live in the card text, one block per finding id
 * (register `docs/handoffs/2026-09-26-card-review/review-2-findings.md`).
 */
import { describe, expect, it } from "vitest";
import { a1FindingDescriptor as a1Descriptor } from "../../src/detector/detectors/a1_tool_result_bloat.js";
import { c2FindingDescriptor } from "../../src/detector/detectors/c2_content_not_found.js";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import { callUsage } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { validateAction } from "../../src/query/api/rec-actions/validate.js";
import { commandText } from "../../src/query/api/tool-calls.js";

const SESSIONS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

function metrics(values: Record<string, number | string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, cardTitle(rec)) };
}

function read(target: string, calls: number, sessions: number, bytes = 26_000): CardToolCall {
  return {
    target,
    kind: "file",
    tool: "Read",
    calls,
    session_ids: ["s1"],
    session_count: sessions,
    total_bytes: calls * bytes,
    max_bytes: bytes,
    whole_file: true,
  };
}

function command(tool: string, target: string, result?: string): CardToolCall {
  return {
    target,
    kind: "command",
    tool,
    calls: 1,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    ...(result === undefined ? {} : { result }),
  };
}

describe("S2: titles match the actions", () => {
  it("A1, D8 and C2 titles name the change the card proposes", () => {
    expect(a1Descriptor.presentation.lever).not.toMatch(/spill/i);
    expect(RECOMMENDATION_TEMPLATES.D8_CACHE_WRITE_CHURN.lever).toMatch(/\/clear/);
    expect(c2FindingDescriptor.presentation.lever).not.toMatch(/before retrying/i);
  });
});

describe("S4: the two C9 cards and the two D7 cards have their own titles", () => {
  const c9 = (denialClass: string): CardActionRecommendation => ({
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: metrics({ DENIAL_CLASS: denialClass, DENIAL_COUNT: 6 }),
    },
  });

  it("titles C9 by what blocked the calls", () => {
    const titles = ["HOOK_BLOCK", "USER_REJECTED", "DENY_RULE"].map((kind) => cardTitle(c9(kind)));
    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toMatch(/guard/);
    expect(titles[1]).toMatch(/reject/);
  });

  it("keeps the lever as the title for other cards", () => {
    const lever = RECOMMENDATION_TEMPLATES.D7_RETRY_LOOP.lever;
    expect(cardTitle({ detector_id: "D7", lever })).toBe(lever);
    expect(lever).not.toBe(RECOMMENDATION_TEMPLATES.D7_CROSS_SESSION_REREAD.lever);
  });
});

describe("D2a + D2b: D2 shows how the cap weight adds up, and counts model calls", () => {
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
    },
  };

  // Review 5 M1 (replaces the P3.1-T9 cap weight): no cap figure, only the raw 108,412,595
  // re-reads (108.4M); the 13.1M cap-weighted total still does not show.
  it("states the raw cache re-reads, no cap weight", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).toContain("These sessions re-read 108.4M cached tokens a week.");
    expect(trigger.problem).not.toMatch(/0\.1 ×|usage cap/);
    expect(trigger.problem).not.toContain("13.1M");
    expect(violations).toEqual([]);
  });

  it("says model calls, not turns", () => {
    const { trigger, actions } = card(rec);
    for (const text of [
      trigger.problem ?? "",
      ...trigger.facts.map((fact) => fact.label),
      actions.primary.copy_text,
    ]) {
      expect(text).not.toMatch(/\bturns?\b/);
    }
    expect(trigger.problem).toContain("516 model calls");
  });
});

describe("D8a/b/d/e: D8 wording", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D8",
    lever: RECOMMENDATION_TEMPLATES.D8_CACHE_WRITE_CHURN.lever,
    facts: {
      session_ids: SESSIONS,
      session_count: 15,
      churn_event_count: 18,
      total_churn_creation_tokens: 2_800_000,
      regime: "mixed",
      longest_gap_min: 2_190,
    },
  };

  it("says the cache lifetime is measured, not usual", () => {
    const { actions } = card(rec);
    expect(actions.primary.copy_text).not.toMatch(/usually/);
    expect(actions.primary.copy_text).toMatch(/measured/);
  });

  // U9: the detector's floor is 0.1% of the workspace's 7-day spend (50K tokens only when spend is
  // unknown), so the card states the rule it applies rather than a fixed 50K cutoff.
  it("states the rule it applies", () => {
    const problem = card(rec).trigger.problem ?? "";
    expect(problem).toContain("read under 20% of what they wrote");
    expect(problem).toContain("at least 0.1% of this workspace's 7-day spend");
  });

  // Review 3 reversed D8b: /clear or /compact before a night's break still shrinks the morning
  // rewrite, so a long break gets no caveat (operator 2026-09-26).
  it("gives an overnight break no caveat", () => {
    const { trigger } = card(rec);
    expect(trigger.problem).toContain("The longest break before one was 36.5 hours.");
    expect(trigger.problem).not.toMatch(/overnight|planned breaks/);
  });

  // Review 3 B6: the before/after reads were B2's summed one-hour breaks, not D8's resumes.
  it("does not show another card's before/after cache reads", () => {
    expect(card(rec).trigger.problem).not.toMatch(/before each break read/);
  });
});

describe("A1b + A1c: the fix depends on whose file it is, and session lists are labelled", () => {
  const rec = (lead: CardToolCall): CardActionRecommendation => ({
    detector_id: "A1",
    lever: a1Descriptor.presentation.lever,
    evidence: {
      session_ids: SESSIONS,
      metrics: metrics({
        EVENT_COUNT: 268,
        MAX_RESULT_BYTES: 62_000,
        RESULT_BYTES_TOTAL: 10_000_000,
      }),
    },
    tool_calls: [lead],
  });

  it("a skill or plugin file: read once and pass along, or ask its author", () => {
    const { actions, violations } = card(
      rec(read("~/.claude/skills/ce-doc-review/references/subagent-template.md", 21, 6)),
    );
    const detail = actions.primary.detail.join(" ");
    expect(detail).toMatch(/pass/);
    expect(detail).toMatch(/author/);
    expect(actions.primary.copy_text).toMatch(/author/);
    expect(violations).toEqual([]);
  });

  it("your own source file read in many sessions: split it", () => {
    const { actions } = card(
      rec(read("~/Documents/GitHub/AgentWrangler/src/query/api/recommendations.ts", 15, 13)),
    );
    expect(actions.primary.detail[0]).toMatch(/^Split it/);
  });

  it("labels the finding's sessions apart from the calls' own", () => {
    const { actions } = card(
      rec(read("~/Documents/GitHub/AgentWrangler/src/query/api/recommendations.ts", 15, 13)),
    );
    expect(actions.primary.copy_text).toContain("- Sessions with any result over 25 KB");
  });
});

describe("D7a2: unknown (0) byte sizes are not shown", () => {
  it("omits the size when none was recorded", () => {
    expect(callUsage({ ...read("docs/plan.md", 13, 1), total_bytes: 0, max_bytes: 0 })).toBe(
      "read whole 13 times in 1 session",
    );
  });
});

describe("D7a3: the loop rule says a call in between ends the run", () => {
  it("says so on the card and in the prompt", () => {
    const { trigger, actions } = card({
      detector_id: "D7",
      lever: RECOMMENDATION_TEMPLATES.D7_RETRY_LOOP.lever,
      facts: { session_ids: SESSIONS, loop_flagged_turn_count: 40, error_loop_event_count: 8 },
    });
    expect(trigger.problem).toMatch(/call in between ends the run/);
    expect(actions.primary.copy_text).toMatch(/call in between ends the run/);
  });
});

describe("D7b2: re-read files get a pointer in CLAUDE.md, not their content", () => {
  it("proposes a pointer and warns against copying content", () => {
    const { trigger, actions } = card({
      detector_id: "D7",
      lever: RECOMMENDATION_TEMPLATES.D7_CROSS_SESSION_REREAD.lever,
      facts: {
        session_ids: SESSIONS,
        redundant_path_count: 4,
        total_redundant_read_count: 120,
        max_path_read_count: 58,
        max_path_session_count: 39,
      },
      tool_calls: [read("docs/plans/00-MASTER-PLAN.md", 58, 39)],
    });
    expect(trigger.problem).toMatch(/pointer/);
    expect(trigger.problem).not.toMatch(/summary in CLAUDE\.md/);
    expect(actions.primary.copy_text).toMatch(/pointer, not the content/);
  });
});

describe("C9 guard card: C9g1 existing rule, C9g4 read-back wording", () => {
  const rec: CardActionRecommendation = {
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: SESSIONS,
      metrics: metrics({ DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 30 }),
    },
    tool_calls: [
      command("Bash", "cd x && npm test", "PreToolUse:Bash hook error: Blocked command shape"),
    ],
  };

  it("points at a CLAUDE.md rule that already covers the shape", () => {
    expect(card(rec).actions.primary.copy_text).toMatch(/already/);
  });

  it("does not label every blocked call with the tools of the ones read back", () => {
    const { actions } = card(rec);
    expect(actions.primary.copy_text).not.toContain("- Blocked calls: 30 (Bash)");
    expect(actions.primary.copy_text).toContain("(Bash in the 1 read back)");
  });
});

describe("C9 rejections: C9r2 labels, C9r3 no re-plan claim, C9r4 polling hint", () => {
  const rec: CardActionRecommendation = {
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: metrics({ DENIAL_CLASS: "USER_REJECTED", DENIAL_COUNT: 2 }),
    },
    tool_calls: [
      command(
        "Bash",
        'curl -s -m 3 http://127.0.0.1:47821/api/ready -o /dev/null -w "%{http_code}"',
      ),
      command("PowerShell", "Get-NetTCPConnection -LocalPort 47821 -State Listen"),
    ],
  };

  it("labels them rejected and gives no allow-rule advice", () => {
    const { actions } = card(rec);
    const text = [actions.primary.summary, ...actions.primary.detail, actions.primary.copy_text];
    expect(actions.primary.copy_text).toContain("- Rejected calls:");
    expect(actions.primary.copy_text).not.toContain("Blocked calls");
    for (const line of text) expect(line).not.toMatch(/allow rule|Bash\(<command>/);
  });

  it("does not claim a rejection costs a re-plan turn", () => {
    const { trigger, actions } = card(rec);
    expect(trigger.problem).not.toMatch(/re-plan/);
    expect(actions.primary.copy_text).not.toMatch(/re-plan/);
  });

  it("notices calls that poll a local server or port", () => {
    expect(card(rec).actions.primary.copy_text).toMatch(/2 of the calls read back poll a local/);
  });
});

describe("H1b/c/d: H1 rule facts, action kind and example", () => {
  const rec: CardActionRecommendation = {
    detector_id: "H1",
    lever:
      "Add a confirmation guard (permissions.ask) for this destructive command class before it runs again.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: metrics({ DESTRUCTIVE_OPERATION: "RM_RF", OPERATION_COUNT: 14 }),
    },
  };

  it("says rules check each part of a chained command", () => {
    const text = card(rec).actions.primary.copy_text;
    expect(text).not.toMatch(/or a chained command/);
    expect(text).toMatch(/each part of a chained command/);
    expect(text).toContain("`rm -fr`");
  });

  it("is a settings change that says Claude ran the command", () => {
    const { trigger, actions, violations } = card(rec);
    expect(actions.primary.kind).toBe("CONFIG");
    expect(actions.primary.file_ref).toBe(".claude/settings.json");
    expect(actions.primary.summary).toMatch(/\bran\b/);
    expect(actions.primary.summary).not.toMatch(/tried/);
    expect(trigger.problem).toMatch(/^Claude ran/);
    // Review 5: H1 has no "Why this matters" text yet (deferred item 11).
    expect(violations).toEqual([NO_WHY]);
  });

  it("validates the JSON block inside the prompt against the real registry", () => {
    const { actions } = card(rec);
    const fs = { existsSync: () => true, statSync: () => ({ isFile: () => true }) };
    const primary = { ...actions.primary, target_metric: "destructive_operation_count" };
    expect(
      validateAction(primary, "destructive_operation_count", [], { fs, baseDir: "/r" }),
    ).toEqual({
      ok: true,
      measured: false,
    });
  });

  it("H1d: a long command keeps the destructive part in view", () => {
    const long = `npx biome format --write src test; npm run -s typecheck; ${"npx vitest run test/query ".repeat(20)}; rm -rf .claude/audits/certification/D4; git status --porcelain`;
    const text = commandText(long);
    expect(text).toContain("rm -rf .claude/audits/certification/D4");
    expect(text.length).toBeLessThanOrEqual(420);
    expect(commandText("npm test; rm -rf dist")).toBe("npm test; rm -rf dist");
  });

  it("a database statement is a CLAUDE.md edit", () => {
    const { actions } = card({
      ...rec,
      evidence: {
        session_ids: ["s1"],
        metrics: metrics({ DESTRUCTIVE_OPERATION: "SQL_DROP", OPERATION_COUNT: 2 }),
      },
    });
    expect(actions.primary.kind).toBe("EDIT");
    expect(actions.primary.file_ref).toBe("CLAUDE.md");
  });
});
