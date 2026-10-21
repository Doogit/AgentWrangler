/**
 * test/ui/status-poller.test.tsx — P2-U5: one /api/status poller per browser (poll-first, D6).
 *
 * Oracle: mocked /api/status bodies with hand-set `data_scopes` counters, and the request counts
 * the real TanStack client makes for the Overview page key vs its `live,status` subset key.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../src/ui/api/client";
import { DaemonUnreachableError } from "../../src/ui/api/daemon-fetch";
import {
  STATUS_BUSY_POLL_MS,
  STATUS_POLL_MS,
  type StatusChannel,
  type StatusLocks,
  createStatusPoller,
} from "../../src/ui/api/status-poller";

// The shared poller (App's) reads client.fetchStatus; the unit tests inject their own.
const { shellFetchStatus } = vi.hoisted(() => ({ shellFetchStatus: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/api/client")>();
  return { ...actual, fetchStatus: shellFetchStatus };
});

type Scopes = { live: number; ingest: number; detectors: number; lifecycle: number; clock: number };
const BASE: Scopes = { live: 1, ingest: 1, detectors: 1, lifecycle: 1, clock: 1 };

function status(over: Partial<Scopes> = {}, extra: Partial<DaemonStatus> = {}, version = 10) {
  return {
    sessions: 1,
    files_seen: 1,
    files_parsed: 1,
    data_version: version,
    data_scopes: { ...BASE, ...over },
    ...extra,
  } as DaemonStatus;
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Mounts the Overview page key and its live,status subset; counts each one's fetches. */
function mountOverviewKeys(client: QueryClient) {
  const counts = { page: 0, live: 0 };
  function Keys() {
    useQuery(
      {
        queryKey: ["overview-view", "7d"],
        queryFn: async () => {
          counts.page++;
          return counts.page;
        },
      },
      client,
    );
    useQuery(
      {
        queryKey: ["overview-view", "7d", "live,status"],
        queryFn: async () => {
          counts.live++;
          return counts.live;
        },
        staleTime: Number.POSITIVE_INFINITY,
      },
      client,
    );
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <Keys />
    </QueryClientProvider>,
  );
  return counts;
}

function sequence(...bodies: DaemonStatus[]) {
  let i = 0;
  return vi.fn(async () => bodies[Math.min(i++, bodies.length - 1)] as DaemonStatus);
}

describe("scope → invalidation (test 1)", () => {
  it("ingest refetches the page once; live refetches only live,status; no change → nothing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchStatus = sequence(
      status(),
      status({ live: 2 }),
      status({ live: 2, ingest: 2 }),
      status({ live: 2, ingest: 2 }),
    );
    const counts = mountOverviewKeys(client);
    const poller = createStatusPoller({ queryClient: client, fetchStatus, locks: null });
    poller.start();
    await advance(0);
    expect(counts).toEqual({ page: 1, live: 1 });

    await advance(STATUS_POLL_MS); // live moved
    expect(counts).toEqual({ page: 1, live: 2 });

    await advance(STATUS_POLL_MS); // ingest moved
    expect(counts.page).toBe(2);
    expect(counts.live).toBe(2);

    await advance(STATUS_POLL_MS); // nothing moved
    expect(counts).toEqual({ page: 2, live: 2 });
    poller.stop();
  });
});

describe("live tail does not recompute heavy sections (test 2)", () => {
  it("over 60 s of live bumps, the page is fetched once per ingest change", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let live = 1;
    let ingest = 1;
    const tail = setInterval(() => {
      live++;
    }, 2_000);
    const fetchStatus = vi.fn(async () => status({ live, ingest }));
    const counts = mountOverviewKeys(client);
    const poller = createStatusPoller({ queryClient: client, fetchStatus, locks: null });
    poller.start();
    await advance(0);
    await advance(30_000);
    ingest = 2;
    await advance(30_000);
    clearInterval(tail);
    expect(counts.page).toBe(2); // mount + one ingest change
    expect(counts.live).toBeGreaterThanOrEqual(4);
    poller.stop();
  });
});

