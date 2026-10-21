/**
 * P3.1-T5: the card side of the review-1 detector fixes, one block per finding id (register
 * `docs/handoffs/2026-09-26-card-review/review-1-findings.md`).
 */
import { describe, expect, it } from "vitest";
import { c1FindingDescriptor } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const SESSIONS = ["s1", "s2", "s3"];

function card(rec: CardActionRecommendation) {
  const trigger = buildTrigger(rec);
  const actions = buildCardActions(rec);
  return { trigger, actions, violations: cardRuleViolations(actions, trigger, rec.lever) };
}

function read(target: string, calls: number, sessions: number): CardToolCall {
  return {
    target,
    kind: "file",
    tool: "Read",
    calls,
    session_ids: ["s1"],
    session_count: sessions,
    total_bytes: calls * 1000,
    max_bytes: 1000,
    whole_file: true,
  };
}

describe("R4.1: D7 cross-session reads names the most-read file", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D7",
    lever: RECOMMENDATION_TEMPLATES.D7_CROSS_SESSION_REREAD.lever,
    facts: {
      session_ids: SESSIONS,
      redundant_path_count: 4,
      total_redundant_read_count: 120,
      total_redundant_result_bytes: 9_600_000,
      max_path_read_count: 69,
      max_path_session_count: 31,
    },
    tool_calls: [read("docs/plans/plan.md", 69, 31), read("src/big.ts", 20, 4)],
  };

  it("names the file on the card, in the action and in the prompt", () => {
    const { trigger, actions, violations } = card(rec);
    // Review 3 B1: one count per session, and only a look-up file is named as the lead.
    expect(trigger.problem).toContain(
      "The most-read look-up file, `docs/plans/plan.md`, was read in 31 sessions",
    );
    expect(actions.primary.summary).toContain("`docs/plans/plan.md`");
    expect(actions.primary.copy_text).toContain(
      "- Most-read look-up file: `docs/plans/plan.md`, read in 31 sessions",
    );
    expect(actions.primary.copy_text).toContain("src/big.ts");
    expect(violations).toEqual([]);
  });

  it("keeps the unnamed wording when no read could be read back", () => {
    const { tool_calls, ...unnamed } = rec;
    const { trigger, actions } = card(unnamed);
    expect(trigger.problem).toContain("The most-read file was read in 31 sessions");
    expect(actions.primary.summary).toContain(
      "Find the look-up files that later sessions read again",
    );
  });
});

describe("R2.9: C1 names every outlier tool its counts cover", () => {
  const rec = (tools: string): CardActionRecommendation => ({
    detector_id: "C1",
    lever: c1FindingDescriptor.presentation.lever,
    evidence: {
      session_ids: SESSIONS,
      metrics: {
        TOOL_ERROR_COUNT: { value: 55 },
        TOOL_CALL_COUNT: { value: 645 },
        CORPUS_ERROR_RATE: { value: 0.022 },
        CORPUS_CALL_COUNT: { value: 11_898 },
        OUTLIER_TOOLS: { value: tools },
      },
    },
    tool_calls: [{ ...read("taskkill /PID 1", 1, 1), kind: "command", tool: "PowerShell" }],
  });

  it("does not label a union of tools with the one tool read back", () => {
    const { trigger, violations } = card(
      rec("PowerShell, Browser find, Browser computer, Artifact"),
    );
    expect(trigger.problem).toContain(
      "55 of 645 calls to 4 tools (PowerShell, Browser find, Browser computer and 1 more) failed",
    );
    expect(violations).toEqual([]);
  });

  it("names a single outlier tool", () => {
    expect(card(rec("PowerShell")).trigger.problem).toContain("55 of 645 PowerShell calls failed");
  });
});

describe("R4.2: D7 retry loops show one concrete loop", () => {
  const rec: CardActionRecommendation = {
    detector_id: "D7",
    lever: RECOMMENDATION_TEMPLATES.D7_RETRY_LOOP.lever,
    facts: {
      session_ids: SESSIONS,
      loop_flagged_turn_count: 40,
      loop_flagged_turn_share: 0.05,
      identical_call_event_count: 12,
      loop_example_call_count: 7,
    },
    tool_calls: [
      {
        ...read("npm test", 5, 1),
        kind: "command",
        tool: "Bash",
        whole_file: false,
        result: "Error: Cannot find module 'x'",
      },
    ],
  };

  it("names the most repeated call and what it returned", () => {
    const { trigger, actions, violations } = card(rec);
    expect(trigger.problem).toContain(
      "The most repeated was Bash `npm test`, 7 times in one session (it returned \"Error: Cannot find module 'x'\")",
    );
    expect(actions.primary.copy_text).toContain("- Most repeated call (7 times in one session):");
    expect(actions.primary.copy_text).toContain("npm test");
    expect(violations).toEqual([]);
  });
});
