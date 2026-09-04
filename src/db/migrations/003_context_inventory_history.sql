-- AgentWrangler migration 003 — context_inventory_history for realized-savings measurement.
-- Applied by: src/db/migrate.ts (auto-discovered by filename order)
--
-- Sibling to context_inventory: stores one row per distinct file_hash version, appended
-- by the probe whenever file_hash changes from the last recorded value.  This gives a
-- bounded change-log (one row per version, not one per probe) so byte-deltas are measurable.

CREATE TABLE context_inventory_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id),
  component           TEXT NOT NULL CHECK (component IN
                      ('CLAUDE_MD','RULES','MCP_SCHEMAS','SETTINGS_SYSTEM','MEMORY','OTHER')),
  file_ref            TEXT NOT NULL,
  file_hash           TEXT NOT NULL,
  tokens              INTEGER NOT NULL,
  attribution_version TEXT NOT NULL,
  observed_at         TEXT NOT NULL
);
CREATE INDEX idx_ctx_hist_workspace ON context_inventory_history(workspace_id, observed_at);
CREATE INDEX idx_ctx_hist_file_ref  ON context_inventory_history(workspace_id, component, file_ref, observed_at);
