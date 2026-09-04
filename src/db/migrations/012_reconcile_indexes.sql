CREATE INDEX IF NOT EXISTS idx_turns_session_ctx ON turns(session_id, context_tokens);
CREATE INDEX IF NOT EXISTS idx_tool_session_name_hash ON tool_events(session_id, tool_name, input_hash);
