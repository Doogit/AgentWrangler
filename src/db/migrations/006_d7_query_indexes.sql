-- Keep D7's trailing-window scans bounded by time as the corpus grows.
-- This is separate from migration 005 because 005 may already have been
-- applied by pre-commit smoke runs during D7 development.

CREATE INDEX idx_tool_ts_session_event
  ON tool_events(ts, session_id, event_id);

CREATE INDEX idx_turns_ts_provisional_session
  ON turns(ts, provisional, session_id);
