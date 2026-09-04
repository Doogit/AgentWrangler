-- AgentWrangler migration 002 — additional indexes for high-frequency FK lookups.
-- Applied by: src/db/migrate.ts

CREATE INDEX IF NOT EXISTS idx_work_items_workspace ON work_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_session_work_links_work_item ON session_work_links(work_item_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_work_item ON review_findings(work_item_id);
