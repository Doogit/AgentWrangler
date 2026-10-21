/**
 * P3.1-T10: review-3 blockers (register `docs/handoffs/2026-09-26-card-review/review-3-findings.md`).
 */
import { describe, expect, it } from "vitest";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import {
  buildCardActions,
  buildTrigger,
  cardTitle,
} from "../../src/query/api/rec-actions/index.js";
import { belowFloor } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";
import { guardShape, rmRisk } from "../../src/query/api/tool-calls.js";
import { withEmptyHome } from "../shared/with-home.js";

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, cardTitle(rec)) };
}

function call(target: string, sessions: string[]): CardToolCall {
  return {
    target,
    kind: "command",
    tool: "PowerShell",
    calls: 3,
    session_ids: sessions,
    session_count: sessions.length,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: "exit code 1",
  };
}

describe("Card rules added in review 3 (would have caught B1, B3, B6, B8)", () => {
  const prompt = (sessions: string) =>
    `# T\n\n## Context\n- c\n\n## Findings\n- Sessions: ${sessions}\n\n## Fix\nf\n\n## Steps\n1. Ask me to confirm.\n2. Verify: x.`;
  const actions = (summary: string, copy: string, detail: string[] = []) => ({
    primary: {
      option_id: "p",
      kind: "HABIT" as const,
      summary,
      detail,
      copy_text: copy,
      file_ref: null,
    },
    alternatives: [],
  });
  const trigger = (over: Partial<Parameters<typeof cardRuleViolations>[1]> = {}) => ({
    session_ids: ["s1", "s2"],
    window: null,
    facts: [{ label: "Failed calls", value: "19 of 989 calls (1.9%)" }],
    problem: "19 of 989 calls (1.9%) failed.",
    why: "It matters.",
    ...over,
  });

  it("every evidence row's session is listed, and the prompt lists the card's sessions", () => {
    const ok = actions("Do x.", prompt("s1, s2"));
    expect(cardRuleViolations(ok, trigger())).toEqual([]);
    expect(cardRuleViolations(ok, trigger({ calls: [{ ...call("x", ["s9"]) }] }))).toContain(
      "evidence session s9 is not listed",
    );
    expect(cardRuleViolations(actions("Do x.", prompt("s1, s3")), trigger())).toContain(
      "option p: copy prompt does not list session s2",
    );
  });

  it("the lead is not a file the card's own detail says to leave", () => {
    const bad = actions("Point Claude at the part of `src/api.ts` it needs.", prompt("s1, s2"), [
      "Leave files that are re-read because they are being edited.",
    ]);
    expect(cardRuleViolations(bad, trigger())).toContain(
      "option p: leads with `src/api.ts`, a file its detail says to leave",
    );
  });

  it("every number in the facts appears in what's wrong or the action", () => {
    expect(
      cardRuleViolations(
        actions("Do x.", prompt("s1, s2")),
        trigger({ problem: "18 of 989 calls failed." }),
      ),
    ).toContain(
      'fact "Failed calls" (19 of 989 calls (1.9%)) disagrees with what\'s wrong: 19, 1.9%',
    );
  });

  it("a savings figure is derived in what's wrong", () => {
    const ok = actions("Do x.", prompt("s1, s2"));
    expect(cardRuleViolations(ok, trigger(), undefined, 2_550_000)).toContain(
      "saving $2.55 a week is not derived in what's wrong",
    );
    expect(
      cardRuleViolations(
        ok,
        trigger({
          problem: "19 of 989 calls (1.9%) failed. Estimated saving: $5.10 × 50% = $2.55 a week.",
        }),
        undefined,
        2_550_000,
      ),
    ).toEqual([]);
  });
});

