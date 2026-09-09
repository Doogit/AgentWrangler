-- ESF3: privacy-preserving work records, immutable membership history, and
-- frozen allocation reports. All human-provided values are bounded enums;
-- opaque identifiers and timestamps are issued by the daemon.

CREATE TABLE work_records (
  work_record_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_revision_no INTEGER NOT NULL CHECK (current_revision_no >= 0),
  archived_at TEXT,
  external_ref_id TEXT,
  external_ref_kind TEXT CHECK (external_ref_kind IN ('ISSUE', 'PULL_REQUEST', 'TASK', 'OTHER')),
  CHECK ((external_ref_id IS NULL) = (external_ref_kind IS NULL))
);

CREATE TABLE work_record_revisions (
  work_record_id TEXT NOT NULL REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 0),
  task_intent TEXT NOT NULL CHECK (task_intent IN
    ('IMPLEMENT', 'DEBUG', 'REVIEW', 'RESEARCH_PLAN', 'OTHER', 'UNKNOWN')),
  outcome_state TEXT NOT NULL CHECK (outcome_state IN
    ('ACTIVE', 'USEFUL', 'PARTIAL', 'UNSUCCESSFUL', 'ABANDONED', 'UNKNOWN')),
  repair_band TEXT NOT NULL CHECK (repair_band IN
    ('NONE', 'MINOR', 'MAJOR', 'UNREPORTED', 'UNKNOWN')),
  effort_band TEXT NOT NULL CHECK (effort_band IN
    ('LOW', 'MEDIUM', 'HIGH', 'UNREPORTED', 'UNKNOWN')),
  feedback_source TEXT NOT NULL CHECK (feedback_source IN ('USER_CLOSEOUT', 'USER_EDIT', 'NONE')),
  reported_at TEXT,
  recorded_at TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (work_record_id, revision_no),
  CHECK ((feedback_source = 'NONE' AND reported_at IS NULL)
      OR (feedback_source <> 'NONE' AND reported_at IS NOT NULL))
);

CREATE TRIGGER trg_work_record_revision_immutable
BEFORE UPDATE ON work_record_revisions
BEGIN
  SELECT RAISE(ABORT, 'work_record_revision_immutable');
END;

CREATE TRIGGER trg_work_record_identity_immutable
BEFORE UPDATE ON work_records
BEGIN
  SELECT CASE WHEN NEW.work_record_id <> OLD.work_record_id
      OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.created_at <> OLD.created_at
      OR COALESCE(NEW.external_ref_id, '') <> COALESCE(OLD.external_ref_id, '')
      OR COALESCE(NEW.external_ref_kind, '') <> COALESCE(OLD.external_ref_kind, '')
    THEN RAISE(ABORT, 'work_record_identity_immutable') END;
  SELECT CASE WHEN NEW.current_revision_no <> OLD.current_revision_no
      AND NEW.current_revision_no <> OLD.current_revision_no + 1
    THEN RAISE(ABORT, 'work_record_revision_pointer_invalid') END;
END;

CREATE TABLE work_record_session_links (
  work_record_id TEXT NOT NULL REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  linked_revision_no INTEGER NOT NULL,
  linked_at TEXT NOT NULL,
  unlinked_revision_no INTEGER,
  unlinked_at TEXT,
  link_source TEXT NOT NULL CHECK (link_source = 'USER'),
  link_mutation_id TEXT NOT NULL UNIQUE,
  unlink_mutation_id TEXT UNIQUE,
  PRIMARY KEY (work_record_id, session_id, linked_revision_no),
  FOREIGN KEY (work_record_id, linked_revision_no)
    REFERENCES work_record_revisions(work_record_id, revision_no),
  FOREIGN KEY (work_record_id, unlinked_revision_no)
    REFERENCES work_record_revisions(work_record_id, revision_no),
  CHECK ((unlinked_at IS NULL AND unlinked_revision_no IS NULL AND unlink_mutation_id IS NULL)
      OR (unlinked_at IS NOT NULL AND unlinked_revision_no IS NOT NULL AND unlink_mutation_id IS NOT NULL)),
  CHECK (unlinked_at IS NULL OR unlinked_at > linked_at)
);

CREATE UNIQUE INDEX idx_work_record_session_open
  ON work_record_session_links(work_record_id, session_id) WHERE unlinked_at IS NULL;
CREATE INDEX idx_work_record_session_links_session_open
  ON work_record_session_links(session_id, linked_at, unlinked_at);

CREATE TRIGGER trg_work_record_session_workspace_insert
BEFORE INSERT ON work_record_session_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM work_records wr
    JOIN sessions s ON s.session_id = NEW.session_id
    WHERE wr.work_record_id = NEW.work_record_id AND wr.workspace_id = s.workspace_id
  ) THEN RAISE(ABORT, 'work_record_session_workspace_mismatch') END;
END;

CREATE TRIGGER trg_work_record_session_workspace_update
BEFORE UPDATE ON work_record_session_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM work_records wr
    JOIN sessions s ON s.session_id = NEW.session_id
    WHERE wr.work_record_id = NEW.work_record_id AND wr.workspace_id = s.workspace_id
  ) THEN RAISE(ABORT, 'work_record_session_workspace_mismatch') END;
