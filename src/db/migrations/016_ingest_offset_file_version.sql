-- Nullable metadata lets existing offsets establish a baseline on their next read.
-- No transcript content is stored here. Identity detects path replacement; timestamps
-- detect equal-size in-place rewrites beyond the existing 256-byte head fingerprint.
ALTER TABLE ingest_offsets ADD COLUMN file_size INTEGER;
ALTER TABLE ingest_offsets ADD COLUMN file_dev TEXT;
ALTER TABLE ingest_offsets ADD COLUMN file_ino TEXT;
ALTER TABLE ingest_offsets ADD COLUMN file_mtime_ms REAL;
ALTER TABLE ingest_offsets ADD COLUMN file_ctime_ms REAL;
