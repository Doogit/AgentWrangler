/**
 * test/ingest/tail.test.ts — byte-offset tailer + offset store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import {
  type Offset,
  fileVersion,
  loadOffset,
  saveOffset,
  tailFile,
} from "../../src/ingest/tail.js";
import { migratedMemDb } from "./dbutil.js";

let tmp: string;
let fp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-tail-"));
  fp = path.join(tmp, "s.jsonl");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function poll(stored: Offset | null): ReturnType<typeof tailFile> {
  return tailFile(fp, stored);
}

describe("tailFile", () => {
  it("reads complete lines and advances the offset to EOF", () => {
    fs.writeFileSync(fp, "a\nb\nc\n");
    const r = poll(null);
    expect(r.lines).toEqual(["a", "b", "c"]);
    expect(r.newOffset).toBe(6);
    expect(r.event).toBeNull();
  });

  it("holds a partial trailing line until it is completed", () => {
    fs.writeFileSync(fp, "a\nb\npar");
    const r1 = poll(null);
    expect(r1.lines).toEqual(["a", "b"]);
    expect(r1.newOffset).toBe(4); // "a\nb\n"

    // Append the rest of the partial line + a newline.
    fs.appendFileSync(fp, "tial\n");
    const r2 = poll({ offset: r1.newOffset, headHash: r1.newHeadHash, fileVersion: null });
    expect(r2.lines).toEqual(["partial"]);
  });

  it("is a no-op when re-polled with nothing new", () => {
    fs.writeFileSync(fp, "a\nb\n");
    const r1 = poll(null);
    const r2 = poll({ offset: r1.newOffset, headHash: r1.newHeadHash, fileVersion: null });
    expect(r2.lines).toEqual([]);
    expect(r2.event).toBeNull();
  });

  it("detects truncation and re-scans from the top", () => {
    fs.writeFileSync(fp, "aaaa\nbbbb\ncccc\n");
    const r1 = poll(null);
    // Shrink the file below the stored offset (same head bytes ⇒ truncation).
    fs.writeFileSync(fp, "aaaa\n");
    const r2 = poll({ offset: r1.newOffset, headHash: r1.newHeadHash, fileVersion: null });
    expect(r2.event).toBe("TRUNCATION");
    expect(r2.wasReset).toBe(true);
    expect(r2.lines).toEqual(["aaaa"]);
  });

  it("detects rotation via a head-hash change", () => {
    fs.writeFileSync(fp, "original-header-line\nsecond\n");
    const r1 = poll(null);
    // Replace with completely different content (same-or-larger size).
    fs.writeFileSync(fp, "totally-different-header\nx\ny\nz\n");
    const r2 = poll({ offset: r1.newOffset, headHash: r1.newHeadHash, fileVersion: null });
    expect(r2.event).toBe("ROTATION");
    expect(r2.wasReset).toBe(true);
    expect(r2.lines).toEqual(["totally-different-header", "x", "y", "z"]);
  });

  it("does not report rotation when a file smaller than HEAD_BYTES is appended to", () => {
    // A fresh session file starts well under HEAD_BYTES (256) and grows by
    // appends. Hashing a different byte count each poll would falsely flag
    // rotation; the width-prefixed head hash must re-hash the original count.
    fs.writeFileSync(fp, "line-one\n");
    const r1 = poll(null);
    fs.appendFileSync(fp, "line-two\n");
    const r2 = poll({ offset: r1.newOffset, headHash: r1.newHeadHash, fileVersion: null });
    expect(r2.event).toBeNull();
    expect(r2.wasReset).toBe(false);
    expect(r2.lines).toEqual(["line-two"]);
  });

  it("preserves normal appends when the persisted version changes", () => {
    fs.writeFileSync(fp, "line-one\n");
    const first = poll(null);
    const before = fileVersion(fs.statSync(fp));
    fs.appendFileSync(fp, "line-two\n");
    const current = fileVersion(fs.statSync(fp));
    const second = tailFile(
      fp,
      { offset: first.newOffset, headHash: first.newHeadHash, fileVersion: before },
      current,
    );
    expect(second.event).toBeNull();
    expect(second.wasReset).toBe(false);
    expect(second.lines).toEqual(["line-two"]);
  });

  it("uses a legacy offset as a version baseline without replaying it", () => {
    fs.writeFileSync(fp, "already-ingested\n");
    const first = poll(null);
    const second = tailFile(
      fp,
      { offset: first.newOffset, headHash: first.newHeadHash, fileVersion: null },
      fileVersion(fs.statSync(fp)),
    );
    expect(second.event).toBeNull();
    expect(second.wasReset).toBe(false);
    expect(second.lines).toEqual([]);
  });

  it("resets an equal-size same-prefix rewrite when its version timestamp changes", () => {
    const prefix = "x".repeat(256);
    fs.writeFileSync(fp, `${prefix}\nold-id\n`);
    const first = poll(null);
    const before = fileVersion(fs.statSync(fp));
    fs.writeFileSync(fp, `${prefix}\nnew-id\n`);
    const changed = { ...before, mtimeMs: before.mtimeMs + 1, ctimeMs: before.ctimeMs + 1 };
    const second = tailFile(
      fp,
      { offset: first.newOffset, headHash: first.newHeadHash, fileVersion: before },
      changed,
    );
    expect(second.event).toBe("ROTATION");
    expect(second.lines).toEqual([prefix, "new-id"]);
  });

  it("resets a growing replacement when file identity changes", () => {
    fs.writeFileSync(fp, "old-id\n");
    const first = poll(null);
    const before = fileVersion(fs.statSync(fp));
    fs.writeFileSync(fp, "old-id\nnew-id\n");
    const changed = { ...fileVersion(fs.statSync(fp)), ino: `${before.ino}-replacement` };
    const second = tailFile(
      fp,
      { offset: first.newOffset, headHash: first.newHeadHash, fileVersion: before },
      changed,
    );
    expect(second.event).toBe("ROTATION");
    expect(second.lines).toEqual(["old-id", "new-id"]);
  });
});

describe("offset store (ingest_offsets)", () => {
  let db: Db;
  beforeEach(() => {
    db = migratedMemDb();
  });
  afterEach(() => db.close());

  it("round-trips an offset through the DB", () => {
    expect(loadOffset(db, fp)).toBeNull();
    const firstVersion = { size: 128, dev: "1", ino: "2", mtimeMs: 3, ctimeMs: 4 };
    saveOffset(db, fp, 128, "deadbeef", firstVersion);
    expect(loadOffset(db, fp)).toEqual({
      offset: 128,
      headHash: "deadbeef",
      fileVersion: firstVersion,
    });
    // Upsert overwrites.
    const secondVersion = { size: 256, dev: "1", ino: "2", mtimeMs: 5, ctimeMs: 6 };
    saveOffset(db, fp, 256, "cafe", secondVersion);
    expect(loadOffset(db, fp)).toEqual({
      offset: 256,
      headHash: "cafe",
      fileVersion: secondVersion,
    });
  });

  it("loads a pre-016 offset as a versionless baseline", () => {
    db.prepare(
      `INSERT INTO ingest_offsets (file_path, byte_offset, file_hash_head, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(fp, 128, "deadbeef", "2026-01-01T00:00:00.000Z");
    expect(loadOffset(db, fp)).toEqual({ offset: 128, headHash: "deadbeef", fileVersion: null });
  });
});