describe("Savings derived on the card (review 3 rule 4)", () => {
  const withSavings = (rec: CardActionRecommendation, savings: number) => {
    const built = card({ ...rec, savings_u_per_wk: savings });
    return {
      ...built,
      violations: cardRuleViolations(built.actions, built.trigger, cardTitle(rec), savings),
    };
  };

  it("D8: net tokens × assumed avoidable share × net write price", () => {
    // 5,880,000 µUSD / (1,200,000 × 0.64) = $7.65625 → $7.66 per million.
    const { trigger, violations } = withSavings(
      {
        detector_id: "D8",
        lever: "Run /clear or /compact before a break longer than the cache lifetime.",
        facts: {
          session_ids: ["s1"],
          session_count: 1,
          churn_event_count: 8,
          total_churn_creation_tokens: 1_700_000,
          base_prefix_tokens: 62_500,
          net_churn_creation_tokens: 1_200_000,
          regime: "mixed",
        },
      },
      5_880_000,
    );
    expect(trigger.problem).toContain(
      "Estimated saving: 1.2M net × 64% assumed avoidable × $7.66 per million tokens (cache-write price less the cache-read price) = $5.88 a week.",
    );
    expect(violations).toEqual([]);
  });

  it("C1: the failed turns' cost × half assumed avoidable", () => {
    const { trigger, violations } = withSavings(
      {
        detector_id: "C1",
        lever:
          "Find the causes behind the failed tool calls before retrying or replacing the tool.",
        evidence: {
          session_ids: ["s1"],
          metrics: {
            TOOL_ERROR_COUNT: { value: 37 },
            TOOL_CALL_COUNT: { value: 342 },
            CORPUS_ERROR_RATE: { value: 0.018 },
            OUTLIER_TOOLS: { value: "Browser computer" },
          },
        },
      },
      2_550_000,
    );
    expect(trigger.problem).toContain(
      "Estimated saving: 50% of the cost of the turns that made these failing calls is assumed avoidable = $2.55 a week.",
    );
    expect(violations).toEqual([]);
  });

  const d7Loop = (costs: Record<string, number>): CardActionRecommendation => ({
    detector_id: "D7",
    lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
    facts: {
      session_ids: ["s1"],
      loop_flagged_turn_count: 271,
      loop_flagged_turn_share: 0.034,
      repeat_excess_turn_count: 3,
      redundant_read_event_count: 12,
      identical_call_event_count: 40,
      error_loop_event_count: 6,
      repeat_excess_turn_cap_weighted_tokens: 1_700_000,
      ...costs,
    },
  });

  it("D7 loops (review 5 B1): the repeat turns' stored cost × half, by component", () => {
    // 75,050 = 50,000 read + 12,500 write + 12,550 io; saving 37,525 µUSD = $0.04.
    // Rounded parts $0.05 + $0.01 + $0.01 = $0.07, not $0.08, so the total reads "≈ $0.08".
    const { trigger, actions, violations } = withSavings(
      d7Loop({
        repeat_excess_read_u: 50_000,
        repeat_excess_write_u: 12_500,
        repeat_excess_io_u: 12_550,
        repeat_excess_cost_u: 75_050,
      }),
      37_525,
    );
    expect(trigger.problem).toContain(
      "Estimated saving: the 3 repeat turns cost $0.05 in cache reads + $0.01 in cache writes + $0.01 in input and output ≈ $0.08, each at its model's price; $0.08 × 50% assumed avoidable = $0.04 a week.",
    );
    expect(trigger.problem).toContain("= $0.04 a week");
    expect(trigger.problem).not.toContain("cache-read price");
    // M17: four facts, no share of all turns.
    expect(trigger.facts).toEqual([
      { label: "Turns repeating calls", value: "271" },
      { label: "Repeated reads", value: "12" },
      { label: "Repeats of the same error", value: "6" },
      { label: "Identical calls", value: "40" },
    ]);
    expect(trigger.summary).toContain("271 turns went to repeating the same calls.");
    expect(trigger.summary).not.toContain("re-sends the whole context");
    // M18: the action names both cases.
    expect(actions.primary.summary).toBe(
      "When the same error comes back twice, stop and change approach; when a file is read again with no edit between, check whether a compaction came between the two reads (the transcript marks it), then read only the part needed.",
    );
    expect(actions.primary.detail.length).toBeGreaterThanOrEqual(2);
    expect(actions.primary.copy_text).toMatch(/same-error or repeated-read/);
    expect(violations).toEqual([]);
  });

  it("D7 loops rounding: rounded parts that miss the total show ≈", () => {
    // 12,500 µUSD each = $0.0125 → "$0.01"; total 37,500 → "$0.04"; saving 18,750 → "$0.02".
    const { trigger, violations } = withSavings(
      d7Loop({
        repeat_excess_read_u: 12_500,
        repeat_excess_write_u: 12_500,
        repeat_excess_io_u: 12_500,
        repeat_excess_cost_u: 37_500,
      }),
      18_750,
    );
    expect(trigger.problem).toContain("≈ $0.04");
    expect(trigger.problem).toContain("$0.04 × 50% assumed avoidable = $0.02 a week.");
    expect(violations).toEqual([]);
  });

  it("D7 loops rounding: rounded parts that add up show =", () => {
    // $0.02 + $0.01 + $0.01 = $0.04 exactly; saving 20,000 → "$0.02".
    const { trigger, violations } = withSavings(
      d7Loop({
        repeat_excess_read_u: 20_000,
        repeat_excess_write_u: 10_000,
        repeat_excess_io_u: 10_000,
        repeat_excess_cost_u: 40_000,
      }),
      20_000,
    );
    expect(trigger.problem).toContain("in input and output = $0.04, each at its model's price");
    expect(trigger.problem).not.toContain("≈");
    expect(violations).toEqual([]);
  });

  it("D7 loops, older row: V1 sentence", () => {
    // 850,000 µUSD / (1,700,000 × 0.5) = $1.00 per million.
    const { trigger, violations } = withSavings(
      {
        detector_id: "D7",
        lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
        facts: {
          session_ids: ["s1"],
          loop_flagged_turn_count: 271,
          loop_flagged_turn_share: 0.034,
          repeat_excess_turn_cap_weighted_tokens: 1_700_000,
        },
      },
      850_000,
    );
    expect(trigger.problem).toContain(
      "Estimated saving: 1.7M tokens re-sent by the repeats × 50% assumed avoidable × $1.00 per million tokens (cache-read price) = $0.85 a week.",
    );
    expect(violations).toEqual([]);
  });
});

