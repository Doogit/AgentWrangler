CREATE TABLE apply_jobs (
  job_id        TEXT PRIMARY KEY,
  rec_id        TEXT NOT NULL REFERENCES recommendations(rec_id),
  run_id        TEXT REFERENCES analysis_runs(run_id),
  status        TEXT NOT NULL CHECK (status IN
                ('PENDING','DRY_RUNNING','DRY_DONE','CONFIRMING','APPLIED','FAILED','ROLLED_BACK')),
  file_ref      TEXT NOT NULL,
  workspace_cwd TEXT NOT NULL,
  diff_preview  TEXT,
  diff_applied  TEXT,
  backup_path   TEXT,
  error_msg     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_apply_jobs_rec ON apply_jobs(rec_id, created_at DESC);
