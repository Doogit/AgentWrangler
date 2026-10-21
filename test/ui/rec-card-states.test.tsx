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
import RecCard from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";

vi.mock("../../src/ui/api/client");
vi.mock("../../src/ui/recommendations/EffectEvidence", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: () => null,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});

function fixture(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base?.actions) throw new Error("Expected actionable recommendation fixture");
  return { ...base, rec_id: "lifecycle-fixture", ...overrides };
}

function cycle(direction: "IMPROVED" | "WORSENED" | "UNCHANGED" | null) {
  return {
    state: direction === null ? "OPEN_MEASURING" : "FINALIZED",
    targetDirection: direction,
    scheduledObservationTo: "2026-10-08T00:00:00.000Z",
    targetDefinition: { unit: "tokens", sampleUnit: "source observation" },
    finalEvidence: direction === null ? null : { before: { value: 120 }, after: { value: 90 } },
  } as unknown as NonNullable<RecommendationCard["effect_cycle"]>;
}

describe("P3.1 review 1 (R1.8): savings on the collapsed card", () => {
  it("states 'No modeled savings' and why when there is no figure", () => {
    const { container } = render(
      <RecCard rec={fixture({ modeled_savings_u_per_wk: null, range_u_per_wk: null })} />,
    );
    const meter = container.querySelector(".rec-savings-meter");
    expect(meter?.textContent).toContain("No modeled savings");
    expect(
      within(meter as HTMLElement).getByRole("button", { name: /modeled savings/i }),
    ).toBeTruthy();
  });

  it("shows a figure with its unit", () => {
    const { container } = render(
      <RecCard rec={fixture({ modeled_savings_u_per_wk: 15_050_174, range_u_per_wk: null })} />,
    );
    expect(container.querySelector(".rec-savings-meter")?.textContent).toContain("$15.05/wk");
  });
});

