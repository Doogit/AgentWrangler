import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GlobalOverview } from "../../../src/query/api/overview";
import type { RecommendationCard } from "../../../src/query/api/recommendations";
import { AcrossDashboard } from "../../../src/ui/overview/AcrossDashboard";

afterEach(cleanup);

const overview = {
  model_mix: [
    { model: "Haiku", turns: 3 },
    { model: "Opus", turns: 1 },
  ],
} as GlobalOverview;

describe("AcrossDashboard", () => {
  it("renders linked model shares, sidechain note, open effect count, and available health rows", () => {
    const adopted = [
      { effect_cycle: { state: "OPEN_MEASURING" } },
      { effect_cycle: { state: "FINALIZED" } },
    ] as RecommendationCard[];
    render(
      <AcrossDashboard
        overview={overview}
        adopted={adopted}
        haikuSidechainTurns={2}
        usageSource="api"
        linkageRate={0.5}
        calibrationDriftPoints={7}
      />,
    );
    expect(screen.getByText(/1 being measured/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Haiku · 3/ }).getAttribute("href")).toBe(
      "#/sessions?model=Haiku",
    );
    expect(screen.getByText(/2 Haiku turns are background subagent calls/)).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("7.0 points high")).toBeTruthy();
    expect(screen.getByText("Claude API")).toBeTruthy();
  });

  it("names the Claude Code /usage reader as the usage source", () => {
    render(<AcrossDashboard overview={overview} adopted={[]} usageSource="cli" />);
    expect(screen.getByText("Claude Code /usage")).toBeTruthy();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("omits unavailable data-health rows and gives tracked-effects next step", () => {
    render(<AcrossDashboard overview={overview} adopted={[]} />);
    expect(screen.getByText("Nothing is being measured yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pick one to track →" }).getAttribute("href")).toBe(
      "#/recommendations",
    );
    expect(screen.queryByText("GitHub linkage")).toBeNull();
    expect(screen.queryByText("Usage source")).toBeNull();
    expect(screen.queryByText("Weekly limit calibration")).toBeNull();
  });
});
