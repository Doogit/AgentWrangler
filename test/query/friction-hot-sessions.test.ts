import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hotSessionsByCost } from "../../src/query/spend.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

describe("hotSessionsByCost friction fields", () => {
  it("returns friction count fields on every row", () => {
    const rows = hotSessionsByCost(db);
    for (const row of rows) {
      expect(row).toHaveProperty("api_error_count");
      expect(row).toHaveProperty("compaction_count");
      expect(row).toHaveProperty("interrupt_count");
      expect(row).toHaveProperty("user_turn_count");
      expect(row).toHaveProperty("tool_error_count");
      expect(row).toHaveProperty("test_fail_count");
    }
  });

  it("tool_error_count and test_fail_count are 0 when no tool_events exist", () => {
    const rows = hotSessionsByCost(db);
    for (const row of rows) {
      expect(row.tool_error_count).toBe(0);
      expect(row.test_fail_count).toBe(0);
    }
  });

  it("tool_error_count increments when ERROR tool_events are added for a session", () => {
    const BASE_TS = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-1", "sess-a1", BASE_TS, "Bash", "ERROR");
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-2", "sess-a1", BASE_TS, "Bash", "ERROR");

    const rows = hotSessionsByCost(db);
    const row = rows.find((r) => r.session_id === "sess-a1");
    expect(row?.tool_error_count).toBe(2);
    // Other sessions unaffected
    const rowB1 = rows.find((r) => r.session_id === "sess-b1");
    expect(rowB1?.tool_error_count).toBe(0);
  });

  it("test_fail_count increments when TEST_FAIL tool_events are added", () => {
    const BASE_TS = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-3", "sess-b1", BASE_TS, "Bash", "TEST_FAIL");

    const rows = hotSessionsByCost(db);
    const row = rows.find((r) => r.session_id === "sess-b1");
    expect(row?.test_fail_count).toBe(1);
  });

  it("OK exit_class tool_events do not affect error/fail counts", () => {
    const BASE_TS = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-4", "sess-a2", BASE_TS, "Read", "OK");

    const rows = hotSessionsByCost(db);
    const row = rows.find((r) => r.session_id === "sess-a2");
    expect(row?.tool_error_count).toBe(0);
    expect(row?.test_fail_count).toBe(0);
  });
});
