-- JMS U5: setup-grade signal queries scanned tool_events / ingest_metric_events on every grade
-- (~0.5 s on a real-size DB). Index only: no table, column or data change.
CREATE INDEX IF NOT EXISTS idx_tool_events_name_ts ON tool_events(tool_name, ts, session_id);
CREATE INDEX IF NOT EXISTS idx_tool_event_metadata_test ON tool_event_metadata(event_id) WHERE is_test_command = 1;
CREATE INDEX IF NOT EXISTS idx_ingest_metric_events_user_turn_ts
  ON ingest_metric_events(COALESCE(event_ts, user_turn_ts)) WHERE is_user_turn = 1;
CREATE INDEX IF NOT EXISTS idx_ingest_metric_events_label_ts
  ON ingest_metric_events(classifier_label, COALESCE(event_ts, user_turn_ts));
