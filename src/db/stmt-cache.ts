/**
 * src/db/stmt-cache.ts — per-connection prepared-statement cache (P0-U5).
 *
 * Only for statements used through `.get()`, `.all()` or `.run()`. `.raw()`, `.pluck()`,
 * `.expand()` and `.safeIntegers()` mutate the shared Statement, and a re-entrant `.iterate()`
 * throws "This statement is busy executing"; test/db/stmt-cache.test.ts rejects those chained
 * off `prep(...)`. Apply to hot paths only.
 */

import type Database from "better-sqlite3";
import type { Db } from "./open.js";

const caches = new WeakMap<Db, Map<string, Database.Statement>>();

/** Return the memoized Statement for `sql` on `db`, preparing it on first use. */
export function prep(db: Db, sql: string): Database.Statement {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
