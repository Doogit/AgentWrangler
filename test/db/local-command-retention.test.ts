/**
 * test/db/local-command-retention.test.ts — SEC-4 migration 020.
 *
 * Spec: docs/plans/spec-local-command-retention.md §"Persistence invariant and
 * legacy migration" — synthetic acceptance matrix rows 7–13 (legacy sanitation,
 * namespace precision, write guards, old-writer UPSERT incompatibility,
 * migration fault atomicity). All strings are invented; DBs are in-memory.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";

const GUARD_ERROR = "SEC4_COMMAND_MARKER_INVALID";

/** The old writer's exact UPSERT shape (existing-first COALESCE). */
const OLD_WRITER_UPSERT = `INSERT INTO tool_events
   (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
 VALUES (?,?,?,?,?,?,?,?,?)
 ON CONFLICT(event_id) DO UPDATE SET
   input_bytes = COALESCE(tool_events.input_bytes, excluded.input_bytes),
   input_hash = COALESCE(tool_events.input_hash, excluded.input_hash)`;

/** `cmd-` + 20 lowercase hex — inside namespace M. */
function mId(suffix: string): string {
  return `cmd-${suffix.padStart(20, "0")}`;
}

function insertMarker(db: Database.Database, eventId: string, inputHash: unknown): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
     VALUES (?, 'sess-1', '2026-01-02T00:00:00.000Z', 'local_command', ?)`,
  ).run(eventId, inputHash);
}

function getHash(db: Database.Database, eventId: string): unknown {
  const row = db.prepare("SELECT input_hash FROM tool_events WHERE event_id = ?").get(eventId) as
    | { input_hash: unknown }
    | undefined;
  return row?.input_hash;
}

/** Invariant query: invalid rows inside namespace M (must be zero after 020). */
function invalidMRowCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tool_events
       WHERE tool_name = 'local_command'
         AND length(event_id) = 24
         AND substr(event_id, 1, 4) = 'cmd-'
         AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
         AND input_hash IS NOT NULL
         AND NOT (typeof(input_hash) = 'text' AND input_hash IN ('/compact', '/clear'))`,
    )
    .get() as { n: number };
  return row.n;
}

