import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateHookConfig } from "../../src/query/api/hook-config.js";
import { getLoopGuard } from "../../src/query/api/loop-guard.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function addToolEvent(
  index: number,
  inputHash: string,
  exitClass: "OK" | "ERROR" | "TEST_FAIL" = "TEST_FAIL",
): void {
  const ts = new Date(Date.UTC(2026, 8, 1, 12, 0, index)).toISOString();
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash, exit_class)
     VALUES (?, 'sess-a1', ?, 'Bash', ?, ?)`,
  ).run(`guard-event-${index}`, ts, inputHash, exitClass);
}

describe("getLoopGuard", () => {
  it("fails open for an unknown session", () => {
    expect(getLoopGuard("missing").data).toMatchObject({
      stage: "ok",
      reason: "unknown_session",
      identical_run_len: 0,
      failing_run_len: 0,
      session_id: "missing",
    });
  });

  it("blocks after three trailing identical failures", () => {
    addToolEvent(1, "same-input");
    addToolEvent(2, "same-input");
    addToolEvent(3, "same-input");

    expect(getLoopGuard("sess-a1").data).toMatchObject({
      stage: "block",
      identical_run_len: 3,
      failing_run_len: 3,
      fail_count_threshold: 3,
      window_turns: 10,
      reason: "repeated_identical_failures",
    });
  });

  it("warns after two trailing identical failures", () => {
    addToolEvent(1, "same-input");
    addToolEvent(2, "same-input");

    expect(getLoopGuard("sess-a1").data).toMatchObject({
      stage: "warn",
      identical_run_len: 2,
      failing_run_len: 2,
      reason: "near_repeated_identical_failures",
    });
  });

  it("stays ok when the trailing run is mixed or successful", () => {
    addToolEvent(1, "same-input");
    addToolEvent(2, "other-input");
    addToolEvent(3, "same-input", "OK");

    expect(getLoopGuard("sess-a1").data).toMatchObject({
      stage: "ok",
      identical_run_len: 1,
      failing_run_len: 0,
      reason: "below_threshold",
    });
  });

  it("keeps a different input outside the trailing identical run", () => {
    updateHookConfig({ d7_fail_count: 3, d7_window_turns: 2 });
    addToolEvent(1, "different-input");
    addToolEvent(2, "same-input");
    addToolEvent(3, "same-input");

    expect(getLoopGuard("sess-a1").data).toMatchObject({
      stage: "warn",
      identical_run_len: 2,
      failing_run_len: 2,
      fail_count_threshold: 3,
      window_turns: 2,
    });
  });

  it("shifts the block boundary with the persisted hook configuration", () => {
    addToolEvent(1, "same-input");
    addToolEvent(2, "same-input");
    addToolEvent(3, "same-input");
    updateHookConfig({ d7_fail_count: 4 });

    expect(getLoopGuard("sess-a1").data).toMatchObject({
      stage: "warn",
      failing_run_len: 3,
      fail_count_threshold: 4,
    });
  });
});
