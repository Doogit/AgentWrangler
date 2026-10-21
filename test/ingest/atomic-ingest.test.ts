/**
 * test/ingest/atomic-ingest.test.ts — P0-U12.
 *
 * (a) Replay idempotence: re-applying an already-committed chunk (the state a
 *     pre-U12 crash between the chunk tx and saveOffset left behind) must not
 *     double sessions.turn_count / user_turn_count / cost_equiv_u or any ingest
 *     table. Oracle: P0-U11's table digest, plus a recount of the session
 *     counters from the rows they summarise.
 * (b) Atomicity: when the offset or a baseline write fails inside a chunk, the
 *     chunk commits nothing (no turns, offset and baselines unchanged), and the
 *     next pass re-applies it cleanly. Covers the non-empty and empty-chunk paths.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HARNESS_NOW_MS,
  corpusFiles,
  diffDigests,
  ingestDigest,
} from "../../scripts/benchmark/backfill-harness.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { Ingestor } from "../../src/ingest/index.js";
import { generateCorpus } from "./synth.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-u12-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Db = Database.Database;

function freshDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function newIngestor(db: Db, root: string): Ingestor {
  return new Ingestor(db, [root], { now: () => new Date(HARNESS_NOW_MS) });
}

/** One synthetic session file; returns its bytes and a line boundary near the middle. */
function oneFile(seed: number): { slug: string; name: string; bytes: Buffer; mid: number } {
  const f = corpusFiles(generateCorpus(seed, { slugs: 1, filesPerSlug: 1, turnsPerFile: 25 }))[0];
  if (f === undefined) throw new Error("empty corpus");
  const mid = f.bytes.indexOf(0x0a, Math.floor(f.bytes.length / 2)) + 1;
  return { ...f, mid };
}

function storedOffset(db: Db, filePath: string): number | undefined {
  const r = db
    .prepare("SELECT byte_offset FROM ingest_offsets WHERE file_path = ?")
    .get(filePath) as { byte_offset: number } | undefined;
  return r?.byte_offset;
}

function metricBaseline(db: Db, filePath: string): number | undefined {
  const r = db
    .prepare("SELECT seeded_offset FROM ingest_metric_baselines WHERE file_path = ?")
    .get(filePath) as { seeded_offset: number } | undefined;
  return r?.seeded_offset;
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Session counters that disagree with a recount from the rows they summarise. */
function counterDrift(db: Db): unknown[] {
  return db
    .prepare(
      `SELECT s.session_id, s.turn_count, s.user_turn_count, s.cost_equiv_u,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turns_n,
              (SELECT COALESCE(SUM(t.cost_equiv_u), 0) FROM turns t WHERE t.session_id = s.session_id) AS cost_n,
              (SELECT COUNT(*) FROM ingest_metric_events m
                 WHERE m.session_id = s.session_id AND m.is_user_turn = 1) AS user_n
         FROM sessions s
        WHERE s.turn_count <> turns_n OR s.cost_equiv_u <> cost_n OR s.user_turn_count <> user_n`,
    )
    .all();
}

describe("P0-U12 replay idempotence (pre-fix crash-restart shape)", () => {
  it("re-applying a committed chunk does not double session counters or any ingest table", () => {
    const f = oneFile(12);
    const root = path.join(tmp, "replay");
    const dir = path.join(root, f.slug);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, f.name);

    // Chunk 1 (first half) then chunk 2 (the rest), as two tails.
    const db = freshDb();
    const first = newIngestor(db, root);
    fs.writeFileSync(filePath, f.bytes.subarray(0, f.mid));
    first.ingestFile(filePath, f.slug);
    expect(storedOffset(db, filePath)).toBe(f.mid);
    fs.appendFileSync(filePath, f.bytes.subarray(f.mid));
    first.ingestFile(filePath, f.slug);
    expect(storedOffset(db, filePath)).toBe(f.bytes.length);

    const before = ingestDigest(db);
    expect(before.turns?.count ?? 0).toBeGreaterThan(0);
    expect(before.sessions?.sums.user_turn_count ?? 0).toBeGreaterThan(0);
    expect(before.sessions?.sums.cost_equiv_u ?? 0).toBeGreaterThan(0);
    expect(counterDrift(db)).toEqual([]);

    // Simulate the pre-U12 crash: chunk 2's rows committed, but the offset and
    // both baselines still point at chunk 2's start. A fresh process resumes.
    db.prepare("UPDATE ingest_offsets SET byte_offset = ? WHERE file_path = ?").run(
      f.mid,
      filePath,
    );
    db.prepare("UPDATE ingest_metric_baselines SET seeded_offset = ? WHERE file_path = ?").run(
      f.mid,
      filePath,
    );
    db.prepare("UPDATE ingest_classifier_baselines SET seeded_offset = ?").run(f.mid);

    const restarted = newIngestor(db, root);
    let applied = 0;
    const target = restarted as unknown as { applyLine: (...a: unknown[]) => void };
    const orig = target.applyLine.bind(restarted);
    target.applyLine = (...a: unknown[]) => {
      applied++;
      orig(...a);
    };
    restarted.ingestFile(filePath, f.slug);
    expect(applied).toBeGreaterThan(0); // the chunk really was re-applied
    expect(storedOffset(db, filePath)).toBe(f.bytes.length);

    expect(diffDigests(before, ingestDigest(db))).toEqual([]);
    expect(counterDrift(db)).toEqual([]);
    db.close();
  });
});

