-- RV2a: L1 Friction substrate — per-session counters for friction signal ingestion.
-- SEC-101: counts only; never message content.
ALTER TABLE sessions ADD COLUMN compaction_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_error_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN interrupt_count   INTEGER NOT NULL DEFAULT 0;