describe("B5: D2 shows its derived reduction and both thresholds", () => {
  // Spend $89.00 × 0.3312 = $29.4768 gross; − $3.00 rebuild = $26.4768 net.
  const rec: CardActionRecommendation = {
    detector_id: "D2",
    lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5"],
      qualifying_session_count: 5,
      qualifying_turn_count: 905,
      raw_context_average_tokens_per_turn: 208_000,
      cap_weighted_burn_tokens_per_week: 20_000_000,
      cache_read_tokens_per_week: 185_900_000,
      cap_read_coefficient: 0.1,
      cache_read_spend_u_per_wk: 89_000_000,
      reduction_fraction: 0.3312,
      suggested_split_count: 5,
      base_prefix_tokens: 68_000,
      summary_tokens: 2_000,
      gross_savings_u_per_wk: 29_476_800,
      rebuild_u_per_wk: 3_000_000,
    },
  };

  it("derives the saving on the card: spend × measured fraction − rebuild", () => {
    const problem = card(rec).trigger.problem ?? "";
    expect(problem).toContain(
      "Estimated saving: $89.00 of re-reads × 33.1% that splits avoid = $29.48, − $3.00 to rebuild = $26.48 a week.",
    );
    expect(problem).toContain(
      "The 33.1% is modelled on these sessions: after a split, each later call re-reads the 68K base and 2K summary plus what it added since, not the whole history.",
    );
  });

  it("states both thresholds on the card", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.problem).toContain(
      "5 sessions ran more than 150 model calls each with more than 180K tokens of context per call on average",
    );
    expect(trigger.facts).toContainEqual({
      label: "Sessions over 150 calls and 180K context",
      value: "5",
    });
    expect(violations).toEqual([]);
  });
});

describe("B1: D7 re-reads lead with a look-up file, not code under edit", () => {
  const read = (target: string, calls: number, sessions: number): CardToolCall => ({
    target,
    kind: "file",
    tool: "Read",
    calls,
    session_ids: [`sess-${sessions}`],
    session_count: sessions,
    total_bytes: calls * 15_000,
    max_bytes: 15_000,
    whole_file: true,
  });
  const rec = (calls: CardToolCall[]): CardActionRecommendation => ({
    detector_id: "D7",
    lever: "Point sessions at the part they need of the files they re-read every session.",
    facts: {
      session_ids: ["s1", "s2"],
      session_count: 27,
      redundant_path_count: 33,
      total_redundant_read_count: 324,
      total_redundant_result_bytes: 2_200_000,
      max_path_read_count: 57,
      max_path_session_count: 26,
    },
    tool_calls: calls,
  });
  const files = [
    read("~/repo/src/query/api/recommendations.ts", 57, 26),
    read("~/repo/src/ingest/ingestor.ts", 42, 11),
    read("~/repo/src/ui/RecCard.tsx", 35, 13),
    read("~/repo/docs/plans/2026-09-23-rec-trust-execution-plan.md", 33, 15),
  ];

  it("leads with the most-read look-up file and names it first", () => {
    const { trigger, actions, violations } = card(rec(files));
    expect(trigger.calls?.[0]?.target).toBe(
      "~/repo/docs/plans/2026-09-23-rec-trust-execution-plan.md",
    );
    expect(actions.primary.summary).toBe(
      "Point Claude at the part of `~/repo/docs/plans/2026-09-23-rec-trust-execution-plan.md` it needs, instead of the whole file (read in 15 sessions).",
    );
    expect(trigger.facts).toContainEqual({
      label: "Most-read look-up file",
      // Review 5 M14: the fact names the file, not just its session count.
      value: "`~/repo/docs/plans/2026-09-23-rec-trust-execution-plan.md` (15 sessions)",
    });
    expect(violations).toEqual([]);
  });

  it("says the source files are left out of the advice, with one count per session", () => {
    const problem = card(rec(files)).trigger.problem ?? "";
    expect(problem).toContain(
      "The most-read look-up file, `~/repo/docs/plans/2026-09-23-rec-trust-execution-plan.md`, was read in 15 sessions.",
    );
    expect(problem).toContain(
      "3 of the files listed are source code, re-read because the code changes; leave those.",
    );
    expect(problem).not.toMatch(/read 57 times/);
  });

  it("gives no CLAUDE.md pointer when every file listed is source code", () => {
    const { trigger, actions } = card(rec(files.slice(0, 3)));
    expect(actions.primary.summary).not.toContain("recommendations.ts");
    expect(trigger.problem).not.toContain("CLAUDE.md");
  });
});

