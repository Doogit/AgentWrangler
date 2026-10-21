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

function est(basis: "P" | "E" | "O" | "R" | "X", rank: number | null) {
  return { basis, rank_value_u_per_wk: rank, summable: false, label: `${basis} estimate` };
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
    "honors newest and estimated-weekly-value sorting in %s groups",
    async (group) => {
      provide([
        card("older-high", { created_at: "2026-09-01", estimate: est("P", 3_000_000) }),
        card("newer-low", { created_at: "2026-09-03", estimate: est("E", 2_000_000) }),
        card("unknown", { created_at: "2026-09-02", estimate: est("R", null) }),
      ]);
      window.location.hash = `#/recommendations?group=${group}&sort=newest`;
      const { container, getByLabelText } = await loaded();
      expect(titles(container)).toEqual(["newer-low", "unknown", "older-high"]);
      fireEvent.change(getByLabelText("Sort recommendations"), { target: { value: "savings" } });
      await waitFor(() =>
        expect(titles(container)).toEqual(["older-high", "newer-low", "unknown"]),
      );
      expect(container.textContent).toContain(
        "Dollar figures are net of overlaps: each token is counted once, so they add up.",
      );
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

  // P3.L-F: the value sort uses the $ the card shows (pre-L6 fixtures: modeled_savings), not the
  // stored rank value; X basis is not special-cased.
  it("sorts estimated weekly value by the shown $ across families", async () => {
    provide([
      card("x-basis-huge-modeled", {
        detector_id: "D2",
        modeled_savings_u_per_wk: 900_000_000,
        estimate: est("X", 900_000_000),
      }),
      card("low-rank", {
        detector_id: "D2",
        modeled_savings_u_per_wk: 800_000_000,
        estimate: est("E", 1_000_000),
      }),
      card("high-rank", {
        detector_id: "D8",
        modeled_savings_u_per_wk: 1,
        estimate: est("P", 5_000_000),
      }),
    ]);
    window.location.hash = "#/recommendations?group=workspace&sort=savings";
    const { container } = await loaded();
    expect(titles(container)).toEqual(["x-basis-huge-modeled", "low-rank", "high-rank"]);
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

  // U5.3 item 1: no "More filters" disclosure; every control is visible at load.
  it("shows Status, Basis, Last seen, Sort and Group by without a disclosure", async () => {
    provide([card("any", { estimate: est("P", 1) })]);
    const { container, getByLabelText } = await loaded();
    expect(container.querySelector(".recs-toolbar details")).toBeNull();
    expect(container.textContent).not.toContain("More filters");
    expect(container.textContent).not.toContain("Suggestion type");
    expect(container.querySelector("[data-toolbar-state='proposed']")).not.toBeNull();
    expect(
      [...container.querySelectorAll("[data-toolbar-basis]")].map((chip) => chip.textContent),
    ).toEqual(["Modeled", "Usage-estimated", "Overlap", "Risk"]);
    expect((getByLabelText("Last seen") as HTMLSelectElement).value).toBe("all");
    expect(getByLabelText("Sort recommendations")).not.toBeNull();
    expect(getByLabelText("Group recommendations by")).not.toBeNull();
  });

  // U5.3 item 2: Basis filters on estimate.basis P/E/O/R.
  it.each([
    ["Modeled", "P", ["p-card"]],
    ["Usage-estimated", "E", ["e-card-1", "e-card-2"]],
    ["Overlap", "O", ["o-card"]],
    ["Risk", "R", ["r-card"]],
  ] as const)("Basis %s shows only basis-%s cards", async (label, basis, expected) => {
    provide(
      [
        card("p-card", { estimate: est("P", 50) }),
        card("e-card-1", { estimate: est("E", 40) }),
        card("o-card", { estimate: est("O", 30) }),
        card("e-card-2", { estimate: est("E", 20) }),
        card("r-card", { estimate: est("R", 10) }),
        card("x-card", { estimate: est("X", null) }),
      ],
      [card("limit-warning", { detector_id: "D5", estimate: est("X", null) })],
    );
    const { container, getByRole } = await loaded();
    expect(titles(container)).toHaveLength(6);
    fireEvent.click(getByRole("button", { name: label }));
    await waitFor(() => expect(window.location.hash).toContain(`basis=${basis}`));
    await waitFor(() => expect([...titles(container)].sort()).toEqual([...expected].sort()));
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      `(${expected.length})`,
    );
    fireEvent.click(getByRole("button", { name: label }));
    await waitFor(() => expect(titles(container)).toHaveLength(6));
  });

  // F5 ranks only the current window; Last seen cannot restore stale cards.
  it.each([
    ["all", ["now"]],
    ["30d", ["now"]],
    ["7d", ["now"]],
  ] as const)("Last seen %s keeps only current-window ranked cards", async (value, expected) => {
    provide([
      card("now", { weeks_ago: 0 }),
      card("one-week", { weeks_ago: 1 }),
      card("four-weeks", { weeks_ago: 4 }),
      card("five-weeks", { weeks_ago: 5 }),
      card("stale", { weeks_ago: 30 }),
    ]);
    const { container, getByLabelText } = await loaded();
    fireEvent.change(getByLabelText("Last seen"), { target: { value } });
    await waitFor(() => expect([...titles(container)].sort()).toEqual([...expected].sort()));
    if (value === "all") expect(window.location.hash).not.toContain("seen=");
    else expect(window.location.hash).toContain(`seen=${value}`);
  });

  it("filters warnings by window without claiming no findings while a visible warning remains", async () => {
    const warning = card("only-warning", { detector_id: "D5", weeks_ago: 0 });
    provide([card("stale-card", { weeks_ago: 9 })], [warning]);
    window.location.hash = "#/recommendations?seen=7d";
    const { container } = await loaded();
    expect(container.querySelector("[data-toolbar-state='proposed']")?.textContent).toContain(
      "(1)",
    );
    expect(titles(container)).toEqual([]);
    expect(container.textContent).not.toContain("No active recommendations");
    expect(container.textContent).not.toContain("No matching recommendations");
    expect(container.querySelector(".recs-summary-count-number")?.textContent).toBe("1");
    expect(container.querySelector(".recs-summary-lever")?.textContent).toContain("Most findings:");
  });

  it("clears proposed-only Basis and Last seen when switching to adopted", async () => {
    const data = provide([card("p-card", { estimate: est("P", 1), weeks_ago: 0 })]);
    data.adopted = [card("adopted-e", { state: "ADOPTED", estimate: est("E", 1), weeks_ago: 9 })];
    window.location.hash = "#/recommendations?basis=P&seen=7d";
    const { container, getByRole } = await loaded();

    fireEvent.click(getByRole("button", { name: /Adopted/ }));
    await waitFor(() => expect(window.location.hash).toContain("state=adopted"));

    expect(window.location.hash).not.toContain("basis=");
    expect(window.location.hash).not.toContain("seen=");
    expect(container.querySelector(".rec-adopted-list")?.textContent).toContain("adopted-e");
  });

  it.each([
    ["adopted", "ADOPTED", ".rec-adopted-list"],
    ["dismissed", "DISMISSED", ".rec-dismissed-list"],
  ] as const)(
    "ignores a direct basis/seen hash for %s recommendations",
    async (state, recommendationState, selector) => {
      const data = provide([]);
      data[state] = [
        card(`${state}-e`, { state: recommendationState, estimate: est("E", 1), weeks_ago: 9 }),
      ];
      window.location.hash = `#/recommendations?state=${state}&basis=P&seen=7d`;

      const { container } = await loaded();

      expect(container.querySelector("[data-toolbar-basis]")).toBeNull();
      expect(container.querySelector(selector)?.textContent).toContain(`${state}-e`);
      expect(container.querySelector(`[data-toolbar-state='${state}']`)?.textContent).toContain(
        "(1)",
      );
    },
  );

  // U5.3 item 5: Reset clears narrowing filters AND sort/group/window.
  it("distinguishes filtered-empty and resets filters, sort, group and window", async () => {
    provide([card("available", { estimate: est("P", 1), weeks_ago: 0 })]);
    window.location.hash =
      "#/recommendations?scope=missing&basis=R&seen=7d&sort=newest&group=workspace";
    const { getAllByText, container } = await loaded();
    expect(container.textContent).toContain("No matching recommendations");
    const [reset] = getAllByText("Reset filters");
    fireEvent.click(reset as HTMLElement);
    await waitFor(() => expect(titles(container)).toEqual(["available"]));
    expect(window.location.hash).toBe("#/recommendations");
  });

  it("offers Reset filters in the toolbar when only sort/group differ from default", async () => {
    provide([card("available")]);
    window.location.hash = "#/recommendations?sort=newest&group=workspace";
    const { container, getByRole } = await loaded();
    fireEvent.click(getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(window.location.hash).toBe("#/recommendations"));
    expect(container.querySelector(".recs-toolbar")?.textContent).not.toContain("Reset filters");
  });
});
