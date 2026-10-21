import { parentPort, workerData } from "node:worker_threads";
/** Read-only Diagnostics triage build on a separate SQLite connection (P4 U4). */
import Database from "better-sqlite3";
import { applyReadPragmas } from "../db/open.js";
import type { WindowDays } from "../query/api/diagnostics-census.js";
import { buildDiagnosticsTriage } from "../query/api/diagnostics-triage.js";
import {
  type CallTarget,
  seedToolCallTargets,
  toolCallTargetEntries,
} from "../query/api/tool-calls.js";
import { setQueryDb } from "../query/db-context.js";

const port = parentPort;
if (port === null) throw new Error("diagnostics worker needs a parent port");
const { dbPath, windowDays, asOf, toolCallTargets } = workerData as {
  dbPath: string;
  windowDays: WindowDays;
  asOf: string;
  toolCallTargets?: Array<[string, CallTarget | null]>;
};
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  db.pragma("query_only = ON");
  applyReadPragmas(db);
  setQueryDb(db);
  seedToolCallTargets(toolCallTargets ?? []);
  const view = buildDiagnosticsTriage(db, windowDays, new Date(asOf), {
    onStage: (stage, ms) => port.postMessage({ type: "stage", stage, ms }),
  });
  port.postMessage({ type: "result", view, toolCallTargets: toolCallTargetEntries() });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