describe("B2: rm -rf into the scratchpad or the project tree is safe (operator 2026-09-26)", () => {
  const cwd = "C:\\work\\repo";
  const sp = "C:/work/tmp/claude/C--work-repo/0a1b/scratchpad";

  it("resolves a variable set earlier in the same command", () => {
    expect(rmRisk(`SP="${sp}"; rm -rf "$SP/prof2"`, cwd)).toBe("LOW");
    expect(rmRisk(`SP=${sp} && rm -rf \${SP}/x`, cwd)).toBe("LOW");
    expect(rmRisk("OUT=/c/work/other; rm -rf $OUT/x", cwd)).toBe("RISKY");
    expect(rmRisk('rm -rf "$OUT"', cwd)).toBe("RISKY");
  });

  it("rates the session scratchpad and paths inside the working directory as low risk", () => {
    expect(rmRisk(`rm -rf "${sp.replaceAll("/", "\\")}\\x"`, cwd)).toBe("LOW");
    expect(rmRisk("rm -rf /c/work/repo/.claude/audits/certification/C9", cwd)).toBe("LOW");
    expect(rmRisk("rm -rf C:/work/repo/.worktrees/x/dist", cwd)).toBe("LOW");
  });

  it("still rates the project itself, a parent path, home and other folders as risky", () => {
    for (const command of [
      "rm -rf C:/work/repo",
      "rm -rf /c/work/repo/../other",
      "rm -rf /c/work/repository-2/x",
      "rm -rf ~/.claude/x",
      "rm -rf C:/work/tmp/other",
    ]) {
      expect(rmRisk(command, cwd), command).toBe("RISKY");
    }
    // With no known working directory, an absolute path stays risky.
    expect(rmRisk("rm -rf /c/work/repo/dist")).toBe("RISKY");
  });

  it("does not count a command that only mentions `rm -rf` as a run (a grep pattern)", () => {
    const run = (target: string, risk?: "LOW" | "RISKY"): CardToolCall => ({
      ...call(target, ["s1"]),
      tool: "Bash",
      calls: 1,
      ...(risk === undefined ? {} : { risk }),
    });
    const h1 = (calls: CardToolCall[]): CardActionRecommendation => ({
      detector_id: "H1",
      lever: "Add a confirmation guard (permissions.ask) for this destructive command class.",
      evidence: {
        session_ids: ["s1"],
        metrics: {
          OPERATION_COUNT: { value: 3 },
          DESTRUCTIVE_OPERATION: { value: "RM_RF" },
        },
      },
      tool_calls: calls,
    });
    const mention = run('grep -n "rm -rf" src/x.ts');
    expect(belowFloor(h1([mention, run("rm -rf dist", "LOW"), run("rm -r .x", "LOW")]))).toBe(true);
    expect(belowFloor(h1([mention, run("rm -rf dist", "LOW"), run("rm -rf $X", "RISKY")]))).toBe(
      false,
    );
  });

  it("rates `rm -r` too, since the detector counts it with `rm -rf`", () => {
    expect(rmRisk("rm -r .claude/audits/certification/B2 .w12bench", cwd)).toBe("LOW");
    expect(rmRisk("rm -r ../x", cwd)).toBe("RISKY");
    expect(rmRisk("rm file.txt", cwd)).toBeNull();
  });
});

describe("B4: a harmless guard block is fixed on the calling side (operator 2026-09-26)", () => {
  const NOW =
    "Blocked command shape: cd&&-prefix / in-place edits (sed -i, python -c) / tmp writes";
  const block = (
    target: string,
    guard_shape: NonNullable<CardToolCall["guard_shape"]>,
  ): CardToolCall => ({
    ...call(target, ["s1"]),
    tool: "Bash",
    calls: 1,
    result: NOW,
    guard_shape,
  });
  const rec: CardActionRecommendation = {
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
        DENIAL_COUNT: { kind: "COUNT", value: 3 },
      },
    },
    tool_calls: [
      block('python -c "import sqlite3; print(1)"', "PYTHON_READ"),
      block("cd a && b", "CD_PREFIX"),
      block("git stash list", "GIT_STASH_READ"),
    ],
  };

  it("keeps the guard and names the shape to use instead", () => {
    const { trigger, actions, violations } = card(rec);
    expect(actions.primary.summary).toBe(
      "Run the 2 harmless blocked calls in a shape your guard allows, and keep the guard as it is: a read-only `python -c` as a script file in the scratchpad (or `sqlite3 -readonly`, or the daemon API); a read-only `git stash list` as `git reflog show refs/stash`.",
    );
    // Review 5 M6/M7: the split is stated once, flat (no shape names, zero parts left out).
    expect(trigger.problem).toContain("Your guard blocked 3 calls: 2 harmless, 1 as intended.");
    const text = [trigger.problem, actions.primary.summary, actions.primary.copy_text].join("\n");
    expect(text).not.toMatch(/[Nn]arrow/);
    expect(text).not.toContain("block `python -c` only when");
    expect(actions.primary.copy_text).toContain("Keep the guard as it is.");
    expect(violations).toEqual([]);
  });

  it("names the JSON shape a rewritten example is verified with", () => {
    const { actions } = card(rec);
    expect(actions.primary.copy_text).toContain(
      '{"tool_name":"Bash","tool_input":{"command":"…"}}',
    );
  });
});

