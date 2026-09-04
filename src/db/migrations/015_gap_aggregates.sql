-- EF3: per-session inter-user-turn gap aggregates (SEC-101: durations in seconds only).
-- Backfilled on next full re-scan (RV2a stance); historical rows keep defaults.
ALTER TABLE sessions ADD COLUMN gap_median_s REAL;
ALTER TABLE sessions ADD COLUMN gap_p90_s REAL;
ALTER TABLE sessions ADD COLUMN long_gap_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN gap_n INTEGER NOT NULL DEFAULT 0;
