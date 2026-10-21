/**
 * test/db/write-intent.test.ts — a worker connection's writes vs main-thread ingest (G-P2 lock defect).
 *
 * Oracle: SQLite's own locking. Two connections on one WAL database stand in for the history worker
 * (B) and main-thread ingest (A); A commits between B's read and B's write, which is what a 25 ms
 * ingest step does to a walk transaction running concurrently on the worker thread.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, openDb } from "../../src/db/open.js";
import {
  announceWrites,
  clearWriteIntent,
  createWriteIntent,
  writeIntentGate,
} from "../../src/db/write-intent.js";

let dir: string;
let a: Db;
let b: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-write-intent-"));
  const dbPath = path.join(dir, "db.sqlite");
  a = openDb(dbPath);
  a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
  a.prepare("INSERT INTO t (v) VALUES (0)").run();
  b = openDb(dbPath);
  a.pragma("busy_timeout = 0");
  b.pragma("busy_timeout = 0");
});

afterEach(() => {
  a.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** B reads, A commits a write, then B writes — all inside one B transaction. */
const readCommitWrite = (): void =>
  b.transaction(() => {
    b.prepare("SELECT COUNT(*) FROM t").get();
    try {
      a.prepare("INSERT INTO t (v) VALUES (1)").run();
    } catch {
      // A is locked out while B holds the write lock; that is the intended outcome.
    }
    b.prepare("INSERT INTO t (v) VALUES (2)").run();
  })();

it("without it, a write after a read fails at once once another connection committed", () => {
  expect(readCommitWrite).toThrow(/locked|busy/i);
});

it("announced transactions open IMMEDIATE, so the walk's write never loses its snapshot", () => {
  const flag = createWriteIntent();
  announceWrites(b, flag);
  expect(readCommitWrite).not.toThrow();
  expect(a.prepare("SELECT v FROM t ORDER BY id").pluck().all()).toEqual([0, 2]);
});

it("the flag is up while an announced transaction or autocommit write runs, and down after", () => {
  const flag = createWriteIntent();
  announceWrites(b, flag);
  const seen: Array<Promise<void> | null> = [];
  b.function("probe", () => {
    seen.push(writeIntentGate(flag));
    return 0;
  });
  b.transaction(() => {
    b.prepare("INSERT INTO t (v) VALUES (probe())").run();
  })();
  b.prepare("INSERT INTO t (v) VALUES (probe())").run();
  b.prepare("SELECT probe()").get();
  expect(seen.map((g) => g !== null)).toEqual([true, true, false]);
  expect(writeIntentGate(flag)).toBeNull();
});

it("the gate resolves when the flag drops, and clearWriteIntent releases a stuck flag", async () => {
  const flag = createWriteIntent();
  Atomics.store(flag, 0, 2);
  const gate = writeIntentGate(flag);
  expect(gate).not.toBeNull();
  let open = false;
  void gate?.then(() => {
    open = true;
  });
  Atomics.sub(flag, 0, 1);
  Atomics.notify(flag, 0);
  await new Promise((r) => setTimeout(r, 20));
  expect(open).toBe(false);
  clearWriteIntent(flag);
  await new Promise((r) => setTimeout(r, 20));
  expect(open).toBe(true);
});
