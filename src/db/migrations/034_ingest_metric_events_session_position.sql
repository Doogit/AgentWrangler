-- Bound previous-boundary lookup to one session and its event position.
CREATE INDEX IF NOT EXISTS idx_ingest_metric_events_session_position
  ON ingest_metric_events(session_id, event_position);