describe("F5 recommendation card states", () => {
  it.each(["undo-adopt", "reopen"] as const)(
    "posts %s with a token and refreshes, or shows a write error",
    async (action) => {
      const refresh = vi.fn();
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
        input === "/api/token"
          ? new Response(JSON.stringify({ token: "test-token" }), { status: 200 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const rec = fixture({
        state: action === "reopen" ? "MEASURED_EFFECTIVE" : "ADOPTED",
        effect_cycle: cycle(action === "reopen" ? "IMPROVED" : null),
      });
      const { container } = render(<RecCard rec={rec} onEffectMutated={refresh} />);
      fireEvent.click(
        within(container).getByRole("button", {
          name: action === "reopen" ? "Reopen" : "Undo adopt",
        }),
      );
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/recommendations/${action}`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-AgentWrangler-Token": "test-token" }),
        }),
      );
      const posted = JSON.parse(
        (
          fetchMock.mock.calls.find(
            ([path]) => path === `/api/recommendations/${action}`,
          )?.[1] as RequestInit
        ).body as string,
      );
      expect(posted).toMatchObject({ rec_id: rec.rec_id, idempotency_key: expect.any(String) });
      fetchMock.mockImplementation(async (input: string) =>
        input === "/api/token"
          ? new Response(JSON.stringify({ token: "test-token" }), { status: 200 })
          : new Response(JSON.stringify({ error: "state conflict" }), { status: 409 }),
      );
      fireEvent.click(
        within(container).getByRole("button", {
          name: action === "reopen" ? "Reopen" : "Undo adopt",
        }),
      );
      await waitFor(() =>
        expect(container.querySelector(".rec-apply-status--error")?.textContent).toContain(
          "state conflict",
        ),
      );
    },
  );
  it("shows no tier chip and validated actions for OPEN", () => {
    const { container } = render(
      <RecCard
        rec={fixture({ confidence_tier: "VERIFIED" })}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector(".rec-confidence-tier")).toBeNull();
    const actions = within(container.querySelector(".rec-card-head-actions") as HTMLElement);
    expect((actions.getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((actions.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (actions.getByRole("button", { name: "Copy instruction" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows the verdict date and disables adopt while measuring", () => {
    vi.useFakeTimers({ now: new Date("2026-09-27T12:00:00.000Z"), toFake: ["Date"] });
    const measuringCycle = cycle(null);
    (measuringCycle as { observationFrom: string }).observationFrom = "2026-09-24T00:00:00.000Z";
    const { container } = render(
      <RecCard rec={fixture({ state: "ADOPTED", effect_cycle: measuringCycle })} />,
    );
    vi.useRealTimers();
    expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe(
      "Measuring · day 4 of 14 · verdict ~2026-10-08",
    );
    expect(
      (within(container).getByRole("button", { name: "Adopted" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(container).getByRole("button", { name: "Undo adopt" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(container.querySelector(".rec-decision-actions")).toBeNull();
  });

  it("labels a source-observation reduction with its measured unit", () => {
    const { container } = render(
      <RecCard rec={fixture({ state: "MEASURED_EFFECTIVE", effect_cycle: cycle("IMPROVED") })} />,
    );
    expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe(
      "Fixed ✓ −30 tokens/source observation",
    );
    expect(
      (within(container).getByRole("button", { name: "Reopen" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(container.querySelector(".rec-decision-actions")).toBeNull();
    expect(within(container).queryByRole("button", { name: "Evaluation" })).toBeNull();
  });

  it("shows preserved history for a legacy improvement without a versioned cycle", () => {
    const { container } = render(
      <RecCard
        rec={fixture({
          state: "MEASURED_EFFECTIVE",
          effect_cycle: null,
          legacy_effect_verdict: "EFFECTIVE",
        })}
      />,
    );
    expect(within(container).getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(within(container).getByRole("region", { name: "Measurement history" })).toBeTruthy();
  });

  it("uses session units for a registered token target and omits a token badge for ratio evidence", () => {
    const sessionCycle = cycle("IMPROVED");
    sessionCycle.targetDefinition.sampleUnit = "session";
    const { container, rerender } = render(
      <RecCard rec={fixture({ state: "MEASURED_EFFECTIVE", effect_cycle: sessionCycle })} />,
    );
    expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe(
      "Fixed ✓ −30 tokens/session",
    );
    const ratioCycle = cycle("IMPROVED");
    ratioCycle.targetDefinition.unit = "ratio";
    ratioCycle.targetDefinition.sampleUnit = "session";
    rerender(<RecCard rec={fixture({ state: "MEASURED_EFFECTIVE", effect_cycle: ratioCycle })} />);
    expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe("Fixed ✓");
  });

  it("does not claim measurement is in progress without an open cycle", () => {
    const { container } = render(<RecCard rec={fixture({ state: "ADOPTED" })} />);
    expect(container.querySelector(".rec-confidence-tier")).toBeNull();
    expect(container.textContent).not.toContain("Measuring");
    expect(within(container).queryByRole("button", { name: "Undo adopt" })).toBeNull();
  });

  it.each(["WORSENED", "UNCHANGED"] as const)(
    "shows the no-improvement badge for %s",
    (direction) => {
      const { container } = render(
        <RecCard
          rec={fixture({ effect_cycle: cycle(direction) })}
          onAdopt={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe(
        "Applied — no improvement measured",
      );
      const actions = within(container.querySelector(".rec-card-head-actions") as HTMLElement);
      expect((actions.getByRole("button", { name: "Adopt" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(
        (actions.getByRole("button", { name: "Copy instruction" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );

  it("keeps legacy no-effect verdict visible after reopening", () => {
    const { container } = render(
      <RecCard
        rec={fixture({ state: "PROPOSED", effect_cycle: null, legacy_effect_verdict: "NO_EFFECT" })}
        onAdopt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector(".rec-confidence-tier")?.textContent).toBe(
      "Applied — no improvement measured",
    );
    expect(within(container).getByRole("button", { name: "Adopt" })).toBeTruthy();
  });

  it("shows RETIRED without a badge or actions", () => {
    const { container } = render(
      <RecCard rec={fixture({ state: "RETIRED" as RecommendationCard["state"] })} />,
    );
    expect(container.querySelector(".rec-confidence-tier")).toBeNull();
    expect(container.querySelector(".rec-decision-actions")).toBeNull();
    expect(within(container).queryByRole("button", { name: "Evaluation" })).toBeNull();
  });

  it.each([
    ["D9", "RETIRED", "Open Sessions"],
    ["D5", "MEASURED_EFFECTIVE", "Calibrate budget hook"],
    ["D9", "ADOPTED", "Open Sessions"],
  ] as const)("hides %s route action in %s", (detectorId, state, label) => {
    const { container } = render(
      <RecCard
        rec={fixture({
          detector_id: detectorId,
          state,
          effect_cycle: state === "RETIRED" ? null : cycle(state === "ADOPTED" ? null : "IMPROVED"),
        })}
      />,
    );
    expect(within(container).queryByRole("link", { name: label })).toBeNull();
  });

  it("hides the D9 primary link for legacy adopted rows without an open cycle", () => {
    const { container } = render(
      <RecCard rec={fixture({ detector_id: "D9", state: "ADOPTED", effect_cycle: null })} />,
    );
    expect(within(container).queryByRole("link", { name: "Open Sessions" })).toBeNull();
  });

  it("keeps an invalid primary withheld after a no-improvement verdict", () => {
    const rec = fixture({
      effect_cycle: cycle("WORSENED"),
      action_validation: {
        primary: { ok: false, reason: "target metric mismatch" },
        alternatives: {},
      },
    });
    const { container } = render(<RecCard rec={rec} onAdopt={vi.fn()} />);
    const actions = within(container.querySelector(".rec-card-head-actions") as HTMLElement);
    expect(
      within(container.querySelector(".rec-decision-actions") as HTMLElement).getByText(
        "Action withheld — failed validation: target metric mismatch",
      ),
    ).toBeTruthy();
    expect(actions.queryByRole("button", { name: "Adopt" })).toBeNull();
    expect(actions.queryByRole("button", { name: "Copy instruction" })).toBeNull();
  });
});

it("places OPEN and no-improvement cards in the ranked area, measuring below them, and improved and retired in history", async () => {
  const response = mockRecommendations();
  if (!response.data) throw new Error("Expected recommendations view");
  const open = fixture({ rec_id: "open", title: "Open card" });
  const reopened = fixture({
    rec_id: "reopened",
    title: "Reopened card",
    effect_cycle: cycle("UNCHANGED"),
  });
  const measuring = fixture({
    rec_id: "measuring",
    title: "Measuring card",
    state: "ADOPTED",
    effect_cycle: cycle(null),
  });
  const improved = fixture({
    rec_id: "improved",
    title: "Improved card",
    state: "MEASURED_EFFECTIVE",
    effect_cycle: cycle("IMPROVED"),
  });
  const retired = fixture({
    rec_id: "retired",
    title: "Retired card",
    state: "RETIRED" as RecommendationCard["state"],
  });
  const old = fixture({ rec_id: "old", title: "Old card", weeks_ago: 2 });
  response.data.active = [open, reopened, old];
  response.data.active_groups = [];
  response.data.adopted = [measuring, improved];
  (response.data as typeof response.data & { history: RecommendationCard[] }).history = [
    retired,
    old,
  ];
  response.data.limit_warnings = [];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<RecommendationsPage />);
  await waitFor(() =>
    expect(container.querySelector('[aria-label="Recommendation history"]')).not.toBeNull(),
  );
  const ranked = within(
    container.querySelector('[aria-label="Ranked by weekly impact"]') as HTMLElement,
  );
  expect(ranked.getByText("Open card")).toBeTruthy();
  expect(ranked.getByText("Reopened card")).toBeTruthy();
  const measuringArea = within(
    container.querySelector('[aria-label="Measuring and reopened recommendations"]') as HTMLElement,
  );
  expect(measuringArea.getByText("Measuring card")).toBeTruthy();
  const history = within(
    container.querySelector('[aria-label="Recommendation history"]') as HTMLElement,
  );
  expect(history.getByText("Improved card")).toBeTruthy();
  expect(history.getByText("Retired card")).toBeTruthy();
  expect(history.getByText("Old card")).toBeTruthy();
  expect(history.queryByText("Open card")).toBeNull();
  expect(ranked.queryByText("Old card")).toBeNull();
});

it("folds history by default and groups it by detector, newest group first", async () => {
  const response = mockRecommendations();
  if (!response.data) throw new Error("Expected recommendations view");
  const h1 = (n: number, created_at: string) =>
    fixture({
      rec_id: `h1-${n}`,
      detector_id: "H1",
      title: `H1 card ${n}`,
      state: "RETIRED" as RecommendationCard["state"],
      created_at,
    });
  response.data.active = [];
  response.data.active_groups = [];
  response.data.adopted = [];
  response.data.limit_warnings = [];
  (response.data as typeof response.data & { history: RecommendationCard[] }).history = [
    h1(1, "2026-09-01T00:00:00.000Z"),
    fixture({
      rec_id: "c9-1",
      detector_id: "C9",
      title: "C9 card",
      state: "RETIRED" as RecommendationCard["state"],
      created_at: "2026-09-20T00:00:00.000Z",
    }),
    h1(2, "2026-09-10T00:00:00.000Z"),
  ];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<RecommendationsPage />);
  await waitFor(() =>
    expect(container.querySelector('[aria-label="Recommendation history"]')).not.toBeNull(),
  );
  const section = container.querySelector('[aria-label="Recommendation history"]') as HTMLElement;
  const outer = section.querySelector(":scope > details") as HTMLDetailsElement;
  expect(outer.open).toBe(false);
  expect(outer.querySelector(":scope > summary")?.textContent).toContain(
    "Recommendation history (3)",
  );
  const groups = [...outer.querySelectorAll<HTMLDetailsElement>(":scope > details")];
  expect(groups.map((g) => g.open)).toEqual([false, false]);
  const summaries = groups.map((g) => g.querySelector(":scope > summary")?.textContent ?? "");
  expect(summaries[0]).toContain("C9");
  expect(summaries[0]).toContain("1 card");
  expect(summaries[1]).toContain("H1");
  expect(summaries[1]).toContain("2 cards");
  expect(within(groups[1] as HTMLElement).getByText("H1 card 2")).toBeTruthy();
  expect(within(groups[1] as HTMLElement).queryByText("C9 card")).toBeNull();
});

it("keeps measuring cards visible under the adopted filter", async () => {
  window.location.hash = "#/recommendations?state=adopted";
  const response = mockRecommendations();
  if (!response.data) throw new Error("Expected recommendations view");
  response.data.active = [];
  response.data.active_groups = [];
  response.data.adopted = [
    fixture({
      rec_id: "measuring",
      title: "Measuring card",
      state: "ADOPTED",
      effect_cycle: cycle(null),
    }),
  ];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<RecommendationsPage />);
  await waitFor(() =>
    expect(
      container.querySelector('[aria-label="Measuring and reopened recommendations"]'),
    ).not.toBeNull(),
  );
  expect(within(container).getByText("Measuring card")).toBeTruthy();
  expect(within(container).queryByText("No adopted recommendations in this selection.")).toBeNull();
});

it("keeps an inconclusive legacy verdict out of the reopened ranking", async () => {
  const response = mockRecommendations();
  if (!response.data) throw new Error("Expected recommendations view");
  response.data.active = [];
  response.data.active_groups = [];
  response.data.adopted = [
    fixture({
      rec_id: "legacy-inconclusive",
      title: "Inconclusive card",
      state: "MEASURED_NO_EFFECT",
      effect_cycle: null,
      legacy_effect_verdict: "INCONCLUSIVE",
    }),
  ];
  vi.mocked(client.fetchRecommendations).mockResolvedValue(response);
  const { container } = render(<RecommendationsPage />);
  await waitFor(() => expect(within(container).getByText("Inconclusive card")).toBeTruthy());
  expect(
    container.querySelector('[aria-label="Measuring and reopened recommendations"]'),
  ).toBeNull();
});
