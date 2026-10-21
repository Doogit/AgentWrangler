import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import {
  SavingsMeter,
  headlineSavings,
  isQuantified,
  meterBounds,
  savingsRange,
} from "../../src/ui/lib/rec-presentation";

afterEach(() => cleanup());

function rec(over: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "r1",
    detector_id: "A1",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "x",
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "M", inputs: {}, kind: "MODELED" },
    evidence: {},
    target_metric: "m",
    state: "PROPOSED",
    created_at: "2026-09-01T00:00:00.000Z",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 1,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    actionability_ok: true,
    ...over,
  } as RecommendationCard;
}

describe("headlineSavings", () => {
  it("number, null and undefined follow the L6 rule", () => {
    expect(
      headlineSavings(rec({ allocated_u_per_wk: 9_210_000, modeled_savings_u_per_wk: 1 })),
    ).toBe(9_210_000);
    expect(
      headlineSavings(rec({ allocated_u_per_wk: null, modeled_savings_u_per_wk: 5 })),
    ).toBeNull();
    expect(headlineSavings(rec({ modeled_savings_u_per_wk: 5 }))).toBe(5);
  });
});

describe("isQuantified", () => {
  it("is true for a numeric allocated headline even with null standalone", () => {
    expect(isQuantified(rec({ allocated_u_per_wk: 9_210_000 }))).toBe(true);
  });
  it("is false when allocated is null, even if a standalone value exists", () => {
    expect(isQuantified(rec({ allocated_u_per_wk: null, modeled_savings_u_per_wk: 5 }))).toBe(
      false,
    );
  });
  it("legacy: falls back to standalone / range", () => {
    expect(isQuantified(rec({ modeled_savings_u_per_wk: 5 }))).toBe(true);
    expect(isQuantified(rec())).toBe(false);
  });
});

