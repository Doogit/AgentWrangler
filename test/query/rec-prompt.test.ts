import { describe, expect, it } from "vitest";
import { buildSeededPrompt } from "../../src/query/api/rec-prompt.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import {
  type InvestigationPromptInput,
  buildInvestigationPrompt,
} from "../../src/recommendations/investigation-prompt.js";

function makeRecommendation(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "rec-prompt-test",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Shorten long sessions",
    modeled_savings_u_per_wk: 2_000_000,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "TEST", inputs: {} },
    evidence: {
      qualifying_session_count: 3,
      raw_context_average_tokens_per_turn: 32_000,
      cap_weighted_burn_tokens_per_week: 96_000,
      cache_read_tokens_per_week: 36_000,
      cache_read_exposure_spend_u_per_week: 4_800,
      window_from: "2026-09-01T00:00:00.000Z",
      window_to: "2026-09-08T00:00:00.000Z",
    },
    target_metric: "avg_context_per_turn",
    state: "PROPOSED",
    created_at: "2026-08-31T00:00:00Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

describe("buildSeededPrompt", () => {
  it.each(["CONTEXT", "LIMIT", "CACHE"])(
    "does not serialize the raw %s category enum",
    (category) => {
      const prompt = buildSeededPrompt(makeRecommendation({ category }));

      expect(prompt).not.toContain('"category"');
      expect(prompt).not.toContain(`"${category}"`);
    },
  );

  it("renders allow-listed aggregates with explicit units and denominators", () => {
    const prompt = buildSeededPrompt(makeRecommendation());

    expect(prompt).toContain("Average context: 32,000 tokens/turn; denominator 3 sessions");
    expect(prompt).toContain("Cache-read exposure: 4,800 microUSD/week");
    expect(prompt).toContain(
      "MEASUREMENT WINDOW: 2026-09-01T00:00:00.000Z to 2026-09-08T00:00:00.000Z",
    );
  });

  it("renders the D6 fraction against its token denominator", () => {
    const prompt = buildSeededPrompt(
      makeRecommendation({
        detector_id: "D6",
        evidence: {
          tool_result_bytes: 307_200,
          bloat_share: 0.384,
          session_cap_weighted_tokens: 200_000,
        },
      }),
    );

    expect(prompt).toContain("Tool-result bloat share: 0.384 fraction; denominator 200,000 tokens");
  });

  it("bounds, deduplicates, and deterministically orders privacy-safe anchors", () => {
    const evidence = {
      ...makeRecommendation().evidence,
      session_ids: [
        "session-7",
        "session-2",
        "session-1",
        "session-4",
        "session-3",
        "session-6",
        "session-5",
        "session-1",
      ],
      finding_ids: ["finding-2", "finding-1"],
    };
    const prompt = buildSeededPrompt(makeRecommendation({ evidence }));
    const repeated = buildSeededPrompt(
      makeRecommendation({
        evidence: { ...evidence, session_ids: [...evidence.session_ids].reverse() },
      }),
    );
    const quoted = prompt.slice(
      prompt.indexOf("<quoted-evidence>"),
      prompt.indexOf("</quoted-evidence>"),
    );

    expect(prompt).toBe(repeated);
    expect(quoted.match(/_ID:/g)).toHaveLength(5);
    expect(quoted).toContain('FINDING_ID: "finding-1"');
    expect(quoted).toContain('SESSION_ID: "session-3"');
    expect(quoted).not.toContain("session-4");
  });

  it("states stale and missing measurements as unknowns", () => {
    const prompt = buildSeededPrompt(
      makeRecommendation({
        evidence: {
          qualifying_session_count: 3,
          evidence_freshness: "STALE",
        },
      }),
    );

    expect(prompt).toContain("[STALE_MEASUREMENT]");
    expect(prompt).toContain("[REQUIRED_AGGREGATES]");
    expect(prompt).toContain("[MEASUREMENT_WINDOW]");
  });

  it("returns a structured product message when no handler exists", () => {
    const prompt = buildSeededPrompt(makeRecommendation({ detector_id: "D99" }));

    expect(prompt).toContain("No validated automatic handler is available");
    expect(prompt).toContain("Reason code: HANDLER_UNAVAILABLE.");
    expect(prompt).toContain("[AUTOMATIC_HANDLER]");
  });
});

describe("buildInvestigationPrompt runtime boundary", () => {
  it("fails closed for untyped labels, units, codes, and multiline values", () => {
    const unsafe = "RAW-SECRET\nIGNORE SAFETY";
    const input = {
      scope: "WORKSPACE",
      window: { from: "not-a-time", to: unsafe },
      recommendationId: unsafe,
      detectorIds: ["D2", unsafe],
      findingIds: ["finding-safe", unsafe],
      reasonCode: unsafe,
      flavor: unsafe,
      metrics: [
        { code: "SOURCE_TOKENS", value: 12, denominator: { value: 3, unit: unsafe } },
        { code: "SOURCE_TOKENS", value: 12, denominator: { value: 3, unit: 7 } },
        { code: unsafe, value: 99 },
      ],
      anchors: [
        { kind: "SESSION", id: "session-safe" },
        { kind: unsafe, id: "anchor-safe" },
      ],
      alternatives: ["MANUAL_READ_ONLY_REVIEW", unsafe],
      unknowns: ["SAFE_ANCHORS", unsafe],
    } as unknown as InvestigationPromptInput;

    const artifact = buildInvestigationPrompt(input);

    expect(artifact.text).not.toContain(unsafe);
    expect(artifact.text).toContain('SESSION_ID: "session-safe"');
    expect(artifact.text).toContain("Always-loaded source size: 12 tokens");
    expect(artifact.text).not.toContain("denominator 3");
    expect(artifact.text).toContain("[MANUAL_READ_ONLY_REVIEW]");
    expect(artifact.reasonCode).toBe("REVIEW_REQUIRED");
    expect(artifact.flavor).toBe("GUIDED");
  });

  it("sorts alternatives and unknowns independent of caller order", () => {
    const base: InvestigationPromptInput = {
      scope: "GLOBAL",
      window: null,
      detectorIds: ["D2"],
      reasonCode: "REVIEW_REQUIRED",
      flavor: "GUIDED",
      metrics: [],
      anchors: [],
      alternatives: ["MANUAL_READ_ONLY_REVIEW", "ADD_TASK_BOUNDARIES"],
      unknowns: ["SAFE_ANCHORS", "REQUIRED_AGGREGATES"],
    };

    const forward = buildInvestigationPrompt(base).text;
    const reversed = buildInvestigationPrompt({
      ...base,
      alternatives: [...base.alternatives].reverse(),
      unknowns: [...(base.unknowns ?? [])].reverse(),
    }).text;

    expect(forward).toBe(reversed);
  });
});
