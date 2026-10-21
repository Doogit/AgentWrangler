import { describe, expect, it } from "vitest";
import { c1Outcome } from "../../src/detector/turn-claim.js";
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

const metrics = (values: Record<string, number | string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));

const rec = (
  detector_id: string,
  values: Record<string, number | string>,
  tool_calls?: CardToolCall[],
  extra: Partial<CardActionRecommendation> = {},
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: { session_ids: ["s1"], metrics: metrics(values) },
  ...(tool_calls === undefined ? {} : { tool_calls }),
  ...extra,
});

describe("U9 round 2, lane r3", () => {
  it("C2 says what its two dollar figures price", () => {
    const r = rec(
      "C2",
      { ERROR_COUNT: 2, SESSION_COUNT: 2 },
      [call({ target: "~/repo/a.md", cause: "WRONG_WORKTREE", calls: 2 })],
      { savings_u_per_wk: 525_997 },
    );
    const problem = buildTrigger(r, {
      allocated_u_per_wk: null,
      reliability_u_per_wk: 141_994,
    }).problem;
    // U9 r4: one $ figure (the headline); the standalone $0.53 stays in the card's details.
    expect(problem).not.toContain("$0.53");
    expect(problem).toContain("the main conversation's turn after each failed lookup");
    expect(problem).toContain("cost up to $0.14 a week");
    expect(problem).not.toContain("Building paths from the current worktree's root avoids that");
  });

  it("C2 worktree fix is Glob first, with the root-checkout case", () => {
    const r = rec("C2", { ERROR_COUNT: 1, SESSION_COUNT: 1 }, [
      call({ target: "~/repo/.worktrees/x/a.md", cause: "WRONG_WORKTREE" }),
    ]);
    const text = buildCardActions(r).primary.copy_text;
    expect(text).toContain("Glob for its file name");
    expect(text).toContain("from the root checkout");
    expect(text).toContain("git rev-parse --show-toplevel");
  });

  it("C1 leaves a missing path to C2 and keeps real failures", () => {
    const gone =
      "Path does not exist: C:\\repo\\.audits-none. Note: your current working directory";
    const wrapped =
      "<tool_use_error>File does not exist. Note: your current working directory</tool_use_error>";
    for (const tool of ["Read", "Grep", "Glob"]) {
      expect(c1Outcome(tool, "ERROR", null, gone)).toBe("OK");
    }
    expect(c1Outcome("Read", "ERROR", null, wrapped)).toBe("OK");
    expect(
      c1Outcome("Grep", "ERROR", null, "Ripgrep search timed out after 20 seconds. Try a path"),
    ).toBe("ERROR");
    expect(c1Outcome("Bash", "ERROR", "ls x", "Exit code 2\nPath does not exist")).toBe("OK");
  });

  it("C1 on Grep names the ripgrep timeout, not a frozen tab", () => {
    const timeout = call({
      tool: "Grep",
      kind: "search",
      target: "x in ~/.claude/projects/p",
      result:
        "Ripgrep search timed out after 20 seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.",
    });
    const text = buildCardActions(
      rec(
        "C1",
        { TOOL_ERROR_COUNT: 3, TOOL_CALL_COUNT: 100, TOOL_ERROR_RATE: 0.03, OUTLIER_TOOLS: "Grep" },
        [
          timeout,
          { ...timeout, target: "y in ~/.claude/projects/p" },
          { ...timeout, target: "z in ~/.claude/projects/p" },
        ],
      ),
    ).primary.copy_text;
    expect(text).not.toContain("CDP");
    expect(text).not.toContain("frozen tab");
    expect(text).toContain("Ripgrep");
    expect(text).toContain("narrowest folder");
  });

  it("D6 names Bash as the second source, the top files and commands, and drops the clearing claim", () => {
    const r = rec(
      "D6",
      { session_count: 55, tool_result_bytes: 20_450_000, read_result_bytes: 10_080_000 },
      [
        call({ target: "~/repo/docs/plan.md", calls: 7, total_bytes: 140_000, max_bytes: 20_000 }),
        call({
          tool: "Bash",
          kind: "command",
          target: "git diff",
          calls: 30,
          total_bytes: 300_000,
        }),
      ],
      {
        facts: {
          tool_result_bytes: 20_450_000,
          top_tools: ["Read|10080000|2022", "Bash|7410000|4713", "Grep|1780000|1334"],
          top_sessions: ["s1|3900000|1334"],
        },
      },
    );
    const prompt = buildCardActions(r).primary.copy_text;
    expect(prompt).toContain("By tool: Read 9.6 MiB in 2,022 calls, Bash 7.1 MiB in 4,713 calls");
    expect(prompt).toContain("`~/repo/docs/plan.md`");
    expect(prompt).toContain("`git diff`");
    expect(prompt).not.toContain("tool-result clearing");
    const problem = buildTrigger(r).problem;
    expect(problem).toContain("The rest came mostly from Bash 7.1 MiB in 4,713 calls and Grep");
  });

  it("D4 names the busiest agents, shows the 50% basis and asks for an existing dispatch rule", () => {
    const r = rec(
      "D4",
      {
        mismatch_turns_per_week: 661,
        total_opus_turns_per_week: 804,
        opus_subagent_count: 30,
        lookup_subagent_count: 15,
        avg_output_tokens: 38,
        mismatch_fraction: 0.8221,
      },
      undefined,
      {
        facts: {
          top_agents: [
            "a1b2c3d4|sess-1|general-purpose|120|35",
            "e5f6a7b8|sess-2|workflow-subagent|80|40",
          ],
        },
        savings_u_per_wk: 3_150_000,
      },
    );
    const prompt = buildCardActions(r).primary.copy_text;
    expect(prompt).toContain("a1b2c3d4 in sess-1: general-purpose, 120 turns, 35 tokens");
    expect(prompt).toContain("e5f6a7b8 in sess-2: workflow-subagent, 80 turns, 40 tokens");
    expect(prompt).toContain("a rule that dispatches pass a model");
    const problem = buildTrigger(r).problem;
    expect(problem).toContain("= $6.30 a week × 50% assumed realizable = $3.15 a week");
    expect(problem).toContain("an assumption, not a measurement");
  });

  it("D2 says what it measured about task boundaries", () => {
    const base = {
      qualifying_session_count: 4,
      qualifying_turn_count: 811,
      raw_context_average_tokens_per_turn: 259_000,
    };
    const none = buildTrigger(rec("D2", { ...base, commit_boundary_count: 0 })).problem;
    expect(none).toContain("No commits were recorded in these sessions");
    expect(none).toContain("branch changes and file switches are not measured");
    const some = buildTrigger(
      rec("D2", { ...base, commit_boundary_count: 5, commit_anchored_splits: 2 }),
    ).problem;
    expect(some).toContain(
      "5 commits were recorded in these sessions, and 2 of the estimate's splits sit on one",
    );
    expect(buildTrigger(rec("D2", base)).problem).not.toContain("commits were recorded");
  });

  it("C3 says how many of its sessions it lists", () => {
    const summary = buildCardActions(
      rec("C3", {
        ERROR_COUNT: 36,
        SESSION_COUNT: 9,
        SUBAGENT_ERROR_COUNT: 26,
        WRITE_ERROR_COUNT: 10,
      }),
    ).primary.summary;
    expect(summary).toContain("across 9 sessions (1 listed)");
  });

  it("C9 classifies a missing-model dispatch as intended and states one harmless count", () => {
    const shape = (message: string) =>
      call({
        tool: "TaskCreate",
        kind: "other",
        target: "TaskCreate",
        result: `PreToolUse:TaskCreate hook error: ${message}`,
        guard_shape: "MISSING_MODEL",
        calls: 16,
      });
    const harmless = call({
      tool: "Bash",
      kind: "command",
      target: "cp a/tmp/x b",
      result: "PreToolUse:Bash hook error: Blocked command shape: tmp writes.",
      guard_shape: "SCRATCH_TMP",
      calls: 22,
    });
    const r = rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 38 }, [
      shape("Agent dispatch omitted `model`, so it would inherit the Opus session default"),
      harmless,
    ]);
    const problem = buildTrigger(r).problem ?? "";
    expect(problem).toContain("22 harmless");
    expect(problem).toContain("16 as intended");
    expect(problem).not.toContain("unclassified");
  });

  it("D7 leaves the ranges rule to the C11 card and owns only the retry", () => {
    const r = rec(
      "D7",
      { loop_flagged_turn_count: 3, loop_example_call_count: 3, error_loop_event_count: 3 },
      [
        call({
          target: "~/docs/plan.md",
          result: "File content (42KB) exceeds maximum allowed size (25KB).",
        }),
      ],
    );
    const actions = buildCardActions(r);
    expect(actions.primary.summary).toContain(
      "Read a smaller part of a large file, or Grep for it.",
    );
    expect(actions.primary.summary).toContain("Stop retrying");
    expect(cardTitle(r)).toBe("Stop retrying a Read after the output-cap error.");
  });

  it("C1 says which events it does not count", () => {
    const problem = buildTrigger(
      rec("C1", { TOOL_ERROR_COUNT: 4, TOOL_CALL_COUNT: 36, OUTLIER_TOOLS: "Grep" }),
    ).problem;
    expect(problem).toContain("Not counted as failures: a hook block");
    expect(problem).toContain("a browser timeout");
  });

  it("C1 does not claim why a null read happened", () => {
    const err = (n: string) =>
      call({
        tool: "mcp__claude-in-chrome__javascript_tool",
        kind: "other",
        result: `JavaScript execution error: TypeError: Cannot read properties of null (reading '${n}')`,
      });
    const text = buildCardActions(
      rec(
        "C1",
        {
          TOOL_ERROR_COUNT: 3,
          TOOL_CALL_COUNT: 40,
          OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
        },
        [err("a"), err("b"), err("c")],
      ),
    ).primary.copy_text;
    expect(text).toContain("the error does not say which");
    expect(text).toContain("unverified trial, not a fix");
  });
});
