/** Run the synchronous history walk off the HTTP server's event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "../db/open.js";
import { announceWrites } from "../db/write-intent.js";
import { runHistoryWalk } from "../detector/engine.js";
import { writeLedgerDaily } from "../detector/ledger-daily.js";
import { createDetectorCountingHook, wrapDbForCounting } from "./detector-counters.js";
import type { DetectorPassSnapshot } from "./perf-monitor.js";

const port = parentPort;
if (port === null) throw new Error("history worker needs a parent port");
const { dbPath, nowIso, completeThroughMs, writeIntent } = workerData as {
  dbPath: string;
  nowIso: string;
  completeThroughMs?: number;
  writeIntent?: Int32Array;
};
const db = openDb(dbPath);
// Main-thread ingest pauses while this walk writes (src/db/write-intent.ts).
if (writeIntent !== undefined) announceWrites(db, writeIntent);

// P0-U10: per-detector duration/statement/rows-read counters for this walk
// (audit §12.1 Stage 1, detector-bench.mjs technique). Instrumentation only —
// db.prepare's read methods gain a counting side effect, no behavior change.
const counts = wrapDbForCounting(db);
const { hook: detectorHook, buildSnapshot } = createDetectorCountingHook(counts);

let response:
  | {
      type: "result";
      statuses: Awaited<ReturnType<typeof runHistoryWalk>>["statuses"];
      detectorPass: DetectorPassSnapshot;
    }
  | { type: "error"; message: string };
try {
  const result = await runHistoryWalk(db, new Date(nowIso), {
    onWeek: (progress) => port.postMessage({ type: "week", progress }),
    detectorHook,
    completeThroughMs,
  });
  response = { type: "result", statuses: result.statuses, detectorPass: buildSnapshot() };
  try {
    // Accepted (L7 review #3): the result is posted only after this write, so a slow ledger_daily delays it.
    // P2-U4: a floored walk runs mid-backfill; the full walk after it writes the ledger.
    if (completeThroughMs === undefined) writeLedgerDaily(db, new Date(nowIso));
  } catch (error) {
    // The walk already committed; a ledger_daily failure must not turn it into an error.
    console.error(
      `ledger-daily — failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
} catch (error) {
  response = {
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  };
} finally {
  db.close();
}
port.postMessage(response);
