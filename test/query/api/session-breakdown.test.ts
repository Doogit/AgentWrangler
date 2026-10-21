import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import { getSessionBreakdown } from "../../../src/query/api/session-breakdown.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('fixture-ws', 'fixture-project', '2026-01-01T00:00:00.000Z')",
  ).run();
  const session = db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'fixture-ws', 'fixture-transcript', 'RECONCILED')",
  );
  session.run("fixture-target");
  session.run("fixture-other");
});
afterEach(() => db.close());

describe("getSessionBreakdown", () => {
  it("returns null for an unknown session", () => {
    expect(getSessionBreakdown("fixture-missing", db).data).toBeNull();
  });

  it("sums model and sidechain costs and maps error and loop markers to all-turn indices", () => {
    const turn = db.prepare(`INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
       cache_write_1h, cache_write_other, cost_equiv_u, parser_version)
      VALUES (?, ?, 'fixture-ws', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture-parser')`);
    turn.run(
      "target-main-a",
      "fixture-target",
      "2026-01-01T00:00:00.000Z",
      "model-a",
      0,
      10,
      2,
      3,
      4,
      5,
      6,
      100,
    );
    turn.run(
      "target-side",
      "fixture-target",
      "2026-01-01T00:10:00.000Z",
      "model-a",
      1,
      7,
      1,
      2,
      3,
      4,
      5,
      50,
    );
    turn.run(
      "target-main-b",
      "fixture-target",
      "2026-01-01T00:20:00.000Z",
      "model-a",
      0,
      20,
      4,
      6,
      8,
      10,
      12,
      200,
    );
    turn.run(
      "other-turn",
      "fixture-other",
      "2026-01-01T00:05:00.000Z",
      "model-a",
      0,
      1000,
      100,
      0,
      0,
      0,
      0,
      10000,
    );
    const event = db.prepare(`INSERT INTO tool_events
      (event_id, session_id, ts, tool_name, input_hash, result_bytes, exit_class,
       tool_error_class, tool_error_classifier_version, bash_command_family)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const owner = db.prepare(`INSERT INTO tool_event_metadata
      (event_id, owner_message_id, block_index, is_test_command)
      VALUES (?, ?, 0, 0)`);
    for (const [id, ts, message] of [
      ["loop-a", "2026-01-01T00:01:00.000Z", "target-main-a"],
      ["loop-b", "2026-01-01T00:11:00.000Z", "target-side"],
      ["loop-c", "2026-01-01T00:21:00.000Z", "target-main-b"],
    ]) {
      event.run(
        id,
        "fixture-target",
        ts,
        "Glob",
        "fixture-repeat-hash",
        10,
        "OK",
        null,
        null,
        null,
      );
      owner.run(id, message);
    }
    event.run(
      "error-a",
      "fixture-target",
      "2026-01-01T00:22:00.000Z",
      "Bash",
      null,
      80,
      "ERROR",
      "NOT_FOUND",
      "tool-error-1",
      "BASH_NPM",
    );
    owner.run("error-a", "target-side");
    event.run(
      "error-b",
      "fixture-target",
      "2026-01-01T00:23:00.000Z",
      "Bash",
      null,
      120,
      "ERROR",
      "NOT_FOUND",
      "tool-error-1",
      "BASH_NPM",
    );
    owner.run("error-b", "target-main-b");
    event.run(
      "other-error",
      "fixture-other",
      "2026-01-01T00:06:00.000Z",
      "Bash",
      null,
      999,
      "ERROR",
      "NOT_FOUND",
      "tool-error-1",
      "BASH_NPM",
    );
    owner.run("other-error", "other-turn");

    const data = getSessionBreakdown("fixture-target", db).data;
    expect(data?.cost_rows).toEqual([
      {
        model: "model-a",
        is_sidechain: false,
        turn_count: 2,
        cost_u: 300,
        input_tokens: 30,
        output_tokens: 6,
        cache_read_tokens: 9,
        cache_write_5m: 12,
        cache_write_1h: 15,
        cache_write_other: 18,
      },
      {
        model: "model-a",
        is_sidechain: true,
        turn_count: 1,
        cost_u: 50,
        input_tokens: 7,
        output_tokens: 1,
        cache_read_tokens: 2,
        cache_write_5m: 3,
        cache_write_1h: 4,
        cache_write_other: 5,
      },
    ]);
    expect(data?.tools.find((tool) => tool.tool_name === "Bash")).toEqual({
      tool_name: "Bash",
      calls: 2,
      errors: 2,
      total_result_bytes: 200,
      max_result_bytes: 120,
      first_error_at: "2026-01-01T00:22:00.000Z",
      last_error_at: "2026-01-01T00:23:00.000Z",
      first_error_turn_index: 1,
      error_breakdown: [
        { tool_error_class: "NOT_FOUND", bash_command_family: "BASH_NPM", count: 2 },
      ],
    });
    expect(data?.tool_error_turn_indices).toEqual([1, 2]);
    expect(data?.loop_turn_indices).toEqual([0, 1, 2]);
  });
});
