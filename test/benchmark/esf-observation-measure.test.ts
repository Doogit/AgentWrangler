import { describe, expect, it } from "vitest";
import { summarizeEsfMeasurement } from "../../scripts/benchmark/esf-observation-measure.js";

describe("summarizeEsfMeasurement", () => {
  it("groups hand-written CPU, RSS, and elapsed samples by scale", () => {
    expect(
      summarizeEsfMeasurement([
        {
          scale_turns: 1_000,
          elapsed_ms: 4,
          cpu_user_us: 100,
          cpu_system_us: 25,
          rss_bytes: 1_000,
        },
        {
          scale_turns: 1_000,
          elapsed_ms: 8,
          cpu_user_us: 200,
          cpu_system_us: 50,
          rss_bytes: 1_200,
        },
        {
          scale_turns: 10_000,
          elapsed_ms: 20,
          cpu_user_us: 500,
          cpu_system_us: 125,
          rss_bytes: 2_000,
        },
      ]),
    ).toEqual({
      by_scale: {
        "1000": {
          sample_count: 2,
          elapsed_ms: { min: 4, p50: 4, p95: 8, max: 8, mean: 6 },
          cpu_us: {
            user: { min: 100, p50: 100, p95: 200, max: 200, mean: 150 },
            system: { min: 25, p50: 25, p95: 50, max: 50, mean: 37.5 },
            total: { min: 125, p50: 125, p95: 250, max: 250, mean: 187.5 },
          },
          rss_bytes: { min: 1_000, p50: 1_000, p95: 1_200, max: 1_200, mean: 1_100 },
        },
        "10000": {
          sample_count: 1,
          elapsed_ms: { min: 20, p50: 20, p95: 20, max: 20, mean: 20 },
          cpu_us: {
            user: { min: 500, p50: 500, p95: 500, max: 500, mean: 500 },
            system: { min: 125, p50: 125, p95: 125, max: 125, mean: 125 },
            total: { min: 625, p50: 625, p95: 625, max: 625, mean: 625 },
          },
          rss_bytes: { min: 2_000, p50: 2_000, p95: 2_000, max: 2_000, mean: 2_000 },
        },
      },
    });
  });
});
