/**
 * test/daemon/wal-checkpointer.test.ts — P2-U4b: WAL checkpoints run off the main thread.
 *
 * Oracle: SQLite and the file system. The main connection's auto-checkpoint is observed through the
 * -wal file (an auto-checkpoint lets the next write restart the WAL, capping its size near 1,000
 * pages); the worker's checkpoints through the same file staying bounded while main keeps writing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPerfSnapshot,
  resetProcessSamplers,
  sampleProcessGauges,
} from "../../src/daemon/perf-monitor.js";
import { type WalCheckpointer, startWalCheckpointer } from "../../src/daemon/wal-checkpointer.js";
import { type Db, openDb } from "../../src/db/open.js";
import { INGEST_TX_BUDGET_MS } from "../../src/ingest/ingestor.js";

const PAGE = 4096;
/** ADR-113's 50 ms event-loop lag bar. */
const LOOP_LAG_BAR_MS = 50;
let dir: string;
let dbPath: string;
let db: Db;
let cp: WalCheckpointer | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-walcp-"));
  dbPath = path.join(dir, "db.sqlite");
  db = openDb(dbPath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)");
  resetProcessSamplers();
});

afterEach(async () => {
  await cp?.stop();
  cp = undefined;
  db.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly; the OS temp dir is reaped anyway.
  }
});

const walSize = (): number => {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
};
const insert = (rows: number): void => {
  // ~3 KB blob per row: about one page per row.
  db.prepare(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) " +
      "INSERT INTO t (b) SELECT randomblob(3000) FROM n",
  ).run(rows);
};
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)));

describe("P2-U4b: off-main WAL checkpoints", () => {
  it("the main connection never auto-checkpoints; other openDb connections still do", () => {
    cp = startWalCheckpointer(db, dbPath, { periodMs: 3_600_000 }); // never kicks in this test
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
    for (let i = 0; i < 15; i++) insert(100); // ~1,500 pages over 15 commits
    // An auto-checkpoint on main would let the WAL restart near 1,000 pages.
    expect(walSize()).toBeGreaterThan(1_400 * PAGE);

    const other = openDb(dbPath);
    try {
      expect(other.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    } finally {
      other.close();
    }
  });

  // A checkpoint flush takes seconds on a slow CI disk (Windows runners): the first one can land
  // well after the 5 s default test timeout and vi.waitFor's 1 s default, so both wait longer.
  it(
    "the worker keeps the WAL bounded while main writes in gated yielding steps, and records M14",
    {
      timeout: 60_000,
    },
    async () => {
      await sampleProcessGauges(dbPath);
      cp = startWalCheckpointer(db, dbPath, { periodMs: 20 });
      const steps = 400;
      const rowsPerStep = 20; // ~8,000 pages (~32 MiB) in total
      let maxWal = 0;
      for (let i = 0; i < steps; i++) {
        // As ingestFileYielding does: no write step starts while a checkpoint is in flight, so the
        // checkpoint can copy every frame and the next write restarts the WAL.
        const gate = cp.writeGate();
        if (gate) await gate;
        insert(rowsPerStep);
        maxWal = Math.max(maxWal, walSize());
        await yieldLoop();
        if (i % 20 === 0) await new Promise((r) => setTimeout(r, 5));
      }
      await vi.waitFor(() => expect(cp?.stats().count ?? 0).toBeGreaterThan(0), {
        timeout: 30_000,
      });
      expect(maxWal).toBeLessThan((steps * rowsPerStep * PAGE) / 2);
      expect(db.prepare("SELECT count(*) FROM t").pluck().get()).toBe(steps * rowsPerStep);

      await sampleProcessGauges(dbPath);
      const wal = getPerfSnapshot().wal;
      expect(wal?.checkpoint?.count).toBeGreaterThan(0);
      expect(wal?.checkpoint?.maxMs).toBeGreaterThanOrEqual(wal?.checkpoint?.lastMs ?? 0);
    },
  );

  // The product promise (rewritten, operator-approved): main-thread writes are gated, so none runs
  // while a checkpoint is in flight; gated steps stay inside the step budget and the event loop stays
  // responsive for the whole checkpoint. An UNGATED write inside a checkpoint is not immune on
  // Windows (an extending write waits for the worker's FlushFileBuffers), which is why every write
  // is gated; test/db/write-gate.test.ts covers that side.
  // Retried: a wall-clock bound that a loaded machine can break (329 ms once under the full suite).
  it(
    "a slow checkpoint in flight never stretches a gated main-thread step past the step budget, nor the loop",
    { retry: 2, timeout: 60_000 },
    async () => {
      // Started first, so main never auto-checkpoints the setup write: the worker's first
      // checkpoint really copies and flushes ~32 MiB of WAL.
      cp = startWalCheckpointer(db, dbPath, { periodMs: 10 });
      insert(8_000); // ~32 MiB of WAL (setup, not measured)
      const checkpointer = cp;
      let maxLagInFlightMs = 0;
      let last = performance.now();
      const sampler = setInterval(() => {
        const now = performance.now();
        if (checkpointer.inFlight()) maxLagInFlightMs = Math.max(maxLagInFlightMs, now - last - 5);
        last = now;
      }, 5);
      let gatedSteps = 0;
      let stepsStartedInFlight = 0;
      let maxStepMs = 0;
      let sawInFlight = false;
      try {
        const deadline = performance.now() + 45_000;
        while ((checkpointer.stats().count === 0 || !sawInFlight) && performance.now() < deadline) {
          sawInFlight ||= checkpointer.inFlight();
          const gate = checkpointer.writeGate();
          if (gate) await gate;
          if (checkpointer.inFlight()) stepsStartedInFlight++;
          const t0 = performance.now();
          insert(5);
          maxStepMs = Math.max(maxStepMs, performance.now() - t0);
          gatedSteps++;
          await yieldLoop();
        }
      } finally {
        clearInterval(sampler);
      }
      expect(checkpointer.stats().count).toBeGreaterThan(0);
      expect(sawInFlight).toBe(true);
      expect(gatedSteps).toBeGreaterThan(0);
      expect(stepsStartedInFlight).toBe(0);
      expect(maxStepMs).toBeLessThan(INGEST_TX_BUDGET_MS);
      expect(maxLagInFlightMs).toBeLessThan(LOOP_LAG_BAR_MS);
    },
  );

  it("a worker that dies hands checkpointing back to main (auto-checkpoint restored)", async () => {
    cp = startWalCheckpointer(db, path.join(dir, "missing", "db.sqlite"), { periodMs: 10 });
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
    await vi.waitFor(() => expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000), {
      timeout: 10_000,
    });
  });
});