describe("visibility (test 3)", () => {
  it("a hidden tab polls once, then never until visible; visible polls at once", async () => {
    hidden = true;
    const client = new QueryClient();
    const fetchStatus = vi.fn(async () => status());
    const poller = createStatusPoller({ queryClient: client, fetchStatus, locks: null });
    poller.start();
    await advance(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(0);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await advance(STATUS_POLL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    poller.stop();
  });
});

describe("cadence (test 4)", () => {
  it.each([
    [
      "pipeline reading",
      { pipeline: { phase: "reading", failed_phase: null } },
      STATUS_BUSY_POLL_MS,
    ],
    ["pre-ready boot", { boot_files_total: 12 }, STATUS_BUSY_POLL_MS],
    [
      "cold recs build",
      {
        jobs: [
          { kind: "recommendations", started_at: "2026-10-13T00:00:00.000Z", expected_ms: null },
        ],
      },
      STATUS_BUSY_POLL_MS,
    ],
    ["no jobs", { jobs: [] }, STATUS_POLL_MS],
    ["pipeline done", { pipeline: { phase: "done", failed_phase: null } }, STATUS_POLL_MS],
    ["scan error", { pipeline: { phase: "reading", failed_phase: "reading" } }, STATUS_POLL_MS],
  ])("%s → next poll in %s… ms", async (_label, extra, interval) => {
    const fetchStatus = vi.fn(async () => status({}, extra as Partial<DaemonStatus>));
    const poller = createStatusPoller({ queryClient: new QueryClient(), fetchStatus, locks: null });
    poller.start();
    await advance(0);
    await advance(interval - 1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

/** In-memory Web Locks: one holder at a time, FIFO queue; the holder keeps it until its promise settles. */
function fakeLocks(): StatusLocks {
  let held = false;
  const queue: Array<() => void> = [];
  const next = () => {
    const grant = queue.shift();
    if (grant) grant();
    else held = false;
  };
  return {
    request(_name, callback) {
      return new Promise((resolve) => {
        const grant = () => {
          held = true;
          void Promise.resolve(callback()).finally(() => {
            next();
            resolve(undefined);
          });
        };
        if (held) queue.push(grant);
        else grant();
      });
    },
  };
}

/** In-memory BroadcastChannel bus: a post reaches every other channel, never the sender. */
function fakeBus(): () => StatusChannel {
  const members = new Set<StatusChannel>();
  return () => {
    const channel: StatusChannel = {
      onmessage: null,
      postMessage(data) {
        for (const other of members) {
          if (other !== channel) queueMicrotask(() => other.onmessage?.({ data }));
        }
      },
      close() {
        members.delete(channel);
      },
    };
    members.add(channel);
    return channel;
  };
}

describe("leader tab (test 5)", () => {
  it("two tabs → one polls, both see the status; the follower takes over when the leader goes", async () => {
    const locks = fakeLocks();
    const channel = fakeBus();
    const fetchA = vi.fn(async () => status());
    const fetchB = vi.fn(async () => status());
    const a = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: fetchA,
      locks,
      channel,
    });
    const b = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: fetchB,
      locks,
      channel,
    });
    a.start();
    await advance(0);
    b.start();
    await advance(0);
    await advance(STATUS_POLL_MS * 2);
    expect(fetchA).toHaveBeenCalledTimes(3);
    expect(fetchB).not.toHaveBeenCalled();
    expect(b.getState().status?.data_version).toBe(10);

    a.stop();
    await advance(0);
    expect(fetchB).toHaveBeenCalledTimes(1);
    await advance(STATUS_POLL_MS);
    expect(fetchB).toHaveBeenCalledTimes(2);
    b.stop();
  });

  it("without navigator.locks, every tab polls", async () => {
    const fetchA = vi.fn(async () => status());
    const fetchB = vi.fn(async () => status());
    const a = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: fetchA,
      locks: null,
    });
    const b = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: fetchB,
      locks: null,
    });
    a.start();
    b.start();
    await advance(STATUS_POLL_MS);
    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(2);
    a.stop();
    b.stop();
  });
});

