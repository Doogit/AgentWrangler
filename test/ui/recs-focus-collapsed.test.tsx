/**
 * RC-B: a `#/recommendations?focus=<rec_id>` deep link to a below-floor or history card (the
 * Usage patterns "Small fix →" hand-off) opens that card's collapsed section and highlights it,
 * instead of the "no longer available" notice.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function setup(hash: string) {
  const response = mockRecommendations();
  if (response.data === null) throw new Error("expected recommendations fixture data");
  const base = response.data.active[0];
  if (!base) throw new Error("expected an active recommendation fixture");
  const make = (overrides: Partial<RecommendationCard>) =>
    ({ ...base, ...overrides }) as RecommendationCard;
  response.data.below_floor = [make({ rec_id: "rcb-small" }), make({ rec_id: "rcb-small-2" })];
  response.data.history = [make({ rec_id: "rcb-old", weeks_ago: 2 })];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  window.location.hash = hash;
  return render(<RecommendationsPage />);
}

function sectionDetails(name: string): HTMLDetailsElement {
  const section = screen.getByRole("region", { name });
  return section.querySelector("details") as HTMLDetailsElement;
}

describe("RC-B: deep-link focus reaches collapsed below-floor and history cards", () => {
  it("lists below-floor cards in a collapsed section when nothing is focused", async () => {
    setup("#/recommendations");
    await screen.findByRole("region", { name: "Below the low-impact threshold" });
    expect(sectionDetails("Below the low-impact threshold").open).toBe(false);
    expect(sectionDetails("Recommendation history").open).toBe(false);
  });

  it("opens the below-floor section and highlights the focused card", async () => {
    const { container } = setup("#/recommendations?focus=rcb-small-2");
    await screen.findByRole("region", { name: "Below the low-impact threshold" });
    expect(sectionDetails("Below the low-impact threshold").open).toBe(true);
    await waitFor(() => expect(container.querySelector(".rec-focus-highlight")).not.toBeNull());
    const section = screen.getByRole("region", { name: "Below the low-impact threshold" });
    expect(section.querySelector(".rec-focus-highlight")).not.toBeNull();
    expect(container.querySelector(".recs-focus-notice")).toBeNull();
  });

  it("opens the history section and its group for a focused history card", async () => {
    const { container } = setup("#/recommendations?focus=rcb-old");
    await screen.findByRole("region", { name: "Recommendation history" });
    const history = screen.getByRole("region", { name: "Recommendation history" });
    expect(sectionDetails("Recommendation history").open).toBe(true);
    const group = history.querySelector(".recs-history-group") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(history.querySelector(".rec-focus-highlight")).not.toBeNull();
    expect(container.querySelector(".recs-focus-notice")).toBeNull();
  });
});
