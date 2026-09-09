/**
 * Synthetic-only measurement harness for the ESF observation cohort query.
 *
 * Run from the repository root:
 *   node --import tsx/esm scripts/benchmark/esf-observation-measure.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import {
  getEsfObservations,
  type EsfCohortWatermark,
} from "../../src/query/api/esf-observations.js";
import {
  SYNTHETIC_WINDOW_FROM,
  SYNTHETIC_WINDOW_TO,
  seedSyntheticHistory,
} from "./synthetic-fixture.js";

const SCALES = [1_000, 10_000, 100_000] as const;
const TEMP_PREFIX = "agent-wrangler-esf-observation-";

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
  for (const [scale, scaleSamples] of [...grouped.entries()].sort(([left], [right]) => left - right)) {
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

function removeSyntheticDirectory(tempDir: string): void {
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith(TEMP_PREFIX)
  )
    throw new Error("Refusing cleanup outside the ESF synthetic temporary directory");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

function assertCountSummaries(
  field: "cost_claim_counts" | "parser_version_counts",
  value: EsfCohortWatermark[typeof field],
): void {
  if (!Array.isArray(value)) throw new Error(`ESF watermark ${field} is missing`);
  for (const entry of value) {
    if (typeof entry.value !== "string" || typeof entry.count !== "number")
      throw new Error(`ESF watermark ${field} contains an incomplete count summary`);
  }
}

/** Verify and return the complete nested accounting-source watermark without transforming it. */
function requireCompleteWatermark(watermark: EsfCohortWatermark | undefined): EsfCohortWatermark {
  if (!watermark || watermark.version !== "esf-cohort-watermark-1")
    throw new Error("ESF cohort did not return its accounting-source watermark version");
  if (!/^[a-f0-9]{64}$/.test(watermark.source_fingerprint))
    throw new Error("ESF watermark source_fingerprint is missing or invalid");
  for (const field of [
    "selected_turn_count",
    "selected_session_count",
    "nonprovisional_turn_count",
  ] as const) {
    if (typeof watermark[field] !== "number")
      throw new Error(`ESF watermark ${field} is missing`);
  }
  if (watermark.latest_selected_turn_at !== null && typeof watermark.latest_selected_turn_at !== "string")
    throw new Error("ESF watermark latest_selected_turn_at is missing");
  assertCountSummaries("cost_claim_counts", watermark.cost_claim_counts);
  assertCountSummaries("parser_version_counts", watermark.parser_version_counts);
  return watermark;
}

function measureScale(scale: number): {
  sample: EsfMeasurementSample;
  accounting_source_watermark: EsfCohortWatermark;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let db: ReturnType<typeof openDb> | undefined;
  let measurementError: unknown;
  let result:
    | { sample: EsfMeasurementSample; accounting_source_watermark: EsfCohortWatermark }
    | undefined;

  try {
    db = openDb(path.join(tempDir, "synthetic.sqlite"));
    runMigrations(db);
    seedSyntheticHistory(db, scale);

    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const response = getEsfObservations(db, {
      workspaceId: null,
      from: SYNTHETIC_WINDOW_FROM,
      to: SYNTHETIC_WINDOW_TO,
    });
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    const cohort = response.data;
    if (!cohort) throw new Error("ESF observations unexpectedly returned no cohort");

    result = {
      sample: {
        scale_turns: scale,
        elapsed_ms: elapsedMs,
        cpu_user_us: cpu.user,
        cpu_system_us: cpu.system,
        rss_bytes: rssAfter,
      },
      // Preserve the returned structure, including source fingerprint and count arrays.
      accounting_source_watermark: requireCompleteWatermark(cohort.watermark),
    };
    if (rssBefore < 0) throw new Error("RSS measurement was unexpectedly negative");
  } catch (error) {
    measurementError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    db?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeSyntheticDirectory(tempDir);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (measurementError && cleanupErrors.length)
    throw new AggregateError(
      [measurementError, ...cleanupErrors],
      "ESF measurement and cleanup failed",
    );
  if (measurementError) throw measurementError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "ESF measurement cleanup failed");
  if (!result) throw new Error("ESF measurement completed without a result");
  return result;
}

function main(): void {
  const results = SCALES.map(measureScale);
  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        synthetic_only: true,
        measurement_definition:
          "One in-process getEsfObservations call after an isolated synthetic seed; elapsed is wall-clock ms, CPU is process delta microseconds, RSS is post-call process bytes.",
        results,
        summaries: summarizeEsfMeasurement(results.map((result) => result.sample)),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
