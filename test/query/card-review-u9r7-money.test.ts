/**
 * U9 round 7, money lane: the headline and the text agree, and the D7 loop card states the
 * counts and basis it measured.
 */
import { describe, expect, it } from "vitest";
import { RECOMMENDATION_TEMPLATES } from "../../src/detector/privacy-contract.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const NOT_READ =
  "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";

function edit(target: string, calls: number): CardToolCall {
  return {
    target,
    kind: "file",
    tool: "Edit",
    calls,
    session_ids: ["s1"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result: NOT_READ,
  };
}

// Shaped like the round-6 loop card: the 8-call example reads back as two files (3 + 2 calls).
const loopRec: CardActionRecommendation = {
  detector_id: "D7",
  lever: RECOMMENDATION_TEMPLATES.D7_RETRY_LOOP.lever,
  facts: {
    session_ids: ["s1", "s2", "s3"],
    session_count: 3,
    loop_flagged_turn_count: 6,
    loop_flagged_turn_share: 0.00594,
    total_turn_count: 1_097,
    identical_call_event_count: 17,
    error_loop_event_count: 20,
    loop_example_call_count: 8,
    repeat_excess_turn_count: 5,
    repeat_excess_cost_u: 85_929,
    repeat_excess_read_u: 74_287,
    repeat_excess_write_u: 10_313,
    repeat_excess_io_u: 1_330,
  },
  savings_u_per_wk: 42_965,
  tool_calls: [edit("~/work/run1.mjs", 3), edit("~/work/run2.mjs", 2)],
};

describe("U9 r7: D7 loop card", () => {
  it("states the loop share against the loop sessions' own turns", () => {
    const trigger = buildTrigger(loopRec, { allocated_u_per_wk: null });
    const copy = buildCardActions(loopRec).primary.copy_text;
    for (const text of [trigger.problem ?? "", copy]) {
      expect(text).toContain("(0.5% of the 1,097 turns in these 3 sessions)");
      expect(text).not.toContain("of all turns");
    }
  });

  it("uses one count for the most repeated call in the text and its list", () => {
    const trigger = buildTrigger(loopRec, { allocated_u_per_wk: null });
    const copy = buildCardActions(loopRec).primary.copy_text;
    expect(trigger.problem).toContain("The most repeated was Edit `~/work/run1.mjs`, 3 times");
    expect(trigger.problem).not.toContain("8 times");
    expect(copy).not.toContain("8 times");
    expect(copy).toContain("- Most repeated call:");
  });

  it("names this user's repeated call and error in the fix, with a ready rule", () => {
    const copy = buildCardActions(loopRec).primary.copy_text;
    expect(copy).toContain("Start with the most repeated call above: Edit on `~/work/run1.mjs`");
    expect(copy).toContain('When Edit returns "');
    expect(copy).not.toContain("such as: after the same error twice");
  });

  it("says its $ is not on the spend ledger, so the headline shows none", () => {
    const trigger = buildTrigger(loopRec, { allocated_u_per_wk: null });
    expect(trigger.problem).toContain("$0.04 a week");
    expect(trigger.problem).toContain("not on the spend ledger");
  });
});

describe("U9 r7: D4 shows the price gap and the realized share behind its $", () => {
  // Shaped like the round-6 card: 740 lookup turns, $33.50 at Opus, $26.59 at Sonnet.
  const d4: CardActionRecommendation = {
    detector_id: "D4",
    lever: RECOMMENDATION_TEMPLATES.D4_MODEL_MISMATCH.lever,
    facts: {
      workspace_id: "ws",
      session_ids: ["s1"],
      total_opus_turns_per_week: 858,
      mismatch_turns_per_week: 740,
      opus_subagent_count: 28,
      lookup_subagent_count: 16,
      mismatch_fraction: 0.8625,
      avg_input_tokens: 2,
      avg_output_tokens: 38,
      main_thread_turns: 0,
      lookup_opus_cost_u: 33_496_048,
      lookup_sonnet_cost_u: 26_594_222,
    },
  };

  it("works the $3.45 out from the turns' cost at each model's prices", () => {
    const trigger = buildTrigger(d4, { allocated_u_per_wk: 3_452_577 });
    expect(trigger.problem).toContain(
      "Those 740 turns cost $33.50 at Opus prices and would cost $26.59 at Sonnet prices, a $6.90 gap; the estimate assumes 50% of that gap is realized (an assumption, not a measurement): $6.90 × 50% = $3.45 a week.",
    );
    // The headline figure is already in the text, so no second $ sentence.
    expect(trigger.problem).not.toContain("After overlap");
  });

  it("U12: states the measured share and why it does not replace the 50%, once", () => {
    const trigger = buildTrigger(d4, { allocated_u_per_wk: 3_452_577 });
    expect(trigger.problem).toContain("the share was 20% (95% interval -48% to 76%)");
    expect(trigger.problem?.split("too imprecise to replace the assumption").length).toBe(2);
  });
});

describe("U9 r7: A1's summary says what its $ covers and what the Read rule reaches", () => {
  const a1: CardActionRecommendation = {
    detector_id: "A1",
    lever: "Shrink the large tool result that costs the most in re-sends",
    evidence: {
      metrics: {
        EVENT_COUNT: { kind: "COUNT", value: 79 },
        RESULT_BYTES_TOTAL: { kind: "BYTES", value: 2_969_049 },
        MAX_RESULT_BYTES: { kind: "BYTES", value: 64_809 },
        THRESHOLD_BYTES: { kind: "BYTES", value: 25 * 1024 },
      },
    },
  };

  it("does not credit the whole $ to the card's fix", () => {
    const summary = buildTrigger(a1, { allocated_u_per_wk: 1_991_675 }).summary ?? "";
    expect(summary).toContain("Shrinking all 79 would save about $1.99 a week");
    expect(summary).toContain("the Read rule on this card reaches only the Read results");
    expect(summary).not.toContain("Fixing it saves");
  });
});

describe("U9 r7: B1's summary says its $ is an assumed half of the rewrite", () => {
  const b1: CardActionRecommendation = {
    detector_id: "B1",
    lever: "Load on-demand tools once, at the start of a task.",
    evidence: {
      session_ids: ["sess-1"],
      metrics: {
        COLLAPSE_EVENT_COUNT: { value: 10 },
        RAPID_COLLAPSE_COUNT: { value: 10 },
        TOOLSEARCH_COLLAPSE_COUNT: { value: 10 },
        PREVIOUS_CACHE_READ_TOKENS: { value: 1_735_693 },
        CURRENT_CACHE_READ_TOKENS: { value: 337_468 },
        CURRENT_TO_PREVIOUS_RATIO: { value: 0.19 },
        REWRITE_COST_U: { value: 11_387_986 },
        CURRENT_CACHE_CREATION_TOKENS: { value: 1_459_998 },
        FIRST_MCP_LOAD_COUNT: { value: 10 },
      },
    },
    savings_u_per_wk: 5_693_993,
  };

  it("names the assumption and that the fix does not stop the break", () => {
    const summary = buildTrigger(b1, { allocated_u_per_wk: 5_694_016 }).summary ?? "";
    expect(summary).toContain(
      "The card assumes loading tools early avoids half of the $11.39, about $5.69 a week",
    );
    expect(summary).toContain("does not stop the break");
    expect(summary).not.toContain("Fixing it saves");
  });
});

describe("U9 r7: a headline that rounds to $0.00 still matches the text", () => {
  // Shaped like the round-6 workspace MEMORY.md card: its own $0.24, a ledger share of $0.
  const d1: CardActionRecommendation = {
    detector_id: "D1",
    lever: "Remove or scope always-loaded context that is not needed for most turns.",
    facts: {
      component: "MEMORY",
      source_tokens: 1_483,
      source_target: 1_000,
      delta_context_tokens: 483,
      turns_per_week: 5_053,
      scope: "workspace",
      workspace_multiplier: 1,
      attribution_method: "CHARS4_ESTIMATE",
      session_ids: ["s1"],
    },
    savings_u_per_wk: 244_034,
    savings_range_u_per_wk: [161_062, 341_648],
  };

  it("states the $0.00 share the headline shows", () => {
    const trigger = buildTrigger(d1, { allocated_u_per_wk: 0 });
    expect(trigger.problem).toContain("$0.24 a week");
    expect(trigger.problem).toContain(
      "The card headline shows only this card's share of the spend ledger, after the spend other cards already count: $0.00 a week.",
    );
  });

  it("says under $0.01 for a positive share that rounds to nothing", () => {
    const trigger = buildTrigger(d1, { allocated_u_per_wk: 3_000 });
    expect(trigger.problem).toContain("other cards already count: under $0.01 a week.");
  });
});
