/**
 * test/db/migration-safety.test.ts — P3-U8 R-9: forward-only migrations.
 *
 * 1. A DB that has a migration newer than this binary knows → refused, nothing applied.
 * 2. A pending migration on a file DB under the size cap → a `VACUUM INTO` backup exists, taken
 *    before the migration ran (oracle: the backup's schema_migrations count = the pre-run count).
 * 3. Over the size cap → no backup, and the skip is reported (not silent).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";

const BEFORE_LAST = "041_perf_indexes";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-migsafe-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const count = (db: Database.Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;

describe("P3-U8 R-9: newer-schema refusal", () => {
  it("refuses a DB with a migration this binary does not know, and applies nothing", () => {
    const db = openDb(path.join(dir, "db.sqlite"));
    runMigrations(db, BEFORE_LAST);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      "999_from_a_newer_build",
      new Date().toISOString(),
    );
    const before = count(db);
    expect(() => runMigrations(db)).toThrow(/newer.*999_from_a_newer_build/i);
    expect(count(db)).toBe(before);
    db.close();
  }, 30_000);
});

describe("P3-U8 R-9: pre-migration backup", () => {
  it("takes a VACUUM INTO backup before a pending migration runs", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const db = openDb(dbPath);
    runMigrations(db, BEFORE_LAST);
    const before = count(db);
    const log: string[] = [];
    const applied = runMigrations(db, undefined, { log: (m) => log.push(m) });
    expect(applied.length).toBeGreaterThan(0);
    const backup = `${dbPath}.pre-migrate.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    const copy = new Database(backup, { readonly: true });
    expect(count(copy)).toBe(before);
    copy.close();
    expect(count(db)).toBe(before + applied.length);
    expect(log.join("\n")).toMatch(/backup/i);
    db.close();
  });

  it("no backup on a fresh DB (nothing to lose) or when nothing is pending", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const db = openDb(dbPath);
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
    expect(fs.existsSync(`${dbPath}.pre-migrate.bak`)).toBe(false);
    db.close();
  });

  it("over the size cap: skips the backup and says so", () => {
    const dbPath = path.join(dir, "db.sqlite");
    const db = openDb(dbPath);
    runMigrations(db, BEFORE_LAST);
    const log: string[] = [];
    runMigrations(db, undefined, { backupMaxBytes: 0, log: (m) => log.push(m) });
    expect(fs.existsSync(`${dbPath}.pre-migrate.bak`)).toBe(false);
    expect(log.join("\n")).toMatch(/backup skipped/i);
    db.close();
  });
});
