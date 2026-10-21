-- P2H history walk (spec-rec-page-history-walk.md): per-week detector cache.
-- SEC-101: ids, enum-bearing scope keys, ISO bounds, counts and micro-dollars only.
--
-- detector_week_results holds one row per (detector, scope key, week) that FIRED
-- in that week. scope_workspace_id lets the walk rebuild the deterministic rec_id
-- for the post-merge rec-GC.
CREATE TABLE detector_week_results (
  detector_id        TEXT NOT NULL,
  scope_key          TEXT NOT NULL,
  week_start         TEXT NOT NULL,
  scope_workspace_id TEXT,
  fired              INTEGER NOT NULL DEFAULT 1 CHECK (fired IN (0, 1)),
  rank_value_u       INTEGER,
  evaluated_at       TEXT NOT NULL,
  PRIMARY KEY (detector_id, scope_key, week_start)
);
CREATE INDEX idx_detector_week_results_week ON detector_week_results(week_start);

-- Per-week "evaluated" marker: a week where nothing fired still has a row here.
-- turns_rowid_hwm snapshots MAX(turns.rowid) at evaluation time. turns are
-- written INSERT OR IGNORE, so every newly ingested turn takes a fresh rowid: a
-- closed week is stale when a turn with ts in the week has rowid > hwm, when
-- the evaluated detector set (detector_ids, sorted, comma-joined) changed, or
-- when inputs_sig (sha1 over the non-turn detector inputs, see engine.ts
-- INPUT_SIGNATURE_SQL) changed.
CREATE TABLE detector_week_marks (
  week_start      TEXT PRIMARY KEY,
  week_end        TEXT NOT NULL,
  evaluated_at    TEXT NOT NULL,
  turns_rowid_hwm INTEGER NOT NULL,
  detector_ids    TEXT NOT NULL,
  inputs_sig      TEXT NOT NULL
);
