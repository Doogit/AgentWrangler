/**
 * Synthetic-only measurement harness for the ESF observation cohort query.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/esf-observation-measure.ts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface EsfMeasurementSample {
  scale_turns: number;
  elapsed_ms: number;
  cpu_user_us: number;
  cpu_system_us: number;
  rss_bytes: number;
}

interface NumericSummary {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

interface EsfScaleMeasurementSummary {
  sample_count: number;
  elapsed_ms: NumericSummary;
  cpu_us: {
    user: NumericSummary;
    system: NumericSummary;
    total: NumericSummary;
  };
  rss_bytes: NumericSummary;
}

export interface EsfMeasurementSummary {
  by_scale: Record<string, EsfScaleMeasurementSummary>;
}

function summarizeNumbers(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error("Cannot summarize an empty measurement set");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
  return {
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

/** Pure per-scale numeric aggregation; it intentionally performs no database or file I/O. */
export function summarizeEsfMeasurement(samples: EsfMeasurementSample[]): EsfMeasurementSummary {
  const grouped = new Map<number, EsfMeasurementSample[]>();
  for (const sample of samples) {
    const scaleSamples = grouped.get(sample.scale_turns) ?? [];
    scaleSamples.push(sample);
    grouped.set(sample.scale_turns, scaleSamples);
  }

  const by_scale: Record<string, EsfScaleMeasurementSummary> = {};
  for (const [scale, scaleSamples] of [...grouped.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    by_scale[String(scale)] = {
      sample_count: scaleSamples.length,
      elapsed_ms: summarizeNumbers(scaleSamples.map((sample) => sample.elapsed_ms)),
      cpu_us: {
        user: summarizeNumbers(scaleSamples.map((sample) => sample.cpu_user_us)),
        system: summarizeNumbers(scaleSamples.map((sample) => sample.cpu_system_us)),
        total: summarizeNumbers(
          scaleSamples.map((sample) => sample.cpu_user_us + sample.cpu_system_us),
        ),
      },
      rss_bytes: summarizeNumbers(scaleSamples.map((sample) => sample.rss_bytes)),
    };
  }
  return { by_scale };
}

/** This checkout has no ESF observation query; never emit fabricated measurements. */
export function esfMeasurementAvailability(): {
  available: false;
  reason: string;
} {
  return {
    available: false,
    reason:
      "getEsfObservations is not implemented in this checkout. Integrate and verify the query and accounting-source watermark before enabling this benchmark.",
  };
}

function main(): void {
  console.log(JSON.stringify({ synthetic_only: true, ...esfMeasurementAvailability() }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
