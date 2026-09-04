/**
 * src/db/migrate.ts — migration runner for AgentWrangler.
 *
 * Discovers SQL migration files in `src/db/migrations/` ordered by filename,
 * records each applied migration in the `schema_migrations` table, and is
 * idempotent: re-running applies nothing if all migrations are already recorded.
 *
 * Convention: migration filenames must be `NNN_<slug>.sql` (e.g. `001_observe.sql`).
 * The version key stored is the bare filename without the `.sql` extension.
 *
 * Boot-strapping note: schema_migrations is created by 001_observe.sql itself.
 * The runner checks sqlite_master directly to determine whether schema_migrations
 * already exists, avoiding the circular dependency of creating it first.
 *
 * Each migration is applied in its own transaction. If a migration fails, the
 * transaction rolls back and the error propagates — leaving the DB at the last
 * successfully applied migration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./open.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Return true if the schema_migrations table exists in the DB. */
function migrationsTableExists(db: Db): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  return row !== undefined;
}

/** Return the set of already-applied migration versions. */
function appliedVersions(db: Db): Set<string> {
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: string;
  }>;
  return new Set(rows.map((r) => r.version));
}

/** Discover migration files, sorted lexicographically (ascending). */
function discoverMigrations(): Array<{ version: string; filePath: string }> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return files.map((f) => ({
    version: f.slice(0, -4), // strip .sql
    filePath: path.join(MIGRATIONS_DIR, f),
  }));
}

/**
 * Run pending migrations against `db`, optionally stopping at `throughVersion`.
 * Returns the list of newly-applied version strings (empty when already up-to-date).
 *
 * The first migration (001_observe.sql) is responsible for creating the
 * schema_migrations table. Subsequent calls find the table already present.
 */
export function runMigrations(db: Db, throughVersion?: string): string[] {
  // Determine which migrations have already been applied (if the bookkeeping
  // table exists) or treat the list as empty (first ever run).
  const hasTable = migrationsTableExists(db);
  const applied = hasTable ? appliedVersions(db) : new Set<string>();
  const pending = discoverMigrations().filter(
    (m) => !applied.has(m.version) && (throughVersion === undefined || m.version <= throughVersion),
  );

  const applied_now: string[] = [];

  for (const { version, filePath } of pending) {
    const sql = fs.readFileSync(filePath, "utf-8");
    // Run the migration SQL + record the version atomically.
    db.transaction(() => {
      db.exec(sql);
      // schema_migrations must now exist (created by the SQL if it wasn't before).
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    })();
    applied_now.push(version);
  }

  return applied_now;
}
