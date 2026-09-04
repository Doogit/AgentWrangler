-- AgentWrangler Data Model v2 DDL — verbatim from AgentWrangler_Data_Model_and_Metrics_v2.md §1
-- metric_definition_version = 'observe-1'
-- Applied by: src/db/migrate.ts

CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  project_slug   TEXT NOT NULL UNIQUE,          -- ~/.claude/projects/<slug>
  repo_path      TEXT,                          -- local checkout, if registered
  repo_owner     TEXT, repo_name TEXT,          -- canonical GitHub identity
  registered_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,              -- sessionId or filename stem
  workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id),
  file_path      TEXT NOT NULL,
  first_turn_at  TEXT, last_turn_at TEXT,
  state          TEXT NOT NULL CHECK (state IN ('LIVE','RECONCILED')),
  turn_count     INTEGER NOT NULL DEFAULT 0,
  cost_equiv_u   INTEGER NOT NULL DEFAULT 0,    -- rollforward; reconciled at close
  hygiene_flags  TEXT NOT NULL DEFAULT '[]'     -- JSON: LONG_FULL_CONTEXT, COMPACT_MID_TASK...
);

CREATE TABLE turns (                             -- one row per assistant message (deduped)
  message_id     TEXT PRIMARY KEY,               -- message.id, fallback uuid
  session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  workspace_id   TEXT NOT NULL,
  ts             TEXT NOT NULL,
  model          TEXT NOT NULL,                  -- '<synthetic>' rows excluded upstream
  is_sidechain   INTEGER NOT NULL DEFAULT 0,     -- subagent marker
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m      INTEGER NOT NULL DEFAULT 0,
  cache_write_1h      INTEGER NOT NULL DEFAULT 0,
  cache_write_other   INTEGER NOT NULL DEFAULT 0,
  context_tokens AS (input_tokens + cache_read_tokens
                     + cache_write_5m + cache_write_1h + cache_write_other) STORED,
  tool_result_bytes   INTEGER,                   -- SUM over all tool_result blocks in the turn; size only, never content
  pricing_snapshot_id TEXT REFERENCES pricing_snapshots(snapshot_id),
  cost_equiv_u   INTEGER,                        -- NULL = unpriceable
  cost_claim     TEXT NOT NULL DEFAULT 'LIST_EQUIV'
                 CHECK (cost_claim IN ('LIST_EQUIV','LIST_EQUIV_STALE','BILLED')),
  provisional    INTEGER NOT NULL DEFAULT 0,
  effort         TEXT,                               -- extended thinking effort label; nullable, tolerated since 2026-08-14
  parser_version TEXT NOT NULL
);
CREATE INDEX idx_turns_ws_ts ON turns(workspace_id, ts);
CREATE INDEX idx_turns_session ON turns(session_id, ts);
CREATE INDEX idx_turns_model ON turns(model, ts);

CREATE TABLE tool_events (                       -- names/sizes/sequence only
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  ts           TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input_bytes  INTEGER, result_bytes INTEGER,
  input_hash   TEXT,                             -- for loop/near-duplicate detection
  exit_class   TEXT,                             -- OK | ERROR | TEST_FAIL | ...
  commit_sha   TEXT                              -- harvested when the event exposes one
);
CREATE INDEX idx_tool_session ON tool_events(session_id, ts);
CREATE INDEX idx_tool_sha ON tool_events(commit_sha) WHERE commit_sha IS NOT NULL;

CREATE TABLE pricing_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  model_tier  TEXT NOT NULL,                     -- opus|sonnet|haiku|fable...
  unit_prices_json TEXT NOT NULL,                -- [in, out, cacheRead, cw5m, cw1h] $/MTok
  captured_at TEXT NOT NULL, stale_after TEXT NOT NULL
);

CREATE TABLE context_inventory (                  -- always-loaded attribution time series
  probe_id     TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  probed_at    TEXT NOT NULL,
  component    TEXT NOT NULL CHECK (component IN
               ('CLAUDE_MD','RULES','MCP_SCHEMAS','SETTINGS_SYSTEM','MEMORY','OTHER')),
  file_ref     TEXT NOT NULL,                    -- path, not content
  file_hash    TEXT NOT NULL,
  tokens       INTEGER NOT NULL,
  attribution_version TEXT NOT NULL
  -- NOTE (v1 qualification): system-prompt and MCP-schema tokens (~1-3% of context) are NOT
  -- attributable from local files in v1; the attributed total may undercount (SG-S5-03 / FW-04).
);

