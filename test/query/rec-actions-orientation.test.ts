import { describe, expect, it } from "vitest";
import { orientationHandler } from "../../src/query/api/rec-actions/families/orientation.js";
import { buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

describe("E1 card (U8 review)", () => {
  it("states the same long-start threshold as the problem text, not the median", () => {
    const rec: CardActionRecommendation = {
      detector_id: "E1",
      lever: "orientation",
      facts: { SESSIONS_OVER_P75: 14, PRE_EDIT_P50: 11, PRE_EDIT_P75: 18 },
    };
    const actions = orientationHandler(rec, { trigger: buildTrigger(rec) });
    expect(actions?.primary.summary).toBe(
      'Open each task with a "Start here" block: 14 sessions made more than 18 model calls before their first edit (11 is typical here).',
    );
  });

  it("copies a durable rule with at most three repo files as the example, no placeholders", () => {
    const call = (target: string, session_count: number) => ({
      target,
      kind: "file" as const,
      whole_file: true,
      tool: "Read",
      calls: session_count,
      session_ids: [],
      session_count,
      total_bytes: 1,
      max_bytes: 1,
    });
    const rec: CardActionRecommendation = {
      detector_id: "E1",
      lever: "orientation",
      facts: { SESSIONS_OVER_P75: 14, PRE_EDIT_P50: 11, PRE_EDIT_P75: 18 },
      tool_calls: [
        call("docs/plans/a.md", 6),
        call("~/.claude/memory/m.md", 5),
        call("C:/elsewhere/x.md", 5),
        call("docs/plans/b.md", 3),
        call("scripts/verify.mjs", 2),
        call("src/d.ts", 1),
      ],
    };
    const copy = orientationHandler(rec, { trigger: buildTrigger(rec) })?.primary.copy_text ?? "";
    expect(copy).toContain('## Start every handoff with a "Start here" block');
    expect(copy).toContain(
      "- `docs/plans/a.md`: read before the first edit in 6 of 14 long starts",
    );
    expect(copy).toContain("- `scripts/verify.mjs`:");
    expect(copy).not.toContain("src/d.ts");
    expect(copy).not.toContain("memory");
    expect(copy).not.toContain("elsewhere");
    expect(copy).not.toMatch(/<[a-z]/);
  });
});
