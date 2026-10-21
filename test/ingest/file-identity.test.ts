/**
 * test/ingest/file-identity.test.ts — P3-U7 file identity across paths (R-4).
 *
 * A file whose bytes up to a stored watermark match an existing ingest_offsets
 * row (same head hash, same 4 KB tail hash at that offset) is the same
 * transcript at a new path: a copy or a rename. Its progress carries over and
 * nothing is re-parsed. A rewrite before the watermark is caught by the tail
 * hash and re-read from 0, and every reset bumps the file's reset_count.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, toJsonl, writeCorpus } from "./synth.js";

const NOW = () => new Date("2026-09-22T12:00:00.000Z");
const OPTIONS = { now: NOW, activityWindowSecs: 300 };

let db: Db;
let tmp: string;
let rootA: string;
let rootB: string;

function turn(id: string, session: string, minute: number): ReturnType<typeof assistant> {
  return assistant({
    id,
    session,
    ts: `2026-09-22T11:${String(minute).padStart(2, "0")}:00.000Z`,
    input: 10,
    output: 1,
  });
}

/** Rows a full re-read could change; the oracle for "carry-over loses nothing". */
function contentDump(): unknown {
  return {
    turns: db
      .prepare(
        "SELECT message_id, session_id, ts, input_tokens, output_tokens FROM turns ORDER BY message_id",
      )
      .all(),
    sessions: db
      .prepare("SELECT session_id, workspace_id, turn_count FROM sessions ORDER BY session_id")
      .all(),
    metricEvents: db.prepare("SELECT COUNT(*) AS n FROM ingest_metric_events").get(),
  };
}

function offsetRow(filePath: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      "SELECT byte_offset, tail_hash, parser_version, reset_count FROM ingest_offsets WHERE file_path = ?",
    )
    .get(filePath) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  db = migratedMemDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-file-identity-"));
  rootA = path.join(tmp, "a");
  rootB = path.join(tmp, "b");
  writeCorpus(rootA, {
    "proj-id": {
      "one.jsonl": [turn("id-1a", "id-s1", 0), turn("id-1b", "id-s1", 1)],
      "two.jsonl": [turn("id-2a", "id-s2", 2)],
    },
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P3-U7 file identity", () => {
  it("a copied corpus at a new path parses 0 files and changes no content", async () => {
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    const before = contentDump();
    fs.cpSync(rootA, rootB, { recursive: true });

    const r = await new Ingestor(db, [rootB], OPTIONS).runBackgroundBackfill(1);
    expect(r.files_total).toBe(2);
    expect(r.files_with_new_data).toBe(0);
    expect(r.files_skipped).toBe(2);
    expect(contentDump()).toEqual(before);

    const copied = path.join(rootB, "proj-id", "one.jsonl");
    expect(offsetRow(copied)?.byte_offset).toBe(fs.statSync(copied).size);
    expect(offsetRow(copied)?.reset_count).toBe(0);
  });

  it("a renamed file carries over", async () => {
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    const before = contentDump();
    fs.renameSync(rootA, rootB);

    const r = await new Ingestor(db, [rootB], OPTIONS).runBackgroundBackfill(1);
    expect(r.files_with_new_data).toBe(0);
    expect(r.files_skipped).toBe(2);
    expect(contentDump()).toEqual(before);
  });

  it("an append to a carried-over copy ingests only the new line", async () => {
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    fs.cpSync(rootA, rootB, { recursive: true });
    fs.appendFileSync(
      path.join(rootB, "proj-id", "one.jsonl"),
      toJsonl([turn("id-1c", "id-s1", 3)]),
    );

    const r = await new Ingestor(db, [rootB], OPTIONS).runBackgroundBackfill(1);
    expect(r.files_with_new_data).toBe(1);
    expect(r.files_skipped).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT turn_count FROM sessions WHERE session_id = 'id-s1'").get()).toEqual({
      turn_count: 3,
    });
  });

  it("a file at a new path whose bytes differ before the watermark is read in full", async () => {
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    writeCorpus(rootB, {
      "proj-id": {
        // Same first line (same head hash), different second line.
        "one.jsonl": [turn("id-1a", "id-s1", 0), turn("id-1x", "id-s1", 1)],
      },
    });

    const r = await new Ingestor(db, [rootB], OPTIONS).runBackgroundBackfill(1);
    expect(r.files_with_new_data).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id = 'id-1x'").get()).toEqual({
      n: 1,
    });
  });

  it("a rewrite before the watermark that grows the file resets to 0 and counts the reset", async () => {
    const file = path.join(rootA, "proj-id", "one.jsonl");
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    const oldOffset = offsetRow(file)?.byte_offset as number;

    // Same first line, same inode, larger size; the second line changed in place.
    fs.writeFileSync(
      file,
      toJsonl([turn("id-1a", "id-s1", 0), turn("id-1y", "id-s1", 1), turn("id-1z", "id-s1", 4)]),
    );
    expect(fs.statSync(file).size).toBeGreaterThan(oldOffset);

    await new Ingestor(db, [rootA], OPTIONS).runBackgroundBackfill(1);
    for (const id of ["id-1y", "id-1z"]) {
      expect(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE message_id = ?").get(id)).toEqual({
        n: 1,
      });
    }
    expect(offsetRow(file)?.reset_count).toBe(1);
    expect(offsetRow(file)?.byte_offset).toBe(fs.statSync(file).size);
  });

  it("a truncation counts a reset", async () => {
    const file = path.join(rootA, "proj-id", "one.jsonl");
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    fs.writeFileSync(file, toJsonl([turn("id-1a", "id-s1", 0)]));

    await new Ingestor(db, [rootA], OPTIONS).runBackgroundBackfill(1);
    expect(offsetRow(file)?.reset_count).toBe(1);
  });

  it("records parser_version and tail_hash, and backfills a legacy row's tail_hash on a skip", async () => {
    const file = path.join(rootA, "proj-id", "one.jsonl");
    new Ingestor(db, [rootA], OPTIONS).runBackscan();
    expect(offsetRow(file)?.parser_version).toEqual(expect.any(String));
    expect(offsetRow(file)?.tail_hash).toEqual(expect.any(String));

    db.prepare("UPDATE ingest_offsets SET tail_hash = NULL").run();
    const r = await new Ingestor(db, [rootA], OPTIONS).runBackgroundBackfill(1);
    expect(r.files_skipped).toBe(2);
    expect(offsetRow(file)?.tail_hash).toEqual(expect.any(String));

    // The backfilled hash is good enough to carry a rename over.
    fs.renameSync(rootA, rootB);
    const moved = await new Ingestor(db, [rootB], OPTIONS).runBackgroundBackfill(1);
    expect(moved.files_with_new_data).toBe(0);
  });
});
