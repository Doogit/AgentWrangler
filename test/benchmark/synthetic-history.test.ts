import { describe, expect, it } from "vitest";
import {
  type RoutePhase,
  type RoutePhaseSamples,
  movingWindowPath,
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
      moving_window: { elapsed_ms: [5, 6, 7, 8], response_bytes: [50, 60, 70, 80] },
    };

    const summary = summarizeRoutePhases(phases);

    expect(Object.keys(summary)).toEqual([
      "cold_process",
      "cold_query",
      "warm_explicit_window",
      "moving_window",
    ]);
    expect(summary.warm_explicit_window.elapsed_ms).toMatchObject({ p50_ms: 2, p95_ms: 4 });
    expect(summary.moving_window.elapsed_ms).toMatchObject({ p50_ms: 6, p95_ms: 8 });
  });

  it("advances fixture-anchored explicit windows instead of clock-relative presets", () => {
    const first = new URL(
      movingWindowPath("/api/overview?bucket=day&preset=7d"),
      "http://localhost",
    );
    const later = new URL(movingWindowPath("/api/overview?bucket=day", 6), "http://localhost");

    expect(first.searchParams.get("preset")).toBeNull();
    expect(first.searchParams.get("from")).toBe("2026-01-01T00:00:00.000Z");
    expect(first.searchParams.get("to")).toBe("2026-01-08T00:00:00.000Z");
    expect(later.searchParams.get("from")).toBe("2026-01-07T00:00:00.000Z");
    expect(later.searchParams.get("to")).toBe("2026-01-14T00:00:00.000Z");
  });
});
