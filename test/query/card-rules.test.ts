import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_WHY, cardRuleViolations } from "../../src/query/api/rec-actions/card-rules.js";
import { CONTEXT_DETECTOR_IDS } from "../../src/query/api/rec-actions/families/context.js";
import { buildCardActions, buildTrigger } from "../../src/query/api/rec-actions/index.js";
import type { CardActionRecommendation } from "../../src/query/api/rec-actions/types.js";

const WINDOW = { from: "2026-09-19T00:00:00.000Z", to: "2026-09-26T00:00:00.000Z" };

function violations(rec: CardActionRecommendation): string[] {
  return cardRuleViolations(buildCardActions(rec), buildTrigger(rec));
}

/** Context cards as the live API builds them. */
const CONTEXT_CARDS: CardActionRecommendation[] = [
  {
    detector_id: "D1",
    lever: "trim",
    facts: {
      component: "CLAUDE_MD",
      source_file_ref: path.join(os.tmpdir(), "aw-card-rules", "CLAUDE.md"),
      attribution_method: "MEASURED_CONTENT",
      source_tokens: 9000,
      source_target: 5000,
      delta_context_tokens: 4000,
      turns_per_week: 700,
    },
  },
  {
    detector_id: "A1",
    lever: "spill",
    evidence: {
      session_ids: ["s1", "s2"],
      window: WINDOW,
      metrics: {
        TOOL_CLASS: { value: "FILE_READ" },
        EVENT_COUNT: { value: 40 },
        RESULT_BYTES_TOTAL: { value: 1_500_000 },
        MAX_RESULT_BYTES: { value: 64_000 },
      },
    },
    tool_calls: [
      {
        target: "~/repo/src/big.ts",
        kind: "file",
        tool: "Read",
        calls: 15,
        session_ids: ["s1", "s2"],
        session_count: 2,
        total_bytes: 640_000,
        max_bytes: 57_000,
        whole_file: true,
      },
    ],
  },
  {
    detector_id: "D2",
    lever: "split",
    facts: {
      session_ids: ["s1", "s2", "s3"],
      qualifying_session_count: 3,
      qualifying_turn_count: 620,
      raw_context_average_tokens_per_turn: 212_345.5,
      cache_read_tokens_per_week: 131_000_000,
      cap_weighted_burn_tokens_per_week: 150_000_000,
    },
  },
  {
    detector_id: "A2",
    lever: "compact",
    evidence: {
      session_ids: ["s1", "s2"],
      window: WINDOW,
      metrics: {
        EVENT_COUNT: { value: 6 },
        RESULT_BYTES_TOTAL: { value: 180_000 },
        MAX_RESULT_BYTES: { value: 52_000 },
        THRESHOLD_BYTES: { value: 10_240 },
      },
    },
  },
  {
    detector_id: "D6",
    lever: "range",
    facts: {
      workspace_id: "ws1",
      session_ids: ["s1", "s2", "s3"],
      session_count: 3,
      tool_result_bytes: 2_400_000,
      bloat_share: 0.41,
      turn_count: 380,
    },
  },
  ...[2, 0].map((alwaysLoad) => ({
    detector_id: "D10",
    lever: "catalog",
    facts: {
      catalog_tokens: 62_000,
      catalog_target_tokens: 40_000,
      catalog_item_count: 140,
      always_load_count: alwaysLoad,
    },
  })),
];

/**
 * Context cards that do not meet the rules yet (none of them fires on the live DB this week).
 * Remove an id when its card passes: this test fails until you do. Other lanes' cards need real
 * evidence to build, so they are checked on the live DB and recorded in the P3.1 plan row.
 */
const NOT_YET = new Set<string>([]);

/**
 * Context cards with a "Why this matters" text (review 5 U2). The rest fail only on the missing
 * text until theirs is written (review 5 deferred item 11, operator 2026-09-26).
 */
const HAS_WHY = new Set(["A1", "D2"]);

