-- OV-12 Phase 2 U4: weekly limit readings over time (spec-overview-spend-card-limits § Phase 2).
-- Percentages and timestamps only (SEC-101). No token or $ sums: those are recomputed from
-- `turns` when read, so late ingestion and price changes apply after the fact.
-- source: 'api' | 'statusline' (forward writes) | 'calibration-backup' | 'limit-hit' (backfill).
CREATE TABLE IF NOT EXISTS limit_snapshots (
  ts TEXT PRIMARY KEY,
  resets_at TEXT,
  used_pct REAL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_limit_snapshots_source_ts ON limit_snapshots(source, ts);
