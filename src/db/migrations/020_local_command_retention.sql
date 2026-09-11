-- 020_local_command_retention.sql — SEC-4 local command retention.
-- Spec: docs/plans/spec-local-command-retention.md §"Persistence invariant and legacy migration".
--
-- Legacy marker namespace M(row): tool_name = 'local_command' AND event_id is
-- 'cmd-' + 20 lowercase hex (length 24). Valid input_hash inside M is SQL NULL
-- or exact binary TEXT '/compact' or '/clear'; everything else is command
-- content and is removed. Genuine tool-use events named 'local_command' with
-- IDs outside M keep their SHA-256 hashes.
--
-- Logical retention reduction only: no physical erasure of WAL frames, free
-- pages, backups, or source transcripts is promised.

-- 1. Data change: NULL every invalid M input_hash in place. No row deletion,
--    no rekeying, no other column touched.
UPDATE tool_events
SET input_hash = NULL
WHERE tool_name = 'local_command'
  AND length(event_id) = 24
  AND substr(event_id, 1, 4) = 'cmd-'
  AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  AND input_hash IS NOT NULL
  AND NOT (typeof(input_hash) = 'text' AND input_hash IN ('/compact', '/clear'));

-- 2. Schema change: BEFORE INSERT/UPDATE guards so an older writer cannot
--    restore raw command values. Fixed error text; never interpolate values.
--    The UPDATE guard checks every update (including name/ID changes into M),
--    not just UPDATE OF input_hash.
CREATE TRIGGER trg_sec4_command_marker_guard_insert
BEFORE INSERT ON tool_events
BEGIN
  SELECT CASE WHEN NEW.tool_name = 'local_command'
      AND length(NEW.event_id) = 24
      AND substr(NEW.event_id, 1, 4) = 'cmd-'
      AND substr(NEW.event_id, 5) NOT GLOB '*[^0-9a-f]*'
      AND NEW.input_hash IS NOT NULL
      AND NOT (typeof(NEW.input_hash) = 'text' AND NEW.input_hash IN ('/compact', '/clear'))
    THEN RAISE(ABORT, 'SEC4_COMMAND_MARKER_INVALID') END;
END;

CREATE TRIGGER trg_sec4_command_marker_guard_update
BEFORE UPDATE ON tool_events
BEGIN
  SELECT CASE WHEN NEW.tool_name = 'local_command'
      AND length(NEW.event_id) = 24
      AND substr(NEW.event_id, 1, 4) = 'cmd-'
      AND substr(NEW.event_id, 5) NOT GLOB '*[^0-9a-f]*'
      AND NEW.input_hash IS NOT NULL
      AND NOT (typeof(NEW.input_hash) = 'text' AND NEW.input_hash IN ('/compact', '/clear'))
    THEN RAISE(ABORT, 'SEC4_COMMAND_MARKER_INVALID') END;
END;
