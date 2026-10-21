// U5.4: Recs "Type" filter. Spec = execution plan §5 U5.4 row. Written before the code.
// Safety H1 · Friction & errors C1 C2 C5 C7 C9 D7 D11 A1 A2 · Cache B1 B2 B4 D8 · Cost D1 D2 D4 D9 D12.
// Unmapped detector ids match no Type. Proposed-only, URL param `type`, cleared by Reset.
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

function card(id: string, patch: Partial<RecommendationCard> = {}): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base) throw new Error("missing synthetic fixture");
  return { ...base, rec_id: id, title: id, lever: id, evidence: {}, ...patch };
}

function est(basis: "P" | "E" | "O" | "R" | "X", rank: number | null) {
  return { basis, rank_value_u_per_wk: rank, summable: false, label: `${basis} estimate` };
}

function provide(active: RecommendationCard[], warnings: RecommendationCard[] = []) {
  const response = mockRecommendations();
  if (!response.data) throw new Error("missing fixture");
  Object.assign(response.data, {
    active,
    active_groups: [],
    limit_warnings: warnings,
    adopted: [],
    dismissed: [],
  });
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  return response.data;
}

async function loaded() {
  const result = render(<RecommendationsPage />);
  await waitFor(() => expect(result.container.querySelector(".recs-toolbar")).not.toBeNull());
  return result;
}

function titles(container: HTMLElement) {
  return [
    ...container.querySelectorAll(".card.rec-card:not(.rec-group-card) .rec-title"),
    ...container.querySelectorAll(".rec-group-members .rec-title"),
  ]
    .filter((el) => el.closest(".limit-warning-strip") === null)
    .map((el) => el.textContent)
    .sort();
}

const DETECTORS = [
  "H1",
  "C1",
  "C2",
  "C5",
  "C7",
  "C9",
  "D7",
  "D11",
  "A1",
  "A2",
  "B1",
  "B2",
  "B4",
  "D8",
  "D1",
  "D2",
  "D4",
  "D9",
  "D12",
  "D6", // unmapped
  "D10", // unmapped
];

function everyDetector() {
  provide(
    DETECTORS.map((id) => card(`card-${id}`, { detector_id: id })),
    [card("limit-warning", { detector_id: "D5" })],
  );
}

describe("U5.4 Recs Type filter", () => {
  it("shows Type chips Safety, Friction & errors, Cache, Cost in the proposed view", async () => {
    everyDetector();
    const { container } = await loaded();
    const chips = [...container.querySelectorAll("[data-toolbar-type]")];
    expect(chips.map((chip) => chip.getAttribute("data-toolbar-type"))).toEqual([
      "safety",
      "friction",
      "cache",
      "cost",
    ]);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Safety",
      "Friction & errors",
      "Cache",
      "Cost",
    ]);
  });

  it.each([
    ["Safety", "safety", ["H1"]],
    ["Friction & errors", "friction", ["C1", "C2", "C5", "C7", "C9", "D7", "D11", "A1", "A2"]],
    ["Cache", "cache", ["B1", "B2", "B4", "D8"]],
    ["Cost", "cost", ["D1", "D2", "D4", "D9", "D12"]],
  ] as const)("Type %s shows only its mapped detectors", async (label, slug, ids) => {
    everyDetector();
    const { container, getByRole } = await loaded();
    expect(titles(container)).toHaveLength(DETECTORS.length);

    fireEvent.click(getByRole("button", { name: label }));
    await waitFor(() => expect(window.location.hash).toContain(`type=${slug}`));
    const expected = ids.map((id) => `card-${id}`).sort();
    await waitFor(() => expect(titles(container)).toEqual(expected));
    // The Proposed count uses the same predicate; the unmapped D5 warning drops out.
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      `(${ids.length})`,
    );

    fireEvent.click(getByRole("button", { name: label }));
    await waitFor(() => expect(window.location.hash).not.toContain("type="));
    await waitFor(() => expect(titles(container)).toHaveLength(DETECTORS.length));
  });

  it("matches unmapped detectors to no Type", async () => {
    provide([card("card-D6", { detector_id: "D6" }), card("card-D10", { detector_id: "D10" })]);
    for (const slug of ["safety", "friction", "cache", "cost"]) {
      window.location.hash = `#/recommendations?type=${slug}`;
      const { container, unmount } = await loaded();
      expect(titles(container)).toEqual([]);
      expect(container.textContent).toContain("No matching recommendations");
      unmount();
    }
  });

  it("ignores an unknown type value", async () => {
    everyDetector();
    window.location.hash = "#/recommendations?type=bogus";
    const { container } = await loaded();
    expect(titles(container)).toHaveLength(DETECTORS.length);
    expect(container.querySelector(".recs-toolbar")?.textContent).not.toContain("Reset filters");
  });

  it("combines with Basis and Last seen", async () => {
    provide([
      card("cost-p-now", { detector_id: "D1", estimate: est("P", 5), weeks_ago: 0 }),
      card("cost-e-now", { detector_id: "D2", estimate: est("E", 4), weeks_ago: 0 }),
      card("cost-p-old", { detector_id: "D4", estimate: est("P", 3), weeks_ago: 9 }),
      card("cache-p-now", { detector_id: "B1", estimate: est("P", 2), weeks_ago: 0 }),
    ]);
    window.location.hash = "#/recommendations?type=cost&basis=P&seen=7d";
    const { container } = await loaded();
    expect(titles(container)).toEqual(["cost-p-now"]);
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      "(1)",
    );
  });

  it("clears Type when switching to adopted", async () => {
    const data = provide([card("card-H1", { detector_id: "H1" })]);
    data.adopted = [card("adopted-D1", { state: "ADOPTED", detector_id: "D1" })];
    window.location.hash = "#/recommendations?type=safety";
    const { container, getByRole } = await loaded();

    fireEvent.click(getByRole("button", { name: /Adopted/ }));
    await waitFor(() => expect(window.location.hash).toContain("state=adopted"));
    expect(window.location.hash).not.toContain("type=");
    expect(container.querySelector(".rec-adopted-list")?.textContent).toContain("adopted-D1");
  });

  it.each([
    ["adopted", "ADOPTED", ".rec-adopted-list"],
    ["dismissed", "DISMISSED", ".rec-dismissed-list"],
  ] as const)(
    "ignores a direct type hash for %s recommendations",
    async (state, recommendationState, selector) => {
      const data = provide([]);
      data[state] = [card(`${state}-D1`, { state: recommendationState, detector_id: "D1" })];
      window.location.hash = `#/recommendations?state=${state}&type=safety`;
      const { container } = await loaded();
      expect(container.querySelector("[data-toolbar-type]")).toBeNull();
      expect(container.querySelector(selector)?.textContent).toContain(`${state}-D1`);
      expect(container.querySelector(`[data-toolbar-state='${state}']`)?.textContent).toContain(
        "(1)",
      );
    },
  );

  it("shows Reset when only Type is set, and Reset clears it", async () => {
    everyDetector();
    window.location.hash = "#/recommendations?type=cache";
    const { container, getByRole } = await loaded();
    expect(titles(container)).toHaveLength(4);
    fireEvent.click(getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(window.location.hash).toBe("#/recommendations"));
    await waitFor(() => expect(titles(container)).toHaveLength(DETECTORS.length));
  });
});
