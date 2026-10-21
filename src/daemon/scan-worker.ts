/** Long-lived read-only worker for the scans in scan-tasks.ts. One request in, one reply out. */
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { applyReadPragmas } from "../db/open.js";
import { setQueryDb } from "../query/db-context.js";
import { type ScanTask, runScanTask } from "./scan-tasks.js";

const port = parentPort;
if (port === null) throw new Error("scan worker needs a parent port");
const { dbPath } = workerData as { dbPath: string };
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");
applyReadPragmas(db);
setQueryDb(db);

port.on("message", (msg: { id: number; task: ScanTask }) => {
  const fail = (error: unknown) =>
    port.postMessage({
      id: msg.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  try {
    // A query reads in one transaction: one WAL snapshot taken at its first statement, so it sees
    // every transaction committed before the request reached it and none landing mid-query, as
    // the inline call on the main connection does (no commit runs while a sync call holds the loop).
    // This connection's per-handle memos (prepared statements, overview.ts cachedQuery) behave as
    // they did on the main connection, so a body is never staler than the inline call's.
    const task = msg.task;
    const run =
      task.kind === "query"
        ? db.transaction(() => runScanTask(db, task) as string)
        : () => runScanTask(db, task as never);
    // Async tasks (agents-liveness awaits a child process) must not hold up the next scan.
    Promise.resolve(run()).then(
      (result) => port.postMessage({ id: msg.id, ok: true, result }),
      fail,
    );
  } catch (error) {
    fail(error);
  }
});