describe("P0-U12 atomicity: a failing offset/baseline write commits nothing from the chunk", () => {
  const FAILURES = [
    {
      name: "saveOffset",
      ddl: "CREATE TRIGGER u12_fail BEFORE INSERT ON ingest_offsets BEGIN SELECT RAISE(ABORT, 'u12 injected'); END",
    },
    {
      name: "metric baseline",
      ddl: "CREATE TRIGGER u12_fail BEFORE UPDATE ON ingest_metric_baselines WHEN NEW.seeded_offset > 0 BEGIN SELECT RAISE(ABORT, 'u12 injected'); END",
    },
    {
      name: "classifier baseline",
      ddl: "CREATE TRIGGER u12_fail BEFORE INSERT ON ingest_classifier_baselines BEGIN SELECT RAISE(ABORT, 'u12 injected'); END",
    },
  ];

  it.each(FAILURES)("non-empty chunk, $name throws", ({ name, ddl }) => {
    const f = oneFile(21);
    const root = path.join(tmp, `atomic-${name.replace(/\W/g, "_")}`);
    const dir = path.join(root, f.slug);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, f.name);
    fs.writeFileSync(filePath, f.bytes);

    const scratch = freshDb();
    newIngestor(scratch, root).ingestFile(filePath, f.slug);
    const expected = ingestDigest(scratch);
    scratch.close();
    expect(expected.turns?.count ?? 0).toBeGreaterThan(0);

    const db = freshDb();
    const ingestor = newIngestor(db, root);
    db.exec(ddl);
    expect(() => ingestor.ingestFile(filePath, f.slug)).toThrow(/u12 injected/);

    // All-or-nothing: none of the chunk's rows, offset unchanged (never written).
    expect(count(db, "turns")).toBe(0);
    expect(count(db, "tool_events")).toBe(0);
    expect(count(db, "ingest_metric_events")).toBe(0);
    expect(storedOffset(db, filePath)).toBeUndefined();
    expect(metricBaseline(db, filePath) ?? 0).toBe(0);
    expect(count(db, "ingest_classifier_baselines")).toBe(0);

    // Next pass (same process) re-applies cleanly.
    db.exec("DROP TRIGGER u12_fail");
    ingestor.ingestFile(filePath, f.slug);
    expect(storedOffset(db, filePath)).toBe(f.bytes.length);
    expect(diffDigests(expected, ingestDigest(db))).toEqual([]);
    expect(counterDrift(db)).toEqual([]);
    db.close();
  });

  it("empty chunk (blank lines only): offset and baselines move together or not at all", () => {
    const root = path.join(tmp, "atomic-empty");
    const dir = path.join(root, "proj-empty");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "blank.jsonl");
    fs.writeFileSync(filePath, "\n\n\n");

    const db = freshDb();
    const ingestor = newIngestor(db, root);
    db.exec(
      "CREATE TRIGGER u12_fail BEFORE INSERT ON ingest_classifier_baselines BEGIN SELECT RAISE(ABORT, 'u12 injected'); END",
    );
    expect(() => ingestor.ingestFile(filePath, "proj-empty")).toThrow(/u12 injected/);
    expect(storedOffset(db, filePath)).toBeUndefined();
    expect(metricBaseline(db, filePath) ?? 0).toBe(0);

    db.exec("DROP TRIGGER u12_fail");
    ingestor.ingestFile(filePath, "proj-empty");
    expect(storedOffset(db, filePath)).toBe(3);
    expect(metricBaseline(db, filePath)).toBe(3);
    expect(count(db, "ingest_classifier_baselines")).toBe(1);
    db.close();
  });
});
