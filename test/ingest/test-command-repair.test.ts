/**
 * test/ingest/test-command-repair.test.ts — one-time re-flag of stored shell events as test runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { configGet } from "../../src/detector/calibration.js";
import { readEnrichmentEpoch } from "../../src/ingest/enrichment-epoch.js";
import {
  TEST_COMMAND_REPAIR_KEY,
  repairTestCommands,
} from "../../src/ingest/test-command-repair.js";
import { migratedMemDb } from "./dbutil.js";

let db: Db;
beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', '2026-10-14T00:00:00.000Z')",
  ).run();
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('s', 'ws', '/fixture/s.jsonl', 'LIVE', 0, 0, '[]')`,
  ).run();
});
afterEach(() => db.close());

function addEvent(
  id: string,
  tool: string,
  command: string,
  flag: number,
  exit: string | null,
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
     VALUES (?, 's', '2026-10-14T00:00:00.000Z', ?, ?)`,
  ).run(id, tool, exit);
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?, 0, ?)",
  ).run(id, flag);
  db.prepare(
    "INSERT INTO tool_event_content (event_id, content_json, content_included) VALUES (?, json_object('command', ?), 1)",
  ).run(id, command);
}

const state = () =>
  db
    .prepare(
      `SELECT e.event_id AS id, m.is_test_command AS t, e.exit_class AS x
         FROM tool_events e JOIN tool_event_metadata m USING (event_id) ORDER BY e.event_id`,
    )
    .all();

describe("repairTestCommands", () => {
  it("re-flags missed test runs, keeps exit_class in step, and runs once", () => {
    addEvent("a-ps", "PowerShell", "npm run verify:app", 0, "OK");
    addEvent("b-chain", "Bash", "cd app && npm test", 0, "ERROR");
    addEvent("c-same", "Bash", "npm test", 1, "TEST_FAIL");
    addEvent("d-other", "Bash", "git status", 0, "ERROR");
    addEvent("e-pending", "Bash", "cd x && pytest", 0, null);

    expect(repairTestCommands(db)).toEqual({ checked: 5, changed: 3 });
    expect(state()).toEqual([
      { id: "a-ps", t: 1, x: "OK" },
      { id: "b-chain", t: 1, x: "TEST_FAIL" },
      { id: "c-same", t: 1, x: "TEST_FAIL" },
      { id: "d-other", t: 0, x: "ERROR" },
      { id: "e-pending", t: 1, x: null },
    ]);
    expect(readEnrichmentEpoch(db)).not.toBe("0");
    expect(configGet(db, TEST_COMMAND_REPAIR_KEY)).toBe("done");

    db.prepare("UPDATE tool_event_metadata SET is_test_command = 0 WHERE event_id = 'a-ps'").run();
    expect(repairTestCommands(db)).toEqual({ checked: 0, changed: 0 });
  });
});
