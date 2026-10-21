import { describe, expect, it } from "vitest";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
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

describe("U9 round 4, tool lane", () => {
  it("C3 keeps the counts, the thread split and the files in the card, and only the rule in the paste", () => {
    const {
      summary,
      detail,
      copy_text: text,
    } = buildCardActions(
      rec(
        "C3",
        { ERROR_COUNT: 36, SESSION_COUNT: 9, SUBAGENT_ERROR_COUNT: 26, WRITE_ERROR_COUNT: 10 },
        [call({ tool: "Edit", target: "~/r/F5.md", calls: 6, subagent_calls: 5 })],
      ),
    ).primary;
    expect(summary).toContain("36 edit or write calls");
    expect(summary).toContain("26 in subagents");
    expect(summary).toContain("10 in the main thread");
    expect(detail.join("\n")).toContain("`~/r/F5.md` 6 times");
    expect(text).toContain("Read each file before you Edit or Write it");
    // U9 r6: the evidence rides below the rule, marked as not part of it (see the r6 test file).
    expect(text.split("Where this came from")[0]).not.toMatch(/36|F5\.md/);
  });

  it("C2 lists every call read back and says how many could not be read back", () => {
    const calls = Array.from({ length: 7 }, (_, i) =>
      call({ target: `~/r/g${i}.ts`, cause: "GUESSED_PATH", result: "File does not exist." }),
    );
    const text = buildCardActions(
      rec("C2", { ERROR_COUNT: 16, SESSION_COUNT: 11 }, calls, ["s1", "s2"]),
    ).primary.copy_text;
    for (let i = 0; i < 7; i++) expect(text).toContain(`~/r/g${i}.ts`);
    expect(text).toContain("9 of the 16 lookups could not be read back");
  });

  it("C1 labels a small sample, the unread call, and an inferred document.open() as unverified", () => {
    const err = (target: string) =>
      call({
        tool: "mcp__claude-in-chrome__javascript_tool",
        kind: "other",
        target,
        session_ids: [target.slice(0, 2)],
        result:
          "JavaScript execution error: TypeError: Cannot read properties of null (reading 'x')",
      });
    const text = buildCardActions(
      rec(
        "C1",
        {
          TOOL_ERROR_COUNT: 4,
          TOOL_CALL_COUNT: 36,
          TOOL_ERROR_RATE: 0.11,
          OUTLIER_TOOLS: "mcp__claude-in-chrome__javascript_tool",
        },
        [err("aa document.open();document.x"), err("bb y"), err("cc z")],
        ["aa", "bb", "cc", "dd"],
      ),
    ).primary.copy_text;
    expect(text).toContain("Small sample: 4 failed calls");
    expect(text).toContain("1 of the 4 failed calls could not be read back");
    expect(text).toContain("no call read back for: dd");
    expect(text).toContain("browser timeouts");
    expect(text).toContain("Whether that caused its null read is unverified");
    expect(text).not.toContain("do not call `document.open()`");
  });

  it("C11 names the file and size, and scopes the count to the main conversation", () => {
    const actions = buildCardActions(
      rec("C11", { ERROR_COUNT: 0, READ_ERROR_COUNT: 1 }, [
        call({
          whole_file: true,
          target: "~/r/docs/plan.md",
          result: "File content (28561 tokens) exceeds maximum allowed tokens (25000).",
        }),
      ]),
    );
    // U9 r9: the file and size are in the card body; copy_text is the rule only.
    expect(actions.primary.detail.join("\n")).toContain(
      "~/r/docs/plan.md: 28561 tokens against a cap of 25000",
    );
    // U9 r6: nothing shows a CLAUDE.md rule was in context, so the card no longer says one failed.
    expect(actions.primary.detail.join("\n")).not.toContain("did not stop this Read");
    expect(actions.primary.detail.join("\n")).toContain("main conversation's Reads only");
  });

  it("C9 prints a fix shared by two shapes once", () => {
    const blocked = (tool: string, shape: "SCRATCH_TMP" | "PS_SCRATCH_TMP") =>
      call({
        tool,
        kind: "command",
        target: "cp a/tmp/x b",
        result: `PreToolUse:${tool} hook error: Blocked ${tool} shape: tmp writes.`,
        guard_shape: shape,
        calls: 2,
      });
    const actions = buildCardActions(
      rec("C9", { DENIAL_CLASS: "HOOK_BLOCK", DENIAL_COUNT: 6 }, [
        blocked("Bash", "SCRATCH_TMP"),
        blocked("PowerShell", "PS_SCRATCH_TMP"),
      ]),
    );
    const fix = "exempt only the job scratch folder from the `/tmp` rule";
    // U9 r7: the summary names the group; the fix itself is one detail line.
    expect(actions.primary.detail.join("\n").split(fix).length - 1).toBe(1);
    expect(actions.primary.copy_text.split(fix).length - 1).toBe(1);
    expect(actions.primary.copy_text).toContain("read the commands under `hooks.PreToolUse`");
    expect(actions.primary.copy_text).toContain("2 of the 6 blocks were not read back");
  });
});
