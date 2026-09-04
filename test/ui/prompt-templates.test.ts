import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import type { RecommendationCard } from "../../src/query/api/recommendations";
import {
  buildPromptArtifact,
  generateAutocompactSnippet,
  generateModelDefaultSnippet,
  generateSettingsDisableBlock,
  generateSubagentRoutingSnippet,
  generateTrailerWriterSnippet,
  scopePromptCaption,
} from "../../src/ui/recommendations/prompt-templates";

function card(overrides: Partial<RecommendationCard>): RecommendationCard {
  return {
    detector_id: "D1",
    evidence: {},
    modeled_formula: { inputs: {}, model: "test" },
    file_ref: null,
    lever: "test lever",
    ...overrides,
  } as unknown as RecommendationCard;
}

function assertMeasuredLines(text: string): void {
  const exempt =
    /^(Prompt artifact|Work-through|Title|Lever|Component|File|Measured |MEASURED CONTEXT|TASK|CONSTRAINTS|ACCEPTANCE|Evidence |Formula input |Acceptance|Caveat|Attributed tool):/;
  for (const line of text.split("\n").filter(Boolean)) {
    if (!exempt.test(line)) {
      expect(line).toMatch(/[0-9]|[/\\]/);
    }
  }
}

describe("buildPromptArtifact", () => {
  it("creates a turnkey D1 artifact with the source path, measured quantities, and verification", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D1",
        evidence: {
          source_tokens: 12000,
          source_target: 4000,
          delta_context_tokens: 8000,
          component: "CLAUDE.md",
        },
        file_ref: "/repo/CLAUDE.md",
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("TURNKEY");
    expect(result.text).toContain("/repo/CLAUDE.md");
    expect(result.text).toContain("12,000");
    expect(result.text).toContain("4,000");
    expect(result.text).toContain("8,000");
    expect(result.text).toMatch(/verify|confirm/i);
    assertMeasuredLines(result.text);
  });

  it("creates a guided D2 artifact that preserves the measured context without prescribing a one-line fix", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D2",
        evidence: {
          qualifying_session_count: 12,
          raw_context_average_tokens_per_turn: 24000,
          cap_weighted_burn_tokens_per_week: 96000,
          cache_read_tokens_per_week: 36000,
          cache_read_exposure_spend_u_per_week: 4800,
        },
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("GUIDED");
    for (const number of ["12", "24,000", "96,000", "36,000", "4,800"]) {
      expect(result.text).toContain(number);
    }
    expect(result.text).toMatch(/work (this )?through|with Claude|with an agent/i);
    expect(result.text).not.toMatch(/^(Fix|Change|Replace|Delete):/im);
    assertMeasuredLines(result.text);
  });

  it("routes D10 to a turnkey artifact with a verification line", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D10",
        evidence: {
          catalog_tokens: 9000,
          catalog_target_tokens: 3000,
          delta_context_tokens: 6000,
          source_count: 14,
          turns_per_week: 55,
        },
        file_ref: "/repo/.claude/commands",
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("TURNKEY");
    expect(result.text).toContain("9,000");
    expect(result.text).toMatch(/verify|confirm/i);
    assertMeasuredLines(result.text);
  });

  it("routes D4 to a turnkey artifact with the cap caveat and a verification line", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D4",
        evidence: {
          mismatch_turns_per_week: 30,
          total_opus_turns_per_week: 100,
          mismatch_fraction: 0.3,
        },
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("TURNKEY");
    expect(result.text).toContain("30");
    expect(result.text).toContain("100");
    expect(result.text).toMatch(/verify|confirm/i);
    assertMeasuredLines(result.text);
  });

  it("routes D6 to a guided artifact retaining the attributed tool and metrics", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D6",
        evidence: {
          tool_result_bytes: 500000,
          bloat_share: 0.6,
          session_cap_weighted_tokens: 82000,
          attributed_tool: "Bash",
        },
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("GUIDED");
    expect(result.text).toContain("500,000");
    expect(result.text).toContain("Bash");
    assertMeasuredLines(result.text);
  });

  it("routes D8 to a guided artifact with churn metrics", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D8",
        evidence: {
          churn_event_count: 7,
          total_churn_creation_tokens: 45000,
          session_cap_weighted_tokens: 82000,
        },
      }),
    );
    assert(result !== null);

    expect(result.flavor).toBe("GUIDED");
    expect(result.text).toContain("45,000");
    assertMeasuredLines(result.text);
  });

  it("returns null for detectors with no template (routed or unknown) — no generic filler", () => {
    // RV4 deletes buildFallback: routed behavioral detectors (D5/D7/D9) and any
    // unknown detector get no artifact rather than metric-only filler. Callers
    // (RecCard, buildBrief) guard the null and route or omit the prompt.
    const result = buildPromptArtifact(
      card({
        detector_id: "DZZ",
        evidence: { observed_tokens: 12345 },
        modeled_formula: { inputs: { weekly_turns: 42 }, model: "test" },
      }),
    );
    expect(result).toBeNull();
  });

  // FB2 — scope preamble tests
  it("workspace-scoped rec prompt contains repo-targeting preamble", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D1",
        scope_workspace_id: "ws-abc123",
        cross_workspace: false,
        evidence: {
          source_tokens: 5000,
          source_target: 2000,
          delta_context_tokens: 3000,
          component: "CLAUDE.md",
        },
        file_ref: "/repo/CLAUDE.md",
      }),
    );
    assert(result !== null);
    // Preamble must identify this as a workspace-scoped target
    expect(result.text).toMatch(/SCOPE:\s*Workspace/i);
    expect(result.text).toMatch(/\.claude\/settings\.json|CLAUDE\.md/);
    // Must NOT reference ~/.claude (that is global territory)
    expect(result.text).not.toContain("~/.claude");
  });

  it("global rec prompt contains ~/.claude preamble", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D1",
        scope_workspace_id: null,
        cross_workspace: true,
        evidence: {
          source_tokens: 8000,
          source_target: 3000,
          delta_context_tokens: 5000,
          component: "CLAUDE.md",
        },
        file_ref: null,
      }),
    );
    assert(result !== null);
    // Preamble must identify this as global and target ~/.claude
    expect(result.text).toMatch(/SCOPE:\s*Global/i);
    expect(result.text).toContain("~/.claude");
    expect(result.text).toContain("all workspaces");
  });

  it("global and workspace recs produce different prompt text", () => {
    const baseEvidence = {
      source_tokens: 5000,
      source_target: 2000,
      delta_context_tokens: 3000,
      component: "CLAUDE.md",
    };
    const wsResult = buildPromptArtifact(
      card({
        detector_id: "D1",
        scope_workspace_id: "ws-xyz",
        cross_workspace: false,
        evidence: baseEvidence,
      }),
    );
    const globalResult = buildPromptArtifact(
      card({
        detector_id: "D1",
        scope_workspace_id: null,
        cross_workspace: true,
        evidence: baseEvidence,
      }),
    );
    assert(wsResult !== null);
    assert(globalResult !== null);
    expect(wsResult.text).not.toBe(globalResult.text);
  });
});

