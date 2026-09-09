import type { Db } from "../db/open.js";
import type { DaemonIdIssuer } from "./ids.js";
import {
  type DeleteResult,
  EFFORT_BANDS,
  type EffortBand,
  FEEDBACK_SOURCES,
  type FeedbackSource,
  type MutationResult,
  OUTCOME_STATES,
  type OutcomeState,
  REPAIR_BANDS,
  type RepairBand,
  TASK_INTENTS,
  type TaskIntent,
  type WorkContextRef,
  WorkRecordError,
  type WorkRecordView,
  type WorkRevision,
  type WorkSessionLink,
} from "./types.js";
import {
  booleanTrueField,
  enumField,
  hashRequest,
  integerField,
  objectWithKeys,
  opaqueIdField,
  optionalEnumField,
  stringField,
} from "./validation.js";

type Operation =
  | "CREATE"
  | "EDIT"
  | "ARCHIVE"
  | "REOPEN"
  | "ATTACH_SESSION"
  | "DETACH_SESSION"
  | "ATTACH_CONTEXT"
  | "DETACH_CONTEXT"
  | "CLOSEOUT";

interface RecordRow {
  work_record_id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  current_revision_no: number;
  archived_at: string | null;
  external_ref_id: string | null;
  external_ref_kind: WorkRecordView["external_ref_kind"];
}

interface ReceiptRow {
  operation: Operation;
  request_sha256: string;
  resulting_revision_no: number;
}

function immediate<T>(db: Db, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function utcNow(now: () => Date): string {
  return now().toISOString();
}

function tombstone(
  db: Db,
  recordId: string,
): { deleted_at: string; delete_mutation_id: string } | undefined {
  return db
    .prepare(
      "SELECT deleted_at, delete_mutation_id FROM work_record_tombstones WHERE work_record_id = ?",
    )
    .get(recordId) as { deleted_at: string; delete_mutation_id: string } | undefined;
}

function assertNotDeleted(db: Db, recordId: string): void {
  if (tombstone(db, recordId) !== undefined)
    throw new WorkRecordError(410, "SOURCE_DELETED", "work record was permanently deleted");
}

function receipt(db: Db, mutationId: string): ReceiptRow | undefined {
  return db
    .prepare(
      "SELECT operation, request_sha256, resulting_revision_no FROM work_record_mutations WHERE mutation_id = ?",
    )
    .get(mutationId) as ReceiptRow | undefined;
}

function replay(
  db: Db,
  mutationId: string,
  operation: Operation,
  hash: string,
): MutationResult | undefined {
  const row = receipt(db, mutationId);
  if (row === undefined) {
    const used = db
      .prepare("SELECT 1 FROM work_record_tombstones WHERE delete_mutation_id = ?")
      .get(mutationId);
    if (used !== undefined)
      throw new WorkRecordError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "mutation id is already a delete receipt",
      );
    return undefined;
  }
  if (row.operation !== operation || row.request_sha256 !== hash) {
    throw new WorkRecordError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "mutation id was reused with different input",
    );
  }
  const recordId = db
    .prepare("SELECT work_record_id FROM work_record_mutations WHERE mutation_id = ?")
    .get(mutationId) as { work_record_id: string };
  return { record: getWorkRecord(db, recordId.work_record_id), replayed: true };
}

function requireRecord(db: Db, recordId: string, expected: number): RecordRow {
  const row = db.prepare("SELECT * FROM work_records WHERE work_record_id = ?").get(recordId) as
    | RecordRow
    | undefined;
  if (row === undefined) throw new WorkRecordError(404, "NOT_FOUND", "work record not found");
  if (row.current_revision_no !== expected)
    throw new WorkRecordError(409, "REVISION_CONFLICT", "expected revision is stale");
  return row;
}

function currentRevision(db: Db, row: RecordRow): WorkRevision {
  return db
    .prepare(`SELECT revision_no, task_intent, outcome_state, repair_band, effort_band,
      feedback_source, reported_at, recorded_at, mutation_id FROM work_record_revisions
      WHERE work_record_id = ? AND revision_no = ?`)
    .get(row.work_record_id, row.current_revision_no) as WorkRevision;
}

