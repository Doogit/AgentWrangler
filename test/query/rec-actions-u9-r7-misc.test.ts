import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { b4EventLine } from "../../src/detector/cache-collapse.js";
import { H1_HOOK_FN } from "../../src/query/api/rec-actions/families/permissions.js";
import { buildCardActions } from "../../src/query/api/rec-actions/index.js";
import { buildTrigger } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { rmRiskyPaths } from "../../src/query/api/tool-calls.js";

const metrics = (values: Record<string, number | string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));

const rec = (
  detector_id: string,
  values: Record<string, number | string>,
  extra: Partial<CardActionRecommendation> = {},
): CardActionRecommendation => ({
  detector_id,
  lever: "lever",
  evidence: { session_ids: ["s1"], metrics: metrics(values) },
  ...extra,
});

const scratch = mkdtempSync(path.join(os.tmpdir(), "aw-u9-r7-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("U9 round 7, lane misc", () => {
  it("D1 global shows the turn split, not a bare workspace count", () => {
    const r = rec("D1", {
      source_tokens: 3502,
      source_target: 2000,
      turns_per_week: 9491,
      workspace_multiplier: 2,
      top_workspace_turns: 9486,
      delta_context_tokens: 1502,
    });
    const fact = buildTrigger(r).facts.find((f) => f.label === "Workspaces");
    expect(fact?.value).toBe("2 (9,486 of 9,491 turns in one)");
    // Rows written before the split was stored keep the bare count.
    const old = rec("D1", { turns_per_week: 9491, workspace_multiplier: 2 });
    expect(buildTrigger(old).facts.find((f) => f.label === "Workspaces")?.value).toBe("2");
  });

  it("D2 rule does not depend on a commit, stays one line and names the skill it verifies", () => {
    const home = mkdtempSync(path.join(scratch, "home-"));
    mkdirSync(path.join(home, ".claude", "skills", "handoff-global"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "handoff-global", "SKILL.md"), "---\n---\n");
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const actions = buildCardActions(
        rec("D2", { qualifying_session_count: 3, raw_context_average_tokens_per_turn: 259_000 }),
      );
      expect(actions.primary.copy_text).toContain(
        "`When a task finishes, offer a handoff of at most 2K tokens and remind me to /clear.`",
      );
      expect(actions.primary.copy_text).toContain("swap out a line you no longer need");
      const alt = actions.alternatives[0]?.copy_text ?? "";
      expect(alt).toContain("(type /handoff-global)");
      expect(alt).not.toContain("type /handoff)");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("D8 pastes as is and lists the resuming sessions, biggest resume first", () => {
    const top = [
      "big|2026-10-05T21:04:22.148Z|269|413466|347004",
      "mid|2026-10-06T01:08:38.083Z|214|309859|243397",
      "big|2026-10-05T21:03:26.361Z|313|228220|161758",
    ];
    const ids = Array.from({ length: 12 }, (_, i) => `sess-${i}`);
    const r = rec(
      "D8",
      { churn_event_count: 25, session_count: 12, base_prefix_tokens: 66_462 },
      {
        evidence: { session_ids: ids, metrics: metrics({ churn_event_count: 25 }) },
        facts: { top_resumes: top },
      },
    );
    const listed = buildTrigger(r).session_ids;
    expect(listed.slice(0, 2)).toEqual(["big", "mid"]);
    expect(listed).toHaveLength(8);
    const text = buildCardActions(r).primary.copy_text;
    expect(text).not.toContain("<branch>");
    expect(text).toContain("to a file named HANDOFF- followed by the current git branch name");
  });

  it("B4 evidence copy ends with an ask that changes nothing and claims no saving", () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      b4EventLine({
        session_id: `sess-${i}`,
        ts: `2026-10-03T22:${String(10 + i).padStart(2, "0")}:00.000Z`,
        written: 200_000,
        read: 33_000,
        previous_read: 230_000,
        first_read: 33_000,
        gap_ms: 4_000,
        rewrite_cost_u: 1_000_000,
        after_tool_search: true,
        first_tool: "mcp__claude-in-chrome__navigate",
      }),
    ).join("\n");
    const r = rec("B4", {
      EVENTS: lines,
      EVENT_COUNT: 3,
      TOOLSEARCH_EVENT_COUNT: 3,
      CURRENT_CACHE_CREATION_TOKENS: 600_000,
      REWRITE_COST_U: 3_000_000,
      FIRST_MCP_LOAD_COUNT: 3,
      SESSION_TOOLSEARCH_CALLS: 4,
    });
    const text = buildCardActions(r).primary.copy_text;
    const ask = text.slice(text.indexOf("## Ask"));
    expect(ask).toContain("For each of the 3 breaks");
    expect(ask).toContain("Do not change any file and do not estimate a saving");
  });

  it("H1 hook rule: one mechanism, honest about the guard, and the patterns do what the card says", () => {
    const run: CardToolCall = {
      target:
        "U=C:/scratch/research; curl -s -o $U/a.json http://x; rm -rf $U/cards; node dump.cjs $U",
      kind: "command",
      whole_file: false,
      tool: "Bash",
      risk: "RISKY",
      risky_paths: ["C:/scratch/research/cards"],
      calls: 1,
      session_ids: ["s1"],
      session_count: 1,
      total_bytes: 0,
      max_bytes: 0,
    };
    const r = rec(
      "H1",
      { DESTRUCTIVE_OPERATION: "RM_RF", OPERATION_COUNT: 1 },
      { guard_exists: true, tool_calls: [run] },
    );
    const trigger = buildTrigger(r);
    const problem = trigger.problem;
    expect(problem).toContain("C:/scratch/research/cards");
    expect(problem).toContain("Check whether that was scratch space you meant to clear");
    expect(problem).toContain("saw your PreToolUse hook block calls in this workspace");
    expect(problem).not.toContain("guard already blocks");
    const primary = buildCardActions(r).primary;
    expect(primary.copy_text).toContain(H1_HOOK_FN);
    expect(primary.copy_text).not.toContain("permissions.ask");
  });

  // The H1 hook snippet's block/allow table (it supersedes the round-7 grep -E table) lives in
  // rec-actions-u9-r8-tool.test.ts.

  it("rmRiskyPaths resolves the command's own variable before naming the risky path", () => {
    expect(rmRiskyPaths("U=C:/scratch/research; rm -rf $U/cards; node x.cjs")).toEqual([
      "C:/scratch/research/cards",
    ]);
    expect(rmRiskyPaths("rm -rf dist")).toEqual([]);
  });
});
