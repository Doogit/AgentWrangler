import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard, RecommendationsView } from "../../src/query/api/recommendations";
import type { ApiResponse } from "../../src/query/envelope";
import * as client from "../../src/ui/api/client";
import { mockEfficiencyHeadroom, mockLedger, mockPractices } from "../../src/ui/api/fixtures";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

function recommendation(
  detector_id: string,
  category: string,
  modeled_savings_u_per_wk: number,
): RecommendationCard {
  return {
    rec_id: `rec-${detector_id}`,
    detector_id,
    category,
    scope_workspace_id: null,
    lever: "Take the recommended action.",
    modeled_savings_u_per_wk,
    run_cost_u: null,
    modeled_formula: {
      model: "test",
      inputs: {},
      kind: detector_id === "D4" ? "ADVISORY" : "MODELED",
    },
    evidence: {},
    target_metric: "test_metric",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [{ kind: "generic", description: "Take the recommended action." }],
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
  };
}

function responseWithActiveRecommendations(): ApiResponse<RecommendationsView> {
  const active = [
    recommendation("D2", "CONTEXT", 20_000_000),
    recommendation("D8", "CACHE", 5_000_000),
    recommendation("D4", "MODEL", 999_000_000),
  ];
  return {
    data: {
      active,
      active_groups: [],
      limit_warnings: [],
      adopted: [],
      dismissed: [],
      detectors: [
        { detector_id: "D2", name: "SESSION_LONG_FULL_CONTEXT", status: "ACTIVE", note: "active" },
        { detector_id: "D8", name: "CACHE_WRITE_CHURN", status: "ACTIVE", note: "active" },
        { detector_id: "D4", name: "MODEL_MISMATCH", status: "BLOCKED", note: "blocked" },
      ],
    },
    meta: {
      n: active.length,
      window: { from: "2026-08-25T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}

describe("RecommendationsPage below-the-line summary", () => {
  it("shows the summary header with active count, biggest lever, trio, and the non-additive note", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(responseWithActiveRecommendations());
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector(".recs-summary-header")).not.toBeNull();
    });

    const header = container.querySelector(".recs-summary-header");
    // Big count — total active
    expect(header?.textContent).toContain("3 active recommendations");
    // Biggest lever line
    expect(header?.textContent).toContain("Biggest lever this week:");
    // Non-additive honesty note
    expect(header?.textContent).toContain("Modeled savings are not additive.");
    // Trio counts present
    expect(header?.querySelector(".recs-summary-trio")).not.toBeNull();
    // No dollar figure in the header (INT-5)
    expect(header?.textContent).not.toContain("$");
  });

  it("places the detector strip in collapsed coverage details with accurate counts", async () => {
    vi.mocked(client.fetchRecommendations).mockResolvedValue(responseWithActiveRecommendations());
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector("details.detector-status-details")).not.toBeNull();
    });

    const details = container.querySelector<HTMLDetailsElement>("details.detector-status-details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector(".detstatus-list")).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain(
      "Detector coverage (2 active / 3 total)",
    );
  });

  it("renders no active-summary header when there are no active recommendations", async () => {
    const response = responseWithActiveRecommendations();
    if (response.data === null) throw new Error("expected recommendations data");
    response.data.active = [];
    response.data.active_groups = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.textContent).toContain("No active recommendations");
    });
    expect(container.querySelector(".recs-summary-header")).toBeNull();
  });
});