function advanceRevision(
  db: Db,
  row: RecordRow,
  mutationId: string,
  at: string,
  values?: Partial<{
    task_intent: TaskIntent;
    outcome_state: OutcomeState;
    repair_band: RepairBand;
    effort_band: EffortBand;
    feedback_source: FeedbackSource;
    reported_at: string | null;
  }>,
): number {
  const old = currentRevision(db, row);
  const next = row.current_revision_no + 1;
  db.prepare(`INSERT INTO work_record_revisions
      (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band,
       feedback_source, reported_at, recorded_at, mutation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.work_record_id,
    next,
    values?.task_intent ?? old.task_intent,
    values?.outcome_state ?? old.outcome_state,
    values?.repair_band ?? old.repair_band,
    values?.effort_band ?? old.effort_band,
    values?.feedback_source ?? old.feedback_source,
    values?.reported_at === undefined ? old.reported_at : values.reported_at,
    at,
    mutationId,
  );
  db.prepare(
    "UPDATE work_records SET current_revision_no = ?, updated_at = ? WHERE work_record_id = ?",
  ).run(next, at, row.work_record_id);
  return next;
}

function saveReceipt(
  db: Db,
  mutationId: string,
  operation: Operation,
  hash: string,
  recordId: string,
  expected: number | null,
  resulting: number,
  at: string,
): void {
  db.prepare(`INSERT INTO work_record_mutations
    (mutation_id, operation, request_sha256, work_record_id, expected_revision_no,
     resulting_revision_no, applied_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, 'APPLIED')`).run(
    mutationId,
    operation,
    hash,
    recordId,
    expected,
    resulting,
    at,
  );
}

function baseMutation(
  raw: unknown,
  extra: readonly string[],
): {
  input: Record<string, unknown>;
  mutationId: string;
  recordId: string;
  expected: number;
  hash: string;
} {
  const input = objectWithKeys(raw, [
    "mutation_id",
    "work_record_id",
    "expected_revision_no",
    ...extra,
  ]);
  const mutationId = opaqueIdField(input, "mutation_id");
  const recordId = opaqueIdField(input, "work_record_id");
  const expected = integerField(input, "expected_revision_no");
  return { input, mutationId, recordId, expected, hash: hashRequest(input) };
}

function mutate(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  operation: Operation,
  extra: readonly string[],
  apply: (input: Record<string, unknown>, row: RecordRow, next: number, at: string) => void,
  now: () => Date,
): MutationResult {
  const parsed = baseMutation(raw, extra);
  return immediate(db, () => {
    assertNotDeleted(db, parsed.recordId);
    const old = replay(db, parsed.mutationId, operation, parsed.hash);
    if (old !== undefined) return old;
    const row = requireRecord(db, parsed.recordId, parsed.expected);
    issuer.claim(parsed.mutationId, "MUTATION");
    try {
      const at = utcNow(now);
      const next = advanceRevision(db, row, parsed.mutationId, at);
      apply(parsed.input, row, next, at);
      saveReceipt(
        db,
        parsed.mutationId,
        operation,
        parsed.hash,
        parsed.recordId,
        parsed.expected,
        next,
        at,
      );
      return { record: getWorkRecord(db, parsed.recordId), replayed: false };
    } catch (error) {
      issuer.restore(parsed.mutationId, "MUTATION");
      throw error;
    }
  });
}

export function createWorkRecord(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  const input = objectWithKeys(raw, [
    "work_record_id",
    "workspace_id",
    "task_intent",
    "external_ref_id",
    "external_ref_kind",
  ]);
  const recordId = opaqueIdField(input, "work_record_id");
  const workspaceId = stringField(input, "workspace_id", 128);
  const intent = enumField(input, "task_intent", TASK_INTENTS);
  const externalKind = optionalEnumField(input, "external_ref_kind", [
    "ISSUE",
    "PULL_REQUEST",
    "TASK",
    "OTHER",
  ] as const);
  const externalId =
    input.external_ref_id === undefined || input.external_ref_id === null
      ? null
      : opaqueIdField(input, "external_ref_id");
  if ((externalId === null) !== (externalKind === null))
    throw new WorkRecordError(400, "INVALID_REQUEST", "external reference fields must be paired");
  const hash = hashRequest(input);
  return immediate(db, () => {
    assertNotDeleted(db, recordId);
    const old = replay(db, recordId, "CREATE", hash);
    if (old !== undefined) return old;
    if (
      db.prepare("SELECT 1 FROM workspaces WHERE workspace_id = ?").get(workspaceId) === undefined
    )
      throw new WorkRecordError(404, "NOT_FOUND", "workspace not found");
    const claims = [
      { id: recordId, kind: "WORK_RECORD" as const },
      ...(externalId === null ? [] : [{ id: externalId, kind: "EXTERNAL_REF" as const }]),
    ];
    issuer.claimMany(claims);
    try {
      const at = utcNow(now);
      db.prepare(`INSERT INTO work_records
        (work_record_id, workspace_id, created_at, updated_at, current_revision_no, archived_at, external_ref_id, external_ref_kind)
        VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`).run(
        recordId,
        workspaceId,
        at,
        at,
        externalId,
        externalKind,
      );
      db.prepare(`INSERT INTO work_record_revisions
        (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band,
         feedback_source, reported_at, recorded_at, mutation_id)
        VALUES (?, 0, ?, 'ACTIVE', 'UNREPORTED', 'UNREPORTED', 'NONE', NULL, ?, ?)`).run(
        recordId,
        intent,
        at,
        recordId,
      );
      saveReceipt(db, recordId, "CREATE", hash, recordId, null, 0, at);
      return { record: getWorkRecord(db, recordId), replayed: false };
    } catch (error) {
      issuer.restoreMany(claims);
      throw error;
    }
  });
}

export function editWorkRecord(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  const parsed = baseMutation(raw, [
    "task_intent",
    "outcome_state",
    "repair_band",
    "effort_band",
    "feedback_source",
  ]);
  const values = {
    task_intent: enumField(parsed.input, "task_intent", TASK_INTENTS),
    outcome_state: enumField(parsed.input, "outcome_state", OUTCOME_STATES),
    repair_band: enumField(parsed.input, "repair_band", REPAIR_BANDS),
    effort_band: enumField(parsed.input, "effort_band", EFFORT_BANDS),
    feedback_source: enumField(parsed.input, "feedback_source", FEEDBACK_SOURCES),
  };
  if (values.feedback_source !== "USER_EDIT")
    throw new WorkRecordError(400, "INVALID_REQUEST", "edit feedback_source must be USER_EDIT");
  return mutateWithRevision(db, issuer, parsed, "EDIT", values, now);
}

export function closeoutWorkRecord(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  const parsed = baseMutation(raw, ["outcome_state", "repair_band", "effort_band"]);
  const outcome = enumField(parsed.input, "outcome_state", [
    "USEFUL",
    "PARTIAL",
    "UNSUCCESSFUL",
    "ABANDONED",
    "UNKNOWN",
  ] as const);
  const values = {
    outcome_state: outcome,
    repair_band: enumField(parsed.input, "repair_band", REPAIR_BANDS),
    effort_band: enumField(parsed.input, "effort_band", EFFORT_BANDS),
    feedback_source: "USER_CLOSEOUT" as const,
  };
  return mutateWithRevision(db, issuer, parsed, "CLOSEOUT", values, now);
}

function mutateWithRevision(
  db: Db,
  issuer: DaemonIdIssuer,
  parsed: ReturnType<typeof baseMutation>,
  operation: Operation,
  values: Partial<{
    task_intent: TaskIntent;
    outcome_state: OutcomeState;
    repair_band: RepairBand;
    effort_band: EffortBand;
    feedback_source: FeedbackSource;
  }>,
  now: () => Date,
): MutationResult {
  return immediate(db, () => {
    assertNotDeleted(db, parsed.recordId);
    const old = replay(db, parsed.mutationId, operation, parsed.hash);
    if (old !== undefined) return old;
    const row = requireRecord(db, parsed.recordId, parsed.expected);
    issuer.claim(parsed.mutationId, "MUTATION");
    try {
      const at = utcNow(now);
      const next = advanceRevision(db, row, parsed.mutationId, at, { ...values, reported_at: at });
      saveReceipt(
        db,
        parsed.mutationId,
        operation,
        parsed.hash,
        parsed.recordId,
        parsed.expected,
        next,
        at,
      );
      return { record: getWorkRecord(db, parsed.recordId), replayed: false };
    } catch (error) {
      issuer.restore(parsed.mutationId, "MUTATION");
      throw error;
    }
  });
}

export function setWorkRecordArchived(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  archived: boolean,
  now: () => Date = () => new Date(),
): MutationResult {
  return mutate(
    db,
    issuer,
    raw,
    archived ? "ARCHIVE" : "REOPEN",
    [],
    (_input, row, _next, at) => {
      if (archived ? row.archived_at !== null : row.archived_at === null)
        throw new WorkRecordError(
          409,
          "REVISION_CONFLICT",
          archived ? "record already archived" : "record is not archived",
        );
      db.prepare("UPDATE work_records SET archived_at = ? WHERE work_record_id = ?").run(
        archived ? at : null,
        row.work_record_id,
      );
    },
    now,
  );
}

export function attachSession(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  return mutate(
    db,
    issuer,
    raw,
    "ATTACH_SESSION",
    ["session_id"],
    (input, row, next, at) => {
      const sessionId = stringField(input, "session_id", 128);
      const session = db
        .prepare("SELECT workspace_id FROM sessions WHERE session_id = ?")
        .get(sessionId) as { workspace_id: string } | undefined;
      if (session === undefined) throw new WorkRecordError(404, "NOT_FOUND", "session not found");
      if (session.workspace_id !== row.workspace_id)
        throw new WorkRecordError(
          422,
          "WORKSPACE_MISMATCH",
          "session and record workspaces differ",
        );
      try {
        db.prepare(`INSERT INTO work_record_session_links
      (work_record_id, session_id, linked_revision_no, linked_at, link_source, link_mutation_id)
      VALUES (?, ?, ?, ?, 'USER', ?)`).run(
          row.work_record_id,
          sessionId,
          next,
          at,
          stringField(input, "mutation_id", 64),
        );
      } catch (error) {
        if (String(error).includes("UNIQUE") || String(error).includes("overlap"))
          throw new WorkRecordError(409, "MEMBERSHIP_CONFLICT", "session is already attached");
        throw error;
      }
    },
    now,
  );
}

export function detachSession(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  return mutate(
    db,
    issuer,
    raw,
    "DETACH_SESSION",
    ["session_id"],
    (input, row, next, at) => {
      const result = db
        .prepare(`UPDATE work_record_session_links SET unlinked_revision_no = ?, unlinked_at = ?, unlink_mutation_id = ?
      WHERE work_record_id = ? AND session_id = ? AND unlinked_at IS NULL`)
        .run(
          next,
          at,
          stringField(input, "mutation_id", 64),
          row.work_record_id,
          stringField(input, "session_id", 128),
        );
      if (result.changes !== 1)
        throw new WorkRecordError(409, "MEMBERSHIP_CONFLICT", "session has no open membership");
    },
    now,
  );
}

export function attachContext(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  const parsed = baseMutation(raw, ["context_kind", "context_ref_id"]);
  enumField(parsed.input, "context_kind", ["WORKTREE"] as const);
  const contextId = opaqueIdField(parsed.input, "context_ref_id");
  return immediate(db, () => {
    assertNotDeleted(db, parsed.recordId);
    const old = replay(db, parsed.mutationId, "ATTACH_CONTEXT", parsed.hash);
    if (old !== undefined) return old;
    const row = requireRecord(db, parsed.recordId, parsed.expected);
    const claims = [
      { id: parsed.mutationId, kind: "MUTATION" as const },
      { id: contextId, kind: "CONTEXT_REF" as const },
    ];
    issuer.claimMany(claims);
    try {
      const at = utcNow(now);
      const next = advanceRevision(db, row, parsed.mutationId, at);
      db.prepare(`INSERT INTO work_record_context_refs
        (work_record_id, context_kind, context_ref_id, linked_revision_no, linked_at, link_mutation_id)
        VALUES (?, 'WORKTREE', ?, ?, ?, ?)`).run(
        row.work_record_id,
        contextId,
        next,
        at,
        parsed.mutationId,
      );
      saveReceipt(
        db,
        parsed.mutationId,
        "ATTACH_CONTEXT",
        parsed.hash,
        parsed.recordId,
        parsed.expected,
        next,
        at,
      );
      return { record: getWorkRecord(db, parsed.recordId), replayed: false };
    } catch (error) {
      issuer.restoreMany(claims);
      throw error;
    }
  });
}

export function detachContext(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): MutationResult {
  return mutate(
    db,
    issuer,
    raw,
    "DETACH_CONTEXT",
    ["context_kind", "context_ref_id"],
    (input, row, next, at) => {
      enumField(input, "context_kind", ["WORKTREE"] as const);
      const result = db
        .prepare(`UPDATE work_record_context_refs SET unlinked_revision_no = ?, unlinked_at = ?, unlink_mutation_id = ?
      WHERE work_record_id = ? AND context_kind = 'WORKTREE' AND context_ref_id = ? AND unlinked_at IS NULL`)
        .run(
          next,
          at,
          stringField(input, "mutation_id", 64),
          row.work_record_id,
          stringField(input, "context_ref_id", 64),
        );
      if (result.changes !== 1)
        throw new WorkRecordError(409, "MEMBERSHIP_CONFLICT", "context has no open membership");
    },
    now,
  );
}

export function deleteWorkRecord(
  db: Db,
  issuer: DaemonIdIssuer,
  raw: unknown,
  now: () => Date = () => new Date(),
): DeleteResult {
  const input = objectWithKeys(raw, [
    "mutation_id",
    "work_record_id",
    "expected_revision_no",
    "confirm",
  ]);
  const mutationId = opaqueIdField(input, "mutation_id");
  const recordId = opaqueIdField(input, "work_record_id");
  const expected = integerField(input, "expected_revision_no");
  booleanTrueField(input, "confirm");
  return immediate(db, () => {
    const dead = tombstone(db, recordId);
    if (dead !== undefined) {
      if (dead.delete_mutation_id !== mutationId)
        throw new WorkRecordError(410, "SOURCE_DELETED", "work record was permanently deleted");
      return {
        work_record_id: recordId,
        deleted_at: dead.deleted_at,
        delete_mutation_id: mutationId,
        replayed: true,
      };
    }
    if (
      receipt(db, mutationId) !== undefined ||
      db
        .prepare("SELECT 1 FROM work_record_tombstones WHERE delete_mutation_id = ?")
        .get(mutationId) !== undefined
    )
      throw new WorkRecordError(409, "IDEMPOTENCY_CONFLICT", "mutation id is already used");
    requireRecord(db, recordId, expected);
    issuer.claim(mutationId, "MUTATION");
    try {
      const at = utcNow(now);
      db.prepare(
        "INSERT INTO work_record_tombstones (work_record_id, deleted_at, delete_mutation_id) VALUES (?, ?, ?)",
      ).run(recordId, at, mutationId);
      db.prepare("DELETE FROM work_records WHERE work_record_id = ?").run(recordId);
      return {
        work_record_id: recordId,
        deleted_at: at,
        delete_mutation_id: mutationId,
        replayed: false,
      };
    } catch (error) {
      issuer.restore(mutationId, "MUTATION");
      throw error;
    }
  });
}

export function getWorkRecord(db: Db, recordId: string): WorkRecordView {
  assertNotDeleted(db, recordId);
  const row = db.prepare("SELECT * FROM work_records WHERE work_record_id = ?").get(recordId) as
    | RecordRow
    | undefined;
  if (row === undefined) throw new WorkRecordError(404, "NOT_FOUND", "work record not found");
  const links = db
    .prepare(`SELECT session_id, linked_revision_no, linked_at, unlinked_revision_no, unlinked_at
    FROM work_record_session_links WHERE work_record_id = ? ORDER BY linked_at, session_id`)
    .all(recordId) as WorkSessionLink[];
  const contexts = db
    .prepare(`SELECT context_kind, context_ref_id, linked_revision_no, linked_at, unlinked_revision_no, unlinked_at
    FROM work_record_context_refs WHERE work_record_id = ? ORDER BY linked_at, context_ref_id`)
    .all(recordId) as WorkContextRef[];
  return {
    ...row,
    current: currentRevision(db, row),
    session_links: links,
    context_refs: contexts,
  };
}

export function listWorkRecords(
  db: Db,
  workspaceId: string,
  includeArchived = false,
): WorkRecordView[] {
  const rows = db
    .prepare(`SELECT work_record_id FROM work_records WHERE workspace_id = ?
    ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY updated_at DESC, work_record_id`)
    .all(workspaceId) as Array<{ work_record_id: string }>;
  return rows.map((row) => getWorkRecord(db, row.work_record_id));
}
