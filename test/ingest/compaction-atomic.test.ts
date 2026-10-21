/**
 * test/ingest/compaction-atomic.test.ts — P0-U12 review fix.
 *
 * turns.is_compaction_boundary is ingest-derived durable state. A process that
 * dies after a chunk commits but before the boundary recompute runs must not
 * leave it stale: on restart the persisted-version skip never re-reads the
 * file, so nothing would repair it. A trigger that aborts the flag write
 * stands in for the kill (the recompute dies part-way); the restarted
 * process must converge on the flags a clean ingest produces.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, writeCorpus } from "./synth.js";

const SESSION = "session-u12-compaction";
const SLUG = "project-synthetic";
const opts = { now: () => new Date("2026-08-01T00:00:00.000Z"), activityWindowSecs: 300 };
const ts = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (id: string, minute: number) =>
  assistant({ id, session: SESSION, ts: ts(minute), input: 100, output: 10 });
const boundary = (minute: number) => ({
  type: "assistant",
  subtype: "compact_boundary",
  timestamp: ts(minute),
  sessionId: SESSION,
  message: { content: [] },
});
const LINES = [turn("t0", 0), turn("t1", 1), boundary(2), turn("t2", 3), turn("t3", 4)];

const KILL_IN_RECOMPUTE =
  "CREATE TRIGGER u12_kill BEFORE UPDATE OF is_compaction_boundary ON turns " +
  "WHEN NEW.is_compaction_boundary = 1 BEGIN SELECT RAISE(ABORT, 'u12 killed in recompute'); END";

let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-u12-compaction-"));
  writeCorpus(root, { [SLUG]: { [`${SESSION}.jsonl`]: LINES } });
  file = path.join(root, SLUG, `${SESSION}.jsonl`);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function flagged(db: Db): string[] {
  return (
    db
      .prepare("SELECT message_id FROM turns WHERE is_compaction_boundary = 1 ORDER BY message_id")
      .all() as { message_id: string }[]
  ).map((r) => r.message_id);
}

function referenceFlags(): string[] {
  const db = migratedMemDb();
  new Ingestor(db, [root], opts).ingestFile(file, SLUG);
  const out = flagged(db);
  db.close();
  return out;
}

describe("P0-U12 compaction-boundary recompute is atomic with the chunk", () => {
  it("a kill during the recompute after the last chunk does not leave the flag stale", () => {
    const expected = referenceFlags();
    expect(expected).toEqual(["t2"]);

    const db = migratedMemDb();
    db.exec(KILL_IN_RECOMPUTE);
    expect(() => new Ingestor(db, [root], opts).ingestFile(file, SLUG)).toThrow(
      /u12 killed in recompute/,
    );
    db.exec("DROP TRIGGER u12_kill");

    // Fresh process on the same DB and an unchanged file.
    new Ingestor(db, [root], opts).ingestFile(file, SLUG);
    expect(flagged(db)).toEqual(expected);
    db.close();
  });

  it("a kill between chunks (one line per chunk) converges after restart", async () => {
    const expected = referenceFlags();

    const db = migratedMemDb();
    db.exec(KILL_IN_RECOMPUTE);
    await expect(new Ingestor(db, [root], opts).ingestFileYielding(file, SLUG, 1)).rejects.toThrow(
      /u12 killed in recompute/,
    );
    db.exec("DROP TRIGGER u12_kill");

    await new Ingestor(db, [root], opts).ingestFileYielding(file, SLUG, 1);
    expect(flagged(db)).toEqual(expected);
    db.close();
  });
});
