-- Persist structural metric events so transcript replay cannot inflate session counters.
-- event_id is a SHA-256 digest computed in-process; transcript content is never stored.
CREATE TABLE ingest_metric_events (
  event_id          TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  user_turn_ts      TEXT,
  is_user_turn      INTEGER NOT NULL CHECK (is_user_turn IN (0, 1)),
  is_compact_summary INTEGER NOT NULL CHECK (is_compact_summary IN (0, 1)),
  is_api_error      INTEGER NOT NULL CHECK (is_api_error IN (0, 1)),
  is_interrupt      INTEGER NOT NULL CHECK (is_interrupt IN (0, 1))
);

CREATE INDEX idx_ingest_metric_events_session_user_ts
  ON ingest_metric_events(session_id, user_turn_ts)
  WHERE is_user_turn = 1;

-- Existing offsets predate the event ledger. Their consumed prefixes are seeded into
-- the ledger without incrementing counters, then this durable boundary is advanced.
CREATE TABLE ingest_metric_baselines (
  file_path     TEXT PRIMARY KEY,
  seeded_offset INTEGER NOT NULL CHECK (seeded_offset >= 0)
);