describe("U5: C9 guard blocks split into one flat count (review 5 M5-M7)", () => {
  const NOW = "Blocked command shape: cd&&-prefix / quoted `python -c` matches / tmp writes";
  const OLD = "Blocked command shape: cd&&-prefix / heredoc edits";
  const block = (
    target: string,
    message: string,
    guard_shape: NonNullable<CardToolCall["guard_shape"]>,
    calls: number,
  ): CardToolCall => ({
    target,
    kind: "command",
    tool: "Bash",
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: message,
    guard_shape,
  });
  const rec: CardActionRecommendation = {
    detector_id: "C9",
    lever: "Review recurring blocked tool requests before repeating the same command shape.",
    evidence: {
      session_ids: ["s1"],
      metrics: {
        DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
        DENIAL_COUNT: { kind: "COUNT", value: 39 },
      },
    },
    tool_calls: [
      // M5: guardShape would classify this as QUOTED_PATTERN; the card is given the shape
      // directly, the way a real guard-block card's calls are read back from a transcript.
      block('grep -n "python -c" x.ts', NOW, "QUOTED_PATTERN", 3),
      block("cd a && b", NOW, "CD_PREFIX", 30),
      block("npm run build", NOW, "OTHER", 2),
      block("git commit -F - <<'EOF'", OLD, "HEREDOC_STDIN", 4),
    ],
  };

  it("puts a current-guard false positive first, then intended, earlier-version, unclassified", () => {
    const { trigger, violations } = card(rec);
    expect(trigger.calls?.[0]?.guard_shape).toBe("QUOTED_PATTERN");
    expect(trigger.calls?.map((call) => call.guard_shape)).toEqual([
      "QUOTED_PATTERN",
      "CD_PREFIX",
      "HEREDOC_STDIN",
      "OTHER",
    ]);
    expect(trigger.facts).toContainEqual({ label: "Calls your guard blocked", value: "39" });
    expect(trigger.facts).toContainEqual({ label: "Harmless blocks to fix", value: "3" });
    expect(trigger.facts).toContainEqual({ label: "Blocked as intended", value: "30" });
    expect(trigger.problem).toContain(
      "Your guard blocked 39 calls: 3 harmless, 30 as intended, 4 from an earlier guard version, 2 unclassified.",
    );
    expect(violations).toEqual([]);
  });
});

describe("B7: C1 states how its tools were picked, not a multiple of a biased baseline", () => {
  const rec: CardActionRecommendation = {
    detector_id: "C1",
    lever: "Find the causes behind the failed tool calls before retrying or replacing the tool.",
    evidence: {
      session_ids: ["s1", "s2"],
      metrics: {
        TOOL_ERROR_COUNT: { value: 36 },
        TOOL_CALL_COUNT: { value: 342 },
        TOOL_ERROR_RATE: { value: 36 / 342 },
        CORPUS_ERROR_RATE: { value: 0.017 },
        CORPUS_CALL_COUNT: { value: 11_898 },
        RATE_MULTIPLE: { value: 6.2 },
        OUTLIER_TOOLS: { value: "Browser javascript, Browser computer" },
      },
    },
  };

  it("says what the all-tool rate predicts and that the listed tools failed most", () => {
    const { trigger, actions, violations } = card(rec);
    // Review 5 (folded minors): 342 × 0.017 = 5.81 → about 6; plain selection sentence.
    expect(trigger.problem).toContain(
      "At the 1.7% rate across all 11,898 tool calls counted (the week's main-conversation calls with a recorded outcome; subagent calls and the shell calls the shell-error card owns are left out), about 6 of these 342 calls would have failed.",
    );
    expect(trigger.problem).toContain(
      "The tools listed are the ones that failed most, so their rate is higher than your overall rate.",
    );
    expect(
      [trigger.problem, actions.primary.summary, actions.primary.copy_text].join(),
    ).not.toMatch(/times your usual rate/);
    expect(trigger.facts).toContainEqual({ label: "Rate across all tool calls", value: "1.7%" });
    expect(violations).toEqual([]);
  });
});

