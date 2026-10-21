/**
 * Review 5 U6: C1 and D11 (M8–M12 and the folded minors), register
 * `docs/handoffs/2026-09-26-card-review/review-5-fix-plan.md`. Expected values are worked by hand
 * in the comments; none is copied from output.
 */
import { describe, expect, it } from "vitest";
import { c1FindingDescriptor } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return {
    trigger,
    actions,
    violations: cardRuleViolations(actions, trigger, cardTitle(rec), rec.savings_u_per_wk),
  };
}

function failed(tool: string, target: string, result: string, calls = 1): CardToolCall {
  return {
    target,
    kind: tool === "PowerShell" ? "command" : "other",
    tool,
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result,
  };
}

const CHROME = [
  "javascript_tool",
  "computer",
  "browser_batch",
  "find",
  "navigate",
  "read_page",
  "tabs_create_mcp",
  "get_page_text",
].map((name) => `mcp__claude-in-chrome__${name}`);

describe("Review 5 U6: C1 (M8, M9, M10)", () => {
  // 8 browser tools + Artifact + Bash = 10 outlier tools, so "mostly browser control" (8 of 10).
  const metrics = {
    TOOL_CALL_COUNT: { value: 404 },
    TOOL_ERROR_COUNT: { value: 42 },
    TOOL_ERROR_RATE: { value: 42 / 404 },
    CORPUS_CALL_COUNT: { value: 14_495 },
    CORPUS_ERROR_RATE: { value: 0.018 },
    OUTLIER_TOOLS: { value: [...CHROME, "Artifact", "Bash"].join(", ") },
  };
  const c1 = (extra: Record<string, { value: number }> = {}): CardActionRecommendation => ({
    detector_id: "C1",
    lever: c1FindingDescriptor.presentation.lever,
    evidence: { session_ids: ["s1", "s2", "s3"], metrics: { ...metrics, ...extra } },
    // costEquivU 5,640,000 µUSD × 50% = 2,820,000 µUSD stored saving.
    savings_u_per_wk: 2_820_000,
    tool_calls: [
      failed(
        "mcp__claude-in-chrome__computer",
        'mcp__claude-in-chrome__computer {"action":"screenshot"}',
        'Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 1. The renderer may be frozen or unresponsive.',
      ),
      failed(
        "mcp__claude-in-chrome__javascript_tool",
        'mcp__claude-in-chrome__javascript_tool {"action":"javascript_exec"}',
        'Failed to execute JavaScript: CDP sendCommand "Runtime.evaluate" timed out after 45000ms on tab 1. The renderer may be frozen or unresponsive.',
      ),
      failed(
        "mcp__claude-in-chrome__browser_batch",
        'mcp__claude-in-chrome__browser_batch {"actions":[]}',
        "actions[2] (find) failed: Failed to find element: 400 prompt is too long: 234436 tokens > 200000 maximum",
      ),
      failed(
        "Artifact",
        "https://claude.ai/artifact/x",
        '<tool_use_error>action "read" takes only `url`, `prompt` and `page`, remove out_dir.</tool_use_error>',
      ),
    ],
  });

  it("M9: the failed-calls fact counts tools and names their family, not their ids", () => {
    const { trigger, actions } = card(c1({ CLAIMED_TURN_COUNT: { value: 42 } }));
    // 42 / 404 = 0.10396 → 10.4%.
    expect(trigger.facts).toContainEqual({
      label: "Failed calls",
      value: "42 of 404 (10.4%) across 10 tools, mostly browser control",
    });
    const face = [
      JSON.stringify(trigger.facts),
      trigger.problem,
      trigger.summary,
      actions.primary.summary,
    ].join("\n");
    expect(face).not.toContain("mcp__");
    // The exact ids stay in the Copy prompt.
    expect(actions.primary.copy_text).toContain("mcp__claude-in-chrome__javascript_tool");
  });

  it("states the failures expected at the all-tool rate and the plain selection sentence", () => {
    const { trigger, violations } = card(c1({ CLAIMED_TURN_COUNT: { value: 42 } }));
    // 404 × 0.018 = 7.27 → 7.
    expect(trigger.facts).toContainEqual({ label: "Expected at the all-tool rate", value: "7" });
    expect(trigger.problem).toContain(
      "At the 1.8% rate across all 14,495 tool calls counted (the week's main-conversation calls with a recorded outcome; subagent calls and the shell calls the shell-error card owns are left out), about 7 of these 404 calls would have failed.",
    );
    expect(trigger.problem).toContain(
      "The tools listed are the ones that failed most, so their rate is higher than your overall rate.",
    );
    expect(trigger.problem).not.toContain("part of the gap");
    expect(violations).toEqual([]);
  });

  it("M10: the saving names its turns, and the headline basis (upper bound)", () => {
    const { trigger, violations } = card(c1({ CLAIMED_TURN_COUNT: { value: 42 } }));
    expect(trigger.problem).toContain(
      'Estimated saving: 50% of the cost of the 42 turns that made these failing calls is assumed avoidable = $2.82 a week. The card headline prices a different, smaller set of turns (only the main conversation\'s turn after each failure, as an upper bound) and shows "under $0.01" when that rounds to nothing.',
    );
    expect(trigger.problem).not.toContain("priced at the turn that made the call");
    expect(violations).toEqual([]);
  });

  it("M10: an older finding without the turn count keeps a count-free derivation", () => {
    const { trigger, violations } = card(c1());
    expect(trigger.problem).toContain(
      "Estimated saving: 50% of the cost of the turns that made these failing calls is assumed avoidable = $2.82 a week.",
    );
    expect(violations).toEqual([]);
  });

  it("M8: the Copy prompt lists the causes seen in these tools' results, and asks what repeats", () => {
    const { actions } = card(c1({ CLAIMED_TURN_COUNT: { value: 42 } }));
    const { summary, copy_text } = actions.primary;
    expect(summary).toContain("check whether any cause repeats");
    expect(summary).not.toContain("one or two causes");
    for (const cause of [
      "a frozen tab or CDP timeout",
      "a page too big for `find`",
      "a wrong parameter",
    ])
      expect(copy_text).toContain(cause);
    expect(copy_text).toMatch(/check whether any cause repeats/i);
    expect(copy_text).not.toContain("wrong shell syntax");
    expect(copy_text).toContain("make MCP changes at the start of a session");
  });
});

