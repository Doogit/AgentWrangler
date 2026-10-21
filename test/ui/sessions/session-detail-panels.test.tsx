import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mockRecommendations,
  mockSessionBreakdown,
  mockSessionDiagnostics,
} from "../../../src/ui/api/fixtures";
import {
  AnomaliesPanel,
  CostBreakdownPanel,
  PatternRecommendationsPanel,
  ToolBreakdownPanel,
} from "../../../src/ui/sessions/SessionPanels";

afterEach(cleanup);

describe("session detail panels", () => {
  const sessionId = "synthetic-session";

  it("renders diagnostic anchors with turn links and an empty state", () => {
    const anchors = mockSessionDiagnostics(sessionId).data ?? [];
    const { rerender } = render(
      <AnomaliesPanel state={{ status: "ok", value: anchors }} retry={() => {}} />,
    );
    fireEvent.click(screen.getByText("Anomalies", { selector: "summary" }));
    expect(screen.getByRole("link", { name: "Turn 2" }).getAttribute("href")).toBe(
      "#/sessions/synthetic-session?turn=1",
    );
    rerender(<AnomaliesPanel state={{ status: "ok", value: [] }} retry={() => {}} />);
    expect(screen.getByText("No anomalies detected")).toBeTruthy();
  });

  it("renders cost and tool aggregates, including error classes and timestamps", () => {
    const breakdown = mockSessionBreakdown(sessionId).data;
    if (breakdown === null) throw new Error("fixture requires a breakdown");
    render(
      <>
        <CostBreakdownPanel state={{ status: "ok", value: breakdown }} retry={() => {}} />
        <ToolBreakdownPanel
          state={{ status: "ok", value: breakdown }}
          retry={() => {}}
          sessionId={sessionId}
        />
      </>,
    );
    expect(screen.getByText("synthetic-model")).toBeTruthy();
    expect(screen.getByText("$0.12")).toBeTruthy();
    expect(screen.getByText("Not found ×1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read" }).getAttribute("href")).toBe(
      "#/sessions/synthetic-session?turn=1",
    );
    const toolRow = screen
      .getByRole("region", { name: "Tool breakdown" })
      .querySelector("tbody tr");
    const cells = toolRow?.querySelectorAll("td");
    expect(cells?.[3]?.textContent).toBeTruthy();
    expect(cells?.[3]?.textContent).not.toBe("—");
    expect(cells?.[4]?.textContent).toBeTruthy();
    expect(cells?.[4]?.textContent).not.toBe("—");
  });

  it("shows independent loading, empty and error states with working retry actions", () => {
    const retry = vi.fn();
    const { rerender } = render(<CostBreakdownPanel state={{ status: "loading" }} retry={retry} />);
    expect(
      screen.getByRole("region", { name: "Cost breakdown" }).querySelector("[aria-busy=true]"),
    ).toBeTruthy();
    rerender(<CostBreakdownPanel state={{ status: "error" }} retry={retry} />);
    expect(screen.getByText("Couldn't load cost breakdown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<CostBreakdownPanel state={{ status: "ok", value: null }} retry={retry} />);
    expect(screen.getByText("No turn data for this session")).toBeTruthy();
    rerender(
      <ToolBreakdownPanel
        state={{ status: "ok", value: null }}
        retry={retry}
        sessionId={sessionId}
      />,
    );
    expect(screen.getByText("No tool calls recorded")).toBeTruthy();
  });

  it("links matching recommendations and provides a fallback on error or empty", () => {
    const rec = mockRecommendations().data?.active[0];
    if (rec === undefined) throw new Error("fixture requires a recommendation");
    const retry = vi.fn();
    const { rerender } = render(
      <PatternRecommendationsPanel state={{ status: "ok", value: [rec] }} retry={retry} />,
    );
    expect(screen.getByRole("link", { name: rec.lever }).getAttribute("href")).toBe(
      `#/recommendations?focus=${encodeURIComponent(rec.rec_id)}`,
    );
    rerender(<PatternRecommendationsPanel state={{ status: "ok", value: [] }} retry={retry} />);
    expect(screen.getByText(/No active recommendations/)).toBeTruthy();
    rerender(<PatternRecommendationsPanel state={{ status: "error" }} retry={retry} />);
    expect(screen.getByText("Couldn't load recommendations for this pattern")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: /View all recommendations/ })).toBeTruthy();
  });
});
