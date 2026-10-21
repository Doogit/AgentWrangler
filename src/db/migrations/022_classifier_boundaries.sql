-- 022_classifier_boundaries.sql — U6 match-and-discard labels and U7 N boundaries.
-- All values below are closed vocabulary / structural data; no transcript text is retained.
ALTER TABLE ingest_metric_events ADD COLUMN classifier_label TEXT
  CHECK (classifier_label IS NULL OR classifier_label IN ('user-rejected','hook-block','deny-rule','interrupt-cancel','api-error'));
ALTER TABLE ingest_metric_events ADD COLUMN command_shape TEXT
  CHECK (command_shape IS NULL OR command_shape IN ('bash:args-0','bash:args-1','bash:args-2-3','bash:args-4+'));
ALTER TABLE ingest_metric_events ADD COLUMN destructive_op TEXT
  CHECK (destructive_op IS NULL OR destructive_op IN ('rm-rf','git-reset-hard','git-clean','sql-drop','truncate'));
ALTER TABLE ingest_metric_events ADD COLUMN cc_version TEXT;
ALTER TABLE ingest_metric_events ADD COLUMN classifier_version TEXT;
ALTER TABLE ingest_metric_events ADD COLUMN event_ts TEXT;
ALTER TABLE ingest_metric_events ADD COLUMN event_position INTEGER CHECK (event_position IS NULL OR event_position >= 0);
ALTER TABLE ingest_metric_events ADD COLUMN boundary_kind TEXT
  CHECK (boundary_kind IS NULL OR boundary_kind IN ('compact-summary','compact-boundary','legacy-summary','cache-read-collapse'));
ALTER TABLE ingest_metric_events ADD COLUMN boundary_verification TEXT
  CHECK (boundary_verification IS NULL OR boundary_verification IN ('VERIFIED','UNVERIFIED'));

CREATE INDEX idx_ingest_metric_events_boundary
  ON ingest_metric_events(session_id, event_ts, event_position)
  WHERE boundary_kind IS NOT NULL;

-- One resumable cursor owns both U6 and U7 historical enrichment. It is deliberately
-- separate from offset tailing: caught-up offsets are EOF and cannot re-enrich history.
CREATE TABLE ingest_classifier_baselines (
  file_path TEXT PRIMARY KEY,
  seeded_offset INTEGER NOT NULL CHECK (seeded_offset >= 0)
);
