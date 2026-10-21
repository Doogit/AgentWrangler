/**
 * test/ui/recs-ranked-list.test.tsx — UIP-7 regression: grouped ranked list.
 *
 * Verifies that each detector family renders as its own visible section (not
 * collapsed under a single "More suggestions" disclosure), and that a family
 * with >3 recs gets a per-group "Show N more" disclosure.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

describe("UIP-7 — grouped ranked list", () => {
  it("renders each group as a visible section, not a single collapsed queue", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");

    // Build 5 D2 recs + 2 D1 recs: D2 group will have 4 remaining after selectedRec
    // promotion, so 3 visible + "Show 1 more". D1 group shows all 2.
    function makeRec(overrides: Partial<RecommendationCard>): RecommendationCard {
      // base is a complete fixture card; overrides only sets defined values.
      return { ...base, ...overrides } as RecommendationCard;
    }

    const d2a = makeRec({ rec_id: "rec-D2-uip7-a", detector_id: "D2" });
    const d2b = makeRec({ rec_id: "rec-D2-uip7-b", detector_id: "D2" });
    const d2c = makeRec({ rec_id: "rec-D2-uip7-c", detector_id: "D2" });
    const d2d = makeRec({ rec_id: "rec-D2-uip7-d", detector_id: "D2" });
    const d2e = makeRec({ rec_id: "rec-D2-uip7-e", detector_id: "D2" });
    const d1a = makeRec({ rec_id: "rec-D1-uip7-a", detector_id: "D1" });
    const d1b = makeRec({ rec_id: "rec-D1-uip7-b", detector_id: "D1" });

    const allActive = [d2a, d2b, d2c, d2d, d2e, d1a, d1b];
    response.data.active = allActive;
    response.data.active_groups = [
      {
        detector_id: "D2",
        label: "Session hygiene",
        recs: [d2a, d2b, d2c, d2d, d2e],
        session_count: 3,
        total_savings_u_per_wk: 0,
      },
      {
        detector_id: "D1",
        label: "CLAUDE.md / memory",
        recs: [d1a, d1b],
        session_count: 2,
        total_savings_u_per_wk: 0,
      },
    ];
    response.data.limit_warnings = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);

    await waitFor(() => {
      expect(container.querySelector(".card.rec-card")).not.toBeNull();
    });

    // (a) More than one RecCard is visible at rest (not all hidden in a single details).
    const recCards = container.querySelectorAll(".card.rec-card");
    expect(recCards.length).toBeGreaterThan(1);

    // (b) Group headers render with a count label (not a dollar amount).
    const groupHeads = container.querySelectorAll(".recs-group-head");
    expect(groupHeads.length).toBe(2);
    // D2 remaining group has 4 recs after selectedRec promotion.
    expect(groupHeads[0]?.textContent).toContain("4");
    // D1 group has 2 recs.
    expect(groupHeads[1]?.textContent).toContain("2");

    // (c) A "Show N more" control appears for the D2 group (4 recs: 3 shown + 1 behind toggle).
    const moreSummaries = container.querySelectorAll(".recs-group-more > summary");
    expect(moreSummaries.length).toBe(1);
    expect(moreSummaries[0]?.textContent).toContain("Show 1 more");

    // (d) The old single-queue disclosure is gone.
    expect(container.querySelector(".recs-remaining-queue")).toBeNull();

    // (e) No group header contains a dollar value (INT-5 / D-B constraint).
    for (const head of groupHeads) {
      expect(head.textContent ?? "").not.toContain("$");
    }
  });
});
