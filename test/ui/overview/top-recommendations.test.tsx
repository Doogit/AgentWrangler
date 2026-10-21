import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../../src/query/api/recommendations";
import { trackEffect } from "../../../src/ui/api/effect-client";
import { TopRecommendations } from "../../../src/ui/overview/TopRecommendations";

vi.mock("../../../src/ui/api/effect-client", () => ({
  createEffectIdempotencyKey: () => "key",
  trackEffect: vi.fn(async () => ({ supported: true, cycle: { state: "OPEN_SETTLING" } })),
}));

afterEach(cleanup);

function rec(
  id: string,
  point: number | null,
  bounds: [number, number],
  kind: "HABIT" | "CONFIG",
  trackable: boolean,
): RecommendationCard {
  return {
    rec_id: id,
    category: "CONTEXT",
    title: `Action ${id}`,
    lever: "Improve usage",
    modeled_savings_u_per_wk: point,
    range_u_per_wk: bounds,
    actions: {
      primary: {
        option_id: "primary",
        kind,
        summary: `Summary ${id}`,
        detail: [],
        copy_text: `Instruction ${id}`,
        file_ref: null,
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
    effect_capability: { mode: trackable ? "TRACKABLE" : "READ_ONLY", reason: null },
  } as unknown as RecommendationCard;
}

describe("TopRecommendations", () => {
  it("keeps ranked order, action kinds, Track on every row, and one shared savings scale", () => {
    const rows = [
      rec("one", 40_000_000, [20_000_000, 80_000_000], "HABIT", true),
      rec("two", null, [10_000_000, 30_000_000], "CONFIG", false),
      rec("three", 20_000_000, [15_000_000, 40_000_000], "HABIT", true),
    ];
    render(<TopRecommendations recommendations={rows} />);
    expect(screen.getByText("Action one")).toBeTruthy();
    expect(screen.getByText("Action two")).toBeTruthy();
    expect(screen.getByText("Action three")).toBeTruthy();
    const track = screen.getAllByRole("button", { name: "Track" }) as HTMLButtonElement[];
    expect(track.map((button) => button.disabled)).toEqual([false, true, false]);
    expect(screen.queryByText("Details →")).toBeNull();
    expect(screen.queryByText("Review recommendation")).toBeNull();
    expect(screen.getByRole("link", { name: "Review config" }).getAttribute("href")).toBe(
      "#/recommendations?focus=two",
    );
    expect(screen.getByRole("link", { name: "Action one" }).getAttribute("href")).toBe(
      "#/recommendations?focus=one",
    );
    expect(screen.getByTestId("savings-point-1").style.width).toBe("50%");
    expect(screen.getByTestId("savings-range-1").style.width).toBe("50%");
    expect(screen.getByTestId("savings-range-2").style.left).toBe("12.5%");
    expect(screen.getByTestId("savings-range-2").style.width).toBe("25%");
    expect(screen.getByTestId("savings-point-3").style.width).toBe("25%");
    expect(screen.getByText(/Top 3 combined: \$45–\$150\/wk/)).toBeTruthy();
    expect(screen.getByText(/one \$0–\$80\/wk scale/)).toBeTruthy();
  });

  it("L6: excludes cards whose net headline is exactly $0 from the top 3", () => {
    const zero = { ...rec("zero", 90_000_000, [1, 2], "HABIT", true), allocated_u_per_wk: 0 };
    const real = {
      ...rec("real", 90_000_000, [1, 2], "HABIT", true),
      allocated_u_per_wk: 5_000_000,
    };
    render(<TopRecommendations recommendations={[zero, real] as RecommendationCard[]} />);
    expect(screen.queryByText("Action zero")).toBeNull();
    expect(screen.getByText("Action real")).toBeTruthy();
  });

  it("excludes recs with neither a point estimate nor a range from the top 3", () => {
    const unquantified = {
      ...rec("guard", null, [0, 0], "CONFIG", false),
      range_u_per_wk: null,
    } as RecommendationCard;
    const rows = [
      unquantified,
      rec("one", 10_000_000, [5_000_000, 20_000_000], "HABIT", true),
      rec("two", null, [1_000_000, 2_000_000], "CONFIG", true),
      rec("three", 3_000_000, [2_000_000, 4_000_000], "HABIT", true),
      rec("four", 1_000_000, [500_000, 1_500_000], "HABIT", true),
    ];
    render(<TopRecommendations recommendations={rows} groupCount={4} />);
    expect(screen.queryByText("Action guard")).toBeNull();
    expect(screen.getByTestId("top-rec-1").textContent).toContain("Action one");
    expect(screen.getByTestId("top-rec-3").textContent).toContain("Action three");
    expect(screen.queryByText("Action four")).toBeNull();
    expect(screen.queryByText("Not quantified")).toBeNull();
    expect(screen.getByRole("link", { name: "All 5 recommendations (4 groups) →" })).toBeTruthy();
  });

  it("replaces a withheld copy action with a link to the recommendation and colors rows by category", () => {
    const withheld = {
      ...rec("one", 10_000_000, [5_000_000, 20_000_000], "HABIT", false),
      category: "TOOLING",
      certification: "UNVERIFIED",
      action_validation: {
        primary: { ok: false, reason: "target metric mismatch or missing" },
        alternatives: {},
      },
      effect_capability: { mode: "MANUAL", reason: "HANDLER_UNAVAILABLE" },
    } as unknown as RecommendationCard;
    render(<TopRecommendations recommendations={[withheld]} />);
    expect(screen.queryByRole("button", { name: "Copy instruction" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open recommendation" }).getAttribute("href")).toBe(
      "#/recommendations?focus=one",
    );
    expect((screen.getByRole("button", { name: "Track" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Why some actions are unavailable" })).toBeTruthy();
    const row = screen.getByTestId("top-rec-1");
    expect(row.dataset.category).toBe("tooling");
    expect(row.querySelector(".overview-top-rec-cat")?.textContent).toBe("Tooling");
    expect(
      row.querySelector(".overview-top-rec-unverified, .overview-top-rec-certified"),
    ).toBeNull();
    expect(row.textContent).not.toMatch(/unverified|certified/i);
  });

  it("keeps an unmeasured action copyable and labels it Effect not tracked", () => {
    const unmeasured = {
      ...rec("one", 10_000_000, [5_000_000, 20_000_000], "HABIT", false),
      action_validation: { primary: { ok: true, measured: false }, alternatives: {} },
    } as unknown as RecommendationCard;
    render(<TopRecommendations recommendations={[unmeasured]} />);
    expect(screen.getByRole("button", { name: "Copy instruction" })).toBeTruthy();
    expect(screen.getByTestId("top-rec-1").textContent).toContain("Effect not tracked");
  });

  it("copies the HABIT instruction and shows the pipeline badge", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <TopRecommendations
        recommendations={[rec("one", 10_000_000, [5_000_000, 20_000_000], "HABIT", false)]}
        pipelineIsIncomplete
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instruction" }));
    expect(writeText).toHaveBeenCalledWith("Instruction one");
    expect(screen.getByTestId("partial-badge")).toBeTruthy();
  });

  it("uses the Recommendations effect tracking function", async () => {
    render(
      <TopRecommendations
        recommendations={[rec("one", 10_000_000, [5_000_000, 20_000_000], "HABIT", true)]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Track" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I completed this change" }));
    fireEvent.click(screen.getByRole("button", { name: "Start tracking" }));
    await waitFor(() => expect(trackEffect).toHaveBeenCalledWith("one", "key"));
  });

  it("links to Recommendations when no active recommendation exists", () => {
    render(<TopRecommendations recommendations={[]} />);
    expect(
      screen.getByRole("link", { name: "No active recommendations" }).getAttribute("href"),
    ).toBe("#/recommendations");
  });
});
