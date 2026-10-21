/**
 * P3.1-T13: review-6 P2 findings that make card advice harmful or self-contradictory
 * (register `docs/handoffs/2026-09-26-card-review/review-6-persona-findings.md`).
 * R6-20, R6-29, R6-30, R6-31, R6-33, R6-34, R6-38, R6-51. R6-50 is a UI test.
 */
import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import { TRANSCRIPTS } from "../../src/query/api/rec-actions/prompt.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";
import { withEmptyHome } from "../shared/with-home.js";

function metrics(values: Record<string, number | string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}

function allCopy(rec: CardActionRecommendation): string[] {
  const { primary, alternatives } = buildCardActions(rec);
  return [primary, ...alternatives].map((option) => option.copy_text ?? "");
}

const d1 = (component: "CLAUDE_MD" | "MEMORY", measured = true): CardActionRecommendation => ({
  detector_id: "D1",
  lever: "trim",
  savings_u_per_wk: 195_000,
  ...(measured ? {} : { savings_range_u_per_wk: [130_000, 280_000] as [number, number] }),
  facts: {
    component,
    source_file_ref: component === "MEMORY" ? "~/.claude/memory/MEMORY.md" : "/repo/CLAUDE.md",
    attribution_method: measured ? "MEASURED_CONTENT" : "CHARS_DIV_4",
    source_tokens: 30_000,
    source_target: 20_000,
    delta_context_tokens: 1_000,
    turns_per_week: 1_560,
  },
});

describe("R6-51: prompts give the real subagent transcript path", () => {
  it("names <session id>/subagents/", () => {
    expect(TRANSCRIPTS).toContain("~/.claude/projects/<project folder>/<session id>/subagents/");
  });
});

describe("R6-29: a D1 pointer is a plain path, not an @path import", () => {
  for (const component of ["CLAUDE_MD", "MEMORY"] as const) {
    it(`every ${component} option says so and checks /context`, () => {
      for (const copy of allCopy(d1(component))) {
        expect(copy).toContain("not an `@path` import");
        expect(copy).toContain("/context");
      }
    });
  }

  it("the D7 cross-session copy says so too", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D7",
      lever: "Point sessions at the part they need of the files they re-read every session.",
      facts: {
        session_ids: ["s1", "s2"],
        session_count: 27,
        redundant_path_count: 35,
        total_redundant_read_count: 362,
        total_redundant_result_bytes: 2_400_000,
      },
    };
    expect(buildCardActions(rec).primary.copy_text).toContain("not an `@path` import");
  });
});

describe("R6-30: the D1 trim keeps rules other files point to", () => {
  it("drops 'enforced elsewhere' and stops at the lowest safe size", () => {
    const copy = buildCardActions(d1("CLAUDE_MD")).primary.copy_text ?? "";
    expect(copy).not.toContain("enforced elsewhere");
    expect(copy).toContain("a guard message, skill or other file points to");
    expect(copy).toContain("stop and report the lowest safe size");
  });
});

describe("R6-31: the MEMORY prune alternative archives, never deletes pending entries", () => {
  it("moves to memory/archive/ instead of deleting", () => {
    const prune = buildCardActions(d1("MEMORY")).alternatives.find(
      (option) => option.option_id === "d1-memory-prune",
    );
    const text = [prune?.summary, ...(prune?.detail ?? []), prune?.copy_text].join("\n");
    expect(text).toContain("memory/archive/");
    expect(text).toMatch(/never (move|delete)[^.]*pending/i);
    expect(text).not.toMatch(/\bdelete\b/i);
  });
});

describe("R6-33: an unmeasured D1 TL;DR gives the range, not a point", () => {
  it("states the range in the TL;DR and backs it in what's wrong", () => {
    const rec = d1("MEMORY", false);
    const trigger = buildTrigger(rec);
    expect(trigger.summary).toContain("$0.13–$0.28 a week");
    expect(trigger.summary).not.toContain("$0.20");
    // D1 has no Why text yet (R6-19, deferred), so only the TL;DR-numbers rule is checked here.
    const violations = cardRuleViolations(buildCardActions(rec), trigger, cardTitle(rec));
    expect(violations.filter((v) => v !== NO_WHY)).toEqual([]);
  });

  it("a measured D1 keeps its point estimate", () => {
    expect(buildTrigger(d1("MEMORY")).summary).toContain("about $0.20 a week");
  });
});

describe("R6-34: the /handoff skill writes a per-branch file started with @", () => {
  it("uses @HANDOFF and never overwrites another branch's handoff", () => {
    const rec: CardActionRecommendation = {
      detector_id: "D2",
      lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
      facts: { qualifying_session_count: 6, raw_context_average_tokens_per_turn: 245_000 },
    };
    const skill = withEmptyHome(() => buildCardActions(rec)).alternatives.find(
      (option) => option.option_id === "d2-handoff-skill",
    );
    const copy = skill?.copy_text ?? "";
    expect(copy).toContain("HANDOFF-<branch>.md");
    expect(copy).toContain("`@HANDOFF-<branch>.md`");
    expect(copy).not.toContain("overwriting any older one");
    expect(copy).toContain("never overwrite another branch's");
  });
});

describe("R6-20: the C1 verify step re-runs only read-only calls", () => {
  it("forbids re-running a click or other page-changing call", () => {
    const rec: CardActionRecommendation = {
      detector_id: "C1",
      lever: "Investigate recurring tool failures.",
      evidence: {
        session_ids: ["s1"],
        metrics: metrics({
          FAILED_CALL_COUNT: 35,
          OUTLIER_TOOLS: "mcp__claude-in-chrome__computer, mcp__claude-in-chrome__browser_batch",
        }),
      },
    };
    const copy = buildCardActions(rec).primary.copy_text ?? "";
    expect(copy).toContain("mcp__claude-in-chrome__computer");
    expect(copy).toContain("never re-run a click");
    expect(copy).not.toContain("re-run one example call from each fixed group");
  });
});

// P3.A (d) changes R6-38 on purpose: C9 now has an effect handler (c9-denial-friction-v1), so the
// copy states the real measurement instead of "it does not compare before and after".
describe("R6-38: C9 copy describes the before/after measurement it has", () => {
  it("says what is counted in later sessions, and that loosening the guard is not a fix", () => {
    for (const denialClass of ["HOOK_BLOCK", "USER_REJECTED", "DENY_RULE"]) {
      const rec: CardActionRecommendation = {
        detector_id: "C9",
        lever: "Review recurring blocked tool requests before repeating the same command shape.",
        evidence: {
          session_ids: ["s1"],
          metrics: metrics({ DENIAL_CLASS: denialClass, DENIAL_COUNT: 21, session_count: 5 }),
        },
      };
      for (const copy of allCopy(rec)) {
        expect(copy).not.toContain("does not compare");
        expect(copy).toMatch(/AgentWrangler counts [^.]+ in later sessions/);
        if (denialClass === "HOOK_BLOCK")
          expect(copy).toContain("blocked or not, so loosening the guard does not count as a fix");
        else expect(copy).toContain("compares them with before");
      }
    }
  });
});
