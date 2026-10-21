import { describe, expect, it } from "vitest";
import { buildCardActions, cardTitle } from "../../src/query/api/rec-actions/index.js";
import { buildTrigger } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const call = (over: Partial<CardToolCall>): CardToolCall => ({
  target: "~/x",
  kind: "file",
  tool: "Read",
  calls: 1,
  session_ids: [],
  session_count: 1,
  total_bytes: 0,
  max_bytes: 0,
  whole_file: false,
  ...over,
});

const rec = (
  detector_id: string,
  values: Record<string, number | string>,
  tool_calls?: CardToolCall[],
  session_ids = ["s1"],
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: {
    session_ids,
    metrics: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])),
  },
  ...(tool_calls === undefined ? {} : { tool_calls }),
});

describe("U9 round 6, tool lane", () => {
  it("C3 pastes the rule only; the evidence stays on the card (U9 r7)", () => {
    const {
      copy_text: text,
      summary,
      detail,
    } = buildCardActions(
      rec(
        "C3",
        { ERROR_COUNT: 36, SESSION_COUNT: 9, SUBAGENT_ERROR_COUNT: 26, WRITE_ERROR_COUNT: 10 },
        [call({ tool: "Edit", target: "~/r/F5.md", calls: 6, subagent_calls: 5 })],
      ),
    ).primary;
    expect(text).toContain("Read each file before you Edit or Write it");
    expect(text).not.toMatch(/36|F5\.md|Where this came from|AgentWrangler/);
    expect(text.split("\n")).toHaveLength(3);
    expect(summary).toContain("36 edit or write calls");
    expect(summary).toContain("26 in subagents");
    expect(detail.join("\n")).toContain("`~/r/F5.md` 6 times (5 in subagents)");
  });

  it("C2 does not claim to fix the source behind most lookups when the commonest cause is 4 of 14", () => {
    const calls = [
      call({
        target: "~/r/a.md",
        cause: "WRONG_WORKTREE",
        calls: 4,
        result: "File does not exist.",
      }),
      call({ target: "~/r/b.md", cause: "GUESSED_PATH", calls: 3, result: "File does not exist." }),
      call({ target: "~/r/c.md", cause: "WRONG_FOLDER", calls: 1, result: "File does not exist." }),
    ];
    const { summary, copy_text: text } = buildCardActions(
      rec("C2", { ERROR_COUNT: 14, SESSION_COUNT: 10 }, calls, ["s1", "s2"]),
    ).primary;
    expect(`${summary}\n${text}`).not.toMatch(/behind most/i);
    // U9 r7: counted among the 8 read back, not the 14 (6 could not be read back).
    expect(summary).toContain(
      "the commonest cause is in the wrong worktree (4 of 8 lookups read back)",
    );
    expect(summary).toContain("(that cause only)");
    expect(text).toContain("It covers that cause only");
  });

  it("C2 says which cause count a deliberate probe is still inside", () => {
    const calls = [
      call({
        tool: "Grep",
        kind: "search",
        target: "D8|/compact in ~/r/.audits-none",
        cause: "GUESSED_PATH",
        result: "Path does not exist",
      }),
    ];
    const { copy_text: text } = buildCardActions(
      rec("C2", { ERROR_COUNT: 3, SESSION_COUNT: 1 }, calls),
    ).primary;
    // U9 r8: a probe is its own bucket now, not counted under a cause.
    expect(text).toContain('counted on its own, as "deliberate probes", not as a guessed path');
  });

  it("C1 states the headline as under $0.01 beside its $0.11 saving, and the excluded errors", () => {
    const base = {
      TOOL_ERROR_COUNT: 4,
      TOOL_CALL_COUNT: 36,
      TOOL_ERROR_RATE: 0.111,
      CORPUS_CALL_COUNT: 6533,
      CORPUS_ERROR_RATE: 0.003,
      OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
      CLAIMED_TURN_COUNT: 4,
      EXCLUDED_ERROR_COUNT: 2,
    };
    const r = {
      ...rec("C1", base),
      savings_u_per_wk: 107_349,
      allocated_u_per_wk: null,
      reliability_u_per_wk: 3_000,
    } as CardActionRecommendation;
    const problem =
      buildTrigger(r, { allocated_u_per_wk: null, reliability_u_per_wk: 3_000 }).problem ?? "";
    expect(problem).toContain("$0.11 a week");
    expect(problem).toContain("under $0.01 a week");
    expect(problem).not.toContain("$0.00");
    const text = buildCardActions(r).primary.copy_text;
    expect(text).toContain(
      "2 more ERROR results from this tool in the week (6 in all) were not counted",
    );
    expect(text).toContain("Cost check:");
  });

  it("C11 does not call a Read that passed offset or limit a whole-file Read", () => {
    const ranged = rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
      call({
        tool: "Read",
        target: "~/docs/plan.md",
        whole_file: false,
        result:
          "File content (28561 tokens) exceeds maximum allowed tokens (25000). Use offset and limit.",
      }),
    ]);
    const { summary, detail, copy_text: text } = buildCardActions(ranged).primary;
    expect(`${summary}\n${detail.join("\n")}\n${text}`).not.toMatch(
      /whole-file|general large-file rule|did not stop this/i,
    );
    expect(summary).toContain("already passed offset or limit");
    expect(detail.join("\n")).toContain("not an MCP tool response");
    expect(cardTitle(ranged)).not.toMatch(/MCP|instead of whole/);

    const whole = rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
      call({
        tool: "Read",
        target: "~/docs/plan.md",
        whole_file: true,
        result: "File content (28561 tokens) exceeds maximum allowed tokens (25000).",
      }),
    ]);
    expect(buildCardActions(whole).primary.summary).toContain("a whole-file Read hit");
  });

  it("C9 uses one session count for the blocked-calls line and the all-counted line", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const guard = (n: number) =>
      call({
        tool: "Bash",
        kind: "command",
        target: `ls jobs/id/tmp/f${n}`,
        guard_shape: "SCRATCH_TMP",
        session_ids: [`extra${n}`],
        result:
          "Blocked command shape (CLAUDE.md rules 1-3 + destructive git): tmp writes / git reset --hard",
      });
    const text = buildCardActions(
      rec(
        "C9",
        { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 30, session_count: 25 },
        [guard(1), guard(2), guard(3)],
        ids,
      ),
    ).primary.copy_text;
    expect(text).toContain("in 25 sessions");
    expect(text).not.toMatch(/in 2[0-4] sessions/);
    expect(text).toContain("The 25 sessions are all counted");
  });
});
