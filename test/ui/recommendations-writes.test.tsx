/**
 * UA3 recommendation lifecycle writes. These are page-level tests: RecCard owns
 * the undo UI, while RecommendationsPage obtains a fresh token and persists it.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("../../src/ui/api/client");

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  window.location.hash = "#/recommendations";
  vi.mocked(client.fetchRecommendations).mockResolvedValue(mockRecommendations());
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

async function loaded() {
  const result = render(<RecommendationsPage />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Show guided prompt" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show guided prompt" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "I completed the change" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "I completed the change" }));
  expect(screen.getByRole("button", { name: "Track this change" })).toBeTruthy();
  return result;
}

async function commit(action: "Track this change" | "Dismiss") {
  fireEvent.click(screen.getByRole("button", { name: action }));
  const pending = action === "Track this change" ? "Adopt" : action;
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
      typeof url === "string" && (url === "/api/token" || url.startsWith("/api/recommendations/")),
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

    await commit("Track this change");

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
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);
    const refreshed = mockRecommendations();
    const adopted = refreshed.data?.active[0];
    if (!refreshed.data || !adopted) throw new Error("missing recommendation fixture");
    refreshed.data.active = [];
    refreshed.data.active_groups = [];
    refreshed.data.adopted = [{ ...adopted, state: "ADOPTED" }];
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(mockRecommendations())
      .mockResolvedValue(refreshed);
    await loaded();
    vi.useFakeTimers();

    await commit("Track this change");
    expect(saveAlert()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryAllByText("Adopt pending \u2014 Undo")).toHaveLength(0);
    await settle();

    expect(screen.queryByRole("button", { name: "Track this change" })).toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/recommendations/adopt",
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
      "/api/recommendations/adopt",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "fresh-token" }),
      }),
    );
    expect(screen.queryAllByText("Adopt pending \u2014 Undo")).toHaveLength(0);
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
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);
    await loaded();
    vi.useFakeTimers();

    await commit("Track this change");

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
      "/api/recommendations/adopt",
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
    const refreshed = mockRecommendations();
    const dismissed = refreshed.data?.active[0];
    if (!refreshed.data || !dismissed) throw new Error("missing recommendation fixture");
    refreshed.data.active = [];
    refreshed.data.active_groups = [];
    refreshed.data.dismissed = [
      { ...dismissed, state: "DISMISSED", dismissed_until: "2026-10-05T00:00:00.000Z" },
    ];
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(mockRecommendations())
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

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getAllByText("Dismiss pending \u2014 Undo").length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(screen.getByText("Saving change\u2026")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Track this change" }));
    expect(screen.getAllByText("Adopt pending \u2014 Undo").length).toBeGreaterThan(0);
    first.unmount();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.useRealTimers();
    render(<RecommendationsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show guided prompt" })).toBeTruthy(),
    );
    expect(screen.queryByText("Tracking saved")).toBeNull();
    expect(screen.queryByText("Dismissal saved")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges a visible D5 limit warning through the existing adopt write", async () => {
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
    const refreshed = structuredClone(initial);
    if (!refreshed.data) throw new Error("missing refreshed recommendations");
    refreshed.data.limit_warnings = [];
    refreshed.data.adopted = [{ ...d5Warning, state: "ADOPTED" }];
    vi.mocked(client.fetchRecommendations)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(refreshed);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { token: "d5-token" }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    render(<RecommendationsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy());
    vi.useFakeTimers();
    expect(screen.getByRole("link", { name: "Calibrate budget hook" }).getAttribute("href")).toBe(
      "#/settings?section=calibration",
    );
    expect(screen.queryByRole("button", { name: "Track this change" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(screen.getAllByText("Adopt pending \u2014 Undo").length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/recommendations/adopt",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rec_id: "rec-d5-warning" }),
        headers: expect.objectContaining({ "X-AgentWrangler-Token": "d5-token" }),
      }),
    );
  });
});