describe("B3: D11 counts and names only failures the shell caused", () => {
  const failed = (target: string, calls: number, result: string): CardToolCall => ({
    ...call(target, ["s1"]),
    calls,
    result,
  });
  const rec: CardActionRecommendation = {
    detector_id: "D11",
    lever: "Route repository and file operations to the lower-error shell.",
    facts: {
      session_ids: ["s1"],
      preferred_tool: "Bash",
      higher_error_tool: "PowerShell",
      powershell_error_count: 19,
      powershell_call_count: 989,
      powershell_error_ratio: 0.019,
      bash_error_count: 65,
      bash_call_count: 9922,
      bash_error_ratio: 0.007,
    },
    tool_calls: [
      failed(
        "npx biome",
        5,
        "Exit code 1 head : The term 'head' is not recognized as the name of a cmdlet",
      ),
      failed(
        "git diff",
        2,
        "Exit code 1 tail : The term 'tail' is not recognized as the name of a cmdlet",
      ),
      failed("npx vitest", 4, "Exit code 1 head : The term 'head' is not recognized as the name"),
      failed("node x.mjs", 1, "Exit code 1 The token '&&' is not a valid statement separator."),
    ],
  };

  it("says what it counts and leaves out what ran and failed", () => {
    const problem = card(rec).trigger.problem ?? "";
    expect(problem).toContain(
      // Review 5: "subagents" is defined at first use.
      "PowerShell calls failed in the shell itself more often than Bash: 19 of 989 calls (1.9%) against 65 of 9,922 calls (0.7%), counting every call that ran, including subagents (helper agents Claude starts for a sub-task).",
    );
    expect(problem).toContain(
      "Only failures the shell caused count (a command it could not parse, or a command it does not have); a script, test or gate that fails would fail the same way in either shell.",
    );
  });

  it("names the causes, not the command a failure sat in", () => {
    expect(card(rec).trigger.problem).toContain(
      "Most were: `head` is not a PowerShell command 9 times, `tail` is not a PowerShell command twice, `&&` is not supported once.",
    );
  });
});

describe("B6: D8 states only its own resumes", () => {
  // 17 main-thread resumes wrote 2.6M; a fresh start writes the 68K base each: 17 × 68K = 1.156M,
  // so 2.6M − 1.156M = 1.444M net. The longest of D8's own gaps is 36.5 h (2,190 min).
  const rec: CardActionRecommendation = {
    detector_id: "D8",
    lever: "Run /clear or /compact before a break longer than the cache lifetime.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      session_count: 14,
      churn_event_count: 17,
      total_churn_creation_tokens: 2_600_000,
      base_prefix_tokens: 68_000,
      net_churn_creation_tokens: 1_444_000,
      longest_gap_min: 2_190,
      regime: "mixed",
    },
  };

  it("labels the fresh-start part by its own resumes", () => {
    expect(card(rec).trigger.problem).toContain(
      "2.6M written again − 1.2M a fresh start would write anyway (the 68K base prompt, for each of the 17 resumes) = 1.4M net",
    );
  });

  it("shows D8's own longest gap, with no overnight caveat and no B2 break sums", () => {
    const { trigger, actions } = card(rec);
    expect(trigger.facts).toContainEqual({
      label: "Longest break before a resume",
      value: "36.5 hours",
    });
    const text = [trigger.problem, actions.primary.summary, actions.primary.copy_text].join("\n");
    expect(text).not.toMatch(/overnight/);
    expect(text).not.toMatch(/before each break read/);
  });

  it("writes a plain summary and leaves subagents out of the cache lifetime", () => {
    const { trigger, actions, violations } = card(rec);
    expect(actions.primary.summary).toBe(
      "Before a break longer than the cache lifetime: if the next task is new, run /clear; if it continues, write a handoff, then /clear; use /compact only as a fallback while the cache is still warm. Back after the cache expired and starting something new? Run /clear before your first message: only the base prompt is written, not the old conversation. Only a continuing task needs the handoff before the break (17 resumes after the cache expired, in 14 sessions; the longest break was 36.5 hours).",
    );
    // Review 5 U8 (M20): copy_text now names "one subagent per session" as a scanning option
    // (unrelated to churn accounting), so the no-subagent check stays on the accounted-for text.
    expect(trigger.problem).not.toMatch(/subagent/);
    expect(actions.primary.summary).not.toMatch(/subagent/);
    expect(violations).toEqual([]);
  });
});

