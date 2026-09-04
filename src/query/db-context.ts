/**
 * src/query/db-context.ts — DB handle for the LocalQueryAPI read layer.
 *
 * WHY THIS EXISTS (interface note for reviewers):
 * The frozen LocalQueryAPI method signatures (query/api/overview.ts) take no
 * `db` parameter, and the daemon router (src/daemon/router.ts, off-limits to
 * WP2) calls them without forwarding the `db` it receives. So the query layer
 * needs its own way to reach the database. This module provides it:
 *
 *   - Tests call `setQueryDb(fixtureDb)` to inject the seeded fixture DB.
 *   - In production, `getQueryDb()` lazily opens a read connection to the same
 *     on-disk DB file the daemon uses (resolved via daemon config / AW_DB_PATH).
 *     better-sqlite3 in WAL mode supports multiple connections to one file, so
 *     a second read-only-in-practice connection alongside the daemon's writer
 *     is safe.
 *
 * The lazy-open is only reached when no DB has been injected. Ideally the daemon
 * boot would call `setQueryDb(db)` so the query layer shares the daemon's single
 * connection — but that is a daemon/** change outside WP2's ownership. Flagged,
 * not blocking: the lazy read connection is correct for the spend-path reads.
 */

import { loadConfig } from "../daemon/config.js";
import type { Db } from "../db/open.js";
import { openDb } from "../db/open.js";

let active: Db | null = null;

/** Inject the DB the query layer should use (tests; optional daemon wiring). */
export function setQueryDb(db: Db): void {
  active = db;
}

/** Clear the injected DB (tests, between cases). Does not close the handle. */
export function resetQueryDb(): void {
  active = null;
}

/**
 * Return the active query DB, lazily opening the configured on-disk DB the
 * first time if none was injected.
 */
export function getQueryDb(): Db {
  if (active !== null) return active;
  active = openDb(loadConfig().dbPath);
  return active;
}
