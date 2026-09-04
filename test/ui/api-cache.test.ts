/**
 * UI API response-cache behavior.
 * Uses only synthetic aggregate-shaped response data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESPONSE_CACHE_TTL_MS,
  fetchCachedJson,
  getCachedResponse,
  getLastFetchTimestamp,
  responseCache,
} from "../../src/ui/api/client";

describe("UI API response cache", () => {
  const endpoint = "/api/cache-test";
  const params = { preset: "7d" };

  beforeEach(() => {
    responseCache.clear();
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
});
