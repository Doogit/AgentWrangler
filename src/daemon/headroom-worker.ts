import { parentPort, workerData } from "node:worker_threads";
/** Read-only efficiency-headroom build on a separate SQLite connection (P3-U5). */
import Database from "better-sqlite3";
import { applyReadPragmas } from "../db/open.js";
import { getEfficiencyHeadroom } from "../query/api/efficiency-headroom.js";
import { setQueryDb } from "../query/db-context.js";

const port = parentPort;
if (port === null) throw new Error("headroom worker needs a parent port");
const { dbPath, from, to } = workerData as { dbPath: string; from: string; to: string };
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  db.pragma("query_only = ON");
  applyReadPragmas(db);
  setQueryDb(db);
  port.postMessage({ type: "result", response: getEfficiencyHeadroom(db, { from, to }) });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