describe("card rules", () => {
  it.each(CONTEXT_CARDS)("$detector_id meets the card rules", (rec) => {
    expect(violations(rec)).toEqual(HAS_WHY.has(rec.detector_id) ? [] : [NO_WHY]);
  });

  it("flags each rule", () => {
    const actions = {
      primary: {
        option_id: "x",
        kind: "HABIT" as const,
        summary: "C11 already covers it",
        detail: [],
        copy_text: "## Context\n## Findings\n## Fix\n## Steps\n1. Do it.",
        file_ref: null,
      },
      alternatives: [],
    };
    expect(cardRuleViolations(actions, { session_ids: [], window: null, facts: [] })).toEqual([
      "no plain statement of what happened",
      NO_WHY,
      'option x: detector code "C11" in summary',
      "option x: steps lack a confirm or verify step",
    ]);
  });

  it("ignores detector-like tokens inside quoted evidence", () => {
    const actions = {
      primary: {
        option_id: "x",
        kind: "INVESTIGATE" as const,
        summary: 'Rerun `npm run certify -- B3`, which returned "A1 failed"',
        detail: [],
        copy_text:
          "## Context\n## Findings\n## Fix\n## Steps\n1. Ask me to confirm.\n2. Verify: done.",
        file_ref: null,
      },
      alternatives: [],
    };
    const trigger = {
      session_ids: [],
      window: null,
      facts: [{ label: "Runs", value: "2" }],
      problem: 'It said "D4 ok".',
      why: "It matters.",
    };
    expect(cardRuleViolations(actions, trigger)).toEqual([]);
    trigger.problem = "D4 fired.";
    expect(cardRuleViolations(actions, trigger)).toEqual(['detector code "D4" in what\'s wrong']);
  });

  it("review 4: flags a capped lead and a TL;DR number the card does not back", () => {
    const actions = {
      primary: {
        option_id: "x",
        kind: "HABIT" as const,
        summary: "Read less",
        detail: [],
        copy_text:
          "## Context\n## Findings\n## Fix\n## Steps\n1. Ask me to confirm.\n2. Verify: ok.",
        file_ref: null,
      },
      alternatives: [],
    };
    const capped = {
      target: "https://claude.ai/artifact/x",
      kind: "url" as const,
      tool: "Artifact",
      calls: 5,
      session_ids: ["s1"],
      session_count: 1,
      total_bytes: 250_000,
      max_bytes: 50_000,
      whole_file: false,
    };
    const trigger = {
      session_ids: ["s1"],
      window: null,
      facts: [{ label: "Blocks", value: "14" }],
      problem: "The guard blocked 14 calls; 14 were false positives.",
      summary: "3 harmless calls were blocked.",
      why: "It matters.",
      calls: [capped],
    };
    expect(cardRuleViolations(actions, trigger)).toEqual([
      "lead `https://claude.ai/artifact/x` is a result cut at the Artifact cap (50,000 bytes)",
      "TL;DR says 3, which what's wrong and the facts do not",
    ]);
    expect(
      cardRuleViolations(actions, {
        ...trigger,
        summary: "14 calls were blocked.",
        calls: [{ ...capped, max_bytes: 40_000 }],
      }),
    ).toEqual([]);
  });

  it("records which context cards do not meet the rules yet", () => {
    const failing: string[] = [];
    for (const detector_id of CONTEXT_DETECTOR_IDS) {
      const rec = CONTEXT_CARDS.find((card) => card.detector_id === detector_id) ?? {
        detector_id,
        lever: "lever",
        evidence: { session_ids: ["s1"], window: WINDOW, metrics: {} },
        facts: {},
        investigation_question: "Which call went wrong here?",
      };
      let found: string[];
      try {
        found = violations(rec);
      } catch {
        found = ["builder needs real evidence"];
      }
      if (found.length > 0) failing.push(detector_id);
    }
    const noWhy = CONTEXT_DETECTOR_IDS.filter((id) => !HAS_WHY.has(id));
    expect(failing.sort()).toEqual([...new Set([...NOT_YET, ...noWhy])].sort());
  });
});
