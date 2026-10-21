/**
 * UA3 recommendation lifecycle writes. These are page-level tests: RecCard owns
 * the undo UI, while RecommendationsPage obtains a fresh token and persists it.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import {
  mockEfficiencyHeadroom,
  mockHookConfigResponse,
  mockLedger,
  mockPractices,
  mockRecommendations,
} from "../../src/ui/api/fixtures";
import { __resetHookInstallCache } from "../../src/ui/recommendations/RecCard";
import RecommendationsPage from "../../src/ui/recommendations/RecommendationsPage";
import { makeEffectCycle } from "./effect-cycle-fixture";

vi.mock("../../src/ui/api/client");

// GoalSelector and the recommendation cards mount on RecommendationsPage and call feedback-client
// functions on load. Mock the entire module so those calls never touch global fetch
// (which is sequenced-mocked per-test for the UA3 lifecycle write paths).
vi.mock("../../src/ui/api/feedback-client", () => ({
  FeedbackClientError: class FeedbackClientError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
    ) {
      super(`Feedback request failed (${code}, HTTP ${status}).`);
      this.name = "FeedbackClientError";
    }
  },
  listFeedback: vi.fn().mockResolvedValue({ data: [], meta: { ts: 0 } }),
  setFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  undoFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  deleteFeedback: vi.fn().mockResolvedValue({ data: {}, meta: { ts: 0 } }),
  getGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
  setGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
  resetGoal: vi.fn().mockResolvedValue({
    data: { scope_key: "__global__", goal: "PRESERVE_QUALITY" },
    meta: { ts: 0 },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  window.location.hash = "#/recommendations";
  vi.mocked(client.fetchRecommendations).mockResolvedValue(trackableRecommendations());
  vi.mocked(client.fetchLedger).mockResolvedValue(mockLedger());
  vi.mocked(client.fetchPractices).mockResolvedValue(mockPractices());
  vi.mocked(client.fetchEfficiencyHeadroom).mockResolvedValue(mockEfficiencyHeadroom());
  vi.mocked(client.fetchHookConfig).mockResolvedValue(mockHookConfigResponse(false));
  __resetHookInstallCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetHookInstallCache();
});

function response(status = 200, body: unknown = undefined): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function trackedEffectResponse(recId: string) {
  return response(200, {
    supported: true,
    cycle: makeEffectCycle({ recId }),
  });
}

function trackableRecommendations() {
  const view = mockRecommendations();
  if (view.data === null) throw new Error("missing recommendation fixture");
  return {
    ...view,
    data: {
      ...view.data,
      active: view.data.active.map((rec) => ({
        ...rec,
        effect_capability: { mode: "TRACKABLE" as const, reason: null },
      })),
      // The page derives these groups from active cards. Retaining pre-ESF
      // group projections would leave the guided card without its capability.
      active_groups: [],
    },
  };
}

async function loaded() {
  const result = render(<RecommendationsPage />);
  await waitFor(() => expect(lifecycleCard()).toBeTruthy());
  // The shared scenario also has a D1 action. Exercise the D2 member's copy.
  fireEvent.click(within(lifecycleCard()).getByRole("button", { name: "Copy instruction" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "I completed the change" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "I completed the change" }));
  expect(within(lifecycleCard()).getByRole("button", { name: "Track" })).toBeTruthy();
  return result;
}

function lifecycleCard(): HTMLElement {
  const card = Array.from(document.querySelectorAll<HTMLElement>(".rec-card")).find((item) =>
    item.textContent?.includes("Use /clear between unrelated tasks"),
  );
  if (!card) throw new Error("missing D2 recommendation card");
  return card;
}

async function commit(action: "Track" | "Dismiss") {
  fireEvent.click(within(lifecycleCard()).getByRole("button", { name: action }));
  const pending = action === "Track" ? "Track" : action;
  expect(screen.getAllByText(`${pending} pending \u2014 Undo`).length).toBeGreaterThan(0);
  await act(async () => {
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function tokenAndPostCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([url]) =>
      typeof url === "string" &&
      (url === "/api/token" ||
        url.startsWith("/api/recommendations/") ||
        url.startsWith("/api/esf/effects/")),
  );
}

function saveAlert() {
  return screen
    .getAllByRole("alert")
    .find((element) => element.textContent?.includes("Could not save:"));
}

describe("RecommendationsPage \u2014 UA3 lifecycle writes", () => {
  it.each([
    ["network rejection", () => Promise.reject(new TypeError("network unavailable"))],
    ["401", () => Promise.resolve(response(401))],
    ["403", () => Promise.resolve(response(403))],
    ["409", () => Promise.resolve(response(409))],
  ])("shows an alert and Retry after %s", async (_label, failure) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { token: "first-token" }))
      .mockImplementationOnce(failure);
    vi.stubGlobal("fetch", fetchMock);
    await loaded();
    vi.useFakeTimers();

    await commit("Track");

    const alert = saveAlert();
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("Could not save:");
    expect(alert?.textContent).toContain("Retry");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(tokenAndPostCalls(fetchMock)).toHaveLength(2);
  });

  it("retries immediately with a fresh token, persists, and refreshes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { token: "stale-token" }))
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(response(200, { token: "fresh-token" }))
      .mockResolvedValueOnce(trackedEffectResponse("rec-D2-global-mock000000000000"));
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = trackableRecommendations();
    const adopted = refreshed.data?.active[0];
    if (!refreshed.data || !adopted) throw new Error("missing recommendation fixture");
    refreshed.data.active = [];
    refreshed.data.active_groups = [];
    refreshed.data.adopted = [
      {
        ...adopted,
        state: "ADOPTED",
        effect_cycle: makeEffectCycle({
          recId: adopted.rec_id,
          detectorId: adopted.detector_id,
          metricId: adopted.target_metric,
        }),
      },
    ];
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(trackableRecommendations())
      .mockResolvedValue(refreshed);
    await loaded();
    vi.useFakeTimers();

    await commit("Track");
    expect(saveAlert()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryAllByText("Track pending \u2014 Undo")).toHaveLength(0);
    await settle();

    expect(screen.getByRole("button", { name: "Stop measurement" })).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/esf/effects/track",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "stale-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/esf/effects/track",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "fresh-token" }),
      }),
    );
    expect(screen.queryAllByText("Track pending \u2014 Undo")).toHaveLength(0);
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it.each([
    ["a failed token response", response(503)],
    ["a token response without a token", response(200, {})],
    ["an empty token", response(200, { token: "" })],
  ])("does not POST after %s and retries with a new valid token", async (_label, badToken) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(badToken)
      .mockResolvedValueOnce(response(200, { token: "replacement-token" }))
      .mockResolvedValueOnce(trackedEffectResponse("rec-D2-global-mock000000000000"));
    vi.stubGlobal("fetch", fetchMock);
    await loaded();
    vi.useFakeTimers();

    await commit("Track");

    expect(saveAlert()?.textContent).toContain("Unable to authorize this change");
    expect(tokenAndPostCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/esf/effects/track",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "replacement-token" }),
      }),
    );
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("retries a failed Dismiss write and refreshes the dismissed view", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { token: "dismiss-first" }))
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(response(200, { token: "dismiss-retry" }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = trackableRecommendations();
    const dismissed = refreshed.data?.active[0];
    if (!refreshed.data || !dismissed) throw new Error("missing recommendation fixture");
    refreshed.data.active = [];
    refreshed.data.active_groups = [];
    refreshed.data.dismissed = [
      { ...dismissed, state: "DISMISSED", dismissed_until: "2026-10-05T00:00:00.000Z" },
    ];
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(trackableRecommendations())
      .mockResolvedValue(refreshed);
    const { container } = await loaded();
    vi.useFakeTimers();

    await commit("Dismiss");
    expect(saveAlert()?.textContent).toContain("HTTP 409");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/recommendations/dismiss",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "dismiss-retry" }),
      }),
    );
    expect(container.querySelector(".rec-dismissed-list")?.textContent).toContain(dismissed.lever);
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("allows only one write while the action is saving", async () => {
    let finishPost: ((value: Response) => void) | undefined;
    const post = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { token: "only-token" }))
      .mockReturnValueOnce(post);
    vi.stubGlobal("fetch", fetchMock);
    await loaded();
    vi.useFakeTimers();

    fireEvent.click(within(lifecycleCard()).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(lifecycleCard()).getByRole("button", { name: "Dismiss" }));
    expect(screen.getAllByText("Dismiss pending \u2014 Undo").length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(screen.getByText("Saving change\u2026")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(within(lifecycleCard()).getByRole("button", { name: "Dismiss" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishPost?.(response(200));
    await settle();
    expect(vi.mocked(client.fetchRecommendations).mock.calls.length).toBeGreaterThan(1);
  });

  it("cancels an uncommitted undo on unmount and does not report lifecycle success after remount", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = await loaded();
    vi.useFakeTimers();

    fireEvent.click(within(lifecycleCard()).getByRole("button", { name: "Track" }));
    expect(screen.getAllByText("Track pending \u2014 Undo").length).toBeGreaterThan(0);
    first.unmount();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.useRealTimers();
    render(<RecommendationsPage />);
    await waitFor(() => expect(lifecycleCard()).toBeTruthy());
    expect(screen.queryByText("Tracking saved")).toBeNull();
    expect(screen.queryByText("Dismissal saved")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // uip-6: D5 limit warning is now a slim banner; the old inline Acknowledge/adopt path was removed.
  it("renders a visible D5 limit warning as a slim calibrate banner", async () => {
    const initial = mockRecommendations();
    const warning = initial.data?.active[0];
    if (!initial.data || !warning) throw new Error("missing recommendation fixture");
    const d5Warning = {
      ...warning,
      rec_id: "rec-d5-warning",
      detector_id: "D5",
      category: "LIMIT",
      modeled_savings_u_per_wk: null,
      modeled_formula: { model: "warning", inputs: {}, kind: "WARNING" },
    };
    initial.data.active = [];
    initial.data.active_groups = [];
    initial.data.limit_warnings = [d5Warning];
    vi.mocked(client.fetchRecommendations).mockResolvedValue(initial);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<RecommendationsPage />);

    // Wait for the slim banner strip to appear
    await waitFor(() => expect(container.querySelector(".limit-warning-strip")).not.toBeNull());

    const strip = container.querySelector(".limit-warning-strip");

    // \u26a0 icon present
    expect(strip?.querySelector(".limit-warning-strip-icon")?.textContent).toContain("\u26a0");

    // "Limit warning {lever}" text
    const textEl = strip?.querySelector(".limit-warning-strip-text");
    expect(textEl?.textContent).toContain("Limit warning");
    expect(textEl?.textContent).toContain(d5Warning.lever);

    // "Calibrate budget hook" link navigates to calibration settings
    const calibrateLink = strip?.querySelector("a.limit-warning-strip-action") as HTMLAnchorElement;
    expect(calibrateLink).not.toBeNull();
    expect(calibrateLink.getAttribute("href")).toBe("#/settings?section=calibration");

    // NO Acknowledge button \u2014 the inline adopt path was removed by uip-6
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();

    // NO adopt fetch \u2014 the banner is purely informational with a link, no write path
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
