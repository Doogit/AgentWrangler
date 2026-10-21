-- P2-U8 detector contract v2 (perf plan #### P2-U8; audit §11.4).
-- SEC-101: ids, versions, ISO bounds, signatures, counts and error class names only.
--
-- detector_eval_marks: one row per (window, detector) the history walk evaluated
-- successfully. window_key is the closed week's week_start, or 'W0' for the rolling
-- window (its start moves every pass). A closed week is stale for one detector when
-- its version or declared-input signature changed, or a turn landed in the week after
-- turns_rowid_hwm. W0 is stale when its version or W0 input signature (content of the
-- window's rows plus every coupled table's high-water mark) changed; outcome_json then
-- holds the outcome the walk replays instead of re-evaluating.
CREATE TABLE detector_eval_marks (
  window_key      TEXT NOT NULL,
  detector_id     TEXT NOT NULL,
  week_end        TEXT NOT NULL,
  version         TEXT NOT NULL,
  inputs_sig      TEXT NOT NULL,
  turns_rowid_hwm INTEGER NOT NULL,
  window_from     TEXT NOT NULL,
  outcome_json    TEXT,
  evaluated_at    TEXT NOT NULL,
  PRIMARY KEY (window_key, detector_id)
);

-- (detector, version, window) pairs that threw. At fail_count >= 3 the walk skips the
-- pair until the detector's version changes or 24 h pass since the last failure
-- (`since`); a success deletes the row.
CREATE TABLE detector_quarantine (
  detector_id      TEXT NOT NULL,
  version          TEXT NOT NULL,
  scope_key        TEXT NOT NULL,
  fail_count       INTEGER NOT NULL,
  last_error_class TEXT NOT NULL,
  since            TEXT NOT NULL,
  PRIMARY KEY (detector_id, version, scope_key)
);
