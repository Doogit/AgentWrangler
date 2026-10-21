-- U11 shared error evidence. All columns are closed labels only: no tool-result
-- text, command text, paths, artifact prose, or content-derived hashes.
ALTER TABLE tool_events ADD COLUMN tool_error_class TEXT
  CHECK (tool_error_class IS NULL OR tool_error_class IN
    ('NOT_FOUND', 'NOT_READ', 'STALE_STRING', 'PATCH_FAILED', 'MCP_CONTENT_TOO_LARGE'));
ALTER TABLE tool_events ADD COLUMN tool_error_classifier_version TEXT;
ALTER TABLE tool_events ADD COLUMN bash_command_family TEXT
  CHECK (bash_command_family IS NULL OR bash_command_family IN
    ('BASH_GIT', 'BASH_NPM', 'BASH_PYTHON', 'BASH_TEST', 'BASH_BUILD', 'BASH_OTHER'));
ALTER TABLE tool_events ADD COLUMN interrupt_kind TEXT
  CHECK (interrupt_kind IS NULL OR interrupt_kind IN
    ('PURE_INTERRUPT', 'KILLED_NO_PROMPT', 'HUMAN_DENY'));
ALTER TABLE tool_events ADD COLUMN interrupt_classifier_version TEXT;

-- Existing ledger rows have no source-chain provenance. Default those rows to
-- sidechain so downstream evidence cannot silently treat them as main-chain.
ALTER TABLE ingest_metric_events ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 1
  CHECK (is_sidechain IN (0, 1));

CREATE INDEX idx_tool_events_error_class
  ON tool_events(session_id, tool_name, tool_error_class, ts)
  WHERE tool_error_class IS NOT NULL;

CREATE INDEX idx_tool_events_bash_failure_family
  ON tool_events(session_id, bash_command_family, ts)
  WHERE bash_command_family IS NOT NULL;

CREATE INDEX idx_tool_events_interrupt_kind
  ON tool_events(session_id, interrupt_kind, ts)
  WHERE interrupt_kind IS NOT NULL;

-- The classifier has one audited schema. Unknown writers fail closed at the DB
-- boundary even if a stale parser reaches this database.
CREATE TRIGGER tool_events_error_classifier_privacy_insert
BEFORE INSERT ON tool_events
WHEN (NEW.tool_error_class IS NOT NULL
        AND NEW.tool_error_classifier_version IS NOT 'tool-error-1')
  OR (NEW.tool_error_classifier_version IS NOT NULL
        AND (NEW.tool_error_classifier_version != 'tool-error-1'
             OR NEW.tool_error_class IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'unknown tool error classifier version');
END;

CREATE TRIGGER tool_events_interrupt_classifier_privacy_insert
BEFORE INSERT ON tool_events
WHEN (NEW.interrupt_kind IS NOT NULL
        AND NEW.interrupt_classifier_version IS NOT 'interrupt-1')
  OR (NEW.interrupt_classifier_version IS NOT NULL
        AND (NEW.interrupt_classifier_version != 'interrupt-1'
             OR NEW.interrupt_kind IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'unknown interrupt classifier version');
END;

CREATE TRIGGER tool_events_interrupt_classifier_privacy_update
BEFORE UPDATE OF interrupt_kind, interrupt_classifier_version ON tool_events
WHEN (NEW.interrupt_kind IS NOT NULL
        AND NEW.interrupt_classifier_version IS NOT 'interrupt-1')
  OR (NEW.interrupt_classifier_version IS NOT NULL
        AND (NEW.interrupt_classifier_version != 'interrupt-1'
             OR NEW.interrupt_kind IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'unknown interrupt classifier version');
END;

CREATE TRIGGER tool_events_error_classifier_privacy_update
BEFORE UPDATE OF tool_error_class, tool_error_classifier_version, bash_command_family ON tool_events
WHEN (NEW.tool_error_class IS NOT NULL
        AND NEW.tool_error_classifier_version IS NOT 'tool-error-1')
  OR (NEW.tool_error_classifier_version IS NOT NULL
        AND (NEW.tool_error_classifier_version != 'tool-error-1'
             OR NEW.tool_error_class IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'unknown tool error classifier version');
END;