describe("020 local command retention", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, "019_work_records");
    db.exec(`
      INSERT INTO workspaces (workspace_id, project_slug, registered_at)
        VALUES ('ws-1', 'synthetic-project', '2026-01-01T00:00:00Z');
      INSERT INTO sessions (session_id, workspace_id, file_path, state)
        VALUES ('sess-1', 'ws-1', 'C:/synthetic/session.jsonl', 'RECONCILED');
    `);
  });
  afterEach(() => db.close());

  describe("legacy sanitation (data change)", () => {
    it("NULLs invalid M values in place, preserves allowed markers and all other columns", () => {
      // Valid M rows — untouched.
      insertMarker(db, mId("a1"), "/compact");
      insertMarker(db, mId("a2"), "/clear");
      insertMarker(db, mId("a3"), null);
      // Invalid M rows — sanitized to NULL.
      insertMarker(db, mId("b1"), "/deploy --token=SYNTHETIC_SECRET");
      insertMarker(db, mId("b2"), "f".repeat(64)); // hex-looking command text
      insertMarker(db, mId("b3"), Buffer.from("/compact")); // blob, not TEXT
      insertMarker(db, mId("b4"), ""); // empty string
      insertMarker(db, mId("b5"), "/compact\u0000"); // embedded NUL
      insertMarker(db, mId("b6"), "/compact synthetic-note");

      const before = db.prepare("SELECT * FROM tool_events ORDER BY event_id").all() as Array<
        Record<string, unknown>
      >;
      const compactCountBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM tool_events WHERE input_hash = '/compact'").get() as {
          n: number;
        }
      ).n;

      const applied = runMigrations(db);
      expect(applied).toEqual(["020_local_command_retention"]);

      const sanitized = new Set([mId("b1"), mId("b2"), mId("b3"), mId("b4"), mId("b5"), mId("b6")]);
      const expected = before.map((row) =>
        sanitized.has(row.event_id as string) ? { ...row, input_hash: null } : row,
      );
      const after = db.prepare("SELECT * FROM tool_events ORDER BY event_id").all() as Array<
        Record<string, unknown>
      >;
      expect(after).toEqual(expected);

      const compactCountAfter = (
        db.prepare("SELECT COUNT(*) AS n FROM tool_events WHERE input_hash = '/compact'").get() as {
          n: number;
        }
      ).n;
      expect(compactCountAfter).toBe(compactCountBefore);
      expect(invalidMRowCount(db)).toBe(0);
    });

    it("leaves rows outside namespace M untouched, including a genuine tool named local_command", () => {
      const sha256 = "3".repeat(64);
      // Genuine tool-use event named local_command with an ordinary tool-use ID.
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, input_hash)
         VALUES ('toolu_synthetic_01', 'sess-1', '2026-01-02T00:01:00.000Z', 'local_command', 42, ?)`,
      ).run(sha256);
      // Ordinary Bash event.
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
         VALUES ('bash-evt-1', 'sess-1', '2026-01-02T00:02:00.000Z', 'Bash', ?)`,
      ).run("4".repeat(64));
      // cmd- prefix but uppercase hex / wrong length — outside M.
      insertMarker(db, "cmd-ABCDEF0123456789ABCD", "raw-but-outside-namespace");
      insertMarker(db, "cmd-abc", "raw-short-id");

      runMigrations(db);

      expect(getHash(db, "toolu_synthetic_01")).toBe(sha256);
      expect(getHash(db, "bash-evt-1")).toBe("4".repeat(64));
      expect(getHash(db, "cmd-ABCDEF0123456789ABCD")).toBe("raw-but-outside-namespace");
      expect(getHash(db, "cmd-abc")).toBe("raw-short-id");
    });

    it("is a no-op on a second run", () => {
      insertMarker(db, mId("c1"), "/synthetic-raw");
      runMigrations(db);
      const snapshot = db.prepare("SELECT * FROM tool_events ORDER BY event_id").all();
      expect(runMigrations(db)).toEqual([]);
      expect(db.prepare("SELECT * FROM tool_events ORDER BY event_id").all()).toEqual(snapshot);
      expect(invalidMRowCount(db)).toBe(0);
    });
  });

  describe("write guards (schema change)", () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it("aborts an old-writer plain INSERT of a raw value and persists nothing", () => {
      expect(() => insertMarker(db, mId("d1"), "/deploy --synthetic")).toThrow(GUARD_ERROR);
      expect(
        db.prepare("SELECT 1 FROM tool_events WHERE event_id = ?").get(mId("d1")),
      ).toBeUndefined();
    });

    it("aborts the old-writer UPSERT even when COALESCE would keep a safe existing value", () => {
      insertMarker(db, mId("e1"), "/compact"); // safe non-NULL existing value
      insertMarker(db, mId("e2"), null); // sanitized existing value
      const upsert = db.prepare(OLD_WRITER_UPSERT);
      const raw = "/deploy --token=SYNTHETIC_SECRET";
      for (const eventId of [mId("e1"), mId("e2")]) {
        expect(() =>
          upsert.run(
            eventId,
            "sess-1",
            "2026-01-02T00:00:00.000Z",
            "local_command",
            null,
            null,
            raw,
            null,
            null,
          ),
        ).toThrow(GUARD_ERROR);
      }
      expect(getHash(db, mId("e1"))).toBe("/compact");
      expect(getHash(db, mId("e2"))).toBeNull();
    });

    it("allows the new writer's classified markers and NULL, including UPSERT enrichment", () => {
      expect(() => insertMarker(db, mId("f1"), "/compact")).not.toThrow();
      expect(() => insertMarker(db, mId("f2"), "/clear")).not.toThrow();
      expect(() => insertMarker(db, mId("f3"), null)).not.toThrow();
      // Duplicate tuple replay from the new writer: existing-first COALESCE keeps the marker.
      const upsert = db.prepare(OLD_WRITER_UPSERT);
      expect(() =>
        upsert.run(
          mId("f1"),
          "sess-1",
          "2026-01-02T00:00:00.000Z",
          "local_command",
          null,
          null,
          "/compact",
          null,
          null,
        ),
      ).not.toThrow();
      expect(getHash(db, mId("f1"))).toBe("/compact");
    });

    it("aborts an UPDATE from NULL to a raw value", () => {
      insertMarker(db, mId("aa1"), null);
      expect(() =>
        db
          .prepare("UPDATE tool_events SET input_hash = ? WHERE event_id = ?")
          .run("/synthetic-restored", mId("aa1")),
      ).toThrow(GUARD_ERROR);
      expect(getHash(db, mId("aa1"))).toBeNull();
    });

    it("aborts an UPDATE moving a raw-hash row into namespace M via name/ID change", () => {
      const sha256 = "5".repeat(64);
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
         VALUES ('toolu_synthetic_02', 'sess-1', '2026-01-02T00:03:00.000Z', 'Bash', ?)`,
      ).run(sha256);
      expect(() =>
        db
          .prepare(
            "UPDATE tool_events SET tool_name = 'local_command', event_id = ? WHERE event_id = 'toolu_synthetic_02'",
          )
          .run(mId("bb1")),
      ).toThrow(GUARD_ERROR);
      expect(getHash(db, "toolu_synthetic_02")).toBe(sha256);
    });

    it("still accepts a genuine local_command tool-use event outside M", () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
             VALUES ('toolu_synthetic_03', 'sess-1', '2026-01-02T00:04:00.000Z', 'local_command', ?)`,
          )
          .run("6".repeat(64)),
      ).not.toThrow();
    });
  });

  describe("migration fault atomicity", () => {
    it("rolls back atomically before ledger commit and succeeds on retry", () => {
      insertMarker(db, mId("cc1"), "/synthetic-raw-value");
      // Fault injection: occupy the guard trigger's name so CREATE TRIGGER fails
      // inside the 020 transaction, after the sanitation UPDATE ran.
      db.exec(
        "CREATE TRIGGER trg_sec4_command_marker_guard_insert BEFORE INSERT ON tool_events BEGIN SELECT 1; END",
      );

      expect(() => runMigrations(db)).toThrow();
      // Ledger has no 020 row and the sanitation UPDATE rolled back with it.
      expect(
        db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = '020_local_command_retention'")
          .get(),
      ).toBeUndefined();
      expect(getHash(db, mId("cc1"))).toBe("/synthetic-raw-value");

      db.exec("DROP TRIGGER trg_sec4_command_marker_guard_insert");
      expect(runMigrations(db)).toEqual(["020_local_command_retention"]);
      expect(getHash(db, mId("cc1"))).toBeNull();
      expect(invalidMRowCount(db)).toBe(0);
    });
  });
});
