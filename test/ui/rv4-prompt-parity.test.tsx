import { describe, expect, it } from "vitest";

import type { RecommendationCard } from "../../src/query/api/recommendations";
import { buildPromptArtifact } from "../../src/ui/recommendations/prompt-templates";

function makeRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "rv4-prompt-parity-rec",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Reduce avoidable context",
    modeled_savings_u_per_wk: 0,
    run_cost_u: null,
    modeled_formula: { model: "test", inputs: {}, expression: "test" },
    evidence: {},
    target_metric: "context_tokens",
    state: "PROPOSED",
    created_at: "2026-09-02T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 1,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

function expectTurnkeySections(rec: RecommendationCard): void {
  const artifact = buildPromptArtifact(rec);

  expect(artifact).not.toBeNull();
  expect(artifact?.flavor).toBe("TURNKEY");
  expect(artifact?.text).toContain("TASK:");
  expect(artifact?.text).toContain("CONSTRAINTS:");
  expect(artifact?.text).toContain("ACCEPTANCE:");
  expect(artifact?.text.match(/Measured .*:\s*[\d,]/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
}

describe("RV4 prompt artifact parity", () => {
  it("keeps required labeled sections and measured quantities for turnkey detectors", () => {
    expectTurnkeySections(
      makeRec({
        detector_id: "D1",
        evidence: {
          source_tokens: 12_000,
          source_target: 4_000,
          delta_context_tokens: 8_000,
          component: "CLAUDE.md",
        },
      }),
    );
    expectTurnkeySections(
      makeRec({
        detector_id: "D10",
        evidence: {
          catalog_tokens: 60_000,
          catalog_target_tokens: 20_000,
          delta_context_tokens: 40_000,
          source_count: 9,
          turns_per_week: 120,
        },
      }),
    );
    expectTurnkeySections(
      makeRec({
        detector_id: "D4",
        evidence: {
          mismatch_turns_per_week: 8,
          total_opus_turns_per_week: 40,
          mismatch_fraction: 0.2,
        },
      }),
    );
  });

  it("uses labeled guided sections without the work-through filler", () => {
    const artifact = buildPromptArtifact(
      makeRec({
        detector_id: "D6",
        evidence: {
          tool_result_bytes: 5_000,
          bloat_share: 0.3,
          session_cap_weighted_tokens: 90_000,
          attributed_tool: "Read",
        },
      }),
    );

    expect(artifact).not.toBeNull();
    expect(artifact?.flavor).toBe("GUIDED");
    expect(artifact?.text).toContain("TASK:");
    expect(artifact?.text).toContain("CONSTRAINTS:");
    expect(artifact?.text).toContain("ACCEPTANCE:");
    expect(artifact?.text).not.toContain("Work this through");
  });

  it("returns null for detectors without a template", () => {
    expect(buildPromptArtifact(makeRec({ detector_id: "D9", evidence: {} }))).toBeNull();
  });
});
