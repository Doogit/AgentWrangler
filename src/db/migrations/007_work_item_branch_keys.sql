CREATE TABLE work_item_branch_keys (
  work_item_id          TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  head_ref_key          TEXT NOT NULL
                        CHECK (length(head_ref_key) = 64
                           AND head_ref_key NOT GLOB '*[^0-9a-f]*'),
  normalization_version TEXT NOT NULL CHECK (normalization_version = 'branch-v1'),
  synced_at             TEXT NOT NULL
);

CREATE INDEX idx_work_item_branch_key
  ON work_item_branch_keys(head_ref_key, work_item_id);
