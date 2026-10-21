import { parentPort, workerData } from "node:worker_threads";
/** Read-only P1-U8 route snapshot build (delivery, practices) on a separate SQLite connection. */
import Database from "better-sqlite3";
import { applyReadPragmas } from "../db/open.js";
import { setQueryDb } from "../query/db-context.js";
import { type RouteSnapshotSpec, buildRouteSnapshot } from "./route-snapshot-build.js";

const port = parentPort;
if (port === null) throw new Error("route snapshot worker needs a parent port");
const { dbPath, spec } = workerData as { dbPath: string; spec: RouteSnapshotSpec };
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  db.pragma("query_only = ON");
  applyReadPragmas(db);
  setQueryDb(db);
  port.postMessage({ type: "result", body: buildRouteSnapshot(db, spec) });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
