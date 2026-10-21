import { describe, expect, it } from "vitest";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

// Synthetic recs for every family that used to hand out a non-runnable action.
const recs: CardActionRecommendation[] = [
  {
    detector_id: "A1",
    lever: "spill",
    evidence: {
      metrics: { TOOL_CLASS: { value: "FILE_READ" }, MAX_RESULT_BYTES: { value: 50000 } },
    },
  },
  { detector_id: "D6", lever: "range", facts: { tool_result_bytes: 250000, session_count: 3 } },
  { detector_id: "D7", lever: "retry", facts: { repeat_excess_event_count: 5 } },
  {
    detector_id: "D14",
    lever: "cancel",
    evidence: {
      metrics: { INTERRUPT_KIND: { value: "KILLED_NO_PROMPT" }, INTERRUPT_COUNT: { value: 4 } },
    },
  },
  {
    detector_id: "D14",
    lever: "interrupt",
    evidence: {
      metrics: { INTERRUPT_KIND: { value: "PURE_INTERRUPT" }, INTERRUPT_COUNT: { value: 2 } },
    },
  },
  {
    detector_id: "H1",
    lever: "guard",
    evidence: {
      metrics: {
        DESTRUCTIVE_OPERATION: { value: "GIT_RESET_HARD" },
        OPERATION_COUNT: { value: 2 },
      },
    },
  },
  ...["DENY_RULE", "USER_REJECTED", "HOOK_BLOCK"].map((denialClass) => ({
    detector_id: "C9",
    lever: "review",
    evidence: {
      metrics: {
        DENIAL_CLASS: { value: denialClass },
        DENIAL_COUNT: { value: 3 },
        COMMAND_ARGUMENT_COUNT_CLASS: { value: "ARGS_1" },
      },
    },
  })),
];

const PATH_LIKE = /[/\\]|\.(?:sh|ps1|mjs)\b/;

function hookCommands(copyText: string): string[] {
  return [...copyText.matchAll(/"command"\s*:\s*"([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("CardActions offer only runnable actions", () => {
  it.each(recs)("$detector_id ($lever) has a primary and no non-runnable option", (rec) => {
    const actions = buildCardActions(rec);
    expect(actions.primary).toBeDefined();
    expect(actions.primary.copy_text).not.toBe("");
    for (const option of [actions.primary, ...actions.alternatives]) {
      for (const command of hookCommands(option.copy_text)) {
        expect(command, `${option.option_id} hook command`).toMatch(PATH_LIKE);
      }
      expect(option.copy_text).not.toContain('"Bash"]');
      expect(option.copy_text).not.toContain("aw_loop_breaker");
    }
  });
});
