/**
 * Review 6 U1 (P1 only): R6-04, R6-06, R6-12, R6-13, R6-14, R6-16.
 * See docs/handoffs/2026-09-26-card-review/review-6-fix-plan.md §U1 and
 * review-6-persona-findings.md for the finding text these tests encode.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecCard, { DETECTOR_GROUP_LABELS } from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/recommendations/EffectEvidence", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

function baseRec(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "review6-u1-rec",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Review the affected sessions",
    modeled_savings_u_per_wk: 39_915_447,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "test", inputs: {} },
    estimate: { basis: "P", rank_value_u_per_wk: 39_915_447, summable: true, label: "test" },
    certification: "UNVERIFIED",
    confidence_tier: "UNVERIFIED",
    evidence: {},
    target_metric: "test",
    state: "PROPOSED",
    created_at: "2026-09-20T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 5,
    steps: [{ kind: "generic", description: "Review the sessions" }],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  } as RecommendationCard;
}

function showDetails(container: HTMLElement, getByRole: ReturnType<typeof render>["getByRole"]) {
  fireEvent.click(getByRole("button", { name: /show details/i }));
  return container.querySelector(".rec-details");
}

describe("R6-04: trust chips no longer contradict each other", () => {
  it("a basis-P rec shows 'Modeled', not 'Measured'", () => {
    const { container } = render(<RecCard rec={baseRec()} />);
    const impact = container.querySelector(".rec-impact-line");
    expect(impact?.textContent).toContain("Modeled");
    expect(impact?.textContent).not.toContain("Measured");
  });

  it("a rec with both certification and tier UNVERIFIED shows no /unverified/i chip", () => {
    const { container } = render(
      <RecCard rec={baseRec({ certification: "UNVERIFIED", confidence_tier: "UNVERIFIED" })} />,
    );
    const chipRow = container.querySelector(".rec-chip-row");
    if (chipRow === null) throw new Error("chip row missing");
    expect(chipRow.textContent).not.toMatch(/unverified|certified|verified/i);
  });

  it("a rec whose tier differs from certification shows neither label", () => {
    const { container } = render(
      <RecCard rec={baseRec({ certification: "UNVERIFIED", confidence_tier: "ESTIMATED" })} />,
    );
    const chipRow = container.querySelector(".rec-chip-row");
    expect(chipRow?.textContent).not.toMatch(/unverified|certified|verified|estimated/i);
  });
});

describe("R6-06: D2 details state the derived 44.7% and $4.77, not 'a default'", () => {
  it("shows 44.7% and $4.77 without 'a default' or 'not calibrated'", () => {
    const rec = baseRec({
      detector_id: "D2",
      evidence: {
        reduction_fraction: 0.4473,
        gross_savings_u_per_wk: 44_680_656,
        rebuild_u_per_wk: 4_765_209,
      },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);
    const details = showDetails(container, getByRole);
    expect(details?.textContent).toContain("44.7%");
    expect(details?.textContent).toContain("$4.77");
    expect(details?.textContent).not.toContain("a default");
    expect(details?.textContent).not.toContain("not calibrated");
  });
});

describe("R6-12: no 'No modeled savings' under a header that shows a $ range", () => {
  it("an expanded range-only card never renders 'No modeled savings'", () => {
    const rec = baseRec({
      detector_id: "D8",
      modeled_savings_u_per_wk: null,
      range_u_per_wk: [3_393_498, 7_198_330],
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);
    fireEvent.click(getByRole("button", { name: /show details/i }));
    expect(container.textContent).not.toContain("No modeled savings");
  });
});

describe("R6-13: D7 caveat no longer contradicts the number above it", () => {
  it("D7 loops: no 'no savings estimate is shown'", () => {
    const rec = baseRec({ detector_id: "D7", evidence: {} });
    const { container, getByRole } = render(<RecCard rec={rec} />);
    const details = showDetails(container, getByRole);
    expect(details?.textContent).not.toContain("no savings estimate is shown");
    expect(container.querySelector(".rec-modeled-note")?.textContent).toContain("50%");
  });

  it("D7 cross-session re-reads: no 'retry'", () => {
    const rec = baseRec({
      detector_id: "D7",
      evidence: { template_id: "D7_CROSS_SESSION_REREAD" },
    });
    const { container, getByRole } = render(<RecCard rec={rec} />);
    showDetails(container, getByRole);
    const caveat = container.querySelector(".rec-modeled-note");
    expect(caveat?.textContent).not.toMatch(/retry/i);
    expect(caveat?.textContent).toContain("Range only");
  });
});

describe("R6-14: session count fallback, no 'unavailable' next to real dates", () => {
  function windowed(from: string, to: string) {
    return { from, to };
  }

  it("D2 falls back to evidence.qualifying_session_count", () => {
    const rec = baseRec({
      detector_id: "D2",
      evidence: { qualifying_session_count: 8 },
      trigger: {
        session_ids: [],
        window: windowed("2026-09-20T00:00:00.000Z", "2026-09-28T00:00:00.000Z"),
        facts: [],
      },
    });
    const { container } = render(<RecCard rec={rec} />);
    const evidenceSection = within(container).getByLabelText("Evidence");
    expect(evidenceSection.textContent).toContain("8 sessions, Sep 20 – Sep 27");
  });

  it("D8 falls back to evidence.session_count", () => {
    const rec = baseRec({
      detector_id: "D8",
      evidence: { session_count: 8 },
      trigger: {
        session_ids: [],
        window: windowed("2026-09-20T00:00:00.000Z", "2026-09-28T00:00:00.000Z"),
        facts: [],
      },
    });
    const { container } = render(<RecCard rec={rec} />);
    const evidenceSection = within(container).getByLabelText("Evidence");
    expect(evidenceSection.textContent).toContain("8 sessions, Sep 20 – Sep 27");
  });

  it("a null count renders only the dates, never 'unavailable' next to them", () => {
    const rec = baseRec({
      detector_id: "A1",
      evidence: {},
      trigger: {
        session_ids: [],
        window: windowed("2026-09-20T00:00:00.000Z", "2026-09-28T00:00:00.000Z"),
        facts: [],
      },
    });
    const { container } = render(<RecCard rec={rec} />);
    const evidenceSection = within(container).getByLabelText("Evidence");
    expect(evidenceSection.textContent).toContain("Sep 20 – Sep 27");
    expect(evidenceSection.textContent).not.toContain("unavailable");
    expect(evidenceSection.textContent).not.toContain("8 sessions");
  });

  it("D11 labels its session count with the tool it used", () => {
    const rec = baseRec({
      detector_id: "D11",
      category: "TOOLING",
      evidence: { session_count: 50, higher_error_tool: "PowerShell" },
      trigger: {
        session_ids: [],
        window: windowed("2026-09-20T00:00:00.000Z", "2026-09-28T00:00:00.000Z"),
        facts: [],
      },
    });
    const { container } = render(<RecCard rec={rec} />);
    const evidenceSection = within(container).getByLabelText("Evidence");
    expect(evidenceSection.textContent).toContain("50 sessions used PowerShell");
  });
});

describe("R6-16: correct group chips, and no bare detector id in history rows", () => {
  it("mirrors the server's DETECTOR_GROUP_LABELS exactly", () => {
    // Kept in sync by hand with src/query/api/recommendations.ts's DETECTOR_GROUP_LABELS
    // (that file is out of this unit's blast radius; see R6-16).
    const serverLabels: Record<string, string> = {
      A1: "Large tool results",
      A2: "Large task outputs",
      B1: "Cache read drops",
      B2: "Cache timeouts",
      B3: "Resume cache misses",
      B4: "Cache prefix breaks",
      C1: "Failed tool calls",
      C2: "Content not found",
      C3: "Edits before reads",
      C4: "Failed edits",
      C5: "Repeated errors",
      C6: "Edit flip-flops",
      C7: "Shell failure clusters",
      C9: "Guard blocks",
      C11: "Output cap errors",
      D1: "CLAUDE.md / memory",
      D2: "Long sessions",
      D4: "Model choice",
      D5: "Limit warning",
      D6: "Large tool results",
      D7: "Repeated attempts and reads",
      D8: "Cache misses",
      D9: "Background sessions",
      D10: "Tool catalog",
      D11: "Shell errors",
      D12: "Subagent overuse",
      D14: "Interrupted turns",
      E1: "Long orientation",
      E2: "Main-model routine runs",
      G11: "Costly failures",
      H1: "Destructive commands",
    };
    expect(DETECTOR_GROUP_LABELS).toEqual(serverLabels);
  });

  it("C9 shows 'Guard blocks' and D11 shows 'Shell errors'", () => {
    const c9 = render(
      <RecCard rec={baseRec({ rec_id: "c9", detector_id: "C9", category: "TOOLING" })} />,
    );
    expect(c9.container.querySelector(".rec-category-chip")?.textContent).toBe("Guard blocks");
    c9.unmount();

    const d11 = render(
      <RecCard rec={baseRec({ rec_id: "d11", detector_id: "D11", category: "TOOLING" })} />,
    );
    expect(d11.container.querySelector(".rec-category-chip")?.textContent).toBe("Shell errors");
  });

  it("groups history rows by human label, never a bare detector id", async () => {
    const response = mockRecommendations();
    if (!response.data) throw new Error("Expected recommendations view");
    response.data.active = [];
    response.data.active_groups = [];
    response.data.adopted = [];
    response.data.dismissed = [];
    response.data.limit_warnings = [];
    (response.data as typeof response.data & { history: RecommendationCard[] }).history = [
      baseRec({ rec_id: "c9-hist", detector_id: "C9", category: "TOOLING", state: "RETIRED" }),
      baseRec({ rec_id: "d11-hist", detector_id: "D11", category: "TOOLING", state: "RETIRED" }),
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Recommendation history"]')).not.toBeNull(),
    );
    const section = container.querySelector('[aria-label="Recommendation history"]') as HTMLElement;
    const summaries = [
      ...section.querySelectorAll<HTMLElement>("details.recs-history-group > summary"),
    ].map((s) => s.textContent ?? "");
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      // Bare-id label would be "C9 · 1 card · newest …" (3 segments); a human label adds a 4th.
      expect(summary.split(" · ").length).toBeGreaterThanOrEqual(4);
      expect(summary).not.toMatch(/^[A-Z]\d+ · \d+ cards? · newest/);
    }
    expect(summaries.some((s) => s.includes("C9 · Guard blocks"))).toBe(true);
    expect(summaries.some((s) => s.includes("D11 · Shell errors"))).toBe(true);
  });
});
