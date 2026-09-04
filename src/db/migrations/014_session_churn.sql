CREATE TABLE session_churn (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(session_id),
  status         TEXT NOT NULL,
  window_days    INTEGER NOT NULL,
  authored_lines INTEGER NOT NULL DEFAULT 0,
  churned_lines  INTEGER NOT NULL DEFAULT 0,
  churn_ratio    REAL,
  commit_count   INTEGER NOT NULL DEFAULT 0,
  commit_shas    TEXT NOT NULL DEFAULT '[]',
  measured_at    TEXT NOT NULL
);
