/**
 * src/detector/index.ts — DetectorEngine public surface.
 *
 * runDetectors(db, { now }) is the post-ingest entrypoint (wired via the ingest
 * post-ingest hook). It MUST receive the ingestor's injected clock so rec_id /
 * created_at windows are deterministic (NFR-107 / Review F4) — never new Date().
 */

import type { Db } from "../db/open.js";
import { buildContext, detectorStatuses, runDetectors as runDetectorsCore } from "./engine.js";
import type { LiveDetectorStatus } from "./engine.js";

export type { LiveDetectorStatus } from "./engine.js";
export type { ModeledFormula } from "./types.js";
export { buildContext } from "./engine.js";

export interface RunDetectorsOptions {
  /** Injected evaluation instant. Defaults to new Date() ONLY when unset (never on the ingest path). */
  now?: Date;
}

/** Evaluate + upsert fired recommendations. Returns the live detector status list. */
export function runDetectors(db: Db, opts: RunDetectorsOptions = {}): LiveDetectorStatus[] {
  return runDetectorsCore(db, buildContext(opts.now ?? new Date()));
}

/** Live detector statuses without writing — for the query layer's detectors[] strip. */
export function getDetectorStatuses(db: Db, opts: RunDetectorsOptions = {}): LiveDetectorStatus[] {
  return detectorStatuses(db, buildContext(opts.now ?? new Date()));
}
