/**
 * test/ui/query-client.test.tsx — P1-U3 TanStack Query foundation.
 *
 * The oracle is the fetch mock's call count: an invalidation must reach the network even when
 * client.ts's responseCache holds a fresh entry or an older request is in flight, one key is one
 * request, and a client write helper invalidates TanStack's caches.
 *
 * Synthetic data only (SEC-101).
 */

import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCachedJson,
  fetchOverviewView,
  responseCache,
  saveSettings,
} from "../../src/ui/api/client";
import { queryClient } from "../../src/ui/api/query-client";
import { queryKeys } from "../../src/ui/api/query-keys";

let calls = 0;
let hold: Promise<void> | null = null;

function mockFetch() {
  calls = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls += 1;
    const n = calls;
    if (hold) await hold;
    return new Response(JSON.stringify({ data_version: n, sections: {} }), { status: 200 });
  });
}

function OverviewProbe({ label }: { label: string }) {
  const query = useQuery({
    queryKey: queryKeys.overviewView("7d"),
    queryFn: ({ signal }) => fetchOverviewView("7d", signal),
  });
  return <p data-testid={label}>{query.data?.data_version ?? "loading"}</p>;
}

function renderProbes(...labels: string[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      {labels.map((label) => (
        <OverviewProbe key={label} label={label} />
      ))}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  responseCache.clear();
  queryClient.clear();
  hold = null;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("TanStack Query foundation (P1-U3)", () => {
  it("1a. an invalidation refetch hits the network although responseCache holds a fresh entry", async () => {
    mockFetch();
    // A legacy read leaves a fresh responseCache entry for the same URL.
    await fetchCachedJson("/api/overview-view", { preset: "7d" }, "/api/overview-view?preset=7d");
    renderProbes("a");
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("2"));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.overviewView("7d") }));
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("3"));
    expect(calls).toBe(3);
  });

  it("1b. an invalidation refetch does not join a request that was already in flight", async () => {
    mockFetch();
    renderProbes("a");
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("1"));
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A legacy read (cache cold, so it goes to the network) starts first and is still in flight.
    responseCache.clear();
    const stale = fetchCachedJson(
      "/api/overview-view",
      { preset: "7d" },
      "/api/overview-view?preset=7d",
    );
    await act(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.overviewView("7d") });
    });
    expect(calls).toBe(3);
    hold = null;
    release();
    await stale;
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("3"));
  });

  it("2. two components with the same key make one network call", async () => {
    mockFetch();
    renderProbes("a", "b");
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("1"));
    expect(screen.getByTestId("a").textContent).toBe("1");
    expect(calls).toBe(1);
  });

  it("3. a client write helper invalidates the overview-view query", async () => {
    mockFetch();
    renderProbes("a");
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("1"));
    await act(async () => {
      await saveSettings({});
    });
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("2"));
    expect(calls).toBe(2);
  });
});
