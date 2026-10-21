// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import {
  generateCacheBehaviorSnippet,
  generateDestructiveGuardSnippet,
  generateFrictionRuleSnippet,
} from "../../src/ui/recommendations/prompt-templates";

/** Minimal V2-shaped friction card: closed metrics + hashed anchors only. */
function makeFrictionRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "friction-rec",
    detector_id: "C3",
    category: "TOOLING",
    scope_workspace_id: "ws-1",
    lever: "Read a file's current contents before issuing an Edit to it.",
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "V2_C3_EDIT_BEFORE_READ", inputs: {} },
    evidence: {
      rule_id: "C3_EDIT_BEFORE_READ",
      label: "EDIT_BEFORE_READ",
      window: { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
      metrics: { ERROR_COUNT: { kind: "COUNT", value: 4 } },
    },
    target_metric: "edit_before_read_count",
    state: "PROPOSED",
    created_at: "2026-09-21T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

describe("generateFrictionRuleSnippet (C3 reference)", () => {
  it("renders a paste-able rule with R3 action, R5 rollback, and R6 before/after", () => {
    const snippet = generateFrictionRuleSnippet(makeFrictionRec());
    expect(snippet).not.toBeNull();
    if (snippet === null) return;
    // R4: the actual rule text is present.
    expect(snippet.text).toContain("Read a file's current contents");
    expect(snippet.language).toBe("md");
    // R3 concrete action + R6 measured before + after target + R5 rollback, all in the caption.
    expect(snippet.caption).toContain("Read a file's current contents before issuing an Edit");
    expect(snippet.caption).toContain("Measured: 4 occurrence(s)");
    expect(snippet.caption).toContain("Target after adoption");
    expect(snippet.caption).toContain("Rollback:");
    // Scope-correct target file (workspace vs global).
    expect(snippet.caption).toContain("CLAUDE.md");
  });

  it("targets ~/.claude for a global (null-scope) rec", () => {
    const snippet = generateFrictionRuleSnippet(makeFrictionRec({ scope_workspace_id: null }));
    expect(snippet?.text).toContain("~/.claude/CLAUDE.md");
  });

  it("returns null when the closed count metric is absent", () => {
    expect(generateFrictionRuleSnippet(makeFrictionRec({ evidence: {} }))).toBeNull();
  });

  it("returns null for a non-friction detector", () => {
    expect(generateFrictionRuleSnippet(makeFrictionRec({ detector_id: "D2" }))).toBeNull();
  });

  it.each([
    ["C2", "ERROR_COUNT", "Glob or Grep"],
    ["C4", "RECOVERY_LOOP_COUNT", "re-read the file"],
    ["C5", "ERROR_LOOP_COUNT", "3 identical tool errors"],
    ["C7", "BASH_FAILURE_COUNT", "permissions.allow"],
    ["C11", "ERROR_COUNT", "narrow oversized MCP calls"],
  ])("renders a §6-complete artifact for %s", (detectorId, metricCode, actionFragment) => {
    const snippet = generateFrictionRuleSnippet(
      makeFrictionRec({
        detector_id: detectorId,
        evidence: { metrics: { [metricCode]: { kind: "COUNT", value: 3 } } },
      }),
    );
    expect(snippet).not.toBeNull();
    if (snippet === null) return;
    expect(snippet.caption.toLowerCase()).toContain(actionFragment.toLowerCase());
    expect(snippet.caption).toContain("Measured: 3 occurrence(s)");
    expect(snippet.caption).toContain("Target after adoption");
    expect(snippet.caption).toContain("Rollback:");
    expect(snippet.text.length).toBeGreaterThan(0);
  });

  it("SEC-101: emits no raw content — only closed action text, counts, and rule lines", () => {
    // Even if a stray raw-content field is present in evidence, the generator must not
    // surface it: it reads only the closed count metric + window.
    const snippet = generateFrictionRuleSnippet(
      makeFrictionRec({
        evidence: {
          metrics: { ERROR_COUNT: { kind: "COUNT", value: 2 } },
          // hostile extras the generator must ignore:
          raw_command: "rm -rf /Users/secret/path",
          transcript: "the user said something private",
        } as unknown as RecommendationCard["evidence"],
      }),
    );
    expect(snippet).not.toBeNull();
    if (snippet === null) return;
    const blob = `${snippet.caption}\n${snippet.text}`;
    expect(blob).not.toContain("rm -rf");
    expect(blob).not.toContain("/Users/secret/path");
    expect(blob).not.toContain("something private");
  });
});

describe("generateDestructiveGuardSnippet (H1)", () => {
  function makeH1Rec(opClass: string, count = 2): RecommendationCard {
    return makeFrictionRec({
      detector_id: "H1",
      scope_workspace_id: "ws-1",
      evidence: {
        metrics: {
          DESTRUCTIVE_OPERATION: { kind: "ENUM", value: opClass },
          OPERATION_COUNT: { kind: "COUNT", value: count },
        },
      },
    });
  }

  it("emits an installable permissions.ask diff for a Bash destructive class", () => {
    const snippet = generateDestructiveGuardSnippet(makeH1Rec("RM_RF"));
    expect(snippet).not.toBeNull();
    if (snippet === null) return;
    expect(snippet.language).toBe("jsonc");
    expect(snippet.text).toContain('"ask"');
    expect(snippet.text).toContain("Bash(rm -rf:*)");
    expect(snippet.caption).toContain("Observed: 2 occurrence(s)");
    expect(snippet.caption).toContain("Rollback:");
  });

  it("emits a CLAUDE.md confirmation rule for SQL classes not routed through Bash", () => {
    const snippet = generateDestructiveGuardSnippet(makeH1Rec("SQL_DROP"));
    expect(snippet?.language).toBe("md");
    expect(snippet?.text).toContain("SQL DROP");
    expect(snippet?.caption).toContain("Rollback:");
  });

  it("returns null for non-H1 or when the closed enum/count is absent", () => {
    expect(generateDestructiveGuardSnippet(makeFrictionRec({ detector_id: "C3" }))).toBeNull();
    expect(
      generateDestructiveGuardSnippet(makeFrictionRec({ detector_id: "H1", evidence: {} })),
    ).toBeNull();
  });
});

describe("generateCacheBehaviorSnippet (B1/B2/B4)", () => {
  const B_METRICS: Record<string, Record<string, number>> = {
    B1: { PREVIOUS_CACHE_READ_TOKENS: 40_000, CURRENT_CACHE_READ_TOKENS: 50 },
    B2: { GAP_DURATION_MS: 7_500_000, CONSERVATIVE_TTL_DURATION_MS: 3_600_000 },
    B4: { PREVIOUS_CACHE_CREATION_TOKENS: 4_000, CURRENT_CACHE_CREATION_TOKENS: 22_000 },
  };

  function makeCacheRec(detectorId: string): RecommendationCard {
    const metrics: Record<string, { kind: string; value: number }> = {};
    for (const [code, value] of Object.entries(B_METRICS[detectorId] ?? {})) {
      metrics[code] = { kind: "TOKENS", value };
    }
    return makeFrictionRec({ detector_id: detectorId, category: "CACHE", evidence: { metrics } });
  }

  it.each([
    ["B1", "40,000", "start a fresh session"],
    ["B2", "2.1h", "start fresh"],
    ["B4", "22,000", "before the session"],
  ])("renders a §6 behavioral artifact for %s", (detectorId, measuredFragment, actionFragment) => {
    const snippet = generateCacheBehaviorSnippet(makeCacheRec(detectorId));
    expect(snippet).not.toBeNull();
    if (snippet === null) return;
    expect(snippet.caption).toContain(measuredFragment);
    expect(snippet.caption.toLowerCase()).toContain(actionFragment.toLowerCase());
    expect(snippet.caption).toContain("Target after adoption");
    expect(snippet.caption).toContain("Rollback:");
    expect(snippet.text).toContain("ACCEPTANCE:");
  });

  it("returns null for a non-cache detector or missing metrics", () => {
    expect(generateCacheBehaviorSnippet(makeFrictionRec({ detector_id: "C3" }))).toBeNull();
    expect(
      generateCacheBehaviorSnippet(makeFrictionRec({ detector_id: "B1", evidence: {} })),
    ).toBeNull();
  });
});
