import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import type { RecommendationCard } from "../../../src/query/api/recommendations";
import type { SessionDrivers } from "../../../src/query/api/session-drivers";
import type { SessionStory } from "../../../src/query/api/session-story";
import { mockSession } from "../../../src/ui/api/fixtures";
import { buildSessionPrompt } from "../../../src/ui/recommendations/prompt-templates";

const fixtureSession = mockSession("synthetic-session").data;
assert(fixtureSession !== null);
const session = {
  ...fixtureSession,
  session_id: "synthetic-session",
  file_path: "/synthetic/transcript.jsonl",
  repo_path: "/synthetic/workspace",
  cost_equiv_u: 2_500_000,
  turn_count: 8,
  first_turn_at: "2027-06-20T10:00:00.000Z",
  last_turn_at: "2027-06-20T11:15:00.000Z",
  hygiene_flags: ["LONG_FULL_CONTEXT"],
  tool_error_count: 5,
  api_error_count: 1,
  test_fail_count: 2,
  compaction_count: 1,
  interrupt_count: 0,
  long_gap_count: 3,
};

const story: SessionStory = {
  session_id: "synthetic-session",
  title: "Fix the synthetic parser",
  first_prompt: "Fix the synthetic parser\nand add a test",
  transcript_available: true,
  files_touched: [
    { path: "src/parser.ts", edits: 4 },
    { path: "test/parser.test.ts", edits: 1 },
  ],
  commits: [{ sha: "abcdef1234567890", ts: "2027-06-20T11:10:00.000Z" }],
  total_cost_u: 2_500_000,
  spend: [
    { chain: "main", model: "claude-opus-4-8", turns: 6, cost_u: 2_000_000 },
    { chain: "subagent", model: "claude-sonnet-4-6", turns: 2, cost_u: 500_000 },
  ],
  headline: {
    text: "Main chat on Opus 4.8 was 80% of this session's cost.",
    detail: "6 turns ran on Opus 4.8.",
    savings_u: 670_000,
  },
  lanes: [],
  turns: [],
  error_groups: [
    {
      tool: "Bash",
      command: "npm run test",
      other_commands: 1,
      signature: "Cannot find module <path>",
      count: 4,
      sample_command: "npm run test -- parser",
      sample_error: "Error: Cannot find module './parser'",
      first_ts: "2027-06-20T10:10:00.000Z",
      last_ts: "2027-06-20T10:20:00.000Z",
    },
    {
      tool: "Edit",
      command: null,
      other_commands: 0,
      signature: "String to replace not found",
      count: 1,
      sample_command: null,
      sample_error: "String to replace not found in file.",
      first_ts: "2027-06-20T10:30:00.000Z",
      last_ts: "2027-06-20T10:30:00.000Z",
    },
  ],
  errors_without_text: 0,
};

const drivers: SessionDrivers = {
  session_id: "synthetic-session",
  workspace_id: "synthetic-workspace",
  percentile: 80,
  drivers: [
    {
      detector_id: "D7",
      label: "LOOP_RETRY_WASTE",
      measured: { repeat_excess_event_count: 3 },
      share: 0.25,
      rec_id: "synthetic-rec",
      routing: "rec_card",
      approx_usd: 1.5,
      session_cost_u: 750_000,
    },
  ],
  tool_error_breakdown: [
    { tool_name: "Bash", tool_error_class: "NOT_FOUND", bash_command_family: "BASH_GIT", count: 2 },
  ],
};

const rec = {
  rec_id: "synthetic-rec",
  detector_id: "D7",
  title: "Reduce repeated calls",
  lever: "lever",
} as unknown as RecommendationCard;

const percentile = { percentile: 0.92, n: 40, window_days: 90 };

const TASK =
  "TASK: Investigate this session. 1) Explain where its cost came from, starting with the biggest item above. 2) Find concrete ways to spend less on work like this (model choice, subagent routing, context size, cache churn, repeated calls). 3) For each error group and friction signal, find the cause and say how to avoid it next time. 4) List anything else worth looking into. Read the transcript to check every claim before acting on it.";
