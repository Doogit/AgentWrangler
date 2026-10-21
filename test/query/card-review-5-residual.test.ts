/**
 * Review 5 residuals: the nine items the independent check of U1–U8 left open.
 */
import { describe, expect, it } from "vitest";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { validateCardActions } from "../../src/query/api/recommendations.js";
import { withEmptyHome } from "../shared/with-home.js";

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, cardTitle(rec)) };
}

function file(target: string, calls: number, sessions: number, whole: boolean): CardToolCall {
  return {
    target,
    kind: "file",
    tool: "Read",
    calls,
    session_ids: ["s1", "s2"],
    session_count: sessions,
    total_bytes: calls * 5_000,
    max_bytes: 5_000,
    whole_file: whole,
  };
}

describe("D7 re-reads: the listed rows agree with the text around them (M16, source count)", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D7",
    lever: "Point sessions at the part they need of the files they re-read every session.",
    facts: {
      session_ids: ["s1", "s2"],
      session_count: 27,
      redundant_path_count: 35,
      total_redundant_read_count: 362,
      total_redundant_result_bytes: 2_400_000,
      max_path_read_count: 59,
      max_path_session_count: 16,
    },
    tool_calls: [
      file("C:/work/docs/plan.md", 34, 16, false),
      file("C:/work/src/recommendations.ts", 59, 12, false),
      file("C:/work/src/ingestor.ts", 48, 10, false),
      file("C:/work/src/RecCard.tsx", 39, 9, false),
      file("C:/work/schemas/findings-schema.json", 27, 8, true),
    ],
  };

  it("counts source code over the listed rows: 3 of the 5 (.ts, .ts, .tsx; not .md or .json)", () => {
    const { trigger } = card(rec);
    expect(trigger.problem).toContain("3 of the files listed are source code");
    expect(trigger.problem).not.toContain("4 of the files listed");
  });

  it("does not label a list that has a whole read 'partial reads only'", () => {
    const { copy_text } = card(rec).actions.primary;
    expect(copy_text).not.toContain("partial reads only");
    expect(copy_text).toContain("read whole 27 times in 8 sessions");
    expect(copy_text).toContain("whole or in parts, as each row says");
  });
});

