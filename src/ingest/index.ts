/**
 * src/ingest/index.ts — WP1 ingestion pipeline public surface.
 *
 * The daemon orchestrator (src/daemon/index.ts) wires these at boot; this module
 * exposes clean importable entrypoints and does NOT touch daemon internals.
 *
 *   runBackscan(db, roots)  — one full idempotent scan of all transcript files,
 *                             then reconcile; returns parser-health counters.
 *   startTail(db, roots)    — initial pass, then discovery (30s) + tail (2s)
 *                             loops with periodic reconciliation; returns a
 *                             handle whose stop() clears the timers.
 */

import type { Db } from "../db/open.js";
import {
  DEFAULT_INGESTOR_OPTIONS,
  Ingestor,
  type IngestorOptions,
  type TailHandle,
} from "./ingestor.js";
import type { HealthCounters } from "./types.js";

export { Ingestor, DEFAULT_INGESTOR_OPTIONS };
export type { IngestorOptions, TailHandle };
export type { HealthCounters } from "./types.js";
export { PARSER_VERSION } from "./types.js";
export { PricingSnapshotStore, seedListPrices, LIST_PRICES } from "./pricing.js";
export { reconcileSessions, DEFAULT_RECONCILE_OPTIONS } from "./reconcile.js";
export { discoverFiles, registerWorkspace } from "./discovery.js";

/** Run a single full back-scan of `roots` into `db`. Returns health counters. */
export function runBackscan(
  db: Db,
  roots: string[],
  options: Partial<IngestorOptions> = {},
): HealthCounters {
  return new Ingestor(db, roots, options).runBackscan();
}

/** Start incremental tailing of `roots` into `db`. Returns a stop handle. */
export function startTail(
  db: Db,
  roots: string[],
  options: Partial<IngestorOptions> = {},
): { handle: TailHandle; ingestor: Ingestor } {
  const ingestor = new Ingestor(db, roots, options);
  const handle = ingestor.startTail();
  return { handle, ingestor };
}
