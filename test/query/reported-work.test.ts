import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { getReportedWork } from "../../src/query/api/reported-work.js";
import type { OutcomeState } from "../../src/work-records/types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
    ).run(id, id, "2026-01-01T00:00:00.000Z");
});
afterEach(() => db.close());
function record(
  id: string,
  outcome: OutcomeState,
  reported: boolean,
  archived = false,
  workspace = "a",
) {
  const ts = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO work_records (work_record_id, workspace_id, created_at, updated_at, current_revision_no, archived_at) VALUES (?, ?, ?, ?, 0, ?)",
  ).run(id, workspace, ts, ts, archived ? ts : null);
  db.prepare(`INSERT INTO work_record_revisions (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band, feedback_source, reported_at, recorded_at, mutation_id)
    VALUES (?, 0, 'UNKNOWN', ?, 'UNREPORTED', 'UNREPORTED', ?, ?, ?, ?)`).run(
    id,
    outcome,
    reported ? "USER_EDIT" : "NONE",
    reported ? ts : null,
    ts,
    id,
  );
}
it("separates reported terminal feedback from unknown, active and unreported records while retaining archived feedback", () => {
  record("useful", "USEFUL", true);
  record("partial", "PARTIAL", true);
  record("unknown", "UNKNOWN", true);
  record("active", "ACTIVE", true);
  record("unreported", "UNKNOWN", false);
  record("archived", "USEFUL", true, true);
  record("other-workspace", "USEFUL", true, false, "b");
  const result = getReportedWork(db, "a", new Date("2026-09-09T00:00:00.000Z"));
  expect(result.data).toMatchObject({
    records_total: 6,
    reported: 5,
    useful: 2,
    reported_terminal: 3,
    archived_count: 1,
    outcome_counts: { UNKNOWN: 1, UNREPORTED: 1, ACTIVE: 1 },
  });
  expect(result.meta.window).toEqual({
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-09-09T00:00:00.001Z",
  });
  expect(getReportedWork(db, null).data).toMatchObject({
    useful: 3,
    reported_terminal: 4,
    records_total: 7,
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM work_allocation_revisions").get()).toEqual({ n: 0 });
});
it("leaves an empty reported terminal denominator at zero for an unknown rate", () => {
  expect(getReportedWork(db, null).data).toMatchObject({
    records_total: 0,
    useful: 0,
    reported_terminal: 0,
  });
  record("unknown", "UNKNOWN", true);
  expect(getReportedWork(db, null).data).toMatchObject({
    records_total: 1,
    reported: 1,
    useful: 0,
    reported_terminal: 0,
  });
});
