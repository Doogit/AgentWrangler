import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import { buildSeededPrompt } from "../../src/query/api/rec-prompt";
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
    rec_id: "rec-prompt-test",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: null,
    evidence: {},
    modeled_formula: { inputs: {}, model: "test" },
    modeled_savings_u_per_wk: null,
    file_ref: null,
    lever: "test lever",
    ...overrides,
  } as unknown as RecommendationCard;
}

describe("buildPromptArtifact", () => {
  it("uses the exact server bytes and preserves only allow-listed aggregates", () => {
    const rec = card({
      detector_id: "D2",
      scope_workspace_id: "workspace-private-id",
      lever: "powershell -NoProfile -Command Get-Secret",
      file_ref: "C:\\Users\\private-user\\sensitive-repo\\CLAUDE.md",
      steps: [{ kind: "generic", description: "Permission denied: customer-token.txt" }],
      evidence: {
        qualifying_session_count: 12,
        raw_context_average_tokens_per_turn: 24_000,
        cap_weighted_burn_tokens_per_week: 96_000,
        cache_read_tokens_per_week: 36_000,
        cache_read_exposure_spend_u_per_week: 4_800,
        transcript: "user: paste the production credential here",
      },
    });
    const result = buildPromptArtifact(rec);
    assert(result !== null);

    expect(result.text).toBe(buildSeededPrompt(rec));
    expect(result.flavor).toBe("GUIDED");
    expect(result.text).toContain("Average context: 24,000 tokens/turn; denominator 12 sessions");
    expect(result.text).toContain("Cache-read exposure: 4,800 microUSD/week");
    for (const unsafe of [
      "powershell -NoProfile -Command Get-Secret",
      "Permission denied: customer-token.txt",
      "user: paste the production credential here",
      "C:\\Users\\private-user\\sensitive-repo\\CLAUDE.md",
      "workspace-private-id",
    ]) {
      expect(result.text).not.toContain(unsafe);
    }
  });

  it("returns a guided product message and structured reason for unsupported detectors", () => {
    const result = buildPromptArtifact(card({ detector_id: "DZZ" }));
    assert(result !== null);

    expect(result.flavor).toBe("GUIDED");
    expect(result.text).toContain(
      "No validated automatic handler is available; use the bounded read-only investigation below.",
    );
    expect(result.text).toContain("Reason code: HANDLER_UNAVAILABLE.");
    expect(result.text).toContain("[AUTOMATIC_HANDLER]");
  });

  it("distinguishes global and workspace scope without exposing concrete paths", () => {
    const workspace = buildPromptArtifact(
      card({ scope_workspace_id: "ws-private", file_ref: "/private/repo/CLAUDE.md" }),
    );
    const global = buildPromptArtifact(card({ scope_workspace_id: null }));
    assert(workspace !== null);
    assert(global !== null);

    expect(workspace.text).toContain(
      "SCOPE: WORKSPACE; concrete identifiers and paths are intentionally withheld.",
    );
    expect(global.text).toContain(
      "SCOPE: GLOBAL; concrete identifiers and paths are intentionally withheld.",
    );
    expect(workspace.text).not.toContain("ws-private");
    expect(workspace.text).not.toContain("/private/repo");
    expect(workspace.text).not.toBe(global.text);
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

  it("labels a U7 D10 row's catalog_target_tokens as the 5% context share, not a target", () => {
    const result = generateSettingsDisableBlock(
      card({
        detector_id: "D10",
        evidence: {
          catalog_tokens: 18_400,
          catalog_target_tokens: 3_100,
          delta_context_tokens: 6_200,
          removable_tokens: 6_200,
          tool_search_mode: "deferred",
        },
      }),
    );

    expect(result?.text).toContain(
      "18,400 tokens, 6,200 in items with no recorded use this week (5% of mean context per turn: 3,100)",
    );
    expect(result?.text).not.toContain("target");
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
      expect(result?.caption).toContain("community suggestion");
      expect(result?.caption).toContain("not verified by Anthropic");
      expect(result?.text).toContain("not verified by Anthropic");
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