describe("Review 5 U4: D2 and D8 actions (M2, M3, M4)", () => {
  // Spend $89.00 × 0.3312 = $29.4768 gross; − $3.00 rebuild = $26.4768 → $26.48 net.
  const d2: CardActionRecommendation = {
    detector_id: "D2",
    lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5"],
      qualifying_session_count: 6,
      qualifying_turn_count: 1_204,
      raw_context_average_tokens_per_turn: 245_000,
      cache_read_tokens_per_week: 291_100_000,
      cache_read_spend_u_per_wk: 89_000_000,
      reduction_fraction: 0.3312,
      suggested_split_count: 7,
      base_prefix_tokens: 68_000,
      summary_tokens: 2_000,
      gross_savings_u_per_wk: 29_476_800,
      rebuild_u_per_wk: 3_000_000,
    },
  };
  const d8: CardActionRecommendation = {
    detector_id: "D8",
    lever: "Run /clear or /compact before a break longer than the cache lifetime.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      session_count: 14,
      churn_event_count: 17,
      total_churn_creation_tokens: 2_600_000,
      base_prefix_tokens: 68_000,
      net_churn_creation_tokens: 1_444_000,
      longest_gap_min: 2_190,
      regime: "mixed",
    },
  };

  it("M2: D2's fix says a rule offers the handoff and the user still types /clear", () => {
    const { copy_text } = withEmptyHome(() => card(d2)).actions.primary;
    expect(copy_text).not.toContain("holds without remembering");
    expect(copy_text).toContain(
      "At each finished task, write a short handoff (goal, decisions, files, next step), run /rename, then /clear, and start the next task from the handoff. A one-line CLAUDE.md rule can make Claude offer the handoff when a task ends; you still type /clear.",
    );
    expect(copy_text).toContain("a commit, a branch change, or a switch to unrelated files");
  });

  it("M3: D2 offers a /handoff skill as its one EDIT alternative", () => {
    const { alternatives } = withEmptyHome(() => card(d2)).actions;
    expect(alternatives.map((option) => option.kind)).toEqual(["EDIT"]);
    const [skill] = alternatives;
    expect(skill?.summary).toContain("/handoff skill");
    // Residual M3: user-level, so it validates on the global D2 rec.
    expect(skill?.file_ref).toBe("~/.claude/skills/handoff/SKILL.md");
    expect(skill?.copy_text).toContain("disable-model-invocation: true");
    // Review 6 R6-34: one handoff file per branch, so parallel sessions don't overwrite each other's.
    expect(skill?.copy_text).toContain("HANDOFF-<branch>.md");
    expect(skill?.copy_text).toMatch(/run it once/i);
  });

  it("D2 states the split rule and a modelled share, and lists 5 of the 6 sessions", () => {
    // ⌊(n − 1) / 150⌋ per session (d2_session_long_full_context.ts): a session of 150 calls
    // gives 0 splits, 151 gives 1, 300 gives 1; the detector test covers 151 and 300.
    const { trigger, actions, violations } = card(d2);
    const problem = trigger.problem ?? "";
    expect(problem).toContain(
      "one split for every 150 model calls after the first, in each session, and a 2K summary are assumptions.",
    );
    expect(problem).not.toContain("one split per 150");
    expect(problem).toContain("The 33.1% is modelled on these sessions:");
    expect(problem).not.toContain("is measured");
    expect(problem).toContain("a commit, a branch change, or a switch to unrelated files");
    expect(actions.primary.copy_text).toContain("- Sessions (5 of 6 listed): s1, s2, s3, s4, s5");
    expect(violations).toEqual([]);
  });

  it("M4: D8's summary is three-way, with /compact only as a warm fallback", () => {
    const { summary } = card(d8).actions.primary;
    expect(summary).toBe(
      "Before a break longer than the cache lifetime: if the next task is new, run /clear; if it continues, write a handoff, then /clear; use /compact only as a fallback while the cache is still warm. Back after the cache expired and starting something new? Run /clear before your first message: only the base prompt is written, not the old conversation. Only a continuing task needs the handoff before the break (17 resumes after the cache expired, in 14 sessions; the longest break was 36.5 hours).",
    );
  });

  it("R KF 3: D8 detail and copy say /compact after a break reprocesses the history uncached", () => {
    const { detail, copy_text } = card(d8).actions.primary;
    for (const text of [detail.join("\n"), copy_text]) {
      expect(text).not.toContain("/compact itself costs");
      expect(text).toContain("reprocesses the whole history as uncached input");
    }
    expect(copy_text).not.toContain("about a tenth");
    expect(copy_text).toContain("write a short handoff");
  });

  it("D8 facts split written-again and net, drop the sessions bookkeeping, and name the read price", () => {
    // 5,880,000 µUSD / (1,444,000 × 0.64) = $6.3626… → $6.36 per million.
    const built = card({ ...d8, savings_u_per_wk: 5_880_000 });
    expect(built.trigger.facts).toContainEqual({ label: "Written again", value: "2.6M" });
    expect(built.trigger.facts).toContainEqual({ label: "Net of a fresh start", value: "1.4M" });
    const labels = built.trigger.facts.map((fact) => fact.label);
    expect(labels).not.toContain("Sessions");
    expect(labels).not.toContain("Tokens written again");
    expect(built.trigger.problem).toContain(
      "× $6.36 per million tokens (cache-write price less the cache-read price) = $5.88 a week.",
    );
    expect(cardRuleViolations(built.actions, built.trigger, cardTitle(d8), 5_880_000)).toEqual([]);
  });
});

