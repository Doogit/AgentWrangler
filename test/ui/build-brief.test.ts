import { describe, expect, it } from "vitest";

import type { GlobalOverview } from "../../src/query/api/overview";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import type { CacheWriteTrend } from "../../src/query/api/trends";
import type { HotSessionRow } from "../../src/query/spend";
import { briefToMarkdown, buildBrief } from "../../src/ui/briefs/buildBrief";

function recommendation(overrides: Partial<RecommendationCard>): RecommendationCard {
  return {
    rec_id: "rec-default",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Reduce always-loaded context",
    modeled_savings_u_per_wk: 1_000_000,
    run_cost_u: null,
    modeled_formula: { model: "test", inputs: {} },
    evidence: {},
    target_metric: "context_tokens",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

const overview: GlobalOverview = {
  cost_equiv_u: 8_500_000,
  turns: 20,
  turns_total: 22,
  unpriced_turns: 0,
  live_sessions: 0,
  forecast: {
    state: "OK",
    limit_tokens: 100_000,
    tokens_used: 20_000,
    tokens_per_day: 2_000,
    projected_exhaustion_jd: 2_460_000,
    warn_threshold_days: 2,
  },
  context_per_turn: [
    {
      model: "claude-opus",
      n: 12,
      avg_context_per_turn: 40_000,
      avg_output_per_turn: 900,
      usd_per_turn: 0.5,
    },
  ],
  model_mix: [{ model: "claude-opus", turns: 12 }],
};

const hotSessions: HotSessionRow[] = [
  {
    session_id: "session-a1",
    workspace_id: "ws-a",
    turns: 8,
    cost_equiv_u: 3_000_000,
    total_output_tokens: 8_000,
    avg_output_tokens: 1_000,
    total_context_tokens: 320_000,
    avg_context_tokens: 40_000,
    model: "claude-opus",
    last_turn_at: "2026-09-01T00:00:00.000Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
    gap_median_s: null,
    gap_p90_s: null,
    long_gap_count: 0,
    gap_n: 0,
  },
  {
    session_id: "session-a2",
    workspace_id: "ws-a",
    turns: 6,
    cost_equiv_u: 2_000_000,
    total_output_tokens: 4_800,
    avg_output_tokens: 800,
    total_context_tokens: 180_000,
    avg_context_tokens: 30_000,
    model: "claude-sonnet",
    last_turn_at: "2026-09-01T00:00:00.000Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
    gap_median_s: null,
    gap_p90_s: null,
    long_gap_count: 0,
    gap_n: 0,
  },
  {
    session_id: "session-b1",
    workspace_id: "ws-b",
    turns: 5,
    cost_equiv_u: 1_000_000,
    total_output_tokens: 3_500,
    avg_output_tokens: 700,
    total_context_tokens: 100_000,
    avg_context_tokens: 20_000,
    model: "claude-haiku",
    last_turn_at: "2026-09-01T00:00:00.000Z",
    api_error_count: 0,
    compaction_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
    gap_median_s: null,
    gap_p90_s: null,
    long_gap_count: 0,
    gap_n: 0,
  },
];

const cacheTrend: CacheWriteTrend = {
  buckets: [
    {
      bucket: "2026-08-31",
      cache_creation_tokens: 1_000,
      cache_read_tokens: 4_000,
      efficiency_ratio: 0.8,
      turns: 8,
    },
    {
      bucket: "2026-09-01",
      cache_creation_tokens: 2_000,
      cache_read_tokens: 6_000,
      efficiency_ratio: 0.75,
      turns: 12,
    },
  ],
  spike_buckets: ["2026-09-01"],
};

function assertParity(text: string): void {
  // Exempt structural label lines (headers carry no number by design); data lines
  // must still carry a digit or bullet. RV4 templates add the uppercase
  // TASK/MEASURED CONTEXT/CONSTRAINTS/ACCEPTANCE section headers.
  const exempt =
    /^(Prompt artifact|Work-through|Title|Lever|Component|File|Measured |Evidence |Formula input |Acceptance|Caveat|Attributed tool|TASK|MEASURED CONTEXT|CONSTRAINTS|ACCEPTANCE):/;
  for (const line of text.split("\n").filter(Boolean)) {
    // `<details>` / `</details>` wrap the collapsed attribution block — structural, no data.
    if (line.startsWith("#") || line.startsWith("<") || exempt.test(line)) continue;
    expect(line).toMatch(/\d|^- /);
  }
}

describe("buildBrief", () => {
  it("builds a global attribution brief with deterministic turnkey-first levers", () => {
    const turnkey = recommendation({
      rec_id: "rec-d1",
      detector_id: "D1",
      modeled_savings_u_per_wk: 2_500_000,
      evidence: { source_tokens: 12_000, source_target: 4_000, delta_context_tokens: 8_000 },
    });
    const guided = recommendation({
      rec_id: "rec-d2",
      detector_id: "D2",
      modeled_savings_u_per_wk: 4_000_000,
      evidence: {
        qualifying_session_count: 3,
        raw_context_average_tokens_per_turn: 32_000,
        cap_weighted_burn_tokens_per_week: 96_000,
        cache_read_tokens_per_week: 36_000,
        cache_read_exposure_spend_u_per_week: 4_800,
      },
    });
    const brief = buildBrief({
      scopeLabel: "Global",
      scopeWorkspaceId: null,
      overview,
      hotSessions,
      cacheTrend,
      recs: [guided, turnkey],
    });
    const markdown = briefToMarkdown(brief);

    expect(brief.attribution.hot_sessions).toHaveLength(3);
    // usd_per_turn arrives already in USD — the brief must pass it through, not re-divide by 1e6.
    expect(brief.attribution.context_per_turn[0]?.usd_per_turn).toBeCloseTo(0.5);
    expect(brief.actions.map((action) => action.id)).toEqual(["rec-d1", "rec-d2"]);
    expect(markdown.match(/\d[\d,.]*/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(markdown).toContain(brief.actions[0]?.prompt ?? "");
    expect(markdown).toContain(brief.actions[1]?.prompt ?? "");
    assertParity(markdown);
  });

  it("caps actions at three (Accept: ≤3 action rows)", () => {
    const recs = [1, 2, 3, 4, 5].map((n) =>
      recommendation({
        rec_id: `rec-${n}`,
        detector_id: `D${n}`,
        modeled_savings_u_per_wk: n * 1_000_000,
      }),
    );
    const brief = buildBrief({
      scopeLabel: "Global",
      scopeWorkspaceId: null,
      overview,
      hotSessions,
      cacheTrend,
      recs,
    });
    expect(brief.actions).toHaveLength(3);
    expect(new Set(brief.actions.map((a) => a.id)).size).toBe(3);
  });

  it("computes deltas against a seeded prior window and a coherent verdict", () => {
    const priorOverview: GlobalOverview = {
      ...overview,
      cost_equiv_u: 5_000_000,
      turns: 10,
      turns_total: 11,
    };
    const priorCacheTrend: CacheWriteTrend = {
      buckets: [
        {
          bucket: "2026-08-24",
          cache_creation_tokens: 5_000,
          cache_read_tokens: 5_000,
          efficiency_ratio: 0.5,
          turns: 6,
        },
      ],
      spike_buckets: [],
    };
    const priorHotSessions: HotSessionRow[] = [hotSessions[0] as HotSessionRow];

    const brief = buildBrief({
      scopeLabel: "Global",
      scopeWorkspaceId: null,
      overview,
      hotSessions,
      cacheTrend,
      recs: [],
      prior: {
        overview: priorOverview,
        cacheTrend: priorCacheTrend,
        hotSessions: priorHotSessions,
      },
    });

    // Spend: $8.5 now vs $5.0 prior → +3.5.
    expect(brief.deltas.spend_usd.current).toBeCloseTo(8.5);
    expect(brief.deltas.spend_usd.prior).toBeCloseTo(5.0);
    expect(brief.deltas.spend_usd.delta).toBeCloseTo(3.5);
    // Cache-write share: current 3000/13000, prior 5000/10000 = 0.5.
    expect(brief.deltas.cache_write_share.current).toBeCloseTo(3_000 / 13_000);
    expect(brief.deltas.cache_write_share.prior).toBeCloseTo(0.5);
    // Hot sessions: 3 now vs 1 prior → +2. Verdict count matches the current tile.
    expect(brief.deltas.hot_session_count.current).toBe(3);
    expect(brief.deltas.hot_session_count.delta).toBe(2);
    expect(brief.verdict.hot_session_count).toBe(3);
    expect(brief.verdict.cost_usd).toBeCloseTo(8.5);
    // No friction inputs in the seed → LOW.
    expect(brief.verdict.peak_friction).toBe("LOW");
  });

  it("surfaces the worst per-session friction band as peak friction", () => {
    const noisy: HotSessionRow = {
      ...(hotSessions[0] as HotSessionRow),
      session_id: "session-noisy",
      api_error_count: 5,
    };
    const brief = buildBrief({
      scopeLabel: "Global",
      scopeWorkspaceId: null,
      overview,
      hotSessions: [noisy, ...hotSessions],
      cacheTrend,
      recs: [],
    });
    expect(brief.verdict.peak_friction).toBe("HIGH");
  });

  it("renders '—' deltas when the prior window is empty", () => {
    const brief = buildBrief({
      scopeLabel: "Global",
      scopeWorkspaceId: null,
      overview,
      hotSessions,
      cacheTrend,
      recs: [],
      prior: {
        overview: { ...overview, cost_equiv_u: 0, turns: 0, turns_total: 0 },
        cacheTrend: { buckets: [], spike_buckets: [] },
        hotSessions: [],
      },
    });
    expect(brief.deltas.spend_usd.prior).toBeNull();
    expect(brief.deltas.spend_usd.delta).toBeNull();
    expect(brief.deltas.hot_session_count.delta).toBeNull();
    expect(briefToMarkdown(brief)).toContain("prior —, delta —");
  });

  it("filters hot-session attribution to the selected workspace", () => {
    const brief = buildBrief({
      scopeLabel: "Workspace A",
      scopeWorkspaceId: "ws-a",
      overview,
      hotSessions,
      cacheTrend,
      recs: [],
    });

    expect(brief.attribution.hot_sessions.map((session) => session.session_id)).toEqual([
      "session-a1",
      "session-a2",
    ]);
    expect(brief.attribution.hot_sessions).not.toContainEqual(
      expect.objectContaining({ session_id: "session-b1" }),
    );
  });

  it("renders valid empty-data markdown without absent-value literals", () => {
    const brief = buildBrief({
      scopeLabel: "Empty",
      scopeWorkspaceId: null,
      overview: {
        ...overview,
        cost_equiv_u: 0,
        turns: 0,
        turns_total: 0,
        context_per_turn: [],
        model_mix: [],
      },
      hotSessions: [],
      cacheTrend: { buckets: [], spike_buckets: [] },
      recs: [],
    });
    const markdown = briefToMarkdown(brief);

    expect(markdown).toContain("# Brief: Empty");
    expect(markdown).not.toMatch(/null|NaN|undefined/);
    assertParity(markdown);
  });
});
