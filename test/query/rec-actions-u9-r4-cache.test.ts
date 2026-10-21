import { describe, expect, it } from "vitest";
import { b4EventLine } from "../../src/detector/cache-collapse.js";
import { LOAD_TOOLS_EARLY_LINE } from "../../src/query/api/rec-actions/families/cache.js";
import { buildCardActions, cardTitle } from "../../src/query/api/rec-actions/index.js";
import { buildTrigger } from "../../src/query/api/rec-actions/trigger.js";
import type {
  CardActionRecommendation,
  CardToolCall,
} from "../../src/query/api/rec-actions/types.js";

const metrics = (values: Record<string, number | string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));

// Twelve breaks in twelve sessions; the second one starts with Bash, so MCP loading is inferred.
const lines = Array.from({ length: 12 }, (_, i) =>
  b4EventLine({
    session_id: `sess-${i}`,
    ts: `2026-10-03T22:${String(10 + i).padStart(2, "0")}:00.000Z`,
    written: 200_000 - i * 10_000,
    read: 33_000,
    previous_read: 230_000 - i * 10_000,
    first_read: 33_000,
    gap_ms: 4_000,
    rewrite_cost_u: 1_000_000 - i * 50_000,
    after_tool_search: true,
    first_tool: i === 1 ? "Bash" : "mcp__claude-in-chrome__navigate",
  }),
).join("\n");

const cacheValues = {
  EVENTS: lines,
  CURRENT_CACHE_CREATION_TOKENS: 1_320_000,
  REWRITE_COST_U: 10_300_000,
  FIRST_MCP_LOAD_COUNT: 12,
  SESSION_TOOLSEARCH_CALLS: 20,
};

const b1 = (): CardActionRecommendation => ({
  detector_id: "B1",
  lever:
    "Load on-demand tools once, at the start of a task, so the cached prompt is not rebuilt mid-session.",
  evidence: {
    session_ids: ["sess-3", "sess-1"],
    metrics: metrics({
      ...cacheValues,
      COLLAPSE_EVENT_COUNT: 12,
      RAPID_COLLAPSE_COUNT: 12,
      TOOLSEARCH_COLLAPSE_COUNT: 12,
      PREVIOUS_CACHE_READ_TOKENS: 1_700_000,
      CURRENT_CACHE_READ_TOKENS: 337_000,
      CURRENT_TO_PREVIOUS_RATIO: 0.19,
    }),
  },
  savings_u_per_wk: 5_150_000,
});

const b4 = (): CardActionRecommendation => ({
  detector_id: "B4",
  lever:
    "Load on-demand tools once, at the start of a task, so the cached prompt is not rebuilt mid-session.",
  evidence: {
    session_ids: ["sess-3"],
    metrics: metrics({ ...cacheValues, EVENT_COUNT: 12, TOOLSEARCH_EVENT_COUNT: 12 }),
  },
});

describe("U9 round 4: B1 owns the cache fix, B4 is its evidence table", () => {
  it("B1's primary copy_text is the CLAUDE.md line, the file it goes in and the late-loading check", () => {
    const actions = buildCardActions(b1());
    expect(actions.primary.copy_text).toContain(LOAD_TOOLS_EARLY_LINE);
    expect(actions.primary.copy_text).toContain("Add this line to ~/.claude/CLAUDE.md");
    expect(actions.primary.copy_text).toContain("loads browser or other on-demand tools late");
    expect(actions.primary.detail.join(" ")).toContain("does not stop the break");
    // The investigation prompt is the alternative and carries every session and its table.
    const alt = actions.alternatives[0]?.copy_text ?? "";
    for (let i = 0; i < 12; i++) expect(alt).toContain(`sess-${i}`);
    expect(alt).toContain("| session | time (UTC)");
  });

  it("B1 lists all sessions, ranked by rewrite cost, and says the sums are over the breaks", () => {
    const trigger = buildTrigger(b1());
    expect(trigger.session_ids).toHaveLength(12);
    expect(trigger.session_ids[0]).toBe("sess-0");
    expect(trigger.session_ids[11]).toBe("sess-11");
    expect(trigger.problem).toContain("12 mid-session cache breaks");
    expect(trigger.problem).toContain("that is not one drop");
    expect(trigger.facts.find((f) => f.label.startsWith("Cache reads"))?.label).toBe(
      "Cache reads, summed over 12 breaks",
    );
  });

  it("B1 and B4 say which break had a non-MCP tool first, so MCP loading is inferred", () => {
    const b1Detail = buildCardActions(b1()).primary.detail.join(" ");
    expect(b1Detail).toContain("1 of 12 had Bash as the first tool");
    expect(b1Detail).toContain("inferred");
    expect(buildCardActions(b4()).primary.copy_text).toContain("1 of 12 had Bash");
  });

  it("B4 has its own title and no copy of B1's prompt or CLAUDE.md line", () => {
    const r = b4();
    expect(cardTitle(r)).toBe("Mid-session cache breaks, one by one: 12 breaks");
    expect(cardTitle(r)).not.toBe(cardTitle(b1()));
    const actions = buildCardActions(r);
    expect(actions.primary.copy_text).not.toContain(LOAD_TOOLS_EARLY_LINE);
    expect(actions.primary.copy_text).not.toContain("## Steps");
    expect(actions.primary.copy_text).toContain("| session | time (UTC)");
    expect(actions.primary.summary).toContain("Load on-demand tools once");
  });
});

describe("U9 round 4: D7 read-retry copy", () => {
  const read = (over: Partial<CardToolCall> = {}): CardToolCall => ({
    target: "~/scratch/dump.txt",
    kind: "file",
    tool: "Read",
    calls: 3,
    session_ids: ["sess-d7"],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
    whole_file: false,
    result:
      "File content (33563 tokens) exceeds maximum allowed tokens (25000). Use offset and limit.",
    at: ["2026-10-05T15:44:19.923Z", "2026-10-05T15:44:22.196Z", "2026-10-05T15:44:24.365Z"],
    ...over,
  });
  const d7 = (): CardActionRecommendation => ({
    detector_id: "D7",
    lever: "lever",
    evidence: {
      session_ids: ["sess-d7"],
      metrics: metrics({
        loop_flagged_turn_count: 3,
        loop_example_call_count: 3,
        error_loop_event_count: 3,
      }),
    },
    tool_calls: [read()],
  });

  it("names the session and times, never says 'unchanged retry' or points at 'the card'", () => {
    const text = buildCardActions(d7()).primary.copy_text;
    expect(text).toContain("session sess-d7");
    expect(text).toContain("2026-10-05T15:44:19.923Z");
    expect(text).toContain("2026-10-05T15:44:24.365Z");
    expect(text).toContain("3 times in a row with the same error");
    expect(text).not.toMatch(/unchanged retry|on the card/i);
    expect(text).not.toContain("whole-file");
  });
});
