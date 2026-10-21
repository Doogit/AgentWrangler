/**
 * Review 6 U4 (R6-18 only): fold every card after #1. The top card (selectedRec) and any
 * focusRecId card stay open; folded cards keep their title, $, and primary button.
 * See docs/handoffs/2026-09-26-card-review/review-6-fix-plan.md §U4 and
 * review-6-persona-findings.md R6-18 / "Layout proposal".
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
import { makeEffectCycle } from "./effect-cycle-fixture";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

describe("R6-18: cards after #1 start folded; the top and focused card stay open", () => {
  it("3 active recs in one group: card 1 open, cards 2-3 folded with a visible primary button", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    function makeRec(overrides: Partial<RecommendationCard>): RecommendationCard {
      return { ...base, ...overrides } as RecommendationCard;
    }
    const recA = makeRec({ rec_id: "u4-a" });
    const recB = makeRec({ rec_id: "u4-b" });
    const recC = makeRec({ rec_id: "u4-c" });
    response.data.active = [recA, recB, recC];
    response.data.active_groups = [
      {
        detector_id: base.detector_id,
        label: "CLAUDE.md / memory",
        recs: [recA, recB, recC],
        session_count: 3,
        total_savings_u_per_wk: 0,
      },
    ];
    response.data.limit_warnings = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelectorAll(".rec-card")).toHaveLength(3));

    const cards = [...container.querySelectorAll(".rec-card")];
    const [card1, card2, card3] = cards;
    expect(card1?.classList.contains("rec-folded")).toBe(false);
    for (const card of [card2, card3]) {
      expect(card?.classList.contains("rec-folded")).toBe(true);
      expect(card?.querySelector(".rec-card-head-actions .btn-primary")).not.toBeNull();
    }
  });

  it("the focusRecId card opens: focusing card 2 promotes it to the open top slot, folding the rest", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    function makeRec(overrides: Partial<RecommendationCard>): RecommendationCard {
      return { ...base, ...overrides } as RecommendationCard;
    }
    const recA = makeRec({ rec_id: "u4-a" });
    const recB = makeRec({ rec_id: "u4-b" });
    const recC = makeRec({ rec_id: "u4-c" });
    response.data.active = [recA, recB, recC];
    response.data.active_groups = [
      {
        detector_id: base.detector_id,
        label: "CLAUDE.md / memory",
        recs: [recA, recB, recC],
        session_count: 3,
        total_savings_u_per_wk: 0,
      },
    ];
    response.data.limit_warnings = [];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    window.location.hash = "#/recommendations?focus=u4-b";
    const { container } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelectorAll(".rec-card")).toHaveLength(3));

    const focusedCard = container.querySelector(".rec-focus-highlight");
    expect(focusedCard).not.toBeNull();
    expect(focusedCard?.classList.contains("rec-folded")).toBe(false);
    const folded = [...container.querySelectorAll(".rec-card")].filter(
      (card) => card !== focusedCard,
    );
    expect(folded).toHaveLength(2);
    for (const card of folded) expect(card.classList.contains("rec-folded")).toBe(true);
  });

  it("adopted (measuring/reopened) cards fold by default: there is no #1 exemption for that list", async () => {
    const response = mockRecommendations();
    if (response.data === null) throw new Error("expected recommendations fixture data");
    const base = response.data.active[0];
    if (!base) throw new Error("expected an active recommendation fixture");
    function makeAdopted(overrides: Partial<RecommendationCard>): RecommendationCard {
      return {
        ...base,
        state: "ADOPTED",
        effect_cycle: makeEffectCycle({ state: "OPEN_MEASURING" }),
        ...overrides,
      } as RecommendationCard;
    }
    response.data.active = [];
    response.data.active_groups = [];
    response.data.limit_warnings = [];
    response.data.adopted = [
      makeAdopted({ rec_id: "u4-adopted-a" }),
      makeAdopted({ rec_id: "u4-adopted-b" }),
    ];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(response);

    const { container } = render(<RecommendationsPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Measuring and reopened recommendations"]'),
      ).not.toBeNull(),
    );
    const section = container.querySelector(
      '[aria-label="Measuring and reopened recommendations"]',
    ) as HTMLElement;
    const cards = [...section.querySelectorAll(".rec-card")];
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.classList.contains("rec-folded")).toBe(true);
  });
});
