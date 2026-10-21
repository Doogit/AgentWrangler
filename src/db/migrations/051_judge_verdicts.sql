-- JMS-P2 U9: one row per completed "Judge me" run. Stores the validated verdict JSON only — never the
-- payload (payload_hash fingerprints it) and never raw model text. grade_hash is the setup_grade_snapshots
-- content_hash the payload was built from; a different current hash marks the verdict outdated (R23).
CREATE TABLE IF NOT EXISTS judge_verdicts (
  verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  snapshot_id INTEGER,
  grade_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_judge_verdicts_created_at ON judge_verdicts(created_at);
