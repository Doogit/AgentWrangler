import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCachedJson, getLastFetchTimestamp, responseCache } from "../../src/ui/api/client";
import { useForegroundPoll } from "../../src/ui/lib/use-foreground-poll";

beforeEach(() => {
  vi.useFakeTimers();
  responseCache.clear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("foreground network polling", () => {
  it.each([
    ["/api/live", 30_000],
    ["/api/status", 30_000],
    ["/api/burn-status", 60_000],
  ] as const)(
    "refreshes %s on every interval and advances success timestamps",
    async (endpoint, interval) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(JSON.stringify({ count: 1 })));
      const success = vi.fn();
      renderHook(() =>
        useForegroundPoll(
          (signal) => fetchCachedJson(endpoint, undefined, undefined, signal),
          interval,
          success,
          vi.fn(),
        ),
      );
      await advance(0);
      const first = getLastFetchTimestamp(endpoint);
      await advance(interval * 3);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(success).toHaveBeenCalledTimes(4);
      expect(getLastFetchTimestamp(endpoint)).toBe((first ?? 0) + interval * 3);
    },
  );

  it("waits for a slow request to settle before scheduling another", async () => {
    let resolve!: (value: number) => void;
    const request = vi.fn(
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    const success = vi.fn();
    renderHook(() => useForegroundPoll(request, 30_000, success, vi.fn()));
    await advance(90_000);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => resolve(1));
    await advance(29_999);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["hidden", "offline"])("pauses when %s and resumes immediately", async (state) => {
    const request = vi.fn().mockResolvedValue(1);
    renderHook(() => useForegroundPoll(request, 30_000, vi.fn(), vi.fn()));
    await advance(0);
    const toggle = (paused: boolean) => {
      if (state === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue(paused ? "hidden" : "visible");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(!paused);
        window.dispatchEvent(new Event(paused ? "offline" : "online"));
      }
    };
    act(() => toggle(true));
    await advance(120_000);
    expect(request).toHaveBeenCalledTimes(1);
    act(() => toggle(false));
    await advance(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not overlap or publish an aborted response during rapid hide/resume", async () => {
    let resolve!: (value: number) => void;
    const request = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    const success = vi.fn();
    renderHook(() => useForegroundPoll(request, 30_000, success, vi.fn()));
    act(() => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(request.mock.calls[0]?.[0].aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => resolve(1));
    await advance(0);
    expect(success).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts on unmount, ignores late completion, and removes resume listeners", async () => {
    let resolve!: (value: number) => void;
    const request = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    const success = vi.fn();
    const { unmount } = renderHook(() => useForegroundPoll(request, 30_000, success, vi.fn()));
    unmount();
    expect(request.mock.calls[0]?.[0].aborted).toBe(true);
    await act(async () => resolve(1));
    window.dispatchEvent(new Event("online"));
    await advance(90_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
  });

  it("retries failures at a bounded cadence and recovers", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(2);
    const success = vi.fn();
    const error = vi.fn();
    renderHook(() => useForegroundPoll(request, 30_000, success, error));
    await advance(0);
    expect(error).toHaveBeenCalledTimes(1);
    await advance(29_999);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(success).toHaveBeenCalledWith(2);
  });

  it("forwards caller cancellation to fetch and preserves the eight-second timeout", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const controller = new AbortController();
    const cancelled = fetchCachedJson("/api/live", undefined, undefined, controller.signal);
    const cancellation = expect(cancelled).rejects.toThrow();
    controller.abort();
    await cancellation;
    expect(signals[0]?.aborted).toBe(true);
    const timed = fetchCachedJson("/api/live");
    const timeout = expect(timed).rejects.toThrow();
    await advance(7_999);
    expect(signals[1]?.aborted).toBe(false);
    await advance(1);
    await timeout;
    expect(signals[1]?.aborted).toBe(true);
    expect(getLastFetchTimestamp("/api/live")).toBeUndefined();
  });
});
