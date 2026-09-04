-- D7 ingestion foundation: privacy-safe target identity and structural ordering.
-- Raw tool input/output and raw tool file paths are intentionally excluded.

CREATE TABLE tool_event_metadata (
  event_id          TEXT PRIMARY KEY REFERENCES tool_events(event_id) ON DELETE CASCADE,
  file_path_hash    TEXT,
  owner_message_id  TEXT,
  block_index       INTEGER NOT NULL,
  is_test_command   INTEGER NOT NULL CHECK (is_test_command IN (0, 1))
);

CREATE INDEX idx_tool_meta_path_order
  ON tool_event_metadata(file_path_hash, block_index)
  WHERE file_path_hash IS NOT NULL;

CREATE INDEX idx_tool_meta_owner_event
  ON tool_event_metadata(owner_message_id, event_id);
