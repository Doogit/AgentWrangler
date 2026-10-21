-- P2-U8: the W0 signature hashes the window's ingest_metric_events rows by event_ts.
-- Without this index that query scans the whole table on every walk.
-- Index only: no table, column or data change.
CREATE INDEX IF NOT EXISTS idx_ingest_metric_events_event_ts ON ingest_metric_events(event_ts);
