import { describe, expect, it } from "vitest";
import {
  summarizeBrowserSamples,
  syntheticBenchmarkApiPath,
} from "../../scripts/benchmark/browser-measure.js";

describe("syntheticBenchmarkApiPath", () => {
  it("rewrites real-clock API presets to the populated synthetic window", () => {
    expect(syntheticBenchmarkApiPath("/api/overview?preset=7d")).toBe(
      "/api/overview?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-15T00%3A00%3A00.000Z",
    );
  });

  it("preserves API requests without a time preset", () => {
    expect(syntheticBenchmarkApiPath("/api/status")).toBe("/api/status");
  });
});

describe("summarizeBrowserSamples", () => {
  it("summarizes fixture-shaped CDP and Performance API measurements without a browser", () => {
    expect(
      summarizeBrowserSamples({
        cold: {
          navigation: { duration: 120 },
          overviewReadyMs: 240,
          requests: [{ requestId: "cold-document" }, { requestId: "cold-script" }],
        },
        warm: {
          navigation: { startTime: 10, loadEventEnd: 55 },
          overviewReadyMs: 75,
          requests: [
            { requestId: "warm-document" },
            { requestId: "warm-script", response: { fromDiskCache: true } },
            { requestId: "warm-style", fromPrefetchCache: true },
          ],
          retainedCacheEntries: [
            { transferSize: 0, initiatorType: "script" },
            { transferSize: 512, initiatorType: "css" },
            { transferSize: 0, initiatorType: "navigation" },
          ],
        },
        longTasks: [{ duration: 62.5 }, { duration: 0 }, { duration: 12.5 }],
        layoutDurations: [{ duration: 4.25 }, { duration: 1.75 }],
      }),
    ).toEqual({
      cold_navigation_ms: 120,
      warm_navigation_ms: 45,
      cold_overview_ready_ms: 240,
      warm_overview_ready_ms: 75,
      cold_request_count: 2,
      warm_request_count: 3,
      eligible_request_count: 0,
      duplicate_eligible_requests: 0,
      retained_cache_entries: 2,
      long_task_count: 2,
      long_task_total_ms: 75,
      long_task_max_ms: 62.5,
      layout_duration_ms: 6,
    });
  });

  it("counts duplicate network URLs within each document and excludes polling and cached duplicates", () => {
    const get = (requestId: string, path: string) => ({
      requestId,
      method: "GET",
      url: `http://127.0.0.1:26370${path}`,
    });
    const summary = summarizeBrowserSamples({
      cold: {
        requests: [
          get("a", "/api/overview?b=2&a=1"),
          get("b", "/api/overview?a=1&b=2"),
          get("c", "/api/workspaces"),
          { ...get("cached", "/api/workspaces"), response: { fromDiskCache: true } },
          get("poll-a", "/api/live"),
          get("poll-b", "/api/live"),
          { ...get("post", "/api/workspaces"), method: "POST" },
        ],
      },
      warm: { requests: [get("warm", "/api/workspaces")] },
    });
    expect(summary).toMatchObject({ eligible_request_count: 5, duplicate_eligible_requests: 1 });
  });
});
