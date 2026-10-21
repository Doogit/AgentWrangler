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

/** P3-U8 R-9: skip the pre-migration backup above this size (`VACUUM INTO` ≈ 20 s at 366 MB). */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;

export interface MigrateOptions {
  backupMaxBytes?: number;
  log?: (message: string) => void;
}

/** `VACUUM INTO <db>.pre-migrate.bak` (one file, replaced each time) when the DB is a file under the cap. */
function backupBeforeMigrating(db: Db, maxBytes: number, log: (m: string) => void): void {
  if (db.memory || !fs.existsSync(db.name)) return;
  const size = fs.statSync(db.name).size;
  if (size > maxBytes) {
    log(`Migrations: backup skipped — DB is ${size} bytes, over the ${maxBytes}-byte cap`);
    return;
  }
  const backup = `${db.name}.pre-migrate.bak`;
  fs.rmSync(backup, { force: true });
  db.prepare("VACUUM INTO ?").run(backup);
  log(`Migrations: backup written to ${backup}`);
}

/**
 * Run pending migrations against `db`, optionally stopping at `throughVersion`.
 * Returns the list of newly-applied version strings (empty when already up-to-date).
 *
 * The first migration (001_observe.sql) is responsible for creating the
 * schema_migrations table. Subsequent calls find the table already present.
 *
 * P3-U8 R-9: refuses a DB that has a migration newer than this binary's newest (a downgrade),
 * and backs up an existing DB before applying anything to it.
 */
export function runMigrations(
  db: Db,
  throughVersion?: string,
  opts: MigrateOptions = {},
): string[] {
  // Determine which migrations have already been applied (if the bookkeeping
  // table exists) or treat the list as empty (first ever run).
  const hasTable = migrationsTableExists(db);
  const applied = hasTable ? appliedVersions(db) : new Set<string>();
  const known = discoverMigrations();
  const newest = known[known.length - 1]?.version ?? "";
  const newer = [...applied].filter((v) => v > newest).sort();
  if (newer.length > 0) {
    throw new Error(
      `This DB was migrated by a newer AgentWrangler (${newer.join(", ")}); this build knows up to ` +
        `${newest}. Upgrade AgentWrangler, or point it at another DB with --db-path.`,
    );
  }
  const pending = known.filter(
    (m) => !applied.has(m.version) && (throughVersion === undefined || m.version <= throughVersion),
  );
  if (hasTable && pending.length > 0) {
    backupBeforeMigrating(db, opts.backupMaxBytes ?? BACKUP_MAX_BYTES, opts.log ?? console.log);
  }

  const applied_now: string[] = [];

  for (const { version, filePath } of pending) {
    const sql = fs.readFileSync(filePath, "utf-8");
    const requiresForeignKeysOff = sql.startsWith("-- migrate: foreign-keys-off");
    const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
    if (requiresForeignKeysOff && foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
    // Run the migration SQL + record the version atomically.
    try {
      db.transaction(() => {
        db.exec(sql);
        if (requiresForeignKeysOff) {
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) {
            throw new Error(`migration ${version} introduced foreign-key violations`);
          }
        }
        // schema_migrations must now exist (created by the SQL if it wasn't before).
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          version,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (requiresForeignKeysOff && foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
    }
    applied_now.push(version);
  }

  return applied_now;
}
