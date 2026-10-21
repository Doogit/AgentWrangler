-- P3-U7 file identity (perf plan #### P3-U7; audit R-4/R-5).
-- SEC-101: hashes, versions and counts only.
--
-- tail_hash: SHA-256 of the up-to-4 KB before byte_offset. With file_hash_head it
-- identifies a file's consumed prefix, so a copy or rename at a new path carries
-- the old row's progress over instead of re-reading, and a rewrite before the
-- watermark is caught on the next tail. NULL on rows written before 048; filled
-- lazily on the next skip or save.
-- parser_version: the PARSER_VERSION that last advanced this file (NULL = before 048).
-- reset_count: truncations and rotations seen for this path (the audit's file_resets
-- counter; derived rows are not discarded on a reset yet).
ALTER TABLE ingest_offsets ADD COLUMN tail_hash TEXT;
ALTER TABLE ingest_offsets ADD COLUMN parser_version TEXT;
ALTER TABLE ingest_offsets ADD COLUMN reset_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ingest_offsets_head ON ingest_offsets(file_hash_head);