END;

CREATE TRIGGER trg_work_record_session_no_overlap
BEFORE INSERT ON work_record_session_links
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM work_record_session_links old
    WHERE old.work_record_id = NEW.work_record_id
      AND old.session_id = NEW.session_id
      AND NEW.linked_at < COALESCE(old.unlinked_at, '9999-12-31T23:59:59.999Z')
      AND old.linked_at < COALESCE(NEW.unlinked_at, '9999-12-31T23:59:59.999Z')
  ) THEN RAISE(ABORT, 'work_record_session_interval_overlap') END;
END;

CREATE TRIGGER trg_work_record_session_closed_immutable
BEFORE UPDATE ON work_record_session_links
BEGIN
  SELECT CASE WHEN OLD.unlinked_at IS NOT NULL
    THEN RAISE(ABORT, 'work_record_session_closed_immutable') END;
  SELECT CASE WHEN NEW.work_record_id <> OLD.work_record_id
      OR NEW.session_id <> OLD.session_id
      OR NEW.linked_revision_no <> OLD.linked_revision_no
      OR NEW.linked_at <> OLD.linked_at
      OR NEW.link_source <> OLD.link_source
      OR NEW.link_mutation_id <> OLD.link_mutation_id
    THEN RAISE(ABORT, 'work_record_session_link_immutable') END;
END;

CREATE TABLE work_record_context_refs (
  work_record_id TEXT NOT NULL REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  context_kind TEXT NOT NULL CHECK (context_kind = 'WORKTREE'),
  context_ref_id TEXT NOT NULL,
  linked_revision_no INTEGER NOT NULL,
  linked_at TEXT NOT NULL,
  unlinked_revision_no INTEGER,
  unlinked_at TEXT,
  link_mutation_id TEXT NOT NULL UNIQUE,
  unlink_mutation_id TEXT UNIQUE,
  PRIMARY KEY (work_record_id, context_kind, context_ref_id, linked_revision_no),
  FOREIGN KEY (work_record_id, linked_revision_no)
    REFERENCES work_record_revisions(work_record_id, revision_no),
  FOREIGN KEY (work_record_id, unlinked_revision_no)
    REFERENCES work_record_revisions(work_record_id, revision_no),
  CHECK ((unlinked_at IS NULL AND unlinked_revision_no IS NULL AND unlink_mutation_id IS NULL)
      OR (unlinked_at IS NOT NULL AND unlinked_revision_no IS NOT NULL AND unlink_mutation_id IS NOT NULL)),
  CHECK (unlinked_at IS NULL OR unlinked_at > linked_at)
);

CREATE UNIQUE INDEX idx_work_record_context_open
  ON work_record_context_refs(work_record_id, context_kind, context_ref_id)
  WHERE unlinked_at IS NULL;

CREATE TRIGGER trg_work_record_context_no_overlap
BEFORE INSERT ON work_record_context_refs
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM work_record_context_refs old
    WHERE old.work_record_id = NEW.work_record_id
      AND old.context_kind = NEW.context_kind
      AND old.context_ref_id = NEW.context_ref_id
      AND NEW.linked_at < COALESCE(old.unlinked_at, '9999-12-31T23:59:59.999Z')
      AND old.linked_at < COALESCE(NEW.unlinked_at, '9999-12-31T23:59:59.999Z')
  ) THEN RAISE(ABORT, 'work_record_context_interval_overlap') END;
END;

CREATE TRIGGER trg_work_record_context_closed_immutable
BEFORE UPDATE ON work_record_context_refs
BEGIN
  SELECT CASE WHEN OLD.unlinked_at IS NOT NULL
    THEN RAISE(ABORT, 'work_record_context_closed_immutable') END;
  SELECT CASE WHEN NEW.work_record_id <> OLD.work_record_id
      OR NEW.context_kind <> OLD.context_kind
      OR NEW.context_ref_id <> OLD.context_ref_id
      OR NEW.linked_revision_no <> OLD.linked_revision_no
      OR NEW.linked_at <> OLD.linked_at
      OR NEW.link_mutation_id <> OLD.link_mutation_id
    THEN RAISE(ABORT, 'work_record_context_link_immutable') END;
END;

CREATE TABLE work_record_mutations (
  mutation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN
    ('CREATE', 'EDIT', 'ARCHIVE', 'REOPEN', 'ATTACH_SESSION', 'DETACH_SESSION',
     'ATTACH_CONTEXT', 'DETACH_CONTEXT', 'CLOSEOUT', 'RECOMPUTE_ALLOCATION')),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 = lower(request_sha256)),
  work_record_id TEXT REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  expected_revision_no INTEGER CHECK (expected_revision_no IS NULL OR expected_revision_no >= 0),
  resulting_revision_no INTEGER CHECK (resulting_revision_no IS NULL OR resulting_revision_no >= 0),
  allocation_revision_id TEXT,
  applied_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('APPLIED', 'NOOP', 'PARTIAL', 'UNSUPPORTED'))
);

