import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseCache } from "../../src/ui/api/client";
import { mockBurnStatus, mockLiveSessions } from "../../src/ui/api/fixtures";
import Sidebar from "../../src/ui/nav/Sidebar";
import OverviewPage from "../../src/ui/overview/OverviewPage";

vi.hoisted(() => vi.stubEnv("MODE", "development"));
let failed = false;
let statusCount = 0;
let liveCount = 0;
let burnCount = 0;
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const mount = (overview = true) =>
  render(
    <>
      <Sidebar active="overview" onNavigate={() => {}} />
      {overview && <OverviewPage />}
    </>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  responseCache.clear();
  failed = false;
  statusCount = liveCount = burnCount = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = String(url);
    if (path === "/api/status") {
      statusCount++;
      if (failed) throw new Error("unreachable");
      return new Response(JSON.stringify({ sessions: 1, files_seen: 1, files_parsed: 1 }));
    }
    if (path === "/api/live") {
      liveCount++;
      if (failed) throw new Error("unreachable");
      const live = mockLiveSessions();
      return new Response(
        JSON.stringify({
          ...live,
          data: {
            items: [
              {
                session_id: "synthetic-live",
                workspace_id: "synthetic-workspace",
                project_slug: "synthetic-workspace",
                repo_path: null,
                repo_owner: null,
                repo_name: null,
                model: "claude-sonnet-4",
                running_usd_u: 100,
                current_context_tokens: 100,
                started_at: null,
              },
            ],
          },
        }),
      );
    }
    if (path === "/api/burn-status") {
      burnCount++;
      if (failed) throw new Error("unreachable");
      const burn = mockBurnStatus();
      return new Response(
        JSON.stringify({
          ...burn,
          data: {
            available: true,
            five_hour: { utilization: 0.42, resets_at: "2026-09-06T06:00:00Z" },
            seven_day: { utilization: 0.2, resets_at: "2026-09-10T06:00:00Z" },
          },
        }),
      );
    }
    // Unrelated sections have their own existing error handling.
    return new Response("unavailable", { status: 503 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Overview and Sidebar freshness with real client transport", () => {
  it("shares status polling, refreshes each endpoint, retains data on failure and recovers", async () => {
    mount();
    await advance(0);
    expect(statusCount).toBe(1);
    expect(liveCount).toBe(1);
    expect(burnCount).toBe(1);
    expect(screen.getByText("Daemon Connected")).toBeTruthy();
    expect(screen.getByText(/Last status check:/)).toBeTruthy();
    expect(screen.queryByText(/Last ingest:/)).toBeNull();
    await advance(60_000);
    expect(statusCount).toBe(3);
    expect(liveCount).toBe(3);
    expect(burnCount).toBe(2);
    expect(screen.getByText("updated 0s ago")).toBeTruthy();
    failed = true;
    await advance(60_000);
    expect(screen.getByText("Daemon Unreachable")).toBeTruthy();
    expect(screen.getByText(/Live session data unavailable/)).toBeTruthy();
    expect(screen.getByText("synthetic-workspace")).toBeTruthy();
    expect(screen.getByLabelText("5-hour utilization 42%")).toBeTruthy();
    expect(screen.getByText(/Burn status refresh failed/)).toBeTruthy();
    expect(screen.getByText("updated 60s ago")).toBeTruthy();
    failed = false;
    await advance(60_000);
    expect(screen.getByText("Daemon Connected")).toBeTruthy();
    expect(screen.queryByText(/Live session data unavailable/)).toBeNull();
    expect(screen.queryByText(/Burn status refresh failed/)).toBeNull();
    expect(screen.getByText("updated 0s ago")).toBeTruthy();
  });

  it.each(["hidden", "offline"])(
    "does not initially request live, burn or status when %s",
    async (state) => {
      if (state === "hidden")
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      else vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      mount();
      await advance(120_000);
      expect([statusCount, liveCount, burnCount]).toEqual([0, 0, 0]);
      act(() => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
        window.dispatchEvent(new Event("online"));
      });
      await advance(0);
      expect([statusCount, liveCount, burnCount]).toEqual([1, 1, 1]);
    },
  );

  it("replays the shared status to a newly mounted Overview without another request", async () => {
    const view = mount(false);
    await advance(0);
    view.rerender(
      <>
        <Sidebar active="overview" onNavigate={() => {}} />
        <OverviewPage />
      </>,
    );
    await advance(0);
    expect(statusCount).toBe(1);
    expect(screen.queryByLabelText("Loading overview data")).toBeNull();
    await advance(30_000);
    expect(statusCount).toBe(2);
  });
});
