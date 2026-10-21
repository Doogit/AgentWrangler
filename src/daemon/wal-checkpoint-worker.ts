/** P2-U4b: run wal_checkpoint(PASSIVE) on this worker's own connection, once per request from main. */
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const port = parentPort;
if (port === null) throw new Error("WAL checkpoint worker needs a parent port");
const { dbPath, delayMs = 0 } = workerData as { dbPath: string; delayMs?: number };
// PASSIVE never calls the busy handler; timeout 0 keeps every other lock wait out of this loop too.
const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
// Test seam: hold each checkpoint in flight this long, standing in for a slow-disk flush.
const sleep = delayMs > 0 ? new Int32Array(new SharedArrayBuffer(4)) : null;

port.on("message", () => {
  const start = performance.now();
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch {
    // SQLITE_BUSY (another checkpoint, e.g. main's idle RESTART, holds the lock): the next request retries.
  }
  if (sleep) Atomics.wait(sleep, 0, 0, delayMs);
  port.postMessage({ ms: performance.now() - start });
});
