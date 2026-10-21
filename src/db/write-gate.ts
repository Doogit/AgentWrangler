/**
 * src/db/write-gate.ts — every main-thread write waits out an in-flight WAL checkpoint.
 *
 * On Windows a write that extends the -wal file blocks while another handle flushes that file
 * (FlushFileBuffers). The off-main checkpoint worker (src/daemon/wal-checkpointer.ts) flushes the
 * -wal and the db on every checkpoint, which takes seconds on a slow disk. A synchronous main-thread
 * write that lands in that window stalls the event loop for the rest of the flush (538–11,469 ms on
 * Windows CI). So each main-thread write section awaits `awaitDbWriteGate()` first.
 *
 * The gate protects only the synchronous code right after the await: the checkpoint kick is a timer
 * (a macrotask), so it cannot start between the gate resolving and the code that follows. Code that
 * awaits again (git, gh, network, file reads) must await the gate again before its next write.
 *
 * The daemon installs the source (`setDbWriteGate`); without one (tests, scripts) the gate is open.
 * `watchUngatedWrites` is the test/check-only oracle: it reports any write that starts on the main
 * connection while a checkpoint is in flight.
 */

import type { Db } from "./open.js";

let source: () => Promise<void> | null = () => null;

/** The daemon's gate: resolves when no checkpoint (or worker write) is in flight; null when none is. */
export function setDbWriteGate(fn: (() => Promise<void> | null) | null): void {
  source = fn ?? (() => null);
}

/**
 * One gate over several sources (the WAL checkpoint, the history worker's write flag). It resolves
 * only once EVERY source is clear at the same moment: while it waits on one, the checkpoint kick
 * (a timer) can start a checkpoint, so `a() ?? b()` awaited once is not enough.
 */
export function combineWriteGates(
  ...sources: Array<() => Promise<void> | null>
): () => Promise<void> | null {
  const pending = (): Promise<void> | null => {
    for (const s of sources) {
      const g = s();
      if (g !== null) return g;
    }
    return null;
  };
  return () => {
    const first = pending();
    if (first === null) return null;
    return (async () => {
      for (let g: Promise<void> | null = first; g !== null; g = pending()) await g;
    })();
  };
}

/** The gate right now: a promise while a checkpoint (or worker write) is in flight, else null. */
export function dbWriteGate(): Promise<void> | null {
  return source();
}

/** Resolves once the gate is open. Run the write synchronously after it, with no await in between. */
export async function awaitDbWriteGate(): Promise<void> {
  for (let gate = source(); gate !== null; gate = source()) await gate;
}

export interface UngatedWrite {
  sql: string;
  stack: string;
}

/**
 * Check mode only (AW_WRITE_GATE_CHECK=1, tests): call `onFlag` for every write that starts on `db`
 * while `inFlight()` is true. Wraps `prepare` (non-readonly statements), `exec` and `transaction`.
 * Install before anything prepares statements on `db`.
 */
export function watchUngatedWrites(
  db: Db,
  inFlight: () => boolean,
  onFlag: (write: UngatedWrite) => void,
): void {
  const check = (sql: string): void => {
    if (!inFlight()) return;
    onFlag({ sql: sql.replace(/\s+/g, " ").trim().slice(0, 160), stack: new Error().stack ?? "" });
  };

  const origPrepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    if (stmt.readonly) return stmt;
    for (const name of ["run", "get", "all", "iterate"] as const) {
      const fn = (stmt[name] as (...a: unknown[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
        if (!db.inTransaction) check(sql);
        return fn(...a);
      };
    }
    return stmt;
  }) as Db["prepare"];

  const origExec = db.exec.bind(db);
  (db as { exec: unknown }).exec = ((sql: string) => {
    if (!db.inTransaction) check(sql);
    return origExec(sql);
  }) as Db["exec"];

  const origTransaction = db.transaction.bind(db);
  (db as { transaction: unknown }).transaction = ((fn: (...a: unknown[]) => unknown) => {
    const tx = origTransaction(fn) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const wrap =
      (run: (...a: unknown[]) => unknown) =>
      (...a: unknown[]) => {
        if (!db.inTransaction) check(`transaction ${fn.name || "(anonymous)"}`);
        return run(...a);
      };
    const run = wrap(tx.default as (...a: unknown[]) => unknown);
    return Object.assign(run, {
      default: run,
      deferred: wrap(tx.deferred as (...a: unknown[]) => unknown),
      immediate: wrap(tx.immediate as (...a: unknown[]) => unknown),
      exclusive: wrap(tx.exclusive as (...a: unknown[]) => unknown),
    });
  }) as Db["transaction"];
}
