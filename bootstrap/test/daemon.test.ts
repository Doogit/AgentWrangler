import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("daemon bootstrap", () => {
  it("opens an in-memory better-sqlite3 DB and enables FK enforcement", () => {
    // WAL is not supported on in-memory DBs (SQLite limitation; stays 'memory').
    // We verify: the native module loads, the pragma API works, and FK is enforced.
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // journal_mode stays 'memory' for in-memory DBs — that is expected and correct.
    const jm = (db.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]?.journal_mode;
    const fk = (db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys;

    expect(jm).toBe("memory"); // in-memory SQLite: WAL inapplicable
    expect(fk).toBe(1); // FK enforcement must be on

    db.close();
  });

  it("enforces foreign key constraints when FK is enabled", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);

    // Insert without a matching parent should throw
    expect(() => {
      db.prepare("INSERT INTO child VALUES (1, 999)").run();
    }).toThrow();

    db.close();
  });
});
