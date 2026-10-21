-- rec-reset U7 (D10 lane): per-item catalog footprint + Skill name at ingest.
--
-- catalog_items is rewritten by ContextInventoryProbe on every pass (current catalog only).
-- kind:       skill | plugin | mcp_server
-- plugin:     owning plugin key (e.g. name@marketplace); NULL for user-level items
-- usage_key:  how use shows up in tool_events — skill: the Skill tool's `skill` input;
--             mcp_server: the tool-name prefix (mcp__<server>__); plugin: NULL (use via its items)
-- tokens/bytes: measured size of the text the item keeps resident; NULL when it cannot be
--             measured from local files (MCP tool schemas come from the running server)
-- size_basis: 'chars4-v1' (ceil(bytes/4)) | 'unmeasured'
CREATE TABLE IF NOT EXISTS catalog_items (
  item_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('skill', 'plugin', 'mcp_server')),
  name       TEXT NOT NULL,
  plugin     TEXT,
  usage_key  TEXT,
  tokens     INTEGER,
  bytes      INTEGER,
  size_basis TEXT NOT NULL CHECK (size_basis IN ('chars4-v1', 'unmeasured')),
  source     TEXT NOT NULL,
  probed_at  TEXT NOT NULL
);

-- The Skill tool_use input names the skill; persisted so a last-used date per skill can be
-- derived. One row per Skill tool event ingested after this migration (a side table, so
-- tool_event_metadata keeps its shape). Skill events ingested earlier have no row.
CREATE TABLE IF NOT EXISTS tool_event_skills (
  event_id   TEXT PRIMARY KEY REFERENCES tool_events(event_id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_event_skills_name ON tool_event_skills(skill_name);
