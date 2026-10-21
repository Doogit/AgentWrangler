/**
 * test/db/pragmas.test.ts — P0-U5 connection pragmas and the idle WAL checkpoint.
 *
 * Oracle: SQLite itself. Every value is read back with `PRAGMA x` on a real on-disk database, and
 * the WAL file size is stat'ed on disk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonLifecycle } from "../../src/daemon/lifecycle.js";
import { createIdleCheckpointer } from "../../src/db/idle-checkpoint.js";
import { applyReadPragmas, openDb } from "../../src/db/open.js";

const SRC = path.resolve(import.meta.dirname, "../../src");
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-pragmas-"));
  dbPath = path.join(dir, "db.sqlite");
});

afterEach(() => {
  vi.useRealTimers();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly; the OS temp dir is reaped anyway.
  }
});

const simple = (db: Database.Database, name: string): unknown => db.pragma(name, { simple: true });

describe("P0-U5 test 1a: pragma read-back", () => {
  it("main and history connections (openDb) carry the hygiene pragmas", () => {
    const db = openDb(dbPath);
    try {
      expect(simple(db, "journal_mode")).toBe("wal");
      expect(simple(db, "synchronous")).toBe(1); // NORMAL
      expect(simple(db, "foreign_keys")).toBe(1);
      expect(simple(db, "busy_timeout")).toBe(5000);
      expect(simple(db, "cache_size")).toBe(-20000);
      expect(simple(db, "mmap_size")).toBe(268435456);
      expect(simple(db, "journal_size_limit")).toBe(67108864);
      // temp_store = MEMORY is deliberately NOT set (large build sorts would grow memory).
      expect(simple(db, "temp_store")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("read-only recs/diagnostics connections get mmap_size only, and keep busy_timeout 5000", () => {
    openDb(dbPath).close();
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      applyReadPragmas(ro);
      expect(simple(ro, "mmap_size")).toBe(268435456);
      expect(simple(ro, "busy_timeout")).toBe(5000);
      // cache_size is left at the SQLite default: a per-build connection would discard it.
      expect(simple(ro, "cache_size")).not.toBe(-20000);
    } finally {
      ro.close();
    }
  });

  it("the recs and diagnostics worker entry files call applyReadPragmas", () => {
    for (const f of ["daemon/recs-worker.ts", "daemon/diagnostics-worker.ts"]) {
      const text = fs.readFileSync(path.join(SRC, f), "utf8");
      expect(text, f).toMatch(/applyReadPragmas\(db\)/);
    }
  });
});

// RESTART, not TRUNCATE (WAL-gate fix, operator-approved): the -wal keeps its size so later writes
// overwrite it in place instead of extending it. The oracle for "restarted" is the file itself: a
// write after a restart lands at frame 0 (the file does not grow); without one it appends.
describe("P0-U5 test 1b: idle WAL checkpoint (RESTART after >= 60 s with no write)", () => {
  const walSize = (): number => {
    try {
      return fs.statSync(`${dbPath}-wal`).size;
    } catch {
      return 0;
    }
  };
  /** One small write; true when it started the WAL over instead of appending to it. */
  const nextWriteRestarts = (db: Database.Database): boolean => {
    const before = walSize();
    db.prepare("INSERT INTO t VALUES (99)").run();
    return walSize() <= before;
  };

  it("restarts the WAL once the connection has been write-idle for 60 s, not before", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = openDb(dbPath);
    try {
      db.exec("CREATE TABLE t (x INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      expect(walSize()).toBeGreaterThan(0);
      expect(nextWriteRestarts(db)).toBe(false); // control: without a restart, a write appends

      const idle = createIdleCheckpointer(db);
      expect(idle.tick()).toBe(false); // first look: a write was just seen
      vi.advanceTimersByTime(59_000);
      expect(idle.tick()).toBe(false);
      expect(walSize()).toBeGreaterThan(0);

      vi.advanceTimersByTime(2_000); // 61 s since the write was first seen
      const kept = walSize();
      expect(idle.tick()).toBe(true);
      expect(walSize()).toBe(kept); // the file keeps its size: no TRUNCATE to 0 bytes

      // Already checkpointed and still idle: no repeat work.
      vi.advanceTimersByTime(120_000);
      expect(idle.tick()).toBe(false);
      expect(nextWriteRestarts(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a new write restarts the idle clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = openDb(dbPath);
    try {
      db.exec("CREATE TABLE t (x INTEGER)");
      const idle = createIdleCheckpointer(db);
      idle.tick();
      vi.advanceTimersByTime(50_000);
      db.prepare("INSERT INTO t VALUES (1)").run();
      expect(idle.tick()).toBe(false); // sees the write, resets the clock
      vi.advanceTimersByTime(50_000);
      expect(idle.tick()).toBe(false); // only 50 s since the write
      expect(walSize()).toBeGreaterThan(0);
      vi.advanceTimersByTime(11_000);
      expect(idle.tick()).toBe(true);
      expect(nextWriteRestarts(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a write from ANOTHER connection (history worker) also counts as activity", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = openDb(dbPath);
    const other = openDb(dbPath);
    try {
      db.exec("CREATE TABLE t (x INTEGER)");
      const idle = createIdleCheckpointer(db);
      idle.tick();
      vi.advanceTimersByTime(50_000);
      other.prepare("INSERT INTO t VALUES (1)").run();
      expect(idle.tick()).toBe(false);
      vi.advanceTimersByTime(50_000);
      expect(idle.tick()).toBe(false);
    } finally {
      other.close();
      db.close();
    }
  });

  it("a pinned reader never stalls the tick, and the checkpoint is retried once the reader is gone", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = openDb(dbPath);
    const reader = openDb(dbPath);
    try {
      db.exec("CREATE TABLE t (x INTEGER)");
      db.prepare("INSERT INTO t VALUES (1)").run();
      const idle = createIdleCheckpointer(db);
      idle.tick();
      // A long-lived read snapshot (like a recs build) pins the WAL.
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM t").all();
      vi.advanceTimersByTime(61_000);

      const t0 = performance.now();
      const ran = idle.tick();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(1_000); // must not sit in the 5 s busy handler
      expect(ran).toBe(false); // blocked checkpoint is not reported as done
      expect(simple(db, "busy_timeout")).toBe(5000); // restored afterwards
      expect(walSize()).toBeGreaterThan(0);

      reader.exec("COMMIT");
      expect(idle.tick()).toBe(true); // retried on the very next tick
      expect(nextWriteRestarts(db)).toBe(true);
    } finally {
      reader.close();
      db.close();
    }
  });

  it("the daemon lifecycle runs the idle tick on its own interval after boot", async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const lc = createDaemonLifecycle({
      bootScan: async () => null,
      calibrationTick: () => {},
      outcomesTick: () => {},
      reportsTick: () => {},
      idleCheckpointTick: tick,
      closeServer: (done) => done(),
      closeDb: () => {},
      bootFallbackMs: 1,
    });
    lc.kickBootScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    lc.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
