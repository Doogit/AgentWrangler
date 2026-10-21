/**
 * The TL;DR line at the top of a card's "What's wrong" (operator 2026-09-26): one short line,
 * then the weekly saving the card shows.
 */
import { describe, expect, it } from "vitest";
import { buildTrigger } from "../../src/query/api/rec-actions/index.js";

describe("trigger.summary (TL;DR)", () => {
  it("states D2's problem in one line and ends with the card's saving", () => {
    const trigger = buildTrigger({
      detector_id: "D2",
      lever: "split",
      savings_u_per_wk: 18_260_000,
      facts: {
        session_ids: ["s1"],
        qualifying_session_count: 5,
        qualifying_turn_count: 907,
        raw_context_average_tokens_per_turn: 208_000,
      },
    });
    expect(trigger.summary).toBe(
      "5 long sessions re-read their whole growing history on every model call. Fixing it saves about $18.26 a week.",
    );
    expect(trigger.problem?.length).toBeGreaterThan(trigger.summary?.length ?? 0);
  });

  it("gives C1 its failure rate and no saving line when the card has none", () => {
    const trigger = buildTrigger({
      detector_id: "C1",
      lever: "fix",
      facts: { session_ids: ["s1"], TOOL_ERROR_COUNT: 37, TOOL_CALL_COUNT: 349 },
    });
    // 37 / 349 = 10.6%.
    expect(trigger.summary).toBe(
      "37 calls to a few tools failed (10.6%), each costing a retry turn.",
    );
  });

  it("falls back to the first sentence of the problem for detectors without their own line", () => {
    const trigger = buildTrigger({
      detector_id: "B4",
      lever: "boundary",
      // U9: B4's problem names the measured cause in its second sentence (was "Making that change").
      facts: {
        session_ids: ["s1"],
        CURRENT_CACHE_CREATION_TOKENS: 120_000,
        EVENT_COUNT: 2,
        TOOLSEARCH_EVENT_COUNT: 2,
      },
    });
    const problem = trigger.problem ?? "";
    expect(problem).toContain(
      ". Measured pattern: 2 of 2 came on the turn right after a ToolSearch call",
    );
    expect(problem).toContain("a pattern, not a proven cause");
    expect(trigger.summary).toBe(`${problem.slice(0, problem.indexOf(". Measured pattern") + 1)}`);
  });

  it("keeps shell commands out of H1 and C7 lines, and drops a saving that rounds to $0.00", () => {
    const h1 = buildTrigger({
      detector_id: "H1",
      lever: "ask",
      savings_u_per_wk: 4_000,
      facts: { session_ids: ["s1"], OPERATION_COUNT: 4, DESTRUCTIVE_OPERATION: "RM_RF" },
    });
    expect(h1.summary).toBe("Claude ran `rm -rf` 4 times, and it cannot be undone.");
    const c7 = buildTrigger({
      detector_id: "C7",
      lever: "fix",
      facts: { session_ids: ["s1"], BASH_FAILURE_COUNT: 6 },
    });
    expect(c7.summary).toMatch(/^6 .+ failed, each costing a retry turn\.$/);
  });

  it("has no summary when there is no problem statement", () => {
    const trigger = buildTrigger({ detector_id: "B4", lever: "boundary", facts: {} });
    expect(trigger.problem).toBeUndefined();
    expect(trigger.summary).toBeUndefined();
  });
});
