/**
 * UI API response-cache behavior.
 * Uses only synthetic aggregate-shaped response data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESPONSE_CACHE_MAX_ENTRIES,
  RESPONSE_CACHE_TTL_MS,
  fetchCachedJson,
  getCachedResponse,
  getLastFetchTimestamp,
  getResponseCacheKey,
  networkOnlyFetchTimestamps,
  resetDatabase,
  responseCache,
} from "../../src/ui/api/client";

describe("UI API response cache", () => {
  const endpoint = "/api/cache-test";
  const params = { preset: "7d" };

  beforeEach(() => {
    responseCache.clear();
    networkOnlyFetchTimestamps.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a fresh cached value without another network fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ count: 1 }), { status: 200 }));

    await expect(fetchCachedJson<{ count: number }>(endpoint, params)).resolves.toEqual({
      count: 1,
    });
    await expect(fetchCachedJson<{ count: number }>(endpoint, params)).resolves.toEqual({
      count: 1,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getCachedResponse<{ count: number }>(endpoint, params)).toEqual({ count: 1 });
  });

  it("refetches after TTL expiry and advances the recorded fetch timestamp", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 2 }), { status: 200 }));

    await fetchCachedJson<{ count: number }>(endpoint, params);
    const firstFetchedAt = getLastFetchTimestamp(endpoint, params);

    vi.advanceTimersByTime(RESPONSE_CACHE_TTL_MS + 1);

    await expect(fetchCachedJson<{ count: number }>(endpoint, params)).resolves.toEqual({
      count: 2,
    });
    const secondFetchedAt = getLastFetchTimestamp(endpoint, params);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(firstFetchedAt).toBeDefined();
    expect(secondFetchedAt).toBeDefined();
    expect(secondFetchedAt).toBeGreaterThan(firstFetchedAt as number);
  });

  it("bounds distinct entries and evicts the oldest fetch timestamp", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    for (let index = 0; index < 200; index += 1) {
      await fetchCachedJson("/api/bounded-cache", { index });
      vi.advanceTimersByTime(1);
    }

    expect(responseCache.size).toBeLessThanOrEqual(RESPONSE_CACHE_MAX_ENTRIES);
    expect(getLastFetchTimestamp("/api/bounded-cache", { index: 0 })).toBeUndefined();
    expect(responseCache.has(getResponseCacheKey("/api/bounded-cache", { index: 0 }))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(200);
  });

  it("removes expired entries on reads and before an insertion at capacity", async () => {
    const expiredKey = getResponseCacheKey("/api/expired-read");
    responseCache.set(expiredKey, {
      data: { stale: true },
      fetchedAt: Date.now() - RESPONSE_CACHE_TTL_MS,
    });

    expect(getCachedResponse("/api/expired-read")).toBeUndefined();
    expect(responseCache.has(expiredKey)).toBe(false);

    for (let index = 0; index < RESPONSE_CACHE_MAX_ENTRIES; index += 1) {
      responseCache.set(getResponseCacheKey("/api/expired-sweep", { index }), {
        data: { index },
        fetchedAt: Date.now() - RESPONSE_CACHE_TTL_MS,
      });
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ fresh: true }), { status: 200 }),
    );

    await fetchCachedJson("/api/expired-sweep", { index: "fresh" });

    expect(responseCache.size).toBe(1);
    expect(getCachedResponse("/api/expired-sweep", { index: "fresh" })).toEqual({ fresh: true });
  });

  it("keeps network-only payloads out of the response cache and timestamps only successes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ live: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

    await fetchCachedJson("/api/live");

    expect(responseCache.has(getResponseCacheKey("/api/live"))).toBe(false);
    expect(getCachedResponse("/api/live")).toBeUndefined();
    expect(getLastFetchTimestamp("/api/live")).toBe(Date.now());

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchCachedJson("/api/status", undefined, undefined, controller.signal),
    ).rejects.toThrow();

    expect(responseCache.has(getResponseCacheKey("/api/status"))).toBe(false);
    expect(getLastFetchTimestamp("/api/status")).toBeUndefined();
  });

  it("does not populate the cache when a successful mutation completes during a fetch", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const pending = fetchCachedJson("/api/generation-guard");
    await resetDatabase();
    resolveFetch?.(new Response(JSON.stringify({ late: true }), { status: 200 }));

    await expect(pending).resolves.toEqual({ late: true });
    expect(responseCache.has(getResponseCacheKey("/api/generation-guard"))).toBe(false);
  });

  it("does not cache rejected fetches and retries them", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry: true }), { status: 200 }));

    await expect(fetchCachedJson("/api/retry")).rejects.toThrow();
    expect(responseCache.has(getResponseCacheKey("/api/retry"))).toBe(false);

    await expect(fetchCachedJson("/api/retry")).resolves.toEqual({ retry: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent reads for the same cache key", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = fetchCachedJson<{ count: number }>(endpoint, params);
    const second = fetchCachedJson<{ count: number }>(endpoint, params);
    resolveFetch?.(new Response(JSON.stringify({ count: 2 }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([{ count: 2 }, { count: 2 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("lets one coalesced caller abort without cancelling the other caller", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const controller = new AbortController();
    const aborted = fetchCachedJson(endpoint, params, endpoint, controller.signal);
    const active = fetchCachedJson(endpoint, params);

    controller.abort();
    resolveFetch?.(new Response(JSON.stringify({ shared: true }), { status: 200 }));

    await expect(aborted).rejects.toThrow();
    await expect(active).resolves.toEqual({ shared: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels the shared transport after every coalesced caller aborts", async () => {
    let transportSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal as AbortSignal;
          transportSignal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchCachedJson(endpoint, params, endpoint, firstController.signal);
    const second = fetchCachedJson(endpoint, params, endpoint, secondController.signal);

    firstController.abort();
    expect(transportSignal?.aborted).toBe(false);
    secondController.abort();

    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(transportSignal?.aborted).toBe(true);
  });

  it("removes a rejected shared request so a retry starts a new transport", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry: true }), { status: 200 }));

    await expect(
      Promise.all([fetchCachedJson("/api/shared-retry"), fetchCachedJson("/api/shared-retry")]),
    ).rejects.toThrow();
    await expect(fetchCachedJson("/api/shared-retry")).resolves.toEqual({ retry: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
