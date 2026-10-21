import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";

describe("migration 022", () => {
  it("applies the classifier/boundary schema and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      const names = new Set(
        (
          db.prepare("PRAGMA table_info(ingest_metric_events)").all() as Array<{ name: string }>
        ).map((x) => x.name),
      );
      for (const name of [
        "classifier_label",
        "command_shape",
        "destructive_op",
        "cc_version",
        "classifier_version",
        "event_ts",
        "event_position",
        "boundary_kind",
        "boundary_verification",
      ])
        expect(names.has(name)).toBe(true);
      expect(runMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
