-- P4 open item (b): cache W0 detector statuses persisted by the history walk.
-- listRecommendations reads from this table instead of re-evaluating every
-- detector's evaluate() on each request (~5s saved per call on a live DB).
-- Populated by runHistoryWalk after every W0 evaluation; falls back to the
-- live cachedDetectorStatuses path on a fresh DB (no rows yet).
-- SEC-101: detector_id (id), ordinal (int), name (str), status (enum),
--          note (label/reason string — not transcript content), evaluated_at (ISO).
CREATE TABLE detector_status_live (
  detector_id   TEXT PRIMARY KEY,
  ordinal       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  note          TEXT,
  evaluated_at  TEXT NOT NULL
);
