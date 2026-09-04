/**
 * test/ingest/dbutil.ts — a migrated in-memory DB for ingestion tests.
 */

import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";

export function migratedMemDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