describe("M19: A1 names how the lead is picked, and tags subagent rows", () => {
  // Ranked as oversizedToolCalls returns them: most re-sends first (U7: main conversation and
  // subagents alike), a repeat only breaks a tie.
  const rec: CardActionRecommendation = {
    detector_id: "A1",
    lever: "spill",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        EVENT_COUNT: { value: 31 },
        RESULT_BYTES_TOTAL: { value: 31 * 40_000 },
        MAX_RESULT_BYTES: { value: 40_000 },
      },
    },
    tool_calls: [
      { ...file("C:/work/docs/ranking-plan.md", 3, 2, true), max_bytes: 40_000 },
      { ...file("C:/work/docs/skill.md", 28, 9, true), max_bytes: 40_000, is_subagent: true },
    ],
  };

  it("says the prompt fixes the one that costs the most in re-sends, subagents included (U7)", () => {
    const { copy_text } = card(rec).actions.primary;
    expect(copy_text).not.toContain("repeats most");
    expect(copy_text).toContain(
      "This prompt fixes the one that costs the most in re-sends, in the main conversation or inside a subagent; the others are listed for reference only.",
    );
  });

  it("tags the subagent row in Also seen", () => {
    const { copy_text } = card(rec).actions.primary;
    expect(copy_text).toMatch(/skill\.md`: read whole 28 times in 9 sessions.*\(subagent\)/);
  });
});

describe("C9: TL;DR numbers and advice agree with the card (settled: guard stays strict)", () => {
  const NOW = "Blocked command shape: cd&&-prefix / in-place edits (python -c) / tmp writes";
  const block = (
    target: string,
    guard_shape: NonNullable<CardToolCall["guard_shape"]>,
    calls: number,
  ): CardToolCall => ({
    target,
    kind: "command",
    tool: "Bash",
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: NOW,
    guard_shape,
  });
  const rec: CardActionRecommendation = {
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
        DENIAL_COUNT: { kind: "COUNT", value: 21 },
        session_count: { kind: "COUNT", value: 21 },
      },
    },
    tool_calls: [
      block('python -c "import sqlite3; print(1)"', "PYTHON_READ", 2),
      block('grep -n "python -c" x.ts', "QUOTED_PATTERN", 1),
      block("cd a && b", "CD_PREFIX", 18),
    ],
  };

  it("the TL;DR states only numbers the problem or facts carry (no session count)", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.summary).toBe(
      "Your PreToolUse guard blocked 21 calls; 3 were harmless calls it should not have stopped.",
    );
    expect(violations).toEqual([]);
  });

  // F5 (2026-10-04) supersedes "quote the classified total": one count per card, DENIAL_COUNT,
  // with the blocks the split cannot place counted as unclassified (live: 42 vs 33).
  it("quotes DENIAL_COUNT everywhere when it is larger than the classified blocks", () => {
    const evidence = {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
        DENIAL_COUNT: { kind: "COUNT", value: 25 },
        session_count: { kind: "COUNT", value: 21 },
      },
    };
    const { trigger, violations, actions } = card({ ...rec, evidence });
    expect(trigger.problem).toContain("Your guard blocked 25 calls");
    expect(trigger.problem).toContain("4 unclassified");
    expect(trigger.summary).toBe(
      "Your PreToolUse guard blocked 25 calls; 3 were harmless calls it should not have stopped.",
    );
    expect(trigger.facts).toContainEqual({ label: "Calls your guard blocked", value: "25" });
    expect(actions.primary.summary).not.toMatch(/\b21\b/);
    expect(violations).toEqual([]);
  });

  it("advises calling-side changes only, in one grammatical list", () => {
    const { summary, copy_text } = card(rec).actions.primary;
    expect(summary).toBe(
      "Run the 3 harmless blocked calls in a shape your guard allows, and keep the guard as it is: a read-only `python -c` as a script file in the scratchpad (or `sqlite3 -readonly`, or the daemon API); a search whose pattern contains `python -c` as a Grep tool call instead of a Bash `grep`.",
    );
    for (const text of [summary, copy_text]) {
      expect(text).not.toContain("only where a command starts");
    }
  });
});

describe("D7 loops: advice and Why fit the mix the card counts", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D7",
    lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
    facts: {
      session_ids: ["s1"],
      loop_flagged_turn_count: 279,
      repeat_excess_turn_count: 217,
      redundant_read_event_count: 185,
      identical_call_event_count: 35,
      error_loop_event_count: 86,
    },
  };

  it("problem advice covers repeated reads and repeated errors, not only failures", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).not.toContain("Changing the approach after the second failure stops");
    expect(trigger.problem).toContain(
      "For a repeated read, re-read only the part needed; for a repeated error, change the approach after the second failure.",
    );
    expect(violations).toEqual([]);
  });

  it("Why does not call counted re-reads 'not a loop'", () => {
    const { trigger } = card(rec);
    expect(trigger.why).not.toContain("is expected, not a loop");
    expect(trigger.why).toContain(
      "A file read again after compaction or tool-result clearing dropped it is needed; this card cannot tell those reads apart, so it counts them too.",
    );
  });
});

describe("M3: D2's /handoff skill alternative validates on a global rec", () => {
  const d2: CardActionRecommendation = {
    detector_id: "D2",
    lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
    facts: { qualifying_session_count: 6, raw_context_average_tokens_per_turn: 245_000 },
  };

  it("targets the user-level skill folder and passes validation with no workspace", () => {
    const { actions } = withEmptyHome(() => card(d2));
    const [skill] = actions.alternatives;
    expect(skill?.file_ref).toBe("~/.claude/skills/handoff/SKILL.md");
    // A global rec: no workspace, no source file.
    const validation = validateCardActions(actions, "D2", null, null, "avg_context_per_turn");
    expect(validation?.alternatives["d2-handoff-skill"]).toMatchObject({ ok: true });
  });

  it("still withholds other home-relative edits on a global rec", () => {
    const { actions } = card(d2);
    const [skill] = actions.alternatives;
    if (skill === undefined) throw new Error("missing skill alternative");
    const other = {
      ...actions,
      alternatives: [{ ...skill, file_ref: "~/.claude/CLAUDE.md" }],
    };
    const validation = validateCardActions(other, "D2", null, null, "avg_context_per_turn");
    expect(validation?.alternatives["d2-handoff-skill"]?.ok).toBe(false);
  });
});
