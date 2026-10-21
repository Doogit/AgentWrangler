import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { existingModelRule } from "../../src/query/api/rec-actions/families/routing.js";
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

const scratch = mkdtempSync(path.join(os.tmpdir(), "aw-u9-r5-"));
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

describe("U9 round 5, lane ctx", () => {
  it("D8 states the cache tier the resume turns wrote to, not a plan rule", () => {
    const r = rec("D8", {
      churn_event_count: 24,
      session_count: 1,
      total_churn_creation_tokens: 4_429_373,
      net_churn_creation_tokens: 2_833_133,
      base_prefix_tokens: 66_510,
      gap_60_240_min_count: 11,
      gap_240_plus_min_count: 13,
      longest_gap_min: 2312,
      churn_write_1h_tokens: 4_429_373,
      churn_write_5m_tokens: 0,
    });
    const text = buildCardActions(r).primary.copy_text;
    expect(text).toContain(
      "these resume turns wrote 4,429,373 tokens to the 1-hour cache tier and 0 to the 5-minute tier",
    );
    expect(text).toContain("read it from a setting or assume it from your plan");
    expect(text).not.toContain("with that script");
    expect(text).not.toContain("1 hour on a subscription");
    expect(text).toContain(
      "paste this line:\n\n`If this task continues, write a handoff (goal, decisions, files, next step) now, to a file named HANDOFF- followed by the current git branch name and .md.`",
    );
    expect(text).not.toContain("<branch>");
  });

  it("D4 says the user's own model rule was broken instead of shipping the same line", () => {
    const r = rec(
      "D4",
      {
        mismatch_turns_per_week: 661,
        opus_subagent_count: 27,
        lookup_subagent_count: 15,
        total_opus_turns_per_week: 779,
        avg_output_tokens: 38,
        mismatch_fraction: 0.8485,
      },
      undefined,
      {
        facts: {
          top_agent_types: ["general-purpose", "workflow-subagent"],
          top_agents: [
            "ab8599bb|s-1|general-purpose|102|46",
            "ace6fb52|s-2|general-purpose|102|39",
          ],
        },
      },
    );
    const withRule = withHome(
      "# Prefs\n- Delegate to right-sized subagents (`sonnet` default; `opus` for hard reasoning).\n",
      () => buildCardActions(r).primary.copy_text,
    );
    const fix = withRule.slice(withRule.indexOf("## Fix"), withRule.indexOf("## Steps"));
    expect(fix).toContain(
      'Your ~/.claude/CLAUDE.md already has a model rule: "Delegate to right-sized',
    );
    expect(fix).toContain(
      "(ab8599bb, ace6fb52 and the rest) still ran on Opus. The data does not show why",
    );
    expect(fix).not.toContain("dispatches broke it");
    expect(fix).not.toContain("Ready CLAUDE.md line");
    // One bullet per type, not one dense paragraph.
    expect(fix).toContain("\n- Custom agent definition:");
    expect(fix).toContain("\n- general-purpose:");
    expect(fix).toContain("\n- workflow-subagent:");
    const noRule = withHome(null, () => buildCardActions(r).primary.copy_text);
    expect(noRule).toContain("Ready CLAUDE.md line (only if step 5 finds no rule saying the same)");
    expect(withHome(null, () => existingModelRule())).toBeNull();
    const problem = buildTrigger(r).problem ?? "";
    expect(problem).toContain("settled Opus turns at the last evaluation");
    expect(problem).toContain("a count taken later is higher");
  });

  it("U9 r6: D4 quote ends at a word with no open backtick; D1 sources its target and turn basis; D2 prints per-session measures", () => {
    const long = `- Delegate to right-sized subagents (\`sonnet\` default; \`opus\` for hard reasoning / architecture / security / migrations / money / external contracts; \`haiku\` for pure lookup/grep) and keep the main thread small${" and so on".repeat(10)}.`;
    const rule = withHome(long, () => existingModelRule());
    expect(rule?.line.endsWith(" ...")).toBe(true);
    expect(rule?.line).not.toContain("`");
    expect(rule?.line).toMatch(/\w \.\.\.$/);

    const d1 = rec("D1", {
      source_tokens: 3502,
      source_target: 2000,
      delta_context_tokens: 1502,
      turns_per_week: 9259,
      workspace_multiplier: 3,
      component: "CLAUDE_MD",
    });
    const problem = buildTrigger(d1).problem ?? "";
    expect(problem).toContain("suggested default");
    expect(problem).toContain("subagent turns other than Explore and Plan");
    const prompt = buildCardActions(d1).primary.copy_text;
    expect(prompt).toContain("suggested default size");
    expect(prompt).toContain("except Explore and Plan agents");

    const d2 = rec(
      "D2",
      {
        qualifying_session_count: 3,
        qualifying_turn_count: 592,
        raw_context_average_tokens_per_turn: 259_130,
      },
      undefined,
      { facts: { session_stats: ["s-1|221|313000|340000|40", "s-2|186|250000|300000|0"] } },
    );
    const d2Text = buildTrigger(d2).problem ?? "";
    expect(d2Text).toContain("s-1: 221 model calls");
    expect(d2Text).toContain("on call 40");
    expect(d2Text).toContain("s-2: 186 model calls");
  });

  it("A1 states what the dollars cover and how much of it the lead group holds", () => {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      path.join(repo, "CLAUDE.md"),
      "- Grep first; Read files over 40 KB with offset/limit.\n",
    );
    const lead: CardToolCall = {
      target: path.join(repo, "trigger.ts"),
      kind: "file",
      tool: "Read",
      calls: 2,
      session_ids: ["s1", "s2"],
      session_count: 2,
      total_bytes: 85_308,
      max_bytes: 52_982,
      whole_file: false,
      is_subagent: true,
    };
    const r = rec(
      "A1",
      { EVENT_COUNT: 75, MAX_RESULT_BYTES: 64_809, RESULT_BYTES_TOTAL: 2_773_667 },
      [lead],
    );
    const text = buildCardActions(r).primary.copy_text;
    // 85,308 - 2 x 25,600 = 34,108 B of the 2,773,667 - 75 x 25,600 = 853,667 B above the line (4%).
    expect(text).toContain("the dollars on the card cover all 75 large results");
    expect(text).toContain("(4%)");
    expect(text).toContain(
      "The lead group was already read with offset and limit, so it followed the rule",
    );
    expect(text).not.toContain("so do not add it again");
    expect(text).toContain("Do not add the rule again; replace it with the stricter one below");
    const problem = buildTrigger(r).problem ?? "";
    expect(problem).toContain("bytes above 25 KB ÷ 2.7 bytes per token × 50% assumed avoidable");
    expect(problem).toContain("It covers all 75 results");
  });

  it("D6 lists no files it did not list, and does not claim an existing rule was violated", () => {
    const r = rec("D6", {
      session_count: 54,
      tool_result_bytes: 20_258_613,
      read_result_bytes: 9_842_530,
      bloat_share: 0.171,
    });
    const text = withHome(
      "- Grep first; Read files over 40 KB with offset/limit.\n",
      () => buildCardActions(r).primary.copy_text,
    );
    expect(text).not.toContain("listed under Findings");
    expect(text).not.toContain("came back despite");
    expect(text).toContain("the 300-line threshold is a suggested starting point");
    // U9 r6: file size vs result size, and subagent turns, are stated.
    expect(text).toContain(
      "The rule applies to files over 40 KB, but these results are each at most 25 KB",
    );
    expect(text).not.toContain("does not catch them");
    const withTop = withHome(
      null,
      () =>
        buildCardActions(
          rec("D6", { session_count: 3, tool_result_bytes: 900_000, turn_count: 50 }, [], {
            facts: { top_sessions: ["s1|500000|40"] },
          }),
        ).primary.copy_text,
    );
    expect(withTop).toContain("40 turns (includes subagent turns)");
    expect(withTop).toContain("including subagent turns");
    const listed = withHome(
      null,
      () =>
        buildCardActions(
          rec("D6", { session_count: 3, tool_result_bytes: 900_000, bloat_share: 0.1 }, [
            {
              target: "/nowhere-r5/a.md",
              kind: "file",
              tool: "Read",
              calls: 3,
              session_ids: [],
              session_count: 1,
              total_bytes: 90_000,
              max_bytes: 30_000,
              whole_file: false,
            },
          ]),
        ).primary.copy_text,
    );
    expect(listed).toContain("Then change each call by what it is:");
    expect(listed).toContain(
      "`a.md`: already read in parts, so offset and limit are not the lever.",
    );
  });
});
