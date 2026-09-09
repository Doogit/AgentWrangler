import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import {
  DaemonIdIssuer,
  WorkRecordError,
  attachSession,
  closeoutWorkRecord,
  createWorkRecord,
  deleteWorkRecord,
  detachSession,
  editWorkRecord,
  getWorkAllocation,
  getWorkRecord,
  recomputeWorkAllocation,
  setWorkRecordArchived,
} from "../../src/work-records/index.js";

function clock(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] ?? "2026-08-10T00:00:00Z");
}

describe("ESF3 work-record storage", () => {
  let db: Database.Database;
  let issuer: DaemonIdIssuer;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.exec(`
      INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES
        ('ws-a', 'a', '2026-08-01T00:00:00Z'), ('ws-b', 'b', '2026-08-01T00:00:00Z');
      INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES
        ('s-a', 'ws-a', 'a.jsonl', 'RECONCILED'),
        ('s-shared', 'ws-a', 'shared.jsonl', 'RECONCILED'),
        ('s-free', 'ws-a', 'free.jsonl', 'RECONCILED'),
        ('s-b', 'ws-b', 'b.jsonl', 'RECONCILED');
    `);
    issuer = new DaemonIdIssuer();
  });

  afterEach(() => db.close());

  function create(workspace = "ws-a", intent = "IMPLEMENT") {
    const id = issuer.issue("WORK_RECORD").id;
    const result = createWorkRecord(
      db,
      issuer,
      {
        work_record_id: id,
        workspace_id: workspace,
        task_intent: intent,
      },
      clock("2026-08-02T00:00:00Z"),
    );
    return result.record;
  }

  function mutation(recordId: string, expected: number, extra: Record<string, unknown> = {}) {
    return {
      mutation_id: issuer.issue("MUTATION").id,
      work_record_id: recordId,
      expected_revision_no: expected,
      ...extra,
    };
  }

  it("creates immutable revisions and replays an identical receipt", () => {
    const id = issuer.issue("WORK_RECORD").id;
    const request = { work_record_id: id, workspace_id: "ws-a", task_intent: "RESEARCH_PLAN" };
    const first = createWorkRecord(db, issuer, request, clock("2026-08-02T00:00:00Z"));
    const replayed = createWorkRecord(db, issuer, request);
    expect(replayed.replayed).toBe(true);
    expect(replayed.record).toEqual(first.record);

    const edit = mutation(id, 0, {
      task_intent: "RESEARCH_PLAN",
      outcome_state: "USEFUL",
      repair_band: "NONE",
      effort_band: "LOW",
      feedback_source: "USER_EDIT",
    });
    const changed = editWorkRecord(db, issuer, edit, clock("2026-08-03T00:00:00Z"));
    expect(changed.record.current_revision_no).toBe(1);
    expect(changed.record.current.outcome_state).toBe("USEFUL");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) n FROM work_record_revisions WHERE work_record_id = ?")
          .get(id) as { n: number }
      ).n,
    ).toBe(2);
    expect(editWorkRecord(db, issuer, edit).replayed).toBe(true);
  });

  it("keeps earlier daemon IDs retryable when a later atomic claim fails", () => {
    const recordId = issuer.issue("WORK_RECORD").id;
    const wrongExternalId = issuer.issue("CONTEXT_REF").id;
    expect(() =>
      createWorkRecord(db, issuer, {
        work_record_id: recordId,
        workspace_id: "ws-a",
        task_intent: "IMPLEMENT",
        external_ref_id: wrongExternalId,
        external_ref_kind: "TASK",
      }),
    ).toThrowError(/unissued or expired EXTERNAL_REF id/);

    const externalId = issuer.issue("EXTERNAL_REF").id;
    expect(
      createWorkRecord(db, issuer, {
        work_record_id: recordId,
        workspace_id: "ws-a",
        task_intent: "IMPLEMENT",
        external_ref_id: externalId,
        external_ref_kind: "TASK",
      }).record.work_record_id,
    ).toBe(recordId);
    expect(() => new DaemonIdIssuer(100, 0)).toThrow(RangeError);
  });

  it("rejects unknown keys, stale revisions, and cross-workspace links without partial writes", () => {
    const record = create();
    expect(() =>
      editWorkRecord(db, issuer, { ...mutation(record.work_record_id, 0), title: "private" }),
    ).toThrowError(WorkRecordError);
    expect(() =>
      attachSession(db, issuer, mutation(record.work_record_id, 1, { session_id: "s-a" })),
    ).toThrowError(/expected revision/);

    const bad = mutation(record.work_record_id, 0, { session_id: "s-b" });
    expect(() => attachSession(db, issuer, bad)).toThrowError(/workspaces differ/);
    expect(getWorkRecord(db, record.work_record_id).current_revision_no).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM work_record_session_links").get() as { n: number }).n,
    ).toBe(0);
  });

  it("records half-open membership and permits detach exactly once", () => {
    const record = create();
    const attached = attachSession(
      db,
      issuer,
      mutation(record.work_record_id, 0, { session_id: "s-a" }),
      clock("2026-08-03T00:00:00Z"),
    );
    expect(attached.record.session_links[0]?.unlinked_at).toBeNull();
    const detached = detachSession(
      db,
      issuer,
      mutation(record.work_record_id, 1, { session_id: "s-a" }),
      clock("2026-08-04T00:00:00Z"),
    );
    expect(detached.record.session_links[0]?.unlinked_at).toBe("2026-08-04T00:00:00.000Z");
    expect(() =>
      detachSession(db, issuer, mutation(record.work_record_id, 2, { session_id: "s-a" })),
    ).toThrowError(/no open membership/);
    expect(getWorkRecord(db, record.work_record_id).current_revision_no).toBe(2);
  });

  it("does not restore a failed reopen claim beyond its original cutoff", () => {
    const record = create();
    let nowMs = Date.parse("2026-08-03T00:00:00Z");
    const cutoffIssuer = new DaemonIdIssuer(1_000, 100, () => nowMs);
    const archiveMutation = cutoffIssuer.issue("MUTATION").id;
    const archived = setWorkRecordArchived(
      db,
      cutoffIssuer,
      {
        mutation_id: archiveMutation,
        work_record_id: record.work_record_id,
        expected_revision_no: 0,
      },
      true,
      () => new Date(nowMs),
    ).record;

    const reopenMutation = cutoffIssuer.issue("MUTATION").id;
    expect(() =>
      setWorkRecordArchived(
        db,
        cutoffIssuer,
        {
          mutation_id: reopenMutation,
          work_record_id: record.work_record_id,
          expected_revision_no: 1,
        },
        false,
        () => new Date(Number.NaN),
      ),
    ).toThrowError(RangeError);

    nowMs += 1_001;

    expect(() =>
      setWorkRecordArchived(
        db,
        cutoffIssuer,
        {
          mutation_id: reopenMutation,
          work_record_id: record.work_record_id,
          expected_revision_no: 1,
        },
        false,
        () => new Date(nowMs),
      ),
    ).toThrowError(/unissued or expired MUTATION id/);
    const afterCutoff = getWorkRecord(db, record.work_record_id);
    expect(afterCutoff.archived_at).toBe(archived.archived_at);
    expect(afterCutoff.current_revision_no).toBe(archived.current_revision_no);
  });

  it("deletes private history, preserves accounting, and gives only minimal delete replay", () => {
    const record = create();
    closeoutWorkRecord(
      db,
      issuer,
      mutation(record.work_record_id, 0, {
        outcome_state: "USEFUL",
        repair_band: "NONE",
        effort_band: "MEDIUM",
      }),
      clock("2026-08-03T00:00:00Z"),
    );
    const request = { ...mutation(record.work_record_id, 1), confirm: true };
    const deleted = deleteWorkRecord(db, issuer, request, clock("2026-08-04T00:00:00Z"));
    expect(deleteWorkRecord(db, issuer, request).replayed).toBe(true);
    expect(deleted.work_record_id).toBe(record.work_record_id);
    expect(() => getWorkRecord(db, record.work_record_id)).toThrowError(/permanently deleted/);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM work_record_revisions").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM work_record_mutations").get() as { n: number }).n,
    ).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(4);
    expect(
      Object.keys(db.prepare("SELECT * FROM work_record_tombstones").get() as object).sort(),
    ).toEqual(["delete_mutation_id", "deleted_at", "work_record_id"]);
  });

  it("freezes allocations with exact conservation, shared/unpriced coverage, and deletion masking", () => {
    db.exec(`
      INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version)
      VALUES ('t1','s-a','ws-a','2026-08-05T00:00:00Z','m',110,'p1'),
             ('t2','s-shared','ws-a','2026-08-05T00:00:00Z','m',70,'p1'),
             ('t3','s-free','ws-a','2026-08-05T00:00:00Z','m',NULL,'p2');
    `);
    const owner = create();
    const other = create();
    attachSession(
      db,
      issuer,
      mutation(owner.work_record_id, 0, { session_id: "s-a" }),
      clock("2026-08-03T00:00:00Z"),
    );
    attachSession(
      db,
      issuer,
      mutation(owner.work_record_id, 1, { session_id: "s-shared" }),
      clock("2026-08-03T01:00:00Z"),
    );
    attachSession(
      db,
      issuer,
      mutation(other.work_record_id, 0, { session_id: "s-shared" }),
      clock("2026-08-03T02:00:00Z"),
    );
    closeoutWorkRecord(
      db,
      issuer,
      mutation(owner.work_record_id, 2, {
        outcome_state: "USEFUL",
        repair_band: "MINOR",
        effort_band: "MEDIUM",
      }),
      clock("2026-08-06T00:00:00Z"),
    );

    const allocationId = issuer.issue("ALLOCATION_REVISION").id;
    const report = recomputeWorkAllocation(db, issuer, {
      mutation_id: issuer.issue("MUTATION").id,
      allocation_revision_id: allocationId,
      workspace_id: "ws-a",
      cohort_from: "2026-08-01T00:00:00Z",
      cohort_to: "2026-08-10T00:00:00Z",
      evidence_as_of: "2026-08-10T00:00:00Z",
    }).allocation;
    expect(report.eligible_session_count).toBe(3);
    expect(report.allocated_session_count).toBe(1);
    expect(report.unallocated_shared_count).toBe(1);
    expect(report.unallocated_ungrouped_count).toBe(1);
    expect(report.allocated_priced_cost_u + report.unallocated_priced_cost_u).toBe(
      report.eligible_priced_cost_u,
    );
    expect(report.eligible_priced_cost_u).toBe(180);
    expect(report.unpriced_turn_count).toBe(1);
    expect(report.reported_terminal_records).toBe(1);
    expect(report.useful_work_rate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(report.feedback_coverage).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.allocation_session_coverage.value).toBeCloseTo(1 / 3);
    expect(report.allocation_cost_coverage).toEqual({
      numerator_u: 110,
      denominator_u: 180,
      value: 110 / 180,
    });
    expect(report.terminal_attempt_priced_cost_u).toBe(110);
    expect(report.cost_per_useful_u).toBeNull();
    expect(report.cost_per_useful_unavailable_reason).toBe("INCOMPLETE_COST_COVERAGE");

    deleteWorkRecord(
      db,
      issuer,
      { ...mutation(owner.work_record_id, 3), confirm: true },
      clock("2026-08-11T00:00:00Z"),
    );
    const frozen = getWorkAllocation(db, allocationId);
    expect(frozen.report_status).toBe("SOURCE_DELETED");
    expect(frozen.source_deleted_count).toBe(1);
    expect(frozen.reported_terminal_records).toBe(0);
    expect(frozen.sessions.find((row) => row.session_id === "s-a")?.owner_snapshot_id).toBe(
      "DELETED_RECORD",
    );
    expect(frozen.eligible_priced_cost_u).toBe(180);
  });
});
