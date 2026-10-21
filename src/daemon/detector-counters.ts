/**
 * src/daemon/detector-counters.ts — P0-U10: per-detector duration/statement/
 * row-read counters for a history walk, using the audit's detector-bench.mjs
 * counting technique (statements = executed statement count, rows = rows
 * returned by .all/.get/.iterate).
 *
 * Behavior-neutral: `wrapDbForCounting` replaces db.prepare's returned
 * statement's read methods with a thin counting wrapper that delegates to
 * the original implementation unchanged — same rows, same errors, same
 * order. Writes (.run) are never touched.
 */

import type { Db } from "../db/open.js";
import type { DetectorEvalHook } from "../detector/engine.js";
import type { DetectorCounters, DetectorPassSnapshot } from "./perf-monitor.js";

/** Structural subset of better-sqlite3's Statement that counting needs. */
interface CountablePreparedStatement {
  all: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  iterate: (...args: unknown[]) => IterableIterator<unknown>;
}

/**
 * Wraps `db.prepare` in place to count statement calls and rows read via
 * .all/.get/.iterate. Call once per DB connection, before the work you want
 * counted — the returned object's `stmts`/`rows` update live as reads happen.
 */
export function wrapDbForCounting(db: Db): { stmts: number; rows: number } {
  const counts = { stmts: 0, rows: 0 };
  const origPrepare = db.prepare.bind(db) as (sql: string) => CountablePreparedStatement;

  const patchedPrepare = (sql: string): CountablePreparedStatement => {
    const stmt = origPrepare(sql);
    const wAll = stmt.all.bind(stmt);
    const wGet = stmt.get.bind(stmt);
    const wIterate = stmt.iterate.bind(stmt);
    stmt.all = (...a: unknown[]) => {
      counts.stmts++;
      const rows = wAll(...a);
      counts.rows += Array.isArray(rows) ? rows.length : 0;
      return rows;
    };
    stmt.get = (...a: unknown[]) => {
      counts.stmts++;
      const row = wGet(...a);
      counts.rows += row ? 1 : 0;
      return row;
    };
    stmt.iterate = (...a: unknown[]) => {
      counts.stmts++;
      const it = wIterate(...a);
      return (function* () {
        for (const row of it) {
          counts.rows++;
          yield row;
        }
      })();
    };
    return stmt;
  };

  (db as unknown as { prepare: (sql: string) => CountablePreparedStatement }).prepare =
    patchedPrepare;
  return counts;
}

/**
 * Builds a per-detector-attributing DetectorEvalHook driven off the running
 * {stmts, rows} totals from `wrapDbForCounting`: `onStart` snapshots the
 * current totals, `onEnd` adds the delta since that snapshot (plus the
 * caller-timed duration) to the named detector's running counters.
 */
export function createDetectorCountingHook(counts: { stmts: number; rows: number }): {
  hook: DetectorEvalHook;
  buildSnapshot(): DetectorPassSnapshot;
} {
  const perDetector = new Map<string, DetectorCounters>();
  let baseStmts = 0;
  let baseRows = 0;

  const hook: DetectorEvalHook = {
    onStart() {
      baseStmts = counts.stmts;
      baseRows = counts.rows;
    },
    onEnd(detectorId, durationMs) {
      const prev = perDetector.get(detectorId) ?? { ms: 0, stmts: 0, rows: 0, evals: 0 };
      perDetector.set(detectorId, {
        ms: prev.ms + durationMs,
        stmts: prev.stmts + (counts.stmts - baseStmts),
        rows: prev.rows + (counts.rows - baseRows),
        evals: (prev.evals ?? 0) + 1,
      });
    },
  };

  return {
    hook,
    buildSnapshot(): DetectorPassSnapshot {
      let totalMs = 0;
      let totalRows = 0;
      let totalStmts = 0;
      for (const c of perDetector.values()) {
        totalMs += c.ms;
        totalRows += c.rows;
        totalStmts += c.stmts;
      }
      return {
        totalMs,
        totalRows,
        totalStmts,
        detectorCount: perDetector.size,
        perDetector: Object.fromEntries(perDetector),
      };
    },
  };
}
