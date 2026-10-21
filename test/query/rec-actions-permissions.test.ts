import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { permissionsHandler } from "../../src/query/api/rec-actions/families/permissions.js";
import {
  assertCardActionsGuardrails,
  buildCardActions,
  buildTrigger,
} from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardActions,
} from "../../src/query/api/rec-actions/types.js";

const fixtures: Array<{
  rec: CardActionRecommendation;
  kind: "CONFIG" | "EDIT" | "HABIT" | "INVESTIGATE";
  fileRef: string | null;
  token: string;
  optionIds: string[];
}> = [
  {
    rec: {
      detector_id: "C9",
      lever: "review blocked requests",
      evidence: {
        metrics: {
          DENIAL_CLASS: { value: "DENY_RULE" },
          COMMAND_ARGUMENT_COUNT_CLASS: { value: "ARGS_1" },
          DENIAL_COUNT: { value: 3 },
        },
      },
    },
    kind: "INVESTIGATE",
    fileRef: null,
    token: "3",
    optionIds: ["c9-review-denials-scoped-rule"],
  },
  {
    rec: {
      detector_id: "D14",
      lever: "review interruption",
      evidence: {
        metrics: {
          INTERRUPT_KIND: { value: "PURE_INTERRUPT" },
          INTERRUPT_COUNT: { value: 2 },
        },
      },
    },
    // One INVESTIGATE prompt per card (P3.1): plan mode and the scope rule are both in its Fix.
    kind: "INVESTIGATE",
    fileRef: null,
    token: "2",
    optionIds: ["d14-plan-before-edits"],
  },
  {
    rec: {
      detector_id: "D14",
      lever: "review cancellation",
      evidence: {
        metrics: {
          INTERRUPT_KIND: { value: "KILLED_NO_PROMPT" },
          INTERRUPT_COUNT: { value: 4 },
        },
      },
    },
    kind: "INVESTIGATE",
    fileRef: null,
    token: "4",
    optionIds: ["d14-limit-task-scope"],
  },
  {
    rec: {
      detector_id: "H1",
      lever: "guard destructive operations",
      evidence: {
        metrics: {
          DESTRUCTIVE_OPERATION: { value: "GIT_RESET_HARD" },
          OPERATION_COUNT: { value: 2 },
        },
      },
    },
    // A settings change (P3.1-T7 H1c): the ask entry sits in the prompt's ```json Fix block.
    kind: "CONFIG",
    fileRef: ".claude/settings.json",
    token: "git reset --hard",
    optionIds: ["h1-ask-destructive-operation"],
  },
];

function direct(rec: CardActionRecommendation): CardActions {
  const actions = permissionsHandler(rec, { trigger: buildTrigger(rec) });
  if (actions === null) throw new Error(`Missing permissions actions for ${rec.detector_id}`);
  return actions;
}

