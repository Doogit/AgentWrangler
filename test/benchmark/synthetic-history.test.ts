import { describe, expect, it } from "vitest";
import {
  type RoutePhase,
  type RoutePhaseSamples,
  summarizePhase,
  summarizeRoutePhases,
} from "../../scripts/benchmark/synthetic-history.js";

describe("synthetic history benchmark summaries", () => {
  it("uses nearest-rank p50/p95 and includes spread fields", () => {
    const summary = summarizePhase([9, 1, 7, 3, 5]);

    expect(summary).toMatchObject({
      count: 5,
      p50_ms: 5,
      p95_ms: 9,
      min_ms: 1,
      max_ms: 9,
    });
    expect(summary.mean_ms).toBe(5);
    expect(summary.stddev_ms).toBeGreaterThan(0);
  });

  it("returns all phase keys with independently summarized samples", () => {
    const phases: Record<RoutePhase, RoutePhaseSamples> = {
      cold_process: { elapsed_ms: [40], response_bytes: [400] },
      cold_query: { elapsed_ms: [20], response_bytes: [200] },
      warm_explicit_window: { elapsed_ms: [1, 2, 3, 4], response_bytes: [10, 20, 30, 40] },
      moving_preset: { elapsed_ms: [5, 6, 7, 8], response_bytes: [50, 60, 70, 80] },
    };

    const summary = summarizeRoutePhases(phases);

    expect(Object.keys(summary)).toEqual([
      "cold_process",
      "cold_query",
      "warm_explicit_window",
      "moving_preset",
    ]);
    expect(summary.warm_explicit_window.elapsed_ms).toMatchObject({ p50_ms: 2, p95_ms: 4 });
    expect(summary.moving_preset.elapsed_ms).toMatchObject({ p50_ms: 6, p95_ms: 8 });
  });
});
