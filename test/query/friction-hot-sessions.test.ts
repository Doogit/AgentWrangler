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
      expect(row.interrupts_supported).toBe(false);
      expect(row.api_error_rate).toBeNull();
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
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, block_index, is_test_command)
       VALUES (?, ?, ?)`,
    ).run("ev-3", 0, 1);

    const rows = hotSessionsByCost(db);
    const row = rows.find((r) => r.session_id === "sess-b1");
    expect(row?.test_fail_count).toBe(1);
    expect(row?.test_completed_count).toBe(0);
    expect(row?.test_outcome).toBe("NO_TEST_OUTCOMES");
  });

  it("reports a tool-error rate only from completed tool results", () => {
    const BASE_TS = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, result_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ev-completed-error", "sess-a1", BASE_TS, "Bash", "ERROR", 12);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, result_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ev-completed-ok", "sess-a1", BASE_TS, "Read", "OK", 8);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-uncompleted-error", "sess-a1", BASE_TS, "Bash", "ERROR");

    const row = hotSessionsByCost(db).find((candidate) => candidate.session_id === "sess-a1");
    expect(row?.tool_error_count).toBe(2);
    expect(row?.tool_completed_count).toBe(2);
    expect(row?.tool_error_rate).toBe(0.5);
  });

  it("keeps test outcome and pass counts within completed test results", () => {
    const BASE_TS = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ev-uncompleted-test-fail", "sess-a1", BASE_TS, "Bash", "TEST_FAIL");
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, result_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ev-completed-test-pass", "sess-a1", "2026-01-01T00:00:01.000Z", "Bash", "OK", 7);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, block_index, is_test_command)
       VALUES (?, ?, ?)`,
    ).run("ev-uncompleted-test-fail", 0, 1);
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, block_index, is_test_command)
       VALUES (?, ?, ?)`,
    ).run("ev-completed-test-pass", 1, 1);

    const row = hotSessionsByCost(db).find((candidate) => candidate.session_id === "sess-a1");
    expect(row?.test_fail_count).toBe(1);
    expect(row?.test_completed_count).toBe(1);
    expect(row?.test_pass_count).toBe(1);
    expect(row?.test_outcome).toBe("NO_FAILURES_OBSERVED");
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
