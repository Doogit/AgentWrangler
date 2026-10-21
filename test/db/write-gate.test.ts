/**
 * test/db/write-gate.test.ts — main-thread writes wait out an in-flight WAL checkpoint.
 *
 * Oracles: the real checkpoint worker (held in flight by its `delayMs` test seam, standing in for
 * a slow-disk flush) and `watchUngatedWrites`, which reports any write that starts on the main
 * connection while that checkpoint is in flight. The regression case uses a real write path that
 * was ungated before the fix (the churn collector's NO_REPO upsert after its loop yield).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WalCheckpointer, startWalCheckpointer } from "../../src/daemon/wal-checkpointer.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";
import {
  type UngatedWrite,
  awaitDbWriteGate,
  combineWriteGates,
  setDbWriteGate,
  watchUngatedWrites,
} from "../../src/db/write-gate.js";
import { collectSessionChurn } from "../../src/ingest/churn-collector.js";

let dir: string;
let dbPath: string;
let db: Db;
let cp: WalCheckpointer | undefined;
let flagged: UngatedWrite[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-wgate-"));
  dbPath = path.join(dir, "db.sqlite");
  db = openDb(dbPath);
  flagged = [];
});

afterEach(async () => {
  setDbWriteGate(null);
  await cp?.stop();
  cp = undefined;
  db.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold the file briefly; the OS temp dir is reaped anyway.
  }
});

describe("awaitDbWriteGate", () => {
  it("is open without a source, and waits for every gate the source hands out", async () => {
    await awaitDbWriteGate(); // no source: resolves
    const order: string[] = [];
    let release: Array<() => void> = [];
    let gates = 2;
    setDbWriteGate(() => {
      if (gates === 0) return null;
      return new Promise<void>((resolve) => {
        release.push(() => {
          gates--;
          order.push(`gate${2 - gates}`);
          resolve();
        });
      });
    });
    const done = awaitDbWriteGate().then(() => order.push("write"));
    await new Promise((r) => setImmediate(r));
    release.shift()?.();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["gate1"]); // a second gate was set: still waiting
    release.shift()?.();
    await done;
    expect(order).toEqual(["gate1", "gate2", "write"]);
    release = [];
  });
});

describe("combineWriteGates (review P1: history wait, then a checkpoint kick)", () => {
  /** The review's ordering: the gate waits on the history flag; a checkpoint starts during it. */
  async function writesInsideCheckpoint(
    combine: (
      cp: () => Promise<void> | null,
      hist: () => Promise<void> | null,
    ) => () => Promise<void> | null,
  ): Promise<boolean> {
    let checkpoint: Promise<void> | null = null;
    let endCheckpoint = (): void => {};
    let endHistory = (): void => {};
    let history: Promise<void> | null = new Promise<void>((r) => {
      endHistory = () => {
        history = null;
        r();
      };
    });
    const gate = combine(
      () => checkpoint,
      () => history,
    );
    let wroteInFlight: boolean | null = null;
    const g = gate();
    const write = (g ?? Promise.resolve()).then(() => {
      wroteInFlight = checkpoint !== null; // the ingest step / reconcile runs here
    });
    // The 1 s kick fires while ingest waits on the history worker.
    checkpoint = new Promise<void>((r) => {
      endCheckpoint = () => {
        checkpoint = null;
        r();
      };
    });
    endHistory();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    endCheckpoint();
    await write;
    return wroteInFlight ?? false;
  }

  it("control: the old `checkpoint() ?? history()` awaited once writes inside the checkpoint", async () => {
    expect(await writesInsideCheckpoint((cp, hist) => () => cp() ?? hist())).toBe(true);
  });

  it("the combined gate waits until every source is clear", async () => {
    expect(await writesInsideCheckpoint((cp, hist) => combineWriteGates(cp, hist))).toBe(false);
    expect(
      combineWriteGates(
        () => null,
        () => null,
      )(),
    ).toBeNull();
  });

  it("the daemon builds its write gate with combineWriteGates", () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../src/daemon/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/const writeGate = combineWriteGates\(/);
  });
});

describe("watchUngatedWrites", () => {
  it("flags run/exec/transaction writes while in flight, never reads or writes outside the window", () => {
    let inFlight = false;
    watchUngatedWrites(
      db,
      () => inFlight,
      (w) => flagged.push(w),
    );
    db.exec("CREATE TABLE t (x INTEGER)");
    db.prepare("INSERT INTO t VALUES (1)").run();
    expect(flagged).toEqual([]);

    inFlight = true;
    db.prepare("SELECT x FROM t").all(); // a read
    expect(flagged).toEqual([]);
    db.prepare("INSERT INTO t VALUES (2)").run();
    db.exec("DELETE FROM t WHERE x = 2");
    db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (3)").run(); // nested: one flag for the transaction
    })();
    expect(flagged.map((w) => w.sql)).toEqual([
      "INSERT INTO t VALUES (2)",
      "DELETE FROM t WHERE x = 2",
      "transaction (anonymous)",
    ]);
    expect(db.prepare("SELECT count(*) FROM t").pluck().get()).toBe(2); // writes still ran
  });
});

describe("write gate vs a real in-flight checkpoint", () => {
  const seedNoRepoSession = (): void => {
    runMigrations(db);
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at) VALUES (?, ?, NULL, ?)",
    ).run("w1", "p1", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, ?)",
    ).run("s1", "w1", "s1.jsonl", "RECONCILED");
  };

  it(
    "a write path that yields then writes waits for the checkpoint instead of writing inside it",
    { timeout: 30_000 },
    async () => {
      seedNoRepoSession();
      cp = startWalCheckpointer(db, dbPath, { periodMs: 10, delayMs: 400 });
      const checkpointer = cp;
      watchUngatedWrites(
        db,
        () => checkpointer.inFlight(),
        (w) => flagged.push(w),
      );
      setDbWriteGate(() => checkpointer.writeGate());

      await vi.waitFor(() => expect(checkpointer.inFlight()).toBe(true), { timeout: 10_000 });
      const countBefore = checkpointer.stats().count;
      await collectSessionChurn(db);

      expect(flagged).toEqual([]); // nothing wrote inside the checkpoint
      // The write was delayed past that checkpoint, not dropped.
      expect(checkpointer.stats().count).toBeGreaterThan(countBefore);
      expect(
        db.prepare("SELECT status FROM session_churn WHERE session_id = 's1'").pluck().get(),
      ).toBe("NO_REPO");
    },
  );

  it(
    "control: the same write without the gate lands inside the checkpoint and is flagged",
    {
      timeout: 30_000,
    },
    async () => {
      seedNoRepoSession();
      cp = startWalCheckpointer(db, dbPath, { periodMs: 10, delayMs: 400 });
      const checkpointer = cp;
      watchUngatedWrites(
        db,
        () => checkpointer.inFlight(),
        (w) => flagged.push(w),
      );
      // No setDbWriteGate: the gate is open, as every non-ingest write was before the fix.
      await vi.waitFor(() => expect(checkpointer.inFlight()).toBe(true), { timeout: 10_000 });
      await collectSessionChurn(db);
      expect(flagged.map((w) => w.sql)).toEqual([
        expect.stringContaining("INSERT INTO session_churn"),
      ]);
    },
  );
});
