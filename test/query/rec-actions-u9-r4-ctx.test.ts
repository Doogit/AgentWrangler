import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { existingReadRule } from "../../src/query/api/rec-actions/families/context.js";
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

const scratch = mkdtempSync(path.join(os.tmpdir(), "aw-u9-r4-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** os.homedir() reads USERPROFILE (Windows) or HOME: point it at an empty folder so the user's own CLAUDE.md is not read. */
function withEmptyHome<T>(run: () => T): T {
  const home = path.join(scratch, "empty-home");
  mkdirSync(home, { recursive: true });
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

describe("U9 round 4, lane ctx", () => {
  it("D8 makes the break message a user habit, not a CLAUDE.md rule, and does not contradict itself", () => {
    const r = rec("D8", {
      churn_event_count: 24,
      session_count: 1,
      total_churn_creation_tokens: 4_429_373,
      net_churn_creation_tokens: 2_832_173,
      base_prefix_tokens: 66_550,
      gap_60_240_min_count: 11,
      gap_240_plus_min_count: 13,
      longest_gap_min: 2312,
    });
    const text = buildCardActions(r).primary.copy_text;
    expect(text).not.toContain("add this line to ~/.claude/CLAUDE.md");
    expect(text).toContain("Claude cannot know a break is coming");
    expect(text).toContain("Before you step away for more than 1 hour");
    expect(text).not.toContain("No files need to change");
    expect(text).toContain("something I type, not a CLAUDE.md rule");
  });

  it("D2 says what it measured when git commands ran but no SHA was read", () => {
    const base = {
      qualifying_session_count: 3,
      qualifying_turn_count: 592,
      raw_context_average_tokens_per_turn: 259_000,
      commit_boundary_count: 0,
    };
    const withGit = buildTrigger(rec("D2", { ...base, git_command_count: 45 })).problem ?? "";
    expect(withGit).toContain(
      "No commit SHAs could be read from these sessions (45 git commands ran",
    );
    expect(withGit).not.toContain("No commits were recorded");
    expect(withGit).toContain("an assumption and not task boundaries found in your sessions");
    const prompt = buildCardActions(rec("D2", { ...base, git_command_count: 45 })).primary
      .copy_text;
    expect(prompt).toContain("Task boundaries were not measured: 45 git commands");
  });

  it("D4 is a habit with a ready dispatch line and words the dollars as an estimate", () => {
    const r = rec(
      "D4",
      {
        mismatch_turns_per_week: 661,
        opus_subagent_count: 27,
        lookup_subagent_count: 15,
        avg_output_tokens: 38,
        mismatch_fraction: 0.8485,
      },
      undefined,
      {
        facts: {
          top_agent_types: ["general-purpose"],
          top_agents: ["a1b2c3d4|sess-1|general-purpose|120|35"],
        },
        savings_u_per_wk: 3_150_000,
      },
    );
    // Point home at an empty folder so the user's own CLAUDE.md model rule is not read.
    const actions = withEmptyHome(() => buildCardActions(r));
    expect(actions.primary.kind).toBe("HABIT");
    expect(actions.primary.summary).toContain(
      "Pass model: sonnet on Agent calls that only read or search",
    );
    expect(actions.primary.summary).toContain("a1b2c3d4 (general-purpose)");
    expect(actions.primary.copy_text).toContain(
      "Ready CLAUDE.md line (only if step 5 finds no rule saying the same): `When dispatching an Agent call that only reads or searches, pass model: sonnet",
    );
    expect(actions.primary.copy_text).toContain("does not prove a lookup");
    const trigger = buildTrigger(r, { allocated_u_per_wk: 3_150_000, reliability_u_per_wk: null });
    expect(trigger.summary).toContain(
      "If all of these are really lookups, the estimate is about $3.15 a week",
    );
    expect(trigger.summary).not.toContain("Fixing it saves");
  });

  it("D6 leads with a ready CLAUDE.md line, labels MiB and does not present the share as a saving", () => {
    const r = rec(
      "D6",
      {
        session_count: 54,
        tool_result_bytes: 20_258_613,
        read_result_bytes: 9_842_530,
        bloat_share: 0.171,
      },
      [call({ target: "/nowhere-r4/a.md", calls: 3, total_bytes: 90_000, max_bytes: 30_000 })],
      { facts: { top_tools: ["Read|9842530|1970", "Bash|7049229|4626"] } },
    );
    const text = withEmptyHome(() => buildCardActions(r).primary.copy_text);
    const fix = text.slice(text.indexOf("## Fix"));
    expect(fix.startsWith("## Fix\nReady CLAUDE.md line")).toBe(true);
    expect(text).toContain("9.4 MiB of the 19.3 MiB");
    expect(text).toContain("sizes are 1,024-based");
    expect(text).toContain("not of what a fix would save");
    const problem = buildTrigger(r).problem ?? "";
    expect(problem).toContain("That is what re-sending cost, not what a fix would save");
    expect(problem).not.toContain(" MB");
  });

  it("finds a Read-range rule in the CLAUDE.md above a file, with its size threshold", () => {
    const repo = path.join(scratch, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(
      path.join(repo, "CLAUDE.md"),
      "# R\n- Grep first; Read files over 40 KB with offset/limit.\n",
    );
    const found = existingReadRule(path.join(repo, "src", "big.ts"), scratch);
    expect(found?.line).toBe("Grep first; Read files over 40 KB with offset/limit.");
    expect(found?.kb).toBe(40);
    expect(existingReadRule(path.join(scratch, "other", "x.md"), scratch)).toBeNull();
  });

  it("A1 says the reads happened despite an existing rule and gives a different one", () => {
    const repo = path.join(scratch, "repo2");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      path.join(repo, "CLAUDE.md"),
      "- Grep first; Read files over 40 KB with offset/limit.\n",
    );
    const r = rec(
      "A1",
      { EVENT_COUNT: 72, MAX_RESULT_BYTES: 64_809, RESULT_BYTES_TOTAL: 2_646_735 },
      [
        call({
          target: path.join(repo, "trigger.ts"),
          calls: 2,
          session_count: 2,
          session_ids: ["s1", "s2"],
          total_bytes: 85_308,
          max_bytes: 52_982,
          is_subagent: true,
        }),
      ],
    );
    const text = buildCardActions(r).primary.copy_text;
    expect(text).toContain("already has this rule");
    // U9 r5: the lead group was read with offset and limit, so it followed the rule; the rule
    // does not cap the range size.
    expect(text).toContain(
      "The lead group was already read with offset and limit, so it followed the rule",
    );
    expect(text).toContain("its 40 KB threshold is above the 25 KB these results crossed");
    expect(text).toContain("Cap every Read at 300 lines when the file is over 25 KB");
    expect(text).toContain("The lead group ran inside a subagent");
  });
});
