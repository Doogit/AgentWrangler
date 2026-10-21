/**
 * src/db/write-intent.ts — a worker connection's pending write, visible to the main thread.
 *
 * Yielding ingest takes the write lock in 25 ms steps with one loop turn between them. A worker
 * connection waiting in `busy_timeout` almost never lands in that gap, so on a live-DB copy the
 * floored W0 walk failed with "database is locked" after its 5 s timeout (G-P2, 2026-10-11).
 *
 * The worker raises a shared flag around each write (a transaction, or an autocommit `run`), and
 * opens its transactions IMMEDIATE so a read snapshot never needs an upgrade (that fails at once,
 * without the busy handler). Main-thread ingest awaits `writeIntentGate()` before each step, so it
 * stops within one step and the worker's busy wait succeeds.
 */

import type { Db } from "./open.js";

// ES2024 (Node ≥ 16); the project's TS lib predates it.
const waitAsync = (
  Atomics as unknown as {
    waitAsync(
      a: Int32Array,
      i: number,
      v: number,
    ): { async: false; value: string } | { async: true; value: Promise<string> };
  }
).waitAsync;

/** One Int32 slot: the worker's count of open write scopes (0 = none). */
export function createWriteIntent(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(4));
}

/** Resolves once no worker write is pending; null when none is. */
export function writeIntentGate(flag: Int32Array): Promise<void> | null {
  const held = Atomics.load(flag, 0);
  if (held === 0) return null;
  const wait = waitAsync(flag, 0, held);
  const settled = wait.async ? wait.value.then(() => undefined) : Promise.resolve();
  // The count may drop to another nonzero value (nested scopes); wait until it reaches 0.
  return settled.then(() => writeIntentGate(flag) ?? undefined);
}

/** Main side: a worker that exits mid-write must not leave ingest waiting forever. */
export function clearWriteIntent(flag: Int32Array): void {
  Atomics.store(flag, 0, 0);
  Atomics.notify(flag, 0);
}

/** Worker side: every transaction and autocommit write on `db` raises `flag` while it runs. */
export function announceWrites(db: Db, flag: Int32Array): void {
  const hold = <T>(fn: () => T): T => {
    Atomics.add(flag, 0, 1);
    try {
      return fn();
    } finally {
      Atomics.sub(flag, 0, 1);
      Atomics.notify(flag, 0);
    }
  };

  const origTransaction = db.transaction.bind(db);
  (db as { transaction: unknown }).transaction = ((fn: (...a: unknown[]) => unknown) => {
    const tx = origTransaction(fn);
    const run = (...a: unknown[]) => hold(() => tx.immediate(...a));
    return Object.assign(run, {
      default: run,
      deferred: run,
      immediate: run,
      exclusive: (...a: unknown[]) => hold(() => tx.exclusive(...a)),
    });
  }) as Db["transaction"];

  const origPrepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    if (stmt.reader) return stmt;
    const run = stmt.run.bind(stmt);
    stmt.run = (...a: unknown[]) => (db.inTransaction ? run(...a) : hold(() => run(...a)));
    return stmt;
  }) as Db["prepare"];
}
