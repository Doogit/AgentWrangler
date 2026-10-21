import { describe, expect, it } from "vitest";
import { isBenignFailure } from "../../src/detector/turn-claim.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import { TMP_SCRUB_SED } from "../../src/query/api/rec-actions/trigger.js";
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
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: { session_ids: ["s1"], metrics: metrics(values) },
  ...(tool_calls === undefined ? {} : { tool_calls }),
});

describe("U9 tool lane", () => {
  it("C3 states the Edit/Write split per thread and names the files", () => {
    const actions = buildCardActions(
      rec(
        "C3",
        {
          ERROR_COUNT: 36,
          SESSION_COUNT: 9,
          SUBAGENT_ERROR_COUNT: 26,
          WRITE_ERROR_COUNT: 10,
          SUBAGENT_WRITE_ERROR_COUNT: 4,
        },
        [
          call({
            tool: "Write",
            target: "~/.claude/jobs/j1/msg1.txt",
            calls: 3,
            subagent_calls: 1,
          }),
        ],
      ),
    );
    const { summary, detail } = actions.primary;
    expect(summary).toContain("26 in subagents (22 Edit, 4 Write)");
    expect(summary).toContain("10 in the main thread (4 Edit, 6 Write)");
    expect(summary).not.toContain("10 of them Write");
    expect(detail.join("\n")).toContain(
      "Write `~/.claude/jobs/j1/msg1.txt` 3 times (1 in subagents)",
    );
    expect(detail.join("\n")).toContain("new file name");
    expect(actions.primary.copy_text).toContain("Read each file before you Edit or Write it");
  });

  it("C4 strips the harness tag, counts files and points a not-read cause at C3", () => {
    const actions = buildCardActions(
      rec("C4", {
        FAILED_EDIT_COUNT: 7,
        AFFECTED_FILE_COUNT: 2,
        TOP_FAILURE_ERROR_TEXT:
          "File has not been read yet. Read it first before writing to it.</tool_use_error>",
      }),
    );
    const text = `${actions.primary.summary}\n${actions.primary.copy_text}`;
    expect(text).not.toContain("tool_use_error");
    expect(text).toContain("across 2 files");
    expect(text).not.toContain("on one file");
    expect(text).toContain("Read a file's current contents before issuing an Edit or Write to it");
  });

  it("C5 drops the harness tag and names the failing call", () => {
    const actions = buildCardActions(
      rec(
        "C5",
        {
          REPEATED_ERROR_COUNT: 3,
          TOP_LOOP_TOOL: "Write",
          TOP_LOOP_ERROR_TEXT:
            "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
        },
        [call({ tool: "Write", target: "~/.claude/jobs/j1/msg1.txt", calls: 2 })],
      ),
    );
    expect(actions.primary.copy_text).not.toContain("tool_use_error");
    expect(actions.primary.copy_text).toContain("Write `~/.claude/jobs/j1/msg1.txt` twice");
    expect(actions.primary.copy_text).toContain("Read a file's current contents");
  });

  it("C1 pre-fills the cause when the errors name it", () => {
    const err = (n: string) =>
      call({
        tool: "mcp__claude-in-chrome__javascript_tool",
        target: "javascript_exec",
        kind: "other",
        result: `JavaScript execution error: TypeError: Cannot read properties of null (reading '${n}')`,
      });
    const actions = buildCardActions(
      rec(
        "C1",
        {
          TOOL_ERROR_COUNT: 4,
          TOOL_CALL_COUNT: 40,
          TOOL_ERROR_RATE: 0.1,
          OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
        },
        [err("documentElement"), err("querySelectorAll"), err("getBoundingClientRect")],
      ),
    );
    const text = actions.primary.copy_text;
    expect(text).toContain("in 3 of the 3 calls read back");
    expect(text).toContain("document.readyState === 'complete'");
    expect(text).not.toContain("a wrong parameter");
  });

  it("C11 on Read errors only names the file and is not titled about MCP", () => {
    const r = rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
      call({ target: "~/repo/big.txt", whole_file: true }),
    ]);
    const actions = buildCardActions(r);
    expect(actions.primary.summary).toBe(
      "Read large files in ranges: a whole-file Read hit the output cap (`~/repo/big.txt`).",
    );
    expect(cardTitle(r)).not.toMatch(/MCP|head_limit/);
  });

  it("C3 pastes only the rule; the evidence stays in the summary and details", () => {
    const actions = buildCardActions(
      rec(
        "C3",
        { ERROR_COUNT: 36, SESSION_COUNT: 9, SUBAGENT_ERROR_COUNT: 26, WRITE_ERROR_COUNT: 10 },
        [call({ tool: "Write", target: "~/.claude/jobs/j1/msg1.txt", calls: 3 })],
      ),
    );
    const paste = actions.primary.copy_text;
    expect(paste).toContain("Read each file before you Edit or Write it");
    // U9 r6: the evidence follows the rule under a "not part of the rule" marker.
    expect(paste.split("Where this came from")[0]).not.toMatch(/36|jobs|week measured|Hit most/);
    expect(actions.primary.summary).toContain("36");
    expect(actions.primary.detail.join("\n")).toContain("msg1.txt");
  });

  it("C1 admits the cause is unknown and labels the CLAUDE.md line an unverified trial", () => {
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
          TOOL_ERROR_COUNT: 4,
          TOOL_CALL_COUNT: 36,
          TOOL_ERROR_RATE: 0.11,
          CORPUS_ERROR_RATE: 0.0035,
          OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
        },
        [err("documentElement"), err("querySelectorAll"), err("getBoundingClientRect")],
      ),
    ).primary.copy_text;
    expect(text).toContain("The cause is unknown");
    expect(text).toContain("unverified trial, not a fix");
    expect(text).not.toContain("treat this line as a trial");
  });

  it("C1 problem says about 0.1 expected failures, not 'about 0'", () => {
    const trigger = buildTrigger(
      rec("C1", {
        TOOL_ERROR_COUNT: 4,
        TOOL_CALL_COUNT: 36,
        TOOL_ERROR_RATE: 0.11,
        CORPUS_ERROR_RATE: 0.0035,
        CORPUS_CALL_COUNT: 6595,
        OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
      }),
    );
    expect(trigger.problem).toContain("about 0.1 of these 36 calls");
    expect(trigger.problem).not.toContain("about 0 of");
  });

  it("C2 separates a deliberate probe from real errors and says subagent lookups are unpriced", () => {
    const actions = buildCardActions(
      rec("C2", { ERROR_COUNT: 3, SESSION_COUNT: 2 }, [
        call({
          tool: "Grep",
          kind: "search",
          target: "D8|/compact in ~/repo/.audits-none",
          cause: "GUESSED_PATH",
        }),
        call({
          tool: "Grep",
          kind: "search",
          target: "spawn in ~/repo/.githooks",
          cause: "GUESSED_PATH",
        }),
      ]),
    );
    const text = actions.primary.copy_text;
    expect(text).toContain("Deliberate probes, not Claude mistakes: 1 of these lookups");
    expect(text).toContain("`~/repo/.audits-none`");
    expect(text).not.toContain("`~/repo/.githooks`)");
    expect(text).toContain("counted but not priced");
  });

  it("C11 on one Read pastes a plain rule with no conditional and says it is not MCP", () => {
    const r = rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
      call({
        whole_file: true,
        target: "~/repo/docs/plan.md",
        result:
          "File content (28561 tokens) exceeds maximum allowed tokens (25000). Use offset and limit",
      }),
    ]);
    const { copy_text: paste, detail } = buildCardActions(r).primary;
    // U9 r9: copy_text is the rule only; the file and size are in the card body.
    expect(paste).toContain("Read it with offset and limit");
    expect(detail.join("\n")).toContain("28561 tokens against a cap of 25000");
    expect(paste).not.toMatch(/If CLAUDE\.md|MCP/);
    expect(detail.join("\n")).toContain("not an MCP tool response");
    expect(detail.join("\n")).not.toContain("did not stop this Read");
  });

  it("C9 guard fix shows a few examples and a search command for the guard script", () => {
    const blocked = (n: number) =>
      call({
        tool: "Bash",
        kind: "command",
        target: `cp a/tmp/x${n} b`,
        result: "Blocked command shape (CLAUDE.md rules 1-3): tmp writes.",
        guard_shape: "SCRATCH_TMP",
        calls: 1,
      });
    const text = buildCardActions(
      rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 8 }, [1, 2, 3, 4, 5, 6].map(blocked)),
    ).primary.copy_text;
    expect(text).toContain("Showing 3 of 6 harmless blocked call groups");
    expect(text).toContain("cp a/tmp/x3 b");
    expect(text).not.toContain("cp a/tmp/x4 b");
    expect(text).toContain('grep -rn "Blocked command shape" ~/.claude .claude');
    expect(text).toContain(TMP_SCRUB_SED);
  });

  it("D7 gives the one-line fix when the repeated Read hit the output cap", () => {
    const actions = buildCardActions(
      rec(
        "D7",
        { loop_flagged_turn_count: 3, loop_example_call_count: 3, error_loop_event_count: 3 },
        [
          call({
            target: "~/.claude/jobs/j1/dump.txt",
            result: "File content (42KB) exceeds maximum allowed size (25KB).",
          }),
        ],
      ),
    );
    expect(actions.primary.option_id).toBe("d7-read-in-ranges-after-cap-error");
    expect(actions.primary.summary).toContain("~/.claude/jobs/j1/dump.txt");
    expect(actions.primary.copy_text).toContain("offset and limit");
  });

  it("C9 keeps an action when the guard pattern is too wide (it had none)", () => {
    const guarded = call({
      tool: "Bash",
      kind: "command",
      target: "cp a/tmp/x b",
      result:
        "PreToolUse:Bash hook error: Blocked command shape (CLAUDE.md rules 1-3): tmp writes.",
      guard_shape: "SCRATCH_TMP",
      calls: 3,
    });
    const actions = buildCardActions(
      rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 3 }, [guarded]),
    );
    expect(actions.primary.option_id).toBe("c9-review-blocking-guard");
    expect(actions.primary.kind).toBe("INVESTIGATE");
    // U9 r7: the fix keeps the guard's `/tmp/` rule and cuts out only the job scratch folder first.
    expect(actions.primary.copy_text).toContain(TMP_SCRUB_SED);
  });

  it("a not-read Edit or Write is no failure for C1 or C5", () => {
    const err =
      "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";
    expect(isBenignFailure(null, err, "Write")).toBe(true);
    expect(isBenignFailure(null, err, "Edit")).toBe(true);
    expect(isBenignFailure(null, err, "Bash")).toBe(false);
    expect(isBenignFailure(null, "String to replace not found in file.", "Edit")).toBe(false);
  });
});
