-- SEC-101: subagent descriptions are sensitive local text. Retain only their
-- character count alongside structural metadata; never retain the text itself.
-- tool_use_id has no FK because a subagent can be discovered during a partial
-- scan before its parent transcript is available.

CREATE TABLE subagent_meta (
  agent_id        TEXT PRIMARY KEY,
  session_id      TEXT,
  agent_type      TEXT,
  tool_use_id     TEXT,
  spawn_depth     INTEGER,
  description_len INTEGER
);
