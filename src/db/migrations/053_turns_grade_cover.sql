-- PERF-P3: setup-grade turnGroups aggregates every non-provisional turn of the 30-day window. Through
-- the ts index that is one table lookup per turn plus a GROUP BY temp b-tree (~150 ms of the ~240 ms
-- /api/judge-setup p95 on a real-size DB). This index covers the query in GROUP BY order (~36 ms).
-- Index only: no table, column or data change.
CREATE INDEX IF NOT EXISTS idx_turns_grade_cover
  ON turns(session_id, is_sidechain, model, ts, provisional,
           input_tokens, cache_read_tokens, context_tokens);
