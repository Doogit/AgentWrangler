/**
 * test/ingest/tool-error-repair.test.ts — rec-reset U2 one-time stored-row repair.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { configGet, configSet } from "../../src/detector/calibration.js";
import {
  TOOL_ERROR_REPAIR_KEY,
  repairToolErrorClasses,
} from "../../src/ingest/tool-error-repair.js";
import { migratedMemDb } from "./dbutil.js";

let db: Db;
beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws', 'ws', '2026-09-15T00:00:00.000Z')",
  ).run();
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('s', 'ws', '/fixture/s.jsonl', 'LIVE', 0, 0, '[]')`,
  ).run();
});
afterEach(() => db.close());

function addEvent(id: string, error: string | null, cls: string | null = null): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES (?, 's', '2026-09-15T00:00:00.000Z', 'Edit', 'ERROR', ?, ?)`,
  ).run(id, cls, cls === null ? null : "tool-error-1");
  if (error !== null) {
    db.prepare(
      "INSERT INTO tool_event_content (event_id, content_json, content_included) VALUES (?, json_object('error', ?), 1)",
    ).run(id, error);
  }
}

const state = () =>
  db
    .prepare(
      "SELECT event_id, tool_error_class AS c, tool_error_classifier_version AS v FROM tool_events ORDER BY event_id",
    )
    .all();

describe("repairToolErrorClasses", () => {
  it("reclassifies wrapped NULL rows, leaves the rest alone, and is idempotent", () => {
    addEvent("stale", "<tool_use_error>String to replace not found in file.\nString: x");
    addEvent("notread", "<tool_use_error>File has not been read yet. Read it first");
    addEvent("plain", "File not found: x");
    addEvent("other", "<tool_use_error>InputValidationError: Grep failed");
    addEvent("noerr", null);
    addEvent("done", "File does not exist", "NOT_FOUND");

    expect(repairToolErrorClasses(db)).toEqual({ checked: 4, reclassified: 3 });
    expect(state()).toEqual([
      { event_id: "done", c: "NOT_FOUND", v: "tool-error-1" },
      { event_id: "noerr", c: null, v: null },
      { event_id: "notread", c: "NOT_READ", v: "tool-error-1" },
      { event_id: "other", c: null, v: null },
      { event_id: "plain", c: "NOT_FOUND", v: "tool-error-1" },
      { event_id: "stale", c: "STALE_STRING", v: "tool-error-1" },
    ]);
    expect(configGet(db, TOOL_ERROR_REPAIR_KEY)).toBe("done");

    const before = state();
    expect(repairToolErrorClasses(db)).toEqual({ checked: 0, reclassified: 0 });
    expect(state()).toEqual(before);
  });

  it("U7: labels the new classes, reruns for a DB that only has the v1 marker, then labels 0 rows", () => {
    configSet(db, "tool_error_repair_v1", "done");
    addEvent(
      "mod",
      "<tool_use_error>File has been modified since read, either by the user or by a linter.",
    );
    addEvent(
      "multi",
      "<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.",
    );
    addEvent(
      "big",
      "File content (1.1MB) exceeds maximum allowed size (256KB). Use offset and limit.",
    );
    addEvent("bigtok", "File content (34813 tokens) exceeds maximum allowed tokens (25000).");
    addEvent("kept", "File has been modified since read", "NOT_FOUND");

    expect(repairToolErrorClasses(db)).toEqual({ checked: 4, reclassified: 4 });
    expect(state()).toEqual([
      { event_id: "big", c: "READ_OUTPUT_TOO_LARGE", v: "tool-error-1" },
      { event_id: "bigtok", c: "READ_OUTPUT_TOO_LARGE", v: "tool-error-1" },
      { event_id: "kept", c: "NOT_FOUND", v: "tool-error-1" },
      { event_id: "mod", c: "MODIFIED_SINCE_READ", v: "tool-error-1" },
      { event_id: "multi", c: "MULTI_MATCH", v: "tool-error-1" },
    ]);
    expect(repairToolErrorClasses(db)).toEqual({ checked: 0, reclassified: 0 });
  });

  it("honours the done-marker even when new unclassified rows exist", () => {
    configSet(db, TOOL_ERROR_REPAIR_KEY, "done");
    addEvent("stale", "<tool_use_error>String to replace not found in file.");
    expect(repairToolErrorClasses(db)).toEqual({ checked: 0, reclassified: 0 });
    expect(state()).toEqual([{ event_id: "stale", c: null, v: null }]);
  });
});