describe("scopePromptCaption", () => {
  it("returns repo-targeting caption for workspace-scoped recs", () => {
    const caption = scopePromptCaption(card({ scope_workspace_id: "ws-abc" }));
    expect(caption).toMatch(/CLAUDE\.md/);
    expect(caption).not.toContain("~/.claude");
  });

  it("returns global caption for global recs (null scope_workspace_id)", () => {
    const caption = scopePromptCaption(card({ scope_workspace_id: null }));
    expect(caption).toContain("~/.claude");
    expect(caption).toContain("everywhere");
  });
});

describe("generated snippets", () => {
  it("generates a D10 lazy-load settings snippet from measured evidence", () => {
    const workspaceId = "workspace-private-id";
    const result = generateSettingsDisableBlock(
      card({
        detector_id: "D10",
        evidence: {
          workspace_id: workspaceId,
          catalog_tokens: 72_000,
          catalog_target_tokens: 40_000,
          delta_context_tokens: 32_000,
          source_count: 12,
          tool_search_mode: "upfront",
          effective_catalog_state: "loaded",
          configured_value: null,
          always_load_count: 3,
          catalog_item_count: 48,
        },
        file_ref: "/private/workspace/.claude/settings.json",
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.text).toContain('"enableToolSearch": true');
    expect(result?.text).toContain("72,000 tokens, 32,000 over the 40,000 target");
    expect(result?.text).toContain("3 MCP server(s) currently set alwaysLoad:true");
    expect(result?.text).not.toContain(workspaceId);
    expect(result?.text).not.toContain("/private/workspace");
  });

  it("keeps the D10 alwaysLoad advisory when tool search is already deferred", () => {
    const result = generateSettingsDisableBlock(
      card({
        detector_id: "D10",
        evidence: {
          catalog_tokens: 72_000,
          catalog_target_tokens: 40_000,
          delta_context_tokens: 32_000,
          tool_search_mode: "deferred",
          configured_value: "true",
          always_load_count: 1,
        },
      }),
    );

    expect(result?.text).not.toContain("enableToolSearch");
    expect(result?.text).toContain("1 MCP server(s) currently set alwaysLoad:true");
  });

  it("returns null for non-D10 cards and missing D10 catalog evidence", () => {
    expect(
      generateSettingsDisableBlock(card({ detector_id: "D1", evidence: { catalog_tokens: 1 } })),
    ).toBe(null);
    expect(generateSettingsDisableBlock(card({ detector_id: "D10", evidence: {} }))).toBe(null);
  });

  it("generates a cap-caveated D4 model-default snippet without workspace identifiers", () => {
    const workspaceId = "workspace-private-id";
    const result = generateModelDefaultSnippet(
      card({
        detector_id: "D4",
        evidence: {
          workspace_id: workspaceId,
          total_opus_turns_per_week: 100,
          mismatch_turns_per_week: 30,
          mismatch_fraction: 0.3,
          avg_input_tokens: 42_000,
          avg_output_tokens: 400,
          reduction_fraction: 0.5,
          advisory: true,
          requires_usage_cap_data: true,
          advisory_note:
            "Routing savings are only real if the all-models/Opus/5h cap is binding — check /usage.",
          diagnostic_savings_u_per_wk_if_all_models_cap_binds: 1_234_567,
          modeled_savings_u_per_wk: null,
        },
        file_ref: "/private/workspace/.claude/settings.json",
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.text).toContain('"model": "sonnet"');
    expect(result?.text).toContain(
      "Routing savings are only real if the all-models/Opus/5h cap is binding",
    );
    expect(result?.text).toContain("30 of 100 Opus turns");
    expect(result?.text).toContain("~$1.23/wk");
    expect(result?.text).not.toContain(workspaceId);
    expect(result?.text).not.toContain("/private/workspace");
  });

  it("returns null for non-D4 cards and missing D4 total-turn evidence", () => {
    expect(
      generateModelDefaultSnippet(
        card({ detector_id: "D1", evidence: { total_opus_turns_per_week: 1 } }),
      ),
    ).toBe(null);
    expect(generateModelDefaultSnippet(card({ detector_id: "D4", evidence: {} }))).toBe(null);
  });
});

describe("generateAutocompactSnippet (RI8/R12)", () => {
  it("returns the override for D2 and D8, with the unverified-heuristic label", () => {
    for (const detector of ["D2", "D8"] as const) {
      const result = generateAutocompactSnippet(card({ detector_id: detector }));
      expect(result).not.toBeNull();
      expect(result?.text).toContain('"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "75"');
      expect(result?.caption).toContain("community-derived heuristic");
      expect(result?.caption).toContain("unverified");
      expect(result?.text).toContain("unverified by Anthropic");
    }
  });

  it("returns null for unrelated detectors", () => {
    expect(generateAutocompactSnippet(card({ detector_id: "D1" }))).toBe(null);
    expect(generateAutocompactSnippet(card({ detector_id: "D4" }))).toBe(null);
    expect(generateAutocompactSnippet(card({ detector_id: "D10" }))).toBe(null);
  });
});

describe("generateSubagentRoutingSnippet (RI8/R12)", () => {
  it("routes read-only subagents to Haiku on D4 cards", () => {
    const result = generateSubagentRoutingSnippet(card({ detector_id: "D4" }));
    expect(result).not.toBeNull();
    expect(result?.text.toLowerCase()).toContain("haiku");
    expect(result?.text).toContain("model: haiku");
    expect(result?.caption).toContain("read-only subagents");
  });

  it("returns null for non-D4 cards", () => {
    expect(generateSubagentRoutingSnippet(card({ detector_id: "D2" }))).toBe(null);
    expect(generateSubagentRoutingSnippet(card({ detector_id: "D8" }))).toBe(null);
  });
});

describe("generateTrailerWriterSnippet (RI10/R3)", () => {
  it("emits the Agent-Session-Id trailer key with opaque per-repo uuid logic", () => {
    const result = generateTrailerWriterSnippet();
    expect(result.language).toBe("sh");
    expect(result.text).toContain("Agent-Session-Id:");
    expect(result.text).toMatch(/uuidgen|random\/uuid/);
    expect(result.text).toContain("agentwrangler-session-id");
  });

  it("NEVER emits or derives from the claude.ai session URL", () => {
    const result = generateTrailerWriterSnippet();
    expect(result.text).not.toContain("claude.ai");
    expect(result.text).not.toContain("Claude-Session:");
    expect(result.caption).not.toContain("claude.ai");
  });

  it("caption carries install and removal steps", () => {
    const result = generateTrailerWriterSnippet();
    expect(result.caption).toContain(".git/hooks/prepare-commit-msg");
    expect(result.caption.toLowerCase()).toContain("install");
    expect(result.caption.toLowerCase()).toContain("uninstall");
  });
});

describe("buildD1 cache-invalidation backfire warning (RI8/R13)", () => {
  it("carries the boundary-edit warning in the CONSTRAINTS section", () => {
    const result = buildPromptArtifact(
      card({
        detector_id: "D1",
        evidence: { source_tokens: 12000, source_target: 4000, component: "CLAUDE.md" },
        file_ref: "/repo/CLAUDE.md",
      }),
    );
    assert(result !== null);
    const constraints = result.text.split("\n").find((l) => l.startsWith("CONSTRAINTS:"));
    assert(constraints !== undefined);
    expect(constraints).toContain("/clear");
    expect(constraints.toLowerCase()).toContain("backfire");
  });
});
