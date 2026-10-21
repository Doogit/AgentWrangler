import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import { buildTrigger } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

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

const scratch = mkdtempSync(path.join(os.tmpdir(), "aw-u9-r8-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Point os.homedir() at a folder holding the given ~/.claude/CLAUDE.md (or none). */
function withHome<T>(claudeMd: string | null, run: () => T): T {
  const home = mkdtempSync(path.join(scratch, "home-"));
  if (claudeMd !== null) {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "CLAUDE.md"), claudeMd);
  }
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const call = (over: Partial<CardToolCall>): CardToolCall => ({
  target: "~/work/a.md",
  kind: "file",
  tool: "Read",
  calls: 1,
  session_ids: [],
  session_count: 1,
  total_bytes: 20_000,
  max_bytes: 20_000,
  whole_file: true,
  ...over,
});

describe("U9 round 8, lane ctx", () => {
  it("D2 quotes the user's own /clear rule and asks to tighten it, not re-ship it", () => {
    const d2 = rec(
      "D2",
      {
        qualifying_session_count: 3,
        qualifying_turn_count: 592,
        raw_context_average_tokens_per_turn: 259_000,
      },
      undefined,
      { facts: { session_stats: ["s-1|221|313000|458000|29", "s-2|186|232000|367000|59"] } },
    );
    const prompt = withHome(
      "# Prefs\n- Externalise state to plan files; `/clear` at task boundaries while still in the cheap zone (~40-60%).\n## Handover prompts\n- Use the handoff skill.\n",
      () => buildCardActions(d2).primary.copy_text,
    );
    const fix = prompt.slice(prompt.indexOf("## Fix"), prompt.indexOf("## Steps"));
    expect(fix).toContain('~/.claude/CLAUDE.md already says: "');
    expect(fix).toContain("/clear at task boundaries");
    expect(fix).toContain('has a "Handover prompts" section');
    expect(fix).toContain("passed 180K tokens of context at calls 29, 59 anyway");
    expect(fix).toContain("do not add a second rule");
    expect(fix).not.toContain("Ready rule for ~/.claude/CLAUDE.md");
    const none = withHome("# Prefs\n- Be concise.\n", () => buildCardActions(d2).primary.copy_text);
    expect(none).toContain("Ready rule for ~/.claude/CLAUDE.md");
  });

  it("D1 drops the move-repo-rules option when nearly all turns are in one workspace", () => {
    const base = {
      source_tokens: 3502,
      source_target: 2000,
      delta_context_tokens: 1502,
      turns_per_week: 10_169,
      workspace_multiplier: 2,
      component: "CLAUDE_MD",
      scope: "global",
    };
    const ids = (values: Record<string, number | string>) =>
      withHome(null, () =>
        buildCardActions(rec("D1", values)).alternatives.map((alt) => alt.option_id),
      );
    expect(ids({ ...base, top_workspace_turns: 10_164 })).not.toContain("d1-repo-rules-to-repo");
    expect(ids({ ...base, top_workspace_turns: 5_000 })).toContain("d1-repo-rules-to-repo");
  });

  it("D4 names every lookup agent with full id and cost, costliest first, and hedges the workflow claim", () => {
    const d4 = rec(
      "D4",
      {
        mismatch_turns_per_week: 900,
        opus_subagent_count: 30,
        lookup_subagent_count: 4,
        total_opus_turns_per_week: 1000,
        avg_output_tokens: 36,
        mismatch_fraction: 0.9,
      },
      undefined,
      {
        facts: {
          top_agent_types: ["general-purpose", "workflow-subagent"],
          top_agents: [
            "a0000000000000001|s-1|general-purpose|50|28|3500000",
            "a0000000000000002|s-2|workflow-subagent|90|40|2100000",
            "a0000000000000003|s-3|general-purpose|10|30|900000",
            "a0000000000000004|s-4|general-purpose|8|30|400000",
          ],
        },
      },
    );
    const prompt = withHome(null, () => buildCardActions(d4).primary.copy_text);
    for (const id of [
      "a0000000000000001",
      "a0000000000000002",
      "a0000000000000003",
      "a0000000000000004",
    ])
      expect(prompt).toContain(id);
    expect(prompt).toContain("general-purpose, 50 turns, 28 tokens, $3.50");
    expect(prompt).toContain("costliest first at Opus prices");
    expect(prompt).not.toContain("the model comes from the Workflow script's agent() call");
    expect(prompt).toContain("(not verified here)");
  });

  it("A1 leads with the general Read cap when the Read share is recorded; the one-file fix is the alternative", () => {
    const a1 = rec(
      "A1",
      {
        EVENT_COUNT: 82,
        MAX_RESULT_BYTES: 64_000,
        RESULT_BYTES_TOTAL: 3_000_000,
        READ_EVENT_COUNT: 71,
        READ_RESULT_BYTES: 2_700_000,
      },
      [
        call({
          target: "~/work/big.ts",
          whole_file: false,
          max_bytes: 52_000,
          total_bytes: 83_000,
        }),
        call({ target: "grep", kind: "command", tool: "Bash", whole_file: false }),
      ],
    );
    const actions = withHome(null, () => buildCardActions(a1));
    expect(actions.primary.option_id).toBe("a1-cap-read-size");
    expect(actions.primary.summary).toContain(
      "71 of the 82 large results are Reads (90% of the bytes)",
    );
    expect(actions.primary.copy_text).toContain(
      "Cap every Read at 300 lines when the file is over 25 KB",
    );
    expect(actions.primary.copy_text).toContain("The other 11");
    expect(actions.alternatives[0]?.copy_text).toContain("big.ts");
    expect(actions.alternatives[0]?.copy_text).not.toContain("- `grep`");
    expect(buildTrigger(a1, { allocated_u_per_wk: 2_000_000 }).summary ?? "").toContain(
      "(71 of 82, 90% of the bytes)",
    );
    // Rows without the Read share keep the one-file primary.
    const old = rec(
      "A1",
      { EVENT_COUNT: 82, MAX_RESULT_BYTES: 64_000, RESULT_BYTES_TOTAL: 3_000_000 },
      [call({ target: "~/work/big.ts" })],
    );
    expect(withHome(null, () => buildCardActions(old)).primary.option_id).toBe(
      "a1-bound-large-results",
    );
  });

  it("B1 puts this user's sessions and numbers in the primary paste", () => {
    const events =
      "s-1|2026-10-03T22:35:35.282Z|239252|33597|266641|33597|3580|1866166|1|mcp__claude-in-chrome__tabs_context_mcp\n" +
      "s-2|2026-10-06T16:30:14.976Z|198687|33520|227058|66506|4224|1549759|1|mcp__claude-in-chrome__navigate";
    const b1 = rec("B1", {
      COLLAPSE_EVENT_COUNT: 2,
      TOOLSEARCH_COLLAPSE_COUNT: 2,
      FIRST_MCP_LOAD_COUNT: 2,
      RAPID_COLLAPSE_COUNT: 2,
      CURRENT_CACHE_CREATION_TOKENS: 437_939,
      CURRENT_CACHE_READ_TOKENS: 67_117,
      PREVIOUS_CACHE_READ_TOKENS: 493_699,
      CURRENT_TO_PREVIOUS_RATIO: 0.14,
      REWRITE_COST_U: 3_400_000,
      EVENTS: events,
    });
    const text = buildCardActions(b1).primary.copy_text;
    expect(text).toContain("s-1, s-2");
    expect(text).toContain("437,939 tokens again ($3.40");
    expect(text).toContain("claude-in-chrome (2 of 2)");
    expect(text).toContain("When a task will use tools that load on demand through ToolSearch");
  });

  it("D6 asks per target: ranged reads and sed are not told to add offset/limit; the threshold comes from the whole-file reads", () => {
    const d6 = rec("D6", { session_count: 3, tool_result_bytes: 900_000, bloat_share: 0.1 }, [
      call({ target: "/nowhere-r8/a.ts", whole_file: false, calls: 9, max_bytes: 19_000 }),
      call({ target: "/nowhere-r8/b.md", whole_file: true, calls: 7, max_bytes: 14_500 }),
      call({
        target: "sed",
        kind: "command",
        tool: "Bash",
        whole_file: false,
        calls: 21,
        max_bytes: 24_000,
      }),
      call({
        target: "cat",
        kind: "command",
        tool: "Bash",
        whole_file: false,
        calls: 4,
        max_bytes: 25_000,
      }),
    ]);
    const prompt = withHome(null, () => buildCardActions(d6).primary.copy_text);
    expect(prompt).toContain(
      "`a.ts`: already read in parts, so offset and limit are not the lever.",
    );
    expect(prompt).toContain("`sed`: already a line-range read, so ranging is not the lever.");
    expect(prompt).toContain("`cat`: prints a whole file");
    expect(prompt).toContain("`b.md`: read whole 7 times");
    expect(prompt).toContain("Before reading a file over about 14 KB");
    expect(prompt).toContain("a rule set at 300 lines may not catch Reads that size");
  });

  it("C11 quotes the Read-range rule the project already has and asks to tighten it", () => {
    const dir = mkdtempSync(path.join(scratch, "proj-"));
    writeFileSync(
      path.join(dir, "CLAUDE.md"),
      "- Grep first; Read files over 40 KB with offset/limit.\n",
    );
    const file = path.join(dir, "plan.md");
    const c11 = (whole: boolean) =>
      rec("C11", { READ_ERROR_COUNT: 1 }, [
        call({
          target: file,
          whole_file: whole,
          ...({
            result: "File content (28561 tokens) exceeds maximum allowed tokens (25000).",
          } as object),
        }),
      ]);
    // U9 r9: the note about the existing rule is in the card body; copy_text is the rule only.
    const ranged = withHome(null, () => buildCardActions(c11(false)).primary);
    const rangedDetail = ranged.detail.join("\n");
    expect(rangedDetail).toContain(
      'already says: "Grep first; Read files over 40 KB with offset/limit."',
    );
    expect(rangedDetail).toContain("it followed that rule");
    expect(rangedDetail).toContain("do not add a second rule");
    expect(ranged.copy_text).toBe(
      "## Large files\n\nFor a file over 40 KB, Grep for the part you need, or Read it with offset and limit. If a ranged Read still exceeds the output cap, retry with half that limit, halving again until it fits; never retry the same Read.",
    );
    const whole = withHome(null, () => buildCardActions(c11(true)).primary.detail.join("\n"));
    expect(whole).toContain("did not follow that rule");
    const none = withHome(null, () => {
      const lone = mkdtempSync(path.join(scratch, "lone-"));
      return buildCardActions(
        rec("C11", { READ_ERROR_COUNT: 1 }, [
          call({ target: path.join(lone, "x.md"), whole_file: true }),
        ]),
      ).primary.detail.join("\n");
    });
    expect(none).not.toContain("already says");
  });
});
