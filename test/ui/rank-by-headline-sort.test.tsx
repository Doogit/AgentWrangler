// P3.L-F I4: the "Estimated weekly value" (savings) toolbar sort orders cards by the $ each card
// SHOWS (rule 1 of docs/plans/2026-10-03-rank-by-headline-spec.md), not by the standalone
// estimate.rank_value_u_per_wk. Written from the spec before the implementation.
//
// Rule 1: allocated number -> it; allocated null + reliability number -> reliability;
// allocated null otherwise ("Not estimated") -> none, sorted last; $0 is a shown $.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#/recommendations";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
});
afterEach(cleanup);

function card(id: string, patch: Partial<RecommendationCard>): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base) throw new Error("missing synthetic fixture");
  return {
    ...base,
    rec_id: id,
    title: id,
    lever: id,
    evidence: {},
    weeks_ago: 0,
    ...patch,
  };
}

function est(rank: number | null) {
  return { basis: "P" as const, rank_value_u_per_wk: rank, summable: false, label: "P estimate" };
}

function provide(active: RecommendationCard[]) {
  const response = mockRecommendations();
  if (!response.data) throw new Error("missing fixture");
  Object.assign(response.data, {
    active,
    active_groups: [],
    limit_warnings: [],
    adopted: [],
    dismissed: [],
  });
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
}

/** Rendered card titles in DOM order (flat cards and group members alike). */
function domOrder(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll(
      ".card.rec-card:not(.rec-group-card) .rec-title, .rec-group-members .rec-title",
    ),
  ]
    .filter((el) => el.closest(".limit-warning-strip") === null)
    .map((el) => el.textContent ?? "");
}

// rank_value order (old) is: big-rank-small-shown, not-estimated, shown-mid, reliability, zero-shown.
// Shown-$ order (rule 1) is:  shown-mid (11.0), reliability (5.0), big-rank-small-shown (0.4),
//                            zero-shown (0), then not-estimated (no shown $).
const FIXTURE = () => [
  card("big-rank-small-shown", {
    detector_id: "D1",
    allocated_u_per_wk: 400_000,
    modeled_savings_u_per_wk: 9_000_000,
    estimate: est(9_000_000),
  }),
  card("not-estimated", {
    detector_id: "D2",
    allocated_u_per_wk: null,
    modeled_savings_u_per_wk: null,
    reliability_u_per_wk: null,
    estimate: est(8_000_000),
  }),
  card("shown-mid", {
    detector_id: "D4",
    allocated_u_per_wk: 11_000_000,
    modeled_savings_u_per_wk: 2_000_000,
    estimate: est(2_000_000),
  }),
  card("reliability", {
    detector_id: "C7",
    allocated_u_per_wk: null,
    modeled_savings_u_per_wk: null,
    reliability_u_per_wk: 5_000_000,
    estimate: est(1_000_000),
  }),
  card("zero-shown", {
    detector_id: "D9",
    allocated_u_per_wk: 0,
    modeled_savings_u_per_wk: 0,
    estimate: est(500_000),
  }),
];

describe("P3.L-F I4: savings toolbar sort follows the shown $", () => {
  it("orders by shown $ desc; reliability uses its own figure; $0 before Not estimated", async () => {
    provide(FIXTURE());
    const { container, getByLabelText } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".recs-toolbar")).not.toBeNull());

    fireEvent.change(getByLabelText("Sort recommendations"), { target: { value: "savings" } });
    await waitFor(() => expect(window.location.hash).toContain("sort=savings"));

    expect(domOrder(container)).toEqual([
      "shown-mid",
      "reliability",
      "big-rank-small-shown",
      "zero-shown",
      "not-estimated",
    ]);
  });
});

// Amended 2026-10-13 (operator): groups go by their cards' summed $, and each heading shows the
// group total.
describe("group order and heading total", () => {
  it("orders groups by summed $ and shows each group's $/wk total", async () => {
    provide([
      card("hero", { detector_id: "D8", allocated_u_per_wk: 20_000_000, estimate: est(1) }),
      card("a1-single", { detector_id: "A1", allocated_u_per_wk: 5_000_000, estimate: est(1) }),
      card("d6-a", { detector_id: "D6", allocated_u_per_wk: 4_000_000, estimate: est(1) }),
      card("d6-b", { detector_id: "D6", allocated_u_per_wk: 3_000_000, estimate: est(1) }),
    ]);
    const { container, getByLabelText } = render(<RecommendationsPage />);
    await waitFor(() => expect(container.querySelector(".recs-group-head")).not.toBeNull());
    // The default view keeps the server's group order (tested in test/query); "savings"
    // re-derives it on the client.
    fireEvent.change(getByLabelText("Sort recommendations"), { target: { value: "savings" } });
    await waitFor(() => expect(window.location.hash).toContain("sort=savings"));

    const heads = [...container.querySelectorAll(".recs-group-section")].map((section) => [
      section.getAttribute("data-detector-id"),
      section.querySelector(".recs-group-total")?.textContent?.match(/\$[\d.]+\/wk total/)?.[0],
    ]);
    // D6 totals $7 (best card $4) so it leads A1 ($5, one card).
    expect(heads).toEqual([
      ["D6", "$7.00/wk total"],
      ["A1", "$5.00/wk total"],
    ]);
  });
});
