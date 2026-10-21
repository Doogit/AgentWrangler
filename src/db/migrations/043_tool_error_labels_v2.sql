-- migrate: foreign-keys-off
-- rec-reset U7 (classifier lane): widen the closed tool_error_class set with
-- MODIFIED_SINCE_READ, MULTI_MATCH and READ_OUTPUT_TOO_LARGE. The classifier version
-- stays 'tool-error-1' (detectors and the privacy triggers key on it). SQLite cannot
-- relax a column CHECK in place, so tool_events is rebuilt (same columns, indexes and
-- triggers; rows copied as-is). Unlabelled rows are repaired by tool-error-repair.ts
-- (done-marker tool_error_repair_v2).

CREATE TABLE tool_events_new (                   -- names/sizes/sequence only
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  ts           TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input_bytes  INTEGER, result_bytes INTEGER,
  input_hash   TEXT,                             -- for loop/near-duplicate detection
  exit_class   TEXT,                             -- OK | ERROR | TEST_FAIL | ...
  commit_sha   TEXT,                             -- harvested when the event exposes one
  tool_error_class TEXT
  CHECK (tool_error_class IS NULL OR tool_error_class IN
    ('NOT_FOUND', 'NOT_READ', 'STALE_STRING', 'PATCH_FAILED', 'MCP_CONTENT_TOO_LARGE',
     'MODIFIED_SINCE_READ', 'MULTI_MATCH', 'READ_OUTPUT_TOO_LARGE')),
  tool_error_classifier_version TEXT,
  bash_command_family TEXT
  CHECK (bash_command_family IS NULL OR bash_command_family IN
    ('BASH_GIT', 'BASH_NPM', 'BASH_PYTHON', 'BASH_TEST', 'BASH_BUILD', 'BASH_OTHER')),
  interrupt_kind TEXT
  CHECK (interrupt_kind IS NULL OR interrupt_kind IN
    ('PURE_INTERRUPT', 'KILLED_NO_PROMPT', 'HUMAN_DENY')),
  interrupt_classifier_version TEXT
);

INSERT INTO tool_events_new
  (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class,
   commit_sha, tool_error_class, tool_error_classifier_version, bash_command_family,
   interrupt_kind, interrupt_classifier_version)
SELECT event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class,
       commit_sha, tool_error_class, tool_error_classifier_version, bash_command_family,
       interrupt_kind, interrupt_classifier_version
  FROM tool_events;

DROP TABLE tool_events;
ALTER TABLE tool_events_new RENAME TO tool_events;

CREATE INDEX idx_tool_session ON tool_events(session_id, ts);
CREATE INDEX idx_tool_sha ON tool_events(commit_sha) WHERE commit_sha IS NOT NULL;
CREATE INDEX idx_tool_ts_session_event
  ON tool_events(ts, session_id, event_id);
CREATE INDEX idx_tool_session_name_hash ON tool_events(session_id, tool_name, input_hash);
CREATE INDEX idx_tool_events_error_class
  ON tool_events(session_id, tool_name, tool_error_class, ts)
  WHERE tool_error_class IS NOT NULL;
CREATE INDEX idx_tool_events_bash_failure_family
  ON tool_events(session_id, bash_command_family, ts)
  WHERE bash_command_family IS NOT NULL;
CREATE INDEX idx_tool_events_interrupt_kind
  ON tool_events(session_id, interrupt_kind, ts)
  WHERE interrupt_kind IS NOT NULL;

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
