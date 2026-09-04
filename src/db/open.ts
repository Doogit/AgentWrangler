/**
 * src/db/open.ts — open a better-sqlite3 database with required pragmas.
 *
 * Enforces:
 *  - WAL journal mode (on-disk only; in-memory stays 'memory', which is expected).
 *  - foreign_keys=ON (SEC constraint; enforced at every open).
 *
 * Never open :memory: in production paths — this module is for on-disk DBs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Open an on-disk SQLite database at `dbPath`, creating parent directories as needed.
 * Applies WAL journal mode and foreign_keys=ON before returning.
 */
export function openDb(dbPath: string): Db {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  const fk = (db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys;
  if (fk !== 1) {
    db.close();
    throw new Error("FATAL: foreign_keys pragma failed to enable");
  }

  return db;
}