CREATE TABLE work_items (                         -- PRs
  work_item_id TEXT PRIMARY KEY,                  -- gh:<owner>/<repo>#<number>
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  number       INTEGER NOT NULL,
  state        TEXT NOT NULL,                     -- OPEN|MERGED|CLOSED
  final_commit TEXT,
  checks_conclusion TEXT,                         -- SUCCESS|FAILURE|PENDING|NONE
  opened_at TEXT, merged_at TEXT, closed_at TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE session_work_links (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  confidence   REAL NOT NULL,                     -- SHA-overlap strength
  method       TEXT NOT NULL,                     -- SHA_OVERLAP | BRANCH | MANUAL
  PRIMARY KEY (session_id, work_item_id)
);

CREATE TABLE observed_outcomes (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id),
  outcome      TEXT NOT NULL CHECK (outcome IN
    ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS',
     'OBSERVED_FAILURE','IN_PROGRESS')),
  derived_at   TEXT NOT NULL,
  methodology_version TEXT NOT NULL
);

CREATE TABLE review_findings (
  finding_id   TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  source       TEXT NOT NULL CHECK (source IN
    ('UNRESOLVED_THREAD','DEFERRAL_SECTION','DIFF_MARKER','LLM')),   -- LLM = P0.5 seam
  severity     TEXT CHECK (severity IN ('HIGH','MEDIUM','LOW','UNKNOWN')),
  status       TEXT NOT NULL CHECK (status IN ('ADDRESSED','DEFERRED','UNKNOWN')),
  evidence_ref TEXT NOT NULL,                    -- thread id / body anchor / file:line
  confidence   REAL,                             -- NULL for deterministic sources
  human_state  TEXT CHECK (human_state IN ('CONFIRMED','REJECTED')),  -- LLM findings only
  raised_at    TEXT NOT NULL,
  cleared_at   TEXT,
  cleared_by   TEXT,                             -- resolving commit SHA or work_item_id
  extractor_version TEXT NOT NULL
);
CREATE INDEX idx_findings_open ON review_findings(status, cleared_at);

CREATE TABLE recommendations (
  rec_id        TEXT PRIMARY KEY,
  provenance    TEXT NOT NULL CHECK (provenance IN ('RULE','CLAUDE_ANALYZED')),
  detector_id   TEXT,                            -- RULE provenance
  analysis_run_id TEXT REFERENCES analysis_runs(run_id),   -- CLAUDE provenance
  category      TEXT NOT NULL,
  scope_workspace_id TEXT,                       -- NULL = global
  lever         TEXT NOT NULL,
  modeled_savings_u_per_wk INTEGER,
  modeled_formula_json TEXT NOT NULL,            -- inputs so the model is reproducible
  evidence_json TEXT NOT NULL,                   -- citations: metric ids + values + row ids
  target_metric TEXT NOT NULL,                   -- what effect measurement watches
  state         TEXT NOT NULL CHECK (state IN
    ('PROPOSED','ADOPTED','DISMISSED','MEASURING',
     'MEASURED_EFFECTIVE','MEASURED_NO_EFFECT')),
  created_at TEXT NOT NULL, adopted_at TEXT, dismissed_until TEXT
);

CREATE TABLE recommendation_effects (
  rec_id       TEXT NOT NULL REFERENCES recommendations(rec_id),
  measured_at  TEXT NOT NULL,                      -- adoption-cycle grain; composite PK with rec_id
  before_from  TEXT NOT NULL, before_to TEXT NOT NULL,
  after_from   TEXT NOT NULL, after_to  TEXT NOT NULL,
  before_value REAL, after_value REAL,
  before_n INTEGER, after_n INTEGER,
  delta_pct    REAL,
  verdict      TEXT CHECK (verdict IN ('EFFECTIVE','NO_EFFECT','INCONCLUSIVE')),
  PRIMARY KEY (rec_id, measured_at)                -- composite: effects re-measurable across cycles
);

CREATE TABLE analysis_runs (                      -- Tier 2 provenance + metering
  run_id        TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,                    -- GLOBAL | workspace_id | session_id
  model         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  evidence_pack_hash TEXT NOT NULL,
  content_included INTEGER NOT NULL DEFAULT 0,    -- explicit opt-in only (SEC-104)
  input_tokens INTEGER, output_tokens INTEGER,
  cost_equiv_u INTEGER,
  contract_valid INTEGER,                         -- schema + citation resolution result
  ran_at TEXT NOT NULL
);

CREATE TABLE ingest_quarantine (
  q_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL, line_no INTEGER NOT NULL,
  error_class TEXT NOT NULL, parser_version TEXT NOT NULL,
  seen_at TEXT NOT NULL                          -- pointer only; no content (SEC-107)
);

CREATE TABLE ingest_offsets (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  file_hash_head TEXT,                           -- rotation/truncation detection
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE user_config (                        -- daemon-side persisted config + alert state
  key        TEXT PRIMARY KEY,                   -- e.g. 'limit_tokens', 'last_warned_jd'
  value      TEXT,                               -- stored as text; callers cast to required type
  updated_at TEXT NOT NULL
  -- Enables Burn-Forecast persistence (FW-06) and alerting detector D5 (FW-07).
  -- Seed rows: ('limit_tokens', NULL, ...) and ('last_warned_jd', NULL, ...).
);
