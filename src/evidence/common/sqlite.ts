import Database from "better-sqlite3";

/** Open an existing SQLite file with both OS-level readonly and SQLite query-only guards. */
export function openQueryOnlyDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const queryOnly = db.pragma("query_only", { simple: true });
    if (queryOnly !== 1) throw new Error("query_only_not_enabled");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function assertDatabaseIntegrity(db: Database.Database): void {
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("sqlite_integrity_check_failed");
  }
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length !== 0) throw new Error("sqlite_foreign_key_check_failed");
}