describe("permissions recommendation actions", () => {
  it.each(fixtures)("builds safe $rec.detector_id actions", (fixture) => {
    const handlerActions = direct(fixture.rec);
    const builtActions = buildCardActions(fixture.rec);

    expect(handlerActions.primary.kind).toBe(fixture.kind);
    expect(handlerActions.primary.file_ref).toBe(fixture.fileRef);
    expect(handlerActions.primary.summary).toContain(fixture.token);
    expect(handlerActions.primary.copy_text).not.toBe("");
    expect(
      [handlerActions.primary, ...handlerActions.alternatives].map((action) => action.option_id),
    ).toEqual(fixture.optionIds);
    expect(() =>
      assertCardActionsGuardrails(handlerActions, fixture.rec.detector_id),
    ).not.toThrow();
    expect(builtActions.alternatives).toEqual(handlerActions.alternatives);
    // Review 5: only C9 has a "Why this matters" text yet (deferred item 11).
    expect(cardRuleViolations(handlerActions, buildTrigger(fixture.rec))).toEqual(
      fixture.rec.detector_id === "C9" ? [] : [NO_WHY],
    );
  });

  it("uses plan mode only for PURE_INTERRUPT and a scope rule without a hook for KILLED_NO_PROMPT", () => {
    const pure = direct(fixtures[1]?.rec ?? { detector_id: "D14", lever: "missing" });
    const killed = direct(fixtures[2]?.rec ?? { detector_id: "D14", lever: "missing" });
    expect(pure.primary.copy_text).toContain('"defaultMode": "plan"');
    expect(killed.primary.copy_text).not.toContain('"defaultMode"');
    expect(killed.primary.copy_text).toContain("Touch only files the task requires.");
    expect(killed.primary.hook).toBeUndefined();
    expect(killed.primary.copy_text).not.toContain('"hooks"');
  });

  // Operator decision (P3.1 review 1): ask, not deny; some runs were legitimate cleanup.
  it("puts a scoped H1 ask entry in the prompt, never a bare Bash rule", () => {
    const h1 = direct(fixtures[3]?.rec ?? { detector_id: "H1", lever: "missing" });
    expect(h1.primary.copy_text).toContain('"ask": ["Bash(git reset --hard:*)"]');
    expect(h1.primary.copy_text).not.toContain('"Bash"]');
    expect(h1.primary.permission_rule).toBeUndefined();
  });

  it("gives C9 scoped-rule guidance, never a settings block or a bare Bash rule", () => {
    const c9 = direct(fixtures[0]?.rec ?? { detector_id: "C9", lever: "missing" });
    const invalid: CardActions = {
      ...c9,
      primary: {
        ...c9.primary,
        permission_rule: { mode: "allow", pattern: "Bash(*)" },
      },
    };
    expect(() => assertCardActionsGuardrails(invalid, "C9")).toThrow(/ask/);
    for (const action of [c9.primary, ...c9.alternatives]) {
      expect(action.permission_rule).toBeUndefined();
      expect(action.copy_text).not.toContain('"permissions"');
      expect(action.copy_text).not.toContain('"Bash"]');
    }
    expect(c9.primary.copy_text).toContain("Bash(<command>:*)");
    expect(c9.primary.copy_text).toContain("never a bare `Bash` entry");
  });

  it.each([
    { denialClass: "DENY_RULE", optionId: "c9-review-denials-scoped-rule" },
    { denialClass: "USER_REJECTED", optionId: "c9-review-denials-scoped-rule" },
    { denialClass: "HOOK_BLOCK", optionId: "c9-review-blocking-guard" },
  ])("builds a guardrail-clean C9 primary for $denialClass", ({ denialClass, optionId }) => {
    const rec: CardActionRecommendation = {
      detector_id: "C9",
      lever: "review blocked requests",
      evidence: {
        metrics: {
          DENIAL_CLASS: { value: denialClass },
          DENIAL_COUNT: { value: 2 },
          COMMAND_ARGUMENT_COUNT_CLASS: { value: "ARGS_2_3" },
        },
      },
    };
    const built = buildCardActions(rec);
    expect(built.primary.option_id).toBe(optionId);
    expect(built.primary.kind).toBe("INVESTIGATE");
    expect(built.primary.summary).toContain("(2 tool calls)");
    expect(() => assertCardActionsGuardrails(built, "C9")).not.toThrow();
    expect(cardRuleViolations(built, buildTrigger(rec))).toEqual([]);
  });

  it("names the blocked tools and the guard's messages from the calls read back", () => {
    const call = (tool: string, target: string, result: string, calls: number) => ({
      target,
      kind: "other" as const,
      tool,
      calls,
      session_ids: [],
      session_count: 1,
      total_bytes: 0,
      max_bytes: 0,
      whole_file: false,
      result,
    });
    const rec: CardActionRecommendation = {
      detector_id: "C9",
      lever: "review blocked requests",
      evidence: {
        session_ids: ["s1", "s2", "s3"],
        metrics: {
          DENIAL_CLASS: { value: "HOOK_BLOCK" },
          DENIAL_COUNT: { value: 5 },
        },
      },
      tool_calls: [
        call("Bash", "git push --force", "PreToolUse:Bash hook error: Blocked command shape:", 3),
        call("Agent", "Agent {}", "PreToolUse:Agent hook error: Dispatch omitted the brief", 2),
      ],
    };
    const trigger = buildTrigger(rec);
    const built = buildCardActions(rec);
    expect(trigger.problem).toContain("blocked 5 Bash and Agent calls in 3 sessions");
    expect(trigger.problem).toContain('most often with "Blocked command shape"');
    expect(trigger.problem).not.toMatch(/hook/i);
    expect(built.primary.summary).toContain("(5 Bash and Agent calls in 3 sessions)");
    expect(built.primary.copy_text).toContain('- "Blocked command shape": 3 times');
    expect(built.primary.copy_text).toContain('- "Dispatch omitted the brief": twice');
    expect(cardRuleViolations(built, trigger)).toEqual([]);
  });

  it("does not suggest an ask rule for a C9 HOOK_BLOCK denial", () => {
    const c9 = buildCardActions({
      detector_id: "C9",
      lever: "review blocked requests",
      evidence: {
        metrics: {
          DENIAL_CLASS: { value: "HOOK_BLOCK" },
          DENIAL_COUNT: { value: 1 },
          COMMAND_ARGUMENT_COUNT_CLASS: { value: "ARGS_1" },
        },
      },
    });
    expect(c9.primary.kind).toBe("INVESTIGATE");
    expect(c9.primary.file_ref).toBeNull();
    expect(c9.primary.permission_rule).toBeUndefined();
    expect(c9.primary.copy_text).not.toContain('"ask"');
    expect(c9.primary.summary).toContain("(1 tool call)");
  });
});
