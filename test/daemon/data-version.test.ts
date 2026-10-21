/**
 * test/daemon/data-version.test.ts — P1-U0 in-memory `data_version` counter (perf plan §3.2).
 *
 * The counter only moves forward, and the daemon's data-change points bump it:
 * an ingest chunk commit and a detector walk completion. (Non-GET API writes
 * are covered in get-memo.test.ts.)
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HARNESS_NOW_MS, corpusFiles } from "../../scripts/benchmark/backfill-harness.mjs";
import { bumpDataVersion, getDataVersion } from "../../src/daemon/data-version.js";
import { createDetectorPassRunner } from "../../src/daemon/detector-pass.js";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { generateCorpus } from "../ingest/synth.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p1u0-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("P1-U0 data_version", () => {
  it("bumpDataVersion moves the counter strictly forward", () => {
    const v0 = getDataVersion();
    bumpDataVersion();
    const v1 = getDataVersion();
    bumpDataVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(getDataVersion()).toBeGreaterThan(v1);
  });

  it("an ingest chunk commit bumps it", () => {
    const f = corpusFiles(generateCorpus(7, { slugs: 1, filesPerSlug: 1, turnsPerFile: 5 }))[0];
    if (f === undefined) throw new Error("empty corpus");
    const dir = path.join(tmp, "ingest", f.slug);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, f.name);
    fs.writeFileSync(filePath, f.bytes);
    const db = freshDb();
    try {
      const ingestor = new Ingestor(db, [path.join(tmp, "ingest")], {
        now: () => new Date(HARNESS_NOW_MS),
      });
      const v = getDataVersion();
      ingestor.ingestFile(filePath, f.slug);
      expect(getDataVersion()).toBeGreaterThan(v);
    } finally {
      db.close();
    }
  });

  it("a detector walk completion bumps it", async () => {
    const db = freshDb();
    try {
      const runner = createDetectorPassRunner({ db, run: async () => [] });
      const v = getDataVersion();
      const result = await runner.runIfDue(true);
      expect(result.ran).toBe(true);
      expect(getDataVersion()).toBeGreaterThan(v);
    } finally {
      db.close();
    }
  });
});
