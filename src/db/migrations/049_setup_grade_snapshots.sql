-- JMS U4: one row per setup-grade CHANGE (score/tier/category/gate/cap/check-result), so the UI can
-- show "since last grade" independent of any judge. No dollar figures (SEC-101: scores and ids only).
-- rubric_version = the registry version tag(s) the grade was computed under; a differing value between
-- two rows flags a delta that crosses a rubric change. content_hash fingerprints the comparable grade
-- content (not computed_at, not raw signal values) so an unchanged grade writes nothing.
CREATE TABLE IF NOT EXISTS setup_grade_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at TEXT NOT NULL,
  overall REAL,
  tier TEXT,
  category_scores TEXT NOT NULL,
  gate_state TEXT NOT NULL,
  cap_state TEXT NOT NULL,
  check_results TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_grade_snapshots_computed_at ON setup_grade_snapshots(computed_at);
