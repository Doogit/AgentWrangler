import { describe, expect, it } from "vitest";
import { summarizeBrowserSamples } from "../../scripts/benchmark/browser-measure.js";

describe("summarizeBrowserSamples", () => {
  it("summarizes fixture-shaped CDP and Performance API measurements without a browser", () => {
    expect(
      summarizeBrowserSamples({
        cold: {
          navigation: { duration: 120 },
          requests: [{ requestId: "cold-document" }, { requestId: "cold-script" }],
        },
        warm: {
          navigation: { startTime: 10, loadEventEnd: 55 },
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
        commits: [{ duration: 4.25 }, { duration: 1.75 }],
      }),
    ).toEqual({
      cold_navigation_ms: 120,
      warm_navigation_ms: 45,
      cold_request_count: 2,
      warm_request_count: 3,
      retained_cache_entries: 2,
      long_task_count: 2,
      long_task_total_ms: 75,
      long_task_max_ms: 62.5,
      commit_duration_ms: 6,
    });
  });
});