describe("Review 5 U8: transcripts stay out of the main conversation (M20)", () => {
  const d2: CardActionRecommendation = {
    detector_id: "D2",
    lever: "Split unrelated work into separate sessions and clear context at task boundaries.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5"],
      qualifying_session_count: 6,
      qualifying_turn_count: 1_204,
      raw_context_average_tokens_per_turn: 245_000,
      cache_read_tokens_per_week: 291_100_000,
      cache_read_spend_u_per_wk: 89_000_000,
      reduction_fraction: 0.3312,
      suggested_split_count: 7,
      base_prefix_tokens: 68_000,
      summary_tokens: 2_000,
      gross_savings_u_per_wk: 29_476_800,
      rebuild_u_per_wk: 3_000_000,
    },
  };
  const d8: CardActionRecommendation = {
    detector_id: "D8",
    lever: "Run /clear or /compact before a break longer than the cache lifetime.",
    facts: {
      session_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
      session_count: 14,
      churn_event_count: 17,
      total_churn_creation_tokens: 2_600_000,
      base_prefix_tokens: 68_000,
      net_churn_creation_tokens: 1_444_000,
      longest_gap_min: 2_190,
      regime: "mixed",
    },
  };
  const c1: CardActionRecommendation = {
    detector_id: "C1",
    lever: "Find the causes behind the failed tool calls before retrying or replacing the tool.",
    evidence: {
      session_ids: ["s1"],
      metrics: {
        TOOL_ERROR_COUNT: { value: 37 },
        TOOL_CALL_COUNT: { value: 342 },
        CORPUS_ERROR_RATE: { value: 0.018 },
        OUTLIER_TOOLS: { value: "Browser computer" },
      },
    },
  };
  const d7Loop: CardActionRecommendation = {
    detector_id: "D7",
    lever: "Stop repeated attempts and re-plan after a bounded retry threshold.",
    facts: {
      session_ids: ["s1"],
      loop_flagged_turn_count: 271,
      loop_flagged_turn_share: 0.034,
      repeat_excess_turn_count: 3,
      redundant_read_event_count: 12,
      identical_call_event_count: 40,
      error_loop_event_count: 6,
      repeat_excess_turn_cap_weighted_tokens: 1_700_000,
    },
  };
  const d7Reread: CardActionRecommendation = {
    detector_id: "D7",
    lever: "Point sessions at the part they need of the files they re-read every session.",
    facts: {
      session_ids: ["s1", "s2"],
      session_count: 27,
      redundant_path_count: 33,
      total_redundant_read_count: 324,
      total_redundant_result_bytes: 2_200_000,
      max_path_read_count: 57,
      max_path_session_count: 26,
    },
  };

  it.each([
    ["D2", d2],
    ["D8", d8],
    ["C1", c1],
    ["D7 loops", d7Loop],
    ["D7 re-reads", d7Reread],
  ] as const)(
    "%s: copy_text scans transcripts in a fresh session, and card-rules pass",
    (_label, rec) => {
      const { actions, violations } = card(rec);
      expect(actions.primary.copy_text).toContain("fresh session");
      expect(actions.primary.copy_text).toContain("subagent per session");
      expect(actions.primary.copy_text).not.toContain("open its transcript");
      expect(violations).toEqual([]);
    },
  );

  // U7 cache lane: B2 now carries D8's habit, so it scans in a fresh session too.
  it("B2 scans its transcripts in a fresh session, like D8", () => {
    const b2: CardActionRecommendation = {
      detector_id: "B2",
      lever: "ttl gap",
      evidence: { metrics: { GAP_DURATION_MS: { value: 7_200_000 } } },
      facts: { session_ids: ["b2-session"] },
    };
    const { copy_text } = card(b2).actions.primary;
    expect(copy_text).toContain("Run this in a fresh session");
    expect(copy_text).toContain("subagent per session");
    expect(copy_text).not.toContain("open its transcript");
  });
});

describe("B8: one ranked session list for the card and its prompt", () => {
  // Stored ids are alphabetical (a1…a7); the evidence rows ran in z1 and z2.
  const d11: CardActionRecommendation = {
    detector_id: "D11",
    lever: "Route repository and file operations to the lower-error shell.",
    facts: {
      session_ids: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
      session_count: 9,
      preferred_tool: "Bash",
      higher_error_tool: "PowerShell",
      powershell_error_count: 41,
      powershell_call_count: 970,
      powershell_error_ratio: 0.042,
      bash_error_count: 203,
      bash_call_count: 9585,
      bash_error_ratio: 0.021,
    },
    tool_calls: [call("git commit -F msg.txt", ["z1", "a3"]), call("npm test", ["z2"])],
  };

  it("lists each evidence row's session first, then the rest by contribution", () => {
    const { trigger } = card({ ...d11, session_rank: ["a6", "z1", "a2", "a1"] });
    expect(trigger.session_ids).toEqual(["z1", "z2", "a6", "a2", "a1"]);
  });

  it("falls back to the stored order when no contribution rank is known", () => {
    expect(card(d11).trigger.session_ids).toEqual(["z1", "z2", "a1", "a2", "a3"]);
  });

  it("shows every evidence row's session even past five", () => {
    const rows = ["r1", "r2", "r3", "r4", "r5", "r6"].map((id) => call(`cmd ${id}`, [id]));
    expect(card({ ...d11, tool_calls: rows }).trigger.session_ids).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
    ]);
  });

  it("puts the same sessions in the copy prompt as on the card", () => {
    const { trigger, actions } = card({ ...d11, session_rank: ["a6", "a2"] });
    const prompts = [actions.primary, ...actions.alternatives].map((action) => action.copy_text);
    const listing = prompts.find((text) => text.includes("Sessions ("));
    expect(listing).toContain(`listed): ${trigger.session_ids.join(", ")}`);
  });
});
