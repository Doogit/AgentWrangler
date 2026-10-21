/**
 * REL-FIX bug 2 — a B1-shaped card (HABIT action, no effect handler) can be adopted.
 * Operator decision 2026-10-19: Adopt saves the adoption without a cycle and the UI
 * says "Effect not measured" instead of a tracking/measuring status or a 400 error.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../../src/ui/api/feedback-client", () => ({
  FeedbackClientError: class FeedbackClientError extends Error {},
  listFeedback: vi.fn().mockResolvedValue({ data: [], meta: { ts: 0 } }),
  setFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  undoFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  deleteFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  getGoal: vi.fn().mockResolvedValue({ data: { goal: "PRESERVE_QUALITY" }, meta: { ts: 0 } }),
  setGoal: vi.fn().mockResolvedValue({ data: { goal: "PRESERVE_QUALITY" }, meta: { ts: 0 } }),
  resetGoal: vi.fn().mockResolvedValue({ data: { goal: "PRESERVE_QUALITY" }, meta: { ts: 0 } }),
}));

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function b1Card(): RecommendationCard {
  const base = mockRecommendations().data?.active[0];
  if (!base?.actions) throw new Error("expected fixture with actions");
  return {
    ...base,
    rec_id: "b1-habit",
    detector_id: "B1",
    category: "CACHE",
    title: "Cache read collapse habit",
    state: "PROPOSED",
    effect_cycle: null,
    effect_capability: { mode: "MANUAL", reason: "HANDLER_UNAVAILABLE" },
    actions: { ...base.actions, primary: { ...base.actions.primary, kind: "HABIT" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Adopt on a card with no effect handler", () => {
  it("shows the adoption succeeded and says Effect not measured — no error path", async () => {
    const rec = b1Card();
    const before = mockRecommendations();
    const after = mockRecommendations();
    if (!before.data || !after.data) throw new Error("expected data");
    before.data.active = [rec];
    before.data.active_groups = [];
    before.data.adopted = [];
    after.data.active = [];
    after.data.active_groups = [];
    after.data.adopted = [{ ...rec, state: "ADOPTED" }];
    vi.mocked(client.fetchRecommendations).mockResolvedValueOnce(before).mockResolvedValue(after);

    // Mirrors the fixed server: the only remaining 400 for this card is a missing
    // completed-change confirmation; otherwise it saves without a cycle.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/token") return fakeResponse(200, { token: "tok" });
      if (url === "/api/recommendations/adopt") {
        const body = JSON.parse(String(init?.body)) as { completed_change?: boolean };
        return body.completed_change === true
          ? fakeResponse(200, { data: { ok: true, effect_measured: false } })
          : fakeResponse(400, { error: "Confirm that the change is complete before tracking." });
      }
      return fakeResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RecommendationsPage />);
    await waitFor(() => expect(screen.getByText("Cache read collapse habit")).toBeTruthy());
    // Track stays disabled with its reason (OV-9); Adopt is the available action.
    expect(screen.getByRole("button", { name: "Track" })).toHaveProperty("disabled", true);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(document.querySelector("output.rec-apply-status")?.textContent).toMatch(
        /^Adopted: .* · Effect not measured$/,
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/recommendations/adopt", expect.anything());
    expect(screen.queryByText(/Could not save/)).toBeNull();
    expect(screen.queryByText(/Tracking saved/)).toBeNull();
    const adoptedRow = document.querySelector(".rec-adopted-row");
    expect(adoptedRow?.textContent).toContain("Effect not measured");
    expect(adoptedRow?.textContent).not.toMatch(/Measuring/);
  });
});