CREATE TABLE work_record_tombstones (
  work_record_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  delete_mutation_id TEXT NOT NULL UNIQUE
);

CREATE TRIGGER trg_work_mutation_id_not_tombstoned
BEFORE INSERT ON work_record_mutations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM work_record_tombstones WHERE delete_mutation_id = NEW.mutation_id
  ) THEN RAISE(ABORT, 'work_mutation_id_conflict') END;
END;

CREATE TRIGGER trg_work_tombstone_id_not_live
BEFORE INSERT ON work_record_tombstones
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM work_record_mutations WHERE mutation_id = NEW.delete_mutation_id
  ) THEN RAISE(ABORT, 'work_mutation_id_conflict') END;
END;

CREATE TABLE work_allocation_revisions (
  allocation_revision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  cohort_from TEXT NOT NULL,
  cohort_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evidence_as_of TEXT NOT NULL,
  contract_version TEXT NOT NULL CHECK (contract_version = 'esf-work-allocation-1'),
  metric_definition_version TEXT NOT NULL,
  source_ingestion_watermark TEXT NOT NULL,
  frozen_record_count INTEGER NOT NULL CHECK (frozen_record_count >= 0),
  report_status TEXT NOT NULL CHECK (report_status IN
    ('COMPLETE', 'PARTIAL', 'UNSUPPORTED_VERSION', 'STALE_SOURCE', 'INSUFFICIENT_EVIDENCE')),
  CHECK (cohort_to > cohort_from),
  CHECK (evidence_as_of >= cohort_to)
);

CREATE TABLE work_session_allocations (
  allocation_revision_id TEXT NOT NULL REFERENCES work_allocation_revisions(allocation_revision_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  owner_snapshot_id TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN
    ('OWNED', 'UNALLOCATED_UNGROUPED', 'UNALLOCATED_SHARED',
     'UNALLOCATED_AMBIGUOUS', 'UNALLOCATED_UNSUPPORTED')),
  priced_reconciled_cost_u INTEGER NOT NULL CHECK (priced_reconciled_cost_u >= 0),
  priced_turn_count INTEGER NOT NULL CHECK (priced_turn_count >= 0),
  unpriced_turn_count INTEGER NOT NULL CHECK (unpriced_turn_count >= 0),
  parser_claim_summary TEXT NOT NULL,
  PRIMARY KEY (allocation_revision_id, session_id),
  CHECK ((disposition = 'OWNED' AND owner_snapshot_id IS NOT NULL)
      OR (disposition <> 'OWNED' AND owner_snapshot_id IS NULL))
);

-- Feedback snapshots remain reproducible across later edits/reopens. They are
-- deliberately record-linked so privacy deletion cascades the structured
-- assessment; the parent revision retains only aggregate record counts.
CREATE TABLE work_allocation_record_snapshots (
  allocation_revision_id TEXT NOT NULL REFERENCES work_allocation_revisions(allocation_revision_id) ON DELETE CASCADE,
  work_record_id TEXT NOT NULL REFERENCES work_records(work_record_id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  outcome_state TEXT NOT NULL CHECK (outcome_state IN
    ('ACTIVE', 'USEFUL', 'PARTIAL', 'UNSUCCESSFUL', 'ABANDONED', 'UNKNOWN')),
  feedback_source TEXT NOT NULL CHECK (feedback_source IN ('USER_CLOSEOUT', 'USER_EDIT', 'NONE')),
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  PRIMARY KEY (allocation_revision_id, work_record_id)
);

CREATE TRIGGER trg_work_allocation_revision_immutable
BEFORE UPDATE ON work_allocation_revisions
BEGIN
  SELECT RAISE(ABORT, 'work_allocation_revision_immutable');
END;

CREATE TRIGGER trg_work_session_allocation_immutable
BEFORE UPDATE ON work_session_allocations
BEGIN
  SELECT RAISE(ABORT, 'work_session_allocation_immutable');
END;

CREATE TRIGGER trg_work_record_allocation_snapshot_immutable
BEFORE UPDATE ON work_allocation_record_snapshots
BEGIN
  SELECT RAISE(ABORT, 'work_record_allocation_snapshot_immutable');
END;

CREATE INDEX idx_work_records_workspace_current
  ON work_records(workspace_id, archived_at, updated_at DESC);
CREATE INDEX idx_work_record_revisions_latest
  ON work_record_revisions(work_record_id, revision_no DESC);
CREATE INDEX idx_work_allocations_owner
  ON work_session_allocations(allocation_revision_id, owner_snapshot_id);
CREATE INDEX idx_work_allocations_disposition
  ON work_session_allocations(allocation_revision_id, disposition);
CREATE INDEX idx_work_allocation_record_outcomes
  ON work_allocation_record_snapshots(allocation_revision_id, feedback_source, outcome_state);
CREATE INDEX idx_work_allocation_revisions_scope
  ON work_allocation_revisions(workspace_id, cohort_from, cohort_to, created_at DESC);