const CONSTRAINTS =
  "CONSTRAINTS: Read the transcript before proposing changes. Cost figures are estimates at public API list prices, not a bill. Do not delete instructions or context the work needs. Propose changes to settings, CLAUDE.md, hooks or agent definitions; do not apply them without approval.";
const ACCEPTANCE =
  "ACCEPTANCE: A short report: the top cost causes with $ figures, each error group's cause and fix, and a ranked list of changes with the expected saving or friction removed. Each claim cites a turn or line in the transcript.";

describe("buildSessionPrompt", () => {
  it("builds the full prompt from session, story, drivers, percentile and recs", () => {
    const text = buildSessionPrompt({
      session,
      story,
      drivers,
      percentile,
      recommendations: [rec],
    });
    expect(text.split("\n")).toEqual([
      "Investigate Claude Code session synthetic-session.",
      "SESSION: synthetic-session",
      "TRANSCRIPT: /synthetic/transcript.jsonl",
      "WORKSPACE: /synthetic/workspace",
      "WHEN: 2027-06-20T10:00:00.000Z to 2027-06-20T11:15:00.000Z (1h 15m)",
      "SIZE: 8 turns · estimated cost $2.50 · top 8% of 40 sessions in this workspace (90 days)",
      'FIRST PROMPT: "Fix the synthetic parser and add a test"',
      "WHERE THE MONEY WENT: Main chat on Opus 4.8 was 80% of this session's cost.",
      "6 turns ran on Opus 4.8.",
      "Estimated saving: about $0.67",
      "SPEND BY CHAIN AND MODEL:",
      "- Main · Opus 4.8 · 6 turns · $2.00 (80%)",
      "- Subagents · Sonnet 4.6 · 2 turns · $0.50 (20%)",
      "COST DRIVERS:",
      "- LOOP_RETRY_WASTE | share: 25% | measured: repeat_excess_event_count=3 | $0.75 in this session",
      "WHAT WENT WRONG (tool errors grouped by error text):",
      "- Bash `npm run test` (+1 other command) × 4: Error: Cannot find module './parser'",
      "- Edit × 1: String to replace not found in file.",
      "FRICTION: 5 tool errors · 1 API error · 2 test failures · 1 compaction · 3 long gaps",
      "HYGIENE FLAGS: Long session near context limit",
      "FILES EDITED: src/parser.ts (4 edits), test/parser.test.ts (1 edit)",
      "COMMITS: abcdef1 (2027-06-20T11:10:00.000Z)",
      "RELATED RECOMMENDATIONS:",
      "- D7 | Reduce repeated calls | #/recommendations?focus=synthetic-rec",
      TASK,
      CONSTRAINTS,
      ACCEPTANCE,
    ]);
  });

  it("works for a session with no drivers", () => {
    const text = buildSessionPrompt({
      session,
      story,
      drivers: { ...drivers, drivers: [], tool_error_breakdown: [] },
    });
    expect(text).not.toContain("COST DRIVERS:");
    expect(text).toContain("WHAT WENT WRONG");
    expect(text).toContain("SIZE: 8 turns · estimated cost $2.50\n");
    expect(text.endsWith(ACCEPTANCE)).toBe(true);
  });

  it("falls back to drivers and session fields when the story is missing", () => {
    const text = buildSessionPrompt({ session, story: null, drivers });
    const lines = text.split("\n");
    expect(lines).toContain("TOOL ERRORS (labels only; error text unavailable):");
    expect(lines).toContain("- Bash | NOT_FOUND | BASH_GIT × 2");
    expect(lines).toContain("FILES EDITED: unknown (session story unavailable)");
    expect(text).not.toContain("WHERE THE MONEY WENT");
    expect(text).not.toContain("SPEND BY CHAIN");
    expect(text).not.toContain("FIRST PROMPT");
    expect(lines).toContain("HYGIENE FLAGS: Long session near context limit");
    expect(text).toContain(TASK);
  });

  it("skips a bare exit-code line for the real error and rounds driver share", () => {
    const text = buildSessionPrompt({
      session,
      story: {
        ...story,
        error_groups: [
          {
            ...(story.error_groups[0] as SessionStory["error_groups"][number]),
            sample_error: "Exit code 1\n\nnpm ERR! missing script: tset",
          },
        ],
      },
      drivers: {
        ...drivers,
        drivers: [{ ...(drivers.drivers[0] as SessionDrivers["drivers"][number]), share: 0.01528 }],
      },
    });
    expect(text).toContain("× 4: npm ERR! missing script: tset");
    expect(text).toContain("| share: 1.5% |");
  });

  it("says files are unknown when the transcript is gone, not none observed", () => {
    const text = buildSessionPrompt({
      session,
      story: { ...story, transcript_available: false, files_touched: [], first_prompt: null },
    });
    expect(text).toContain(
      "FILES EDITED: unknown (transcript no longer on disk; first prompt and edits can't be read)",
    );
    expect(text).not.toContain("FILES EDITED: none observed");
  });

  it("marks the error groups as partial when they cover fewer errors than recorded", () => {
    const text = buildSessionPrompt({ session: { ...session, tool_error_count: 60 }, story });
    // groups: 4 + 1 = 5 of 60
    expect(text).toContain(
      "WHAT WENT WRONG (tool errors grouped by error text; top 2 groups cover 5 of 60 errors):",
    );
  });

  it("explains text-less errors even when no group has text", () => {
    const text = buildSessionPrompt({
      session,
      story: { ...story, error_groups: [], errors_without_text: 7 },
    });
    expect(text).toContain("(7 older tool errors have no stored text.)");
    expect(text).not.toContain("WHAT WENT WRONG");
  });

  it("warns after SIZE when some turns have no price, and stays silent otherwise", () => {
    const text = buildSessionPrompt({ session, story, unpricedTurns: 3 });
    expect(text).toContain(
      "SIZE: 8 turns · estimated cost $2.50\nPRICING: 3 turns have no price; their cost is not in the $ figures.\nFIRST PROMPT:",
    );
    expect(buildSessionPrompt({ session, story, unpricedTurns: 1 })).toContain(
      "PRICING: 1 turn has no price; its cost is not in the $ figures.",
    );
    expect(buildSessionPrompt({ session, story, unpricedTurns: 0 })).not.toContain("PRICING:");
    expect(buildSessionPrompt({ session, story, unpricedTurns: null })).not.toContain("PRICING:");
  });

  it("says price coverage is unknown when pricing failed to load", () => {
    expect(buildSessionPrompt({ session, story, unpricedTurns: "unknown" })).toContain(
      "SIZE: 8 turns · estimated cost $2.50\nPRICING: unknown (price coverage failed to load); the $ figures may leave out unpriced turns.\nFIRST PROMPT:",
    );
  });

  it("lists diagnostic anchors with 1-based turns", () => {
    const text = buildSessionPrompt({
      session,
      story,
      anchors: [
        {
          session_id: "synthetic-session",
          category: "loops",
          label: "Repeated call",
          timestamp: "2027-06-20T10:05:00Z",
          turn_index: 2,
          ceu: null,
        },
      ],
    });
    expect(text).toContain("DIAGNOSTIC ANCHORS:\n- loops | Repeated call | turn 3\nTASK:");
    expect(buildSessionPrompt({ session, story })).not.toContain("DIAGNOSTIC ANCHORS:");
  });

  it("says when nothing went wrong and nothing was committed", () => {
    const clean = {
      ...session,
      hygiene_flags: [],
      tool_error_count: 0,
      api_error_count: 0,
      test_fail_count: 0,
      compaction_count: 0,
      interrupt_count: 0,
      long_gap_count: 0,
    };
    const text = buildSessionPrompt({
      session: clean,
      story: { ...story, error_groups: [], commits: [], files_touched: [] },
    });
    const lines = text.split("\n");
    expect(lines).toContain("FRICTION: none observed");
    expect(lines).toContain("HYGIENE FLAGS: none");
    expect(lines).toContain("FILES EDITED: none observed");
    expect(lines).toContain("COMMITS: none observed");
    expect(text).not.toContain("WHAT WENT WRONG");
  });
});