describe("daemon restart (test 6)", () => {
  it("a data_version drop invalidates every key once, after the 0–2 s jitter", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const fetchStatus = sequence(status({}, {}, 50), status({ live: 0, ingest: 0 }, {}, 3));
    const poller = createStatusPoller({
      queryClient: client,
      fetchStatus,
      locks: null,
      random: () => 0.5,
    });
    poller.start();
    await advance(0);
    invalidate.mockClear();
    await advance(STATUS_POLL_MS);
    await advance(999);
    expect(invalidate).not.toHaveBeenCalled();
    await advance(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toBeUndefined();
    await advance(STATUS_POLL_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});

describe("degraded state (test 7)", () => {
  it("2 misses → paused and a 30 s page fallback; 4 unreachable misses → unreachable; one success clears", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let down = false;
    const fetchStatus = vi.fn(async () => {
      if (down) throw new DaemonUnreachableError();
      return status();
    });
    const counts = mountOverviewKeys(client);
    const poller = createStatusPoller({ queryClient: client, fetchStatus, locks: null });
    poller.start();
    await advance(0);
    expect(poller.getState()).toMatchObject({ connected: true, paused: false, unreachable: false });

    down = true;
    await advance(STATUS_POLL_MS);
    expect(poller.getState()).toMatchObject({
      connected: false,
      paused: false,
      unreachable: false,
    });
    await advance(STATUS_POLL_MS);
    expect(poller.getState()).toMatchObject({ paused: true, unreachable: false });
    const pageAtPause = counts.page;
    await advance(30_000);
    expect(counts.page).toBe(pageAtPause + 1);
    expect(poller.getState()).toMatchObject({ paused: true, unreachable: true });

    down = false;
    await advance(STATUS_POLL_MS);
    expect(poller.getState()).toMatchObject({ connected: true, paused: false, unreachable: false });
    const pageAtRecovery = counts.page;
    await advance(60_000);
    expect(counts.page).toBe(pageAtRecovery);
    poller.stop();
  });

  it("a tab that never connected is unreachable on its first failure; a 503 never is", async () => {
    const fail = vi.fn(async () => {
      throw new DaemonUnreachableError();
    });
    const p1 = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: fail,
      locks: null,
    });
    p1.start();
    await advance(0);
    expect(p1.getState().unreachable).toBe(true);
    p1.stop();

    const http = vi.fn(async () => {
      throw new Error("/api/status returned 503");
    });
    const p2 = createStatusPoller({
      queryClient: new QueryClient(),
      fetchStatus: http,
      locks: null,
    });
    p2.start();
    await advance(STATUS_POLL_MS * 4);
    expect(p2.getState()).toMatchObject({ paused: true, unreachable: false });
    p2.stop();
  });
});

describe("paused header in the shell (test 7, assembled)", () => {
  it("shows 'Live updates paused — reconnecting' after 2 misses and clears on recovery", async () => {
    const { default: App } = await import("../../src/ui/App");
    const { _resetStatusPoller } = await import("../../src/ui/api/status-poller");
    _resetStatusPoller();
    let down = false;
    shellFetchStatus.mockImplementation(async () => {
      if (down) throw new DaemonUnreachableError();
      return status();
    });
    window.history.replaceState(null, "", "#/help");
    render(<App />);
    await advance(0);
    down = true;
    await advance(STATUS_POLL_MS);
    expect(screen.queryByText("Live updates paused — reconnecting")).toBeNull();
    await advance(STATUS_POLL_MS);
    expect(screen.getByText("Live updates paused — reconnecting")).toBeTruthy();
    down = false;
    await advance(STATUS_POLL_MS);
    expect(screen.queryByText("Live updates paused — reconnecting")).toBeNull();
    _resetStatusPoller();
    window.history.replaceState(null, "", "/");
  });
});

describe("poller census (test 8)", () => {
  const UI = join(__dirname, "../../src/ui");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // Every timer-driven refresh in src/ui. A new one fails this test: route it through the
  // status poller, or add it here with its reason.
  const ALLOWED: Record<string, number> = {
    // limits: upstream rate-limited, 180 s (§5 "Kept")
    "useForegroundPoll( overview/OverviewPage.tsx": 1,
    "useForegroundPoll( overview/UsageLimitsCard.tsx": 1,
    // the status poller itself has no setInterval / refetchInterval (setTimeout chain)
    // top-recs pending poll (2 s, only while the cold recs build answers `pending`) and the
    // kpi-first query's explicit `false`
    "refetchInterval overview/OverviewPage.tsx": 2,
    // stays: runs only during a user-triggered outcomes sync (P2-U3 cut, D7)
    "setInterval( settings/SettingsPage.tsx": 1,
    // clock ticks, not network
    "setInterval( nav/Sidebar.tsx": 1,
    "setInterval( overview/LiveStrip.tsx": 1,
    "setInterval( overview/UsageLimitsCard.tsx": 1,
    "setInterval( shell/LoadProgress.tsx": 1,
    // OV-13: the elapsed-seconds display ticker while a section builds (no fetch).
    "setInterval( shell/SectionStatus.tsx": 1,
  };

  it("finds only the allow-listed pollers", () => {
    const found: Record<string, number> = {};
    for (const file of files(UI)) {
      const src = strip(readFileSync(file, "utf8"));
      const rel = relative(UI, file).replace(/\\/g, "/");
      for (const pattern of ["useForegroundPoll(", "setInterval(", "refetchInterval"]) {
        if (rel === "lib/use-foreground-poll.ts" && pattern === "useForegroundPoll(") continue;
        const n = src.split(pattern).length - 1;
        if (n > 0) found[`${pattern} ${rel}`] = n;
      }
    }
    expect(found).toEqual(ALLOWED);
  });
});
