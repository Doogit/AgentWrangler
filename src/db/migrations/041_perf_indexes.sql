-- P0-U5: indexes for statements that EXPLAIN QUERY PLAN showed as `SCAN sessions`.
-- `sessions` had no secondary index. (`turns` windowed queries already SEARCH
-- idx_turns_ts_provisional_session, so no turns index is added.)
-- Indexes only: no table, column or data change.

-- LIVE count / live strip / workspaces LIVE ids / workspace LIVE probe.
CREATE INDEX IF NOT EXISTS idx_sessions_state_last ON sessions(state, last_turn_at);
-- Workspace sessions list + count, spend-percentile population, workspace LIVE probe.
CREATE INDEX IF NOT EXISTS idx_sessions_ws_last ON sessions(workspace_id, last_turn_at);
-- Global drivers population (last_turn_at window, no other predicate).
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_turn_at);
-- Trends: RECONCILED sessions in a first_turn_at window.
CREATE INDEX IF NOT EXISTS idx_sessions_state_first ON sessions(state, first_turn_at);