describe("SavingsMeter headline", () => {
  it("shows allocated $ + net of overlaps when standalone is null and no range (A1/D7)", () => {
    const r = rec({ allocated_u_per_wk: 9_210_000 });
    const { container } = render(
      <SavingsMeter rec={r} scale={savingsRange(r)?.[1] ?? 0} testIdSuffix="a" />,
    );
    expect(container.textContent).toContain("$9.21/wk");
    expect(container.textContent).toContain("net of overlaps");
    expect(container.textContent).not.toContain("No modeled savings");
  });
  it("shows allocated $ for D1 heuristic cards instead of the standalone range", () => {
    const r = rec({
      detector_id: "D1",
      allocated_u_per_wk: 2_000_000,
      modeled_savings_u_per_wk: 3_000_000,
      range_u_per_wk: [1_000_000, 5_000_000],
      evidence: { attribution_method: "HEURISTIC" } as RecommendationCard["evidence"],
    });
    const { container } = render(<SavingsMeter rec={r} scale={5_000_000} testIdSuffix="d" />);
    expect(container.textContent).toContain("$2.00/wk");
    expect(container.textContent).toContain("net of overlaps");
    expect(container.textContent).not.toContain("$1.00–$5.00");
  });
  // F1 (card review 2026-10-04) replaces "a net headline ignores the standalone range: no band".
  it("a net headline inside the range keeps the point and draws the band (D8)", () => {
    const r = rec({ allocated_u_per_wk: 18_160_000, range_u_per_wk: [9_400_000, 19_900_000] });
    expect(meterBounds(r)).toEqual([9_400_000, 19_900_000]);
    const { container } = render(
      <SavingsMeter rec={r} scale={meterBounds(r)?.[1] ?? 0} testIdSuffix="b" />,
    );
    expect(container.textContent).toContain("$18.16/wk");
    expect(container.textContent).toContain("net of overlaps");
    expect(container.textContent).toContain("as low as $9.40, up to $19.90");
    expect(container.querySelector('[data-testid="savings-point-b"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="savings-range-b"]')).not.toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Savings range $9.40 to $19.90 per week",
    );
  });
  it("a net headline above the range shows the range only, with the net $ in an InfoTip (A1)", () => {
    const r = rec({ allocated_u_per_wk: 2_730_000, range_u_per_wk: [87_000, 186_000] });
    expect(meterBounds(r)).toEqual([87_000, 186_000]);
    const { container, getByRole } = render(
      <SavingsMeter rec={r} scale={meterBounds(r)?.[1] ?? 0} testIdSuffix="a1" />,
    );
    expect(container.textContent).toContain("Modeled range");
    expect(container.textContent).toContain("$0.09–$0.19/wk");
    expect(container.textContent).toContain("range only · no point estimate");
    expect(container.textContent).not.toContain("$2.73");
    expect(container.textContent).not.toContain("net of overlaps");
    expect(container.querySelector('[data-testid="savings-point-a1"]')).toBeNull();
    fireEvent.focus(getByRole("button", { name: "About modeled savings" }));
    expect(getByRole("tooltip").textContent).toContain("($2.73/wk) covers more spend");
  });
  it("a net headline below the range stays a point with no band (overlaps took part of it)", () => {
    const r = rec({ allocated_u_per_wk: 0, range_u_per_wk: [236_000, 502_000] });
    expect(meterBounds(r)).toEqual([0, 0]);
    const { container } = render(<SavingsMeter rec={r} scale={0} testIdSuffix="lo" />);
    expect(container.textContent).toContain("$0.00/wk");
    expect(container.textContent).not.toContain("up to");
    expect(container.querySelector('[data-testid="savings-range-lo"]')).toBeNull();
  });
  it("allocated 0 with a modeled standalone draws no band under the $0.00 headline", () => {
    const r = rec({ allocated_u_per_wk: 0, modeled_savings_u_per_wk: 10_000_000 });
    const { container } = render(<SavingsMeter rec={r} scale={0} testIdSuffix="z" />);
    expect(container.textContent).toContain("$0.00/wk");
    expect(container.querySelector('[data-testid="savings-range-z"]')).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Savings range $0.00 to $0.00 per week",
    );
  });
  it("legacy (allocated undefined): standalone modeled + range render as before, no net label", () => {
    const r = rec({ modeled_savings_u_per_wk: 3_000_000, range_u_per_wk: [1_000_000, 5_000_000] });
    const { container } = render(<SavingsMeter rec={r} scale={5_000_000} testIdSuffix="l" />);
    expect(container.textContent).toContain("$3.00/wk");
    expect(container.textContent).toContain("as low as $1.00");
    expect(container.textContent).toContain("up to $5.00");
    expect(container.textContent).not.toContain("net of overlaps");
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Savings range $1.00 to $5.00 per week",
    );
  });
  it("net-of-overlaps label sits on its own line (block class), not run into the $ figure", () => {
    const { container } = render(
      <SavingsMeter rec={rec({ allocated_u_per_wk: 670_000 })} scale={670_000} testIdSuffix="n" />,
    );
    const net = container.querySelector(".rec-savings-net-of-overlaps");
    expect(net).not.toBeNull();
    expect(net?.classList.contains("rec-savings-line")).toBe(true);
  });
  it("null allocated renders Not estimated", () => {
    const { container } = render(
      <SavingsMeter rec={rec({ allocated_u_per_wk: null })} scale={0} testIdSuffix="c" />,
    );
    expect(container.textContent).toContain("Not estimated");
  });
  it("a folded card names the card that prices its $ instead of Not estimated (B4, F5)", () => {
    const { container, queryByTestId } = render(
      <SavingsMeter
        rec={rec({ detector_id: "B4", allocated_u_per_wk: null, modeled_savings_u_per_wk: null })}
        scale={0}
        testIdSuffix="b4"
      />,
    );
    expect(container.textContent).toContain("$ counted in B1");
    expect(container.textContent).not.toContain("Not estimated");
    expect(queryByTestId("savings-folded-b4")?.querySelector("button")).not.toBeNull();
  });
  it("a non-summable standalone estimate shows its $ as 'estimate · not in page total' (E1/E2)", () => {
    const estimate = {
      basis: "E" as const,
      rank_value_u_per_wk: 7_740_000,
      summable: false,
      label: "x",
    };
    const { container, queryByTestId } = render(
      <SavingsMeter
        rec={rec({
          detector_id: "E1",
          allocated_u_per_wk: null,
          modeled_savings_u_per_wk: 7_740_000,
          estimate,
        })}
        scale={0}
        testIdSuffix="e"
      />,
    );
    expect(container.textContent).toContain("$7.74/wk");
    expect(container.textContent).toContain("estimate · not in page total");
    expect(container.textContent).not.toContain("Not estimated");
    expect(queryByTestId("savings-standalone-e")?.querySelector("button")).not.toBeNull();
  });
  it("a summable estimate with no ledger figure still reads Not estimated (D6)", () => {
    const estimate = {
      basis: "E" as const,
      rank_value_u_per_wk: 57_000_000,
      summable: true,
      label: "x",
    };
    const { container } = render(
      <SavingsMeter
        rec={rec({
          allocated_u_per_wk: null,
          modeled_savings_u_per_wk: 57_000_000,
          estimate,
        })}
        scale={0}
        testIdSuffix="d"
      />,
    );
    expect(container.textContent).toContain("Not estimated");
  });
  it("a reliability card with a number shows $X/wk and 'upper bound', with an InfoTip", () => {
    const { container, queryByTestId } = render(
      <SavingsMeter
        rec={rec({ detector_id: "C7", allocated_u_per_wk: null, reliability_u_per_wk: 1_500_000 })}
        scale={0}
        testIdSuffix="r"
      />,
    );
    expect(container.textContent).toContain("$1.50/wk");
    expect(container.textContent).toContain("upper bound");
    expect(container.textContent).not.toContain("Not estimated");
    expect(queryByTestId("savings-reliability-r")?.querySelector("button")).not.toBeNull();
  });
  it("subagent failures show beside the main-chain headline, not in it", () => {
    const { getByTestId, queryByTestId } = render(
      <SavingsMeter
        rec={rec({
          detector_id: "C2",
          allocated_u_per_wk: null,
          reliability_u_per_wk: 100_000,
          reliability_sidechain_u_per_wk: 460_000,
        })}
        scale={0}
        testIdSuffix="rs"
      />,
    );
    expect(getByTestId("savings-reliability-rs").querySelector("strong")?.textContent).toBe(
      "$0.10/wk",
    );
    expect(getByTestId("savings-reliability-subagent-rs").textContent).toContain(
      "$0.46/wk in subagents",
    );
    cleanup();
    render(
      <SavingsMeter
        rec={rec({ detector_id: "C2", allocated_u_per_wk: null, reliability_u_per_wk: 100_000 })}
        scale={0}
        testIdSuffix="rs0"
      />,
    );
    expect(queryByTestId("savings-reliability-subagent-rs0")).toBeNull();
  });
  it("a reliability figure that rounds to $0.00 shows 'under $0.01/wk', never a bare $0.00", () => {
    const { container } = render(
      <SavingsMeter
        rec={rec({ detector_id: "C1", allocated_u_per_wk: null, reliability_u_per_wk: 3_000 })}
        scale={0}
        testIdSuffix="rsmall"
      />,
    );
    expect(container.textContent).toContain("under $0.01/wk");
    expect(container.textContent).not.toContain("$0.00");
  });
  it("a reliability card of $0 shows $0/wk, not Not estimated", () => {
    const { container } = render(
      <SavingsMeter
        rec={rec({ detector_id: "C7", allocated_u_per_wk: null, reliability_u_per_wk: 0 })}
        scale={0}
        testIdSuffix="r0"
      />,
    );
    expect(container.textContent).toContain("upper bound");
  });
  it("a null/absent reliability field still renders Not estimated", () => {
    for (const over of [
      { reliability_u_per_wk: null },
      {},
    ] satisfies Partial<RecommendationCard>[]) {
      const { container } = render(
        <SavingsMeter
          rec={rec({ detector_id: "C7", allocated_u_per_wk: null, ...over })}
          scale={0}
          testIdSuffix="rn"
        />,
      );
      expect(container.textContent).toContain("Not estimated");
      cleanup();
    }
  });
  it("safety cards show their count with an InfoTip and no $ (operator 2026-10-04)", () => {
    const metrics = (code: string, value: number) =>
      ({ metrics: { [code]: { kind: "COUNT", value } } }) as RecommendationCard["evidence"];
    const { getByTestId } = render(
      <SavingsMeter
        rec={rec({
          detector_id: "C9",
          safety_lane: true,
          allocated_u_per_wk: null,
          reliability_u_per_wk: null,
          evidence: metrics("DENIAL_COUNT", 42),
        })}
        scale={0}
        testIdSuffix="s9"
      />,
    );
    const guard = getByTestId("savings-safety-s9");
    expect(guard.querySelector("strong")?.textContent).toBe("42 blocked calls");
    expect(guard.textContent).not.toMatch(/\$|Not estimated/);
    expect(guard.querySelector("button")).not.toBeNull();
    cleanup();
    const { getByTestId: h1 } = render(
      <SavingsMeter
        rec={rec({
          detector_id: "H1",
          safety_lane: true,
          allocated_u_per_wk: null,
          evidence: metrics("OPERATION_COUNT", 1),
        })}
        scale={0}
        testIdSuffix="h1"
      />,
    );
    expect(h1("savings-safety-h1").querySelector("strong")?.textContent).toBe("1 run");
  });
});
