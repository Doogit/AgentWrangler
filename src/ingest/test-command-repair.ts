/**
 * src/ingest/test-command-repair.ts — one-time repair for the judge-setup test-loop fix (2026-10-14).
 *
 * `is_test_command` was set at ingest from the Bash tool only, and only when the whole command
 * started with a test runner, so PowerShell runs, `cd app && npm test` and `npm run verify:app`
 * were missed. This reclassifies every shell event from its stored secrets-filtered command slice
 * (tool_event_content.content_json $.command) and keeps `exit_class` in step: a failed run reads
 * TEST_FAIL only when it is a test. A test past the 4,000-char slice stays unflagged.
 * Done-marker in user_config, like tool-error-repair.
 */

import type { Db } from "../db/open.js";
import { configGet, configSet } from "../detector/calibration.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";
import { isTestCommand } from "./parser.js";

export const TEST_COMMAND_REPAIR_KEY = "test_command_repair_v1";

export interface TestCommandRepairResult {
  checked: number;
  changed: number;
}

interface CandidateRow {
  event_id: string;
  command: string;
  is_test_command: number;
}

export function repairTestCommands(db: Db): TestCommandRepairResult {
  const result: TestCommandRepairResult = { checked: 0, changed: 0 };
  if (configGet(db, TEST_COMMAND_REPAIR_KEY) !== null) return result;

  const rows = db
    .prepare(
      `SELECT m.event_id, json_extract(c.content_json, '$.command') AS command, m.is_test_command
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.tool_name IN ('Bash', 'PowerShell', 'Shell')
          AND json_extract(c.content_json, '$.command') IS NOT NULL`,
    )
    .all() as CandidateRow[];
  const setFlag = db.prepare(
    "UPDATE tool_event_metadata SET is_test_command = ? WHERE event_id = ?",
  );
  const setExit = db.prepare(
    `UPDATE tool_events SET exit_class = ?
      WHERE event_id = ? AND exit_class IN ('ERROR', 'TEST_FAIL')`,
  );
  db.transaction(() => {
    for (const row of rows) {
      result.checked++;
      const flag = isTestCommand(row.command) ? 1 : 0;
      if (flag === row.is_test_command) continue;
      setFlag.run(flag, row.event_id);
      setExit.run(flag === 1 ? "TEST_FAIL" : "ERROR", row.event_id);
      result.changed++;
    }
    if (result.changed > 0) bumpEnrichmentEpoch(db);
    configSet(db, TEST_COMMAND_REPAIR_KEY, "done");
  })();
  return result;
}
