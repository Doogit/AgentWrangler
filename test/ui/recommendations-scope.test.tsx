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
  // The selected recommendation is a standalone action card; the compact queue
  // retains grouped siblings. Read both surfaces in their displayed order.
  return [
    ...container.querySelectorAll(".card.rec-card:not(.rec-group-card) .rec-title"),
    ...container.querySelectorAll(".rec-group-members .rec-title"),
  ]
    .filter((el) => el.closest(".limit-warning-strip") === null)
    .map((el) => el.textContent);
}

describe("UA2 recommendation ordering and scope", () => {
  it.each(["detector", "workspace"])(
    "honors newest and within-family modeled sorting in %s groups",
    async (group) => {
      provide([
        card("older-high", { created_at: "2026-09-01", modeled_savings_u_per_wk: 3_000_000 }),
        card("newer-low", { created_at: "2026-09-03", modeled_savings_u_per_wk: 2_000_000 }),
        card("unknown", { created_at: "2026-09-02", modeled_savings_u_per_wk: null }),
      ]);
      window.location.hash = `#/recommendations?group=${group}&sort=newest`;
      const { container, getByLabelText } = await loaded();
      expect(titles(container)).toEqual(["newer-low", "unknown", "older-high"]);
      fireEvent.change(getByLabelText("Sort recommendations"), { target: { value: "savings" } });
      await waitFor(() =>
        expect(titles(container)).toEqual(["older-high", "newer-low", "unknown"]),
      );
      expect(container.textContent).toContain("Estimates can overlap; do not add them together.");
      expect(getByLabelText("Sort recommendations").textContent).toContain("Recommended order");
    },
  );

  it("keeps workspace order while sorting newest within each group", async () => {
    provide([
      card("a-older", { scope_workspace_id: "a", created_at: "2026-09-01" }),
      card("b-newest", { scope_workspace_id: "b", created_at: "2026-09-04" }),
      card("a-newer", { scope_workspace_id: "a", created_at: "2026-09-02" }),
    ]);
    window.location.hash = "#/recommendations?group=workspace&sort=newest";
    const { container } = await loaded();
    expect(titles(container)).toEqual(["a-newer", "a-older", "b-newest"]);
  });

  it("keeps family policy when workspace sorting by non-comparable estimates", async () => {
    provide([
      card("first-family", { detector_id: "D2", modeled_savings_u_per_wk: 2_000_000 }),
      card("second-family", { detector_id: "D8", modeled_savings_u_per_wk: 900_000_000 }),
    ]);
    window.location.hash = "#/recommendations?group=workspace&sort=savings";
    const { container } = await loaded();
    expect(titles(container)).toEqual(["first-family", "second-family"]);
  });

  it("uses scope ahead of legacy workspace for warnings, lifecycle lists, summary and ledger", async () => {
    const warning = card("global-warning", {
      detector_id: "D5",
      modeled_formula: { model: "warning", inputs: {}, kind: "WARNING" },
    });
    const data = provide(
      [card("global-active"), card("workspace-active", { scope_workspace_id: "workspace-a" })],
      [
        warning,
        {
          ...warning,
          rec_id: "workspace-warning",
          lever: "workspace-warning",
          scope_workspace_id: "workspace-a",
        },
      ],
    );
    data.adopted = [
      card("global-adopted", { state: "ADOPTED" }),
      card("workspace-adopted", { state: "ADOPTED", scope_workspace_id: "workspace-a" }),
    ];
    data.dismissed = [
      card("global-dismissed", { state: "DISMISSED" }),
      card("workspace-dismissed", { state: "DISMISSED", scope_workspace_id: "workspace-a" }),
    ];
    const ledger = mockLedger();
    if (!ledger.data) throw new Error("missing ledger fixture");
    const entry = ledger.data.entries[0];
    if (!entry) throw new Error("missing ledger entry");
    ledger.data.entries = [
      { ...entry, rec_id: "global-adopted", lever: "included-ledger-row" },
      { ...entry, rec_id: "workspace-adopted", lever: "excluded-ledger-row" },
    ];
    vi.mocked(client.fetchLedger).mockResolvedValue(ledger);
    window.location.hash = "#/recommendations?scope=global&ws=workspace-a";
    const { container } = await loaded();
    expect(titles(container)).toEqual(["global-active"]);
    expect(container.querySelector(".limit-warning-strip")?.textContent).toContain(
      "global-warning",
    );
    expect(container.querySelector(".limit-warning-strip")?.textContent).not.toContain(
      "workspace-warning",
    );
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      "(2)",
    );
    expect(container.querySelector("[data-toolbar-state='adopted']")?.textContent).toContain("(1)");
    expect(container.querySelector("[data-toolbar-state='dismissed']")?.textContent).toContain(
      "(1)",
    );
    expect(container.querySelector(".recs-summary-count-number")?.textContent).toBe("2");
    expect(container.querySelector(".rec-adopted-list")?.textContent).not.toContain(
      "workspace-adopted",
    );
    expect(container.querySelector(".rec-dismissed-list")?.textContent).not.toContain(
      "workspace-dismissed",
    );
    await waitFor(() =>
      expect(container.querySelector(".impact-ledger")?.textContent).toContain(
        "included-ledger-row",
      ),
    );
    expect(container.querySelector(".impact-ledger")?.textContent).not.toContain(
      "excluded-ledger-row",
    );
  });

  it("filters warnings by tier without claiming no findings while a visible warning remains", async () => {
    const warning = card("only-warning", {
      detector_id: "D5",
      modeled_formula: { model: "warning", inputs: {}, kind: "WARNING" },
    });
    provide([card("modeled")], [warning]);
    window.location.hash = "#/recommendations?tier=WARNING";
    const { container, getByText } = await loaded();
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      "(1)",
    );
    expect(container.textContent).not.toContain("No active recommendations");
    expect(container.querySelector(".recs-summary-count-number")?.textContent).toBe("1");
    expect(container.querySelector(".recs-summary-lever")?.textContent).toContain("Most findings:");
    fireEvent.click(container.querySelector(".recs-toolbar-more summary") as HTMLElement);
    fireEvent.click(getByText("Warning", { selector: "button" }));
    await waitFor(() => expect(titles(container)).toEqual(["modeled"]));
  });

  it("clears the proposed-only tier when switching to adopted", async () => {
    const data = provide([
      card("warning", {
        detector_id: "D5",
        modeled_formula: { model: "warning", inputs: {}, kind: "WARNING" },
      }),
    ]);
    data.adopted = [card("adopted-modeled", { state: "ADOPTED" })];
    const { container, getByRole } = await loaded();

    fireEvent.click(container.querySelector(".recs-toolbar-more summary") as HTMLElement);
    fireEvent.click(getByRole("button", { name: "Warning" }));
    await waitFor(() => expect(window.location.hash).toContain("tier=WARNING"));

    fireEvent.click(getByRole("button", { name: /Adopted/ }));
    await waitFor(() => expect(window.location.hash).toContain("state=adopted"));

    expect(window.location.hash).not.toContain("tier=");
    expect(container.querySelector(".rec-adopted-list")?.textContent).toContain("adopted-modeled");
  });

  it.each([
    ["adopted", "ADOPTED", ".rec-adopted-list"],
    ["dismissed", "DISMISSED", ".rec-dismissed-list"],
  ] as const)(
    "ignores a direct tier hash for %s recommendations",
    async (state, recommendationState, selector) => {
      const data = provide([]);
      data[state] = [card(`${state}-modeled`, { state: recommendationState })];
      window.location.hash = `#/recommendations?state=${state}&tier=WARNING`;

      const { container } = await loaded();

      expect(container.querySelector("[data-toolbar-tier]")).toBeNull();
      expect(container.querySelector(selector)?.textContent).toContain(`${state}-modeled`);
      expect(container.querySelector(`[data-toolbar-state='${state}']`)?.textContent).toContain(
        "(1)",
      );
    },
  );

  it("distinguishes filtered-empty and resets filters while retaining the route and sort", async () => {
    provide([card("available")]);
    window.location.hash = "#/recommendations?scope=missing&sort=newest";
    const { getByText, container } = await loaded();
    expect(container.textContent).toContain("No matching recommendations");
    fireEvent.click(getByText("Reset filters"));
    await waitFor(() => expect(titles(container)).toEqual(["available"]));
    expect(window.location.hash).toBe("#/recommendations?sort=newest");
  });
});