describe("Review 5 U6: D11 (M11, M12)", () => {
  // PowerShell 20 of 1,192 against Bash 65 of 10,397: 20 − 1,192 × 65 / 10,397 = 20 − 7.45 =
  // 12.55 → about 13 more failures a week than the Bash rate.
  const d11 = (over: Partial<CardActionRecommendation> = {}): CardActionRecommendation => ({
    detector_id: "D11",
    lever: "Prefer the measured lower-error shell for repository and file operations.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      preferred_tool: "Bash",
      higher_error_tool: "PowerShell",
      powershell_error_count: 20,
      powershell_call_count: 1_192,
      powershell_error_ratio: 20 / 1_192,
      bash_error_count: 65,
      bash_call_count: 10_397,
      bash_error_ratio: 65 / 10_397,
    },
    tool_calls: [
      failed(
        "PowerShell",
        "npx biome check src | grep error",
        "Exit code 1 grep : The term 'grep' is not recognized as the name of a cmdlet",
        5,
      ),
      failed(
        "PowerShell",
        "git diff | head -5",
        "Exit code 1 head : The term 'head' is not recognized as the name of a cmdlet",
        2,
      ),
      failed(
        "PowerShell",
        "npx vitest run",
        "Exit code 1 Invoke-Expression : At line:1 char:4 Unexpected token",
        4,
      ),
      failed(
        "PowerShell",
        "git log --oneline | head -3",
        "Exit code 1 head : The term 'head' is not recognized as the name of a cmdlet",
        1,
      ),
    ],
    ...over,
  });

  it("M12: labels each row by the command that was missing", () => {
    const { trigger, actions } = card(d11());
    const targets = trigger.calls?.map((call) => call.target) ?? [];
    // grep 5; head 2 + 1 = 3; the parse error keeps its command.
    expect(targets).toEqual(["| grep", "npx vitest run", "| head"]);
    expect(trigger.calls?.find((call) => call.target === "| head")?.calls).toBe(3);
    expect(actions.primary.copy_text).toContain("- `| grep` in PowerShell: 5");
    expect(actions.primary.copy_text).toContain("- `| head` in PowerShell: 3");
    expect(actions.primary.copy_text).not.toContain("PowerShell failure: `npx biome");
  });

  it("M11: the primary stops the pipes, and a guard gets a PowerShell matcher", () => {
    const { actions, violations } = card(d11({ guard_exists: true }));
    expect(actions.primary.summary).toContain(
      "Stop piping `grep`, `head` and `tail` in PowerShell: use Bash for them",
    );
    const guard = actions.alternatives.find((option) =>
      option.summary.includes("`PowerShell` matcher"),
    );
    expect(guard?.summary).toBe(
      "Add a `PowerShell` matcher to your existing guard that blocks `| grep`, `| head` and `| tail` (the guard may match only `Bash` today).",
    );
    expect(violations).toEqual([]);
  });

  it("M11: no guard, no matcher alternative", () => {
    const { actions } = card(d11());
    expect(actions.alternatives.some((option) => option.summary.includes("matcher"))).toBe(false);
  });

  it("OC2: the remove-PowerShell alternative targets settings.local.json at session start", () => {
    const deny = card(d11()).actions.alternatives.find((option) => option.kind === "CONFIG");
    expect(deny?.file_ref).toBe(".claude/settings.local.json");
    expect(deny?.copy_text).toContain(
      "apply at the start of a session: removing a tool rewrites the cache",
    );
  });

  it("folded minors: shell-caused label, subagents defined, listed sessions, extra failures", () => {
    const { trigger, actions, violations } = card(d11());
    expect(trigger.facts.map((fact) => fact.label)).toEqual([
      "Shell-caused failures in PowerShell",
      "Shell-caused failures in Bash",
    ]);
    expect(trigger.problem).toContain(
      "including subagents (helper agents Claude starts for a sub-task)",
    );
    // 7 stored sessions; the card lists s1 (the rows' session) then s2…s5.
    expect(trigger.problem).toContain("in 7 sessions (5 listed)");
    expect(actions.primary.copy_text).toContain("about 13 more failures a week than");
    expect(actions.primary.copy_text).not.toContain("far more often");
    expect(violations).toEqual([]);
  });
});
