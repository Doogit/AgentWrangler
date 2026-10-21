-- PERF-RECS: index the correlated session/agent eligibility checks in claim evidence.
CREATE INDEX IF NOT EXISTS idx_subagent_meta_session ON subagent_meta(session_id, agent_type);
