-- rec-reset U7 (C6 lane): per-Edit old_string / new_string hashes so C6 can detect a
-- true swap (A->B then B->A) on one file. Hashes only; the strings are never stored.
-- Existing rows stay NULL: the edit strings were never persisted, so they cannot be
-- re-derived from the DB. C6 sees edits ingested after this migration.

ALTER TABLE tool_event_metadata ADD COLUMN edit_old_string_hash TEXT;
ALTER TABLE tool_event_metadata ADD COLUMN edit_new_string_hash TEXT;
