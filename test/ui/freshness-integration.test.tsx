import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCachedJson,
  getCachedResponse,
  getLastFetchTimestamp,
  getResponseCacheKey,
  networkOnlyFetchTimestamps,
  responseCache,
} from "../../src/ui/api/client";
import { mockLiveSessions } from "../../src/ui/api/fixtures";
import { STATUS_POLL_MS, _resetStatusPoller } from "../../src/ui/api/status-poller";
import Sidebar from "../../src/ui/nav/Sidebar";
import OverviewPage from "../../src/ui/overview/OverviewPage";

vi.hoisted(() => vi.stubEnv("MODE", "development"));
let failed = false;
/** The status's `ingest` counter; bumping it is what makes the page refetch (P2-U5). */
let ingest = 1;
let statusCount = 0;
let pageCount = 0;
let limitsCount = 0;
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
const CachedRoute = () => {
  const [data, setData] = useState(() => getCachedResponse<{ label: string }>("/api/route-cache"));
  useEffect(() => {
    void fetchCachedJson<{ label: string }>("/api/route-cache").then(setData);
  }, []);
  return <p>{data?.label ?? "Loading cached route"}</p>;
};

beforeEach(() => {
  vi.useFakeTimers();
  responseCache.clear();
  networkOnlyFetchTimestamps.clear();
  failed = false;
  ingest = 1;
  statusCount = pageCount = limitsCount = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = String(url);
    if (path === "/api/status") {
      statusCount++;
      if (failed) throw new Error("unreachable");
      return new Response(
        JSON.stringify({
          sessions: 1,
          files_seen: 1,
          files_parsed: 1,
          data_version: 1,
          data_scopes: { live: 1, ingest, detectors: 1, lifecycle: 1, clock: 1 },
        }),
      );
    }
    // P1-U4: the Overview reads live (and its own status) from its one page request. Sections
    // left out arrive missing and render their own error cards.
    if (path === "/api/overview-view?preset=7d") {
      pageCount++;
      if (failed) throw new Error("unreachable");
      const ok = (data: unknown) => ({ status: "ok", data, ms: 0 });
      return new Response(
        JSON.stringify({
          data_version: 1,
          consistent: true,
          window: mockLiveSessions().meta.window,
          sections: {
            status: ok({ sessions: 1, files_seen: 1, files_parsed: 1 }),
            live: ok({
              next_cursor: null,
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
            }),
          },
        }),
      );
    }
    if (path === "/api/query/limits") {
      limitsCount++;
      if (failed) throw new Error("unreachable");
      return new Response(
        JSON.stringify({
          state: "signed-out",
          asOf: new Date().toISOString(),
          stale: false,
          rows: [],
          live: { sessions: 0, runningSpendUsd: 0 },
        }),
      );
    }
    if (path === "/api/route-cache") {
      return new Response(JSON.stringify({ label: "Cached route data" }));
    }
    // Unrelated sections have their own existing error handling.
    return new Response("unavailable", { status: 503 });
  });
});
afterEach(() => {
  cleanup();
  _resetStatusPoller();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Overview and Sidebar freshness with real client transport", () => {
  it("shares status polling, refreshes each endpoint, retains data on failure and recovers", async () => {
    mount();
    await advance(0);
    expect(statusCount).toBe(1);
    expect(pageCount).toBe(1);
    expect(limitsCount).toBe(1);
    expect(screen.getByText("Daemon Connected")).toBeTruthy();
    expect(screen.getByText(/Last status check:/)).toBeTruthy();
    expect(screen.queryByText(/Last ingest:/)).toBeNull();
    expect(screen.getByText("Local history unavailable")).toBeTruthy();
    expect(screen.getByText(/Restart AgentWrangler/)).toBeTruthy();
    // Limits polls every 180s (matches claude.ai's usage page). P2-U5: the shared status poller
    // runs every 15 s, and the page refetches only when a scope it reads moves.
    await advance(180_000);
    expect(statusCount).toBe(1 + 180_000 / STATUS_POLL_MS);
    expect(pageCount).toBe(1);
    expect(limitsCount).toBe(2);
    expect(screen.getByText("updated 0s ago")).toBeTruthy();
    ingest = 2;
    await advance(STATUS_POLL_MS);
    expect(pageCount).toBe(2);
    failed = true;
    await advance(180_000);
    expect(screen.getByText("Daemon Unreachable")).toBeTruthy();
    expect(screen.getByText(/Live session data unavailable/)).toBeTruthy();
    expect(screen.getByText("synthetic-workspace")).toBeTruthy();
    // BurnForecastCard removed in overview-v2; UsageLimitsCard retains last-good on error.
    expect(screen.getByText("updated 180s ago")).toBeTruthy();
    failed = false;
    await advance(180_000);
    expect(screen.getByText("Daemon Connected")).toBeTruthy();
    expect(screen.queryByText(/Live session data unavailable/)).toBeNull();
    // P1-U4: the failed refetch's retry backoff shifts the page query's 30 s interval phase, so
    // the recovered view is fresh within one poll cadence rather than exactly 0 s old.
    const freshness = screen.getByText(/^updated \d+s ago$/).textContent ?? "";
    expect(Number(freshness.match(/\d+/)?.[0])).toBeLessThan(30);
  });

  it.each(["hidden", "offline"])(
    "fires the initial request once even when %s, then pauses recurring polls (O3/O6)",
    async (state) => {
      if (state === "hidden")
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      else vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      mount();
      await advance(0);
      // The initial fetch runs even while hidden/offline so the UI reaches a
      // terminal state (no endless skeleton / "Checking…" widget — O3/O6).
      expect([statusCount, pageCount, limitsCount]).toEqual([1, 1, 1]);
      // Recurring polls stay paused while hidden (battery optimization). The status poller, like
      // the page query (networkMode "always"), ignores navigator.onLine — the daemon is on
      // 127.0.0.1 — so offline it keeps its 15 s cadence (8 more by 120 s). The page refetches
      // only on a scope change (P2-U5).
      await advance(120_000);
      expect([statusCount, pageCount, limitsCount]).toEqual(
        state === "hidden" ? [1, 1, 1] : [9, 1, 1],
      );
      act(() => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
        // The browser's own events: visibilitychange bubbles from document to window.
        if (state === "hidden")
          document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
        else window.dispatchEvent(new Event("online"));
      });
      await advance(0);
      // Becoming visible/online resumes polling; becoming visible polls status at once.
      expect([statusCount, pageCount, limitsCount]).toEqual(
        state === "hidden" ? [2, 1, 2] : [9, 1, 2],
      );
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
    await advance(STATUS_POLL_MS);
    expect(statusCount).toBe(2);
  });

  it("renders a cached route synchronously after navigation without another request", async () => {
    const routeRequests = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url) === "/api/route-cache")
        .length;
    const firstView = render(<CachedRoute />);
    await advance(0);
    expect(screen.getByText("Cached route data")).toBeTruthy();
    expect(routeRequests()).toBe(1);

    firstView.unmount();
    const requestCountBeforeRemount = routeRequests();
    render(<CachedRoute />);

    expect(screen.getByText("Cached route data")).toBeTruthy();
    expect(routeRequests()).toBe(requestCountBeforeRemount);
    await advance(0);
    expect(routeRequests()).toBe(requestCountBeforeRemount);
  });

  it("retains network-only freshness timestamps without retaining their payloads", async () => {
    mount();
    await advance(0);

    expect(getLastFetchTimestamp("/api/status")).toBe(Date.now());
    expect(responseCache.has(getResponseCacheKey("/api/status"))).toBe(false);
    // P1-U4: the Overview no longer reads /api/live; its page request is TanStack-owned (`fresh`)
    // and never enters responseCache.
    expect(responseCache.has(getResponseCacheKey("/api/overview-view", { preset: "7d" }))).toBe(
      false,
    );
    expect(screen.getByText(/Last status check: just now/)).toBeTruthy();
    expect(screen.getByText("updated 0s ago")).toBeTruthy();
  });
});
