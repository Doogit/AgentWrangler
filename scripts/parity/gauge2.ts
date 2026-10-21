/**
 * scripts/parity/gauge2.ts — Gauge 2 (adoption) capture.
 *
 * Records whether the operator adopted a recommendation on live data
 * and whether its named before/after metric moved.
 *
 * This is a CAPTURE tool — it does NOT score or judge. The human records
 * the adoption and metric movement; this module stores and summarizes the records.
 *
 * The adoption gauge measures the moat axes that Gauge 1 (parity) cannot:
 * installed artifacts + measured effect.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** One adoption record per recommendation shown to the operator. */
export interface AdoptionRecord {
  rec_id: string;
  detector_id: string | null;
  session_id: string;
  workspace_id: string;
  /** ISO timestamp when the operator adopted this rec; null = not yet adopted. */
  adopted_at: string | null;
  /** The named before/after metric (from rec's target_metric). */
  before_metric_name: string;
  /** Metric value before adoption. Null until measured. */
  before_metric_value: number | null;
  /** Metric value after adoption. Null until follow-up measurement. */
  after_metric_value: number | null;
  /** True if the metric moved in the expected direction. Null = not yet judged. */
  metric_moved: boolean | null;
  notes: string;
}

/** Create an empty adoption record stub for a recommendation. */
export function emptyAdoptionRecord(
  rec_id: string,
  detector_id: string | null,
  session_id: string,
  workspace_id: string,
  before_metric_name: string,
): AdoptionRecord {
  return {
    rec_id,
    detector_id,
    session_id,
    workspace_id,
    adopted_at: null,
    before_metric_name,
    before_metric_value: null,
    after_metric_value: null,
    metric_moved: null,
    notes: "",
  };
}

export interface Gauge2Summary {
  total_recs: number;
  adopted_count: number;
  metric_moved_count: number;
  records: AdoptionRecord[];
}

/** Summarize adoption records for the exit criteria: adoption count + metric movement count. */
export function summarizeAdoption(records: AdoptionRecord[]): Gauge2Summary {
  return {
    total_recs: records.length,
    adopted_count: records.filter((r) => r.adopted_at !== null).length,
    metric_moved_count: records.filter((r) => r.metric_moved === true).length,
    records,
  };
}

/** Write the adoption log to disk; creates parent directories. */
export function writeAdoptionLog(records: AdoptionRecord[], outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summarizeAdoption(records), null, 2));
}
