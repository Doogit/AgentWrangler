-- Structural position of the first main-chain turn after a compaction marker.
ALTER TABLE turns ADD COLUMN is_compaction_boundary INTEGER NOT NULL DEFAULT 0;
