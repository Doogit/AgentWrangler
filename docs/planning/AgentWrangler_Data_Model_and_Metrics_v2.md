# AgentWrangler — SQLite Data Model & Metric Query Draft v2.0

**Date:** 2026-08-21 · **Status:** Draft for MVP (Observe) · **Supersedes v1.0 for MVP scope** (v1.0 tables remain the P1 governance schema) · **Companions:** Architecture v4.5.0 §9, PRD v0.7.0 §9 · **Point-release:** v0.7.1 patches applied 2026-08-21 (Session 12) — see Change log

Conventions unchanged: TEXT ids, `*_at` ISO-8601 UTC, money = INTEGER micro-USD (`_u`), enums TEXT+CHECK. `PRAGMA journal_mode=WAL; foreign_keys=ON;` **No content-bearing columns exist in this schema** (SEC-101 is structural).

> **⚠️ Metric note — 2026-08-25 (external research pass).** The `context_tokens` generated column and the
> spend rollups below sum `input + output + cache_read + cache_write_*` at **FULL weight**. For
> **rate-limit-cap** attribution this over-counts cache reads ~10×: the 2026-08-25 economics brief finds
> cache reads draw on the cap at the **cached rate (~0.1×, unverified)**, not full weight. The go-forward
> metric is a **cap-weighted token** = `full(cache_write_*) + COEFF×cache_read + full(input+output)`,
> computed **query-side** (frozen `context_tokens` is unchanged), with `COEFF` a runtime config constant
> (default 0.1, flagged unverified — ship both 0.1× and 1× and select at runtime). Raw summed tokens stay
> valid for **$ cost** (priced per-field) and as a UI-suppressed internal, never a headline. See
> `spec-recommendations-engine.md` §W0.1 + [[economic-model-research-2026-08-25]]. **Full build-ready
> definition (expression, `COEFF` config, both regimes, copy-pasteable SQL, cache-efficiency ratio): §2A below.**
> Useful adjuncts the brief flags for future metrics: a **cache-efficiency ratio** (`cache_read :
> cache_creation`) and a **cache-miss event** signal (`cache_write_*` spike after an idle gap) — both derivable
> from existing columns.

## 1. DDL

```sql
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

CREATE TABLE tool_event_metadata (              -- migration 005; privacy-safe D7 inputs
  event_id         TEXT PRIMARY KEY REFERENCES tool_events(event_id) ON DELETE CASCADE,
  file_path_hash   TEXT,                        -- normalized path identity; raw path never persisted
  owner_message_id TEXT,                        -- structural turn owner; no content
  block_index      INTEGER NOT NULL,            -- stable order within one assistant message
  is_test_command  INTEGER NOT NULL CHECK (is_test_command IN (0, 1))
);
CREATE INDEX idx_tool_meta_path_order
  ON tool_event_metadata(file_path_hash, block_index)
  WHERE file_path_hash IS NOT NULL;
CREATE INDEX idx_tool_meta_owner_event
  ON tool_event_metadata(owner_message_id, event_id);
CREATE INDEX idx_tool_ts_session_event           -- migration 006; bounded D7 window scan
  ON tool_events(ts, session_id, event_id);
CREATE INDEX idx_turns_ts_provisional_session    -- migration 006; D7 coverage denominator
  ON turns(ts, provisional, session_id);

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
  -- NOTE (v1 qualification): system-prompt and MCP-schema tokens (~1–3% of context) are NOT
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
```

## 2. Metric queries (`metric_definition_version = 'observe-1'`)

```sql
-- Spend by workspace (window :t_from/:t_to), with cache split and claim purity
-- Note (FW-12): per-workspace breakdown is already supported — the cache-split, claim-kind guard,
-- and provisional exclusion below apply; no schema change needed.
SELECT w.workspace_id,
       SUM(t.cost_equiv_u)/1e6                                   AS cost_equiv_usd,
       SUM(t.input_tokens) AS input_tok, SUM(t.output_tokens)    AS output_tok,
       SUM(t.cache_read_tokens)                                  AS cache_read_tok,
       SUM(t.cache_write_5m + t.cache_write_1h + t.cache_write_other) AS cache_write_tok,
       COUNT(*) AS turns,
       SUM(t.cost_equiv_u IS NULL)                               AS unpriced_turns,
       COUNT(DISTINCT t.cost_claim)                              AS claim_kinds   -- must not mix
FROM turns t JOIN workspaces w USING (workspace_id)
WHERE t.ts >= :t_from AND t.ts < :t_to AND t.provisional = 0
GROUP BY w.workspace_id ORDER BY cost_equiv_usd DESC;

-- Context per turn by model (the diagnosis metric)
SELECT model, COUNT(*) AS n,
       AVG(context_tokens) AS avg_context_per_turn,
       AVG(output_tokens)  AS avg_output_per_turn,
       SUM(cost_equiv_u)*1.0/COUNT(*)/1e6 AS usd_per_turn
FROM turns WHERE ts >= :t_from AND ts < :t_to
GROUP BY model;

-- Live strip: active sessions with provisional running cost
SELECT s.session_id, s.workspace_id, s.turn_count,
       s.cost_equiv_u/1e6 AS running_usd,
       (SELECT context_tokens FROM turns tt WHERE tt.session_id = s.session_id
         ORDER BY tt.ts DESC LIMIT 1) AS current_context_tokens
FROM sessions s
WHERE s.state = 'LIVE' AND s.last_turn_at >= :activity_cutoff;

-- Weekly-limit burn forecast (ADR-107 §D-5; states: EXCEEDED | COLD_START | ON_TRACK)
-- EXCEEDED: tok >= :limit_tokens → projected_exhaustion_jd = NULL (already over)
-- COLD_START: elapsed_days < 0.25 (< 6 h) → rate unreliable, projected_exhaustion_jd = NULL
WITH burn AS (
  SELECT SUM(input_tokens + output_tokens + cache_read_tokens
             + cache_write_5m + cache_write_1h + cache_write_other) AS tok,
         julianday('now') - julianday(:window_start)                  AS elapsed_days
  FROM turns WHERE ts >= :window_start)
SELECT tok                                                            AS tokens_used,
       tok * 1.0 / MAX(1, elapsed_days)                              AS tokens_per_day,
       :limit_tokens - tok                                            AS tokens_remaining,
       CASE
         WHEN tok >= :limit_tokens THEN NULL   -- EXCEEDED
         WHEN elapsed_days < 0.25  THEN NULL   -- COLD_START
         ELSE julianday('now') + (:limit_tokens - tok) / NULLIF(tok / elapsed_days, 0)
       END                                                            AS projected_exhaustion_jd,
       CASE
         WHEN tok >= :limit_tokens THEN 'EXCEEDED'
         WHEN elapsed_days < 0.25  THEN 'COLD_START'
         ELSE 'ON_TRACK'
       END                                                            AS forecast_state
FROM burn;

-- Observed Success Rate with mandatory clean/with-deferrals split (FR-OUTCOME-103)
-- Denominator contract: terminal (non-IN_PROGRESS) work items in the window with ≥1 session_work_links row.
-- UNLINKED sessions are IMPLICIT (absence of a session_work_links row) and excluded from the denominator.
-- no_ci_success_n: successes where checks_conclusion='NONE'; annotation only, NOT folded into success_rate.
SELECT COUNT(*) AS terminal_n,
       AVG(outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')) AS success_rate,
       SUM(outcome = 'OBSERVED_SUCCESS')                AS clean_success_n,
       SUM(outcome = 'OBSERVED_SUCCESS_WITH_DEFERRALS') AS with_deferrals_n,
       SUM(outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')
           AND wi.checks_conclusion = 'NONE')           AS no_ci_success_n
FROM observed_outcomes o JOIN work_items wi USING (work_item_id)
WHERE o.outcome != 'IN_PROGRESS'
  AND COALESCE(wi.merged_at, wi.closed_at) >= :t_from
  AND COALESCE(wi.merged_at, wi.closed_at) <  :t_to
  AND EXISTS (SELECT 1 FROM session_work_links l WHERE l.work_item_id = o.work_item_id);

-- Cost per Observed Success (1:1 linked, exact-priced cohort; failed linked work in numerator)
-- Denominator: work items whose contributing sessions each link to exactly one work item.
-- Sessions linked to >1 work item are excluded (cost not attributable 1:1); count in excluded_multilink_n.
WITH one_to_one_sessions AS (
  SELECT session_id FROM session_work_links
  GROUP BY session_id HAVING COUNT(DISTINCT work_item_id) = 1),
linked_cost AS (
  SELECT l.work_item_id, SUM(t.cost_equiv_u) AS cost_u,
         SUM(t.cost_equiv_u IS NULL)          AS unpriced
  FROM session_work_links l
  JOIN turns t ON t.session_id = l.session_id
  WHERE l.session_id IN (SELECT session_id FROM one_to_one_sessions)
  GROUP BY l.work_item_id)
SELECT SUM(lc.cost_u) * 1.0
       / NULLIF(SUM(o.outcome IN ('OBSERVED_SUCCESS','OBSERVED_SUCCESS_WITH_DEFERRALS')),0)
       / 1e6                                            AS usd_per_success,
       SUM(o.outcome = 'OBSERVED_SUCCESS')              AS clean_success_n,
       COUNT(*)                                         AS cohort_n,
       (SELECT COUNT(*) FROM (
          SELECT session_id FROM session_work_links
          GROUP BY session_id HAVING COUNT(DISTINCT work_item_id) > 1
        ))                                              AS excluded_multilink_n
FROM linked_cost lc
JOIN observed_outcomes o USING (work_item_id)
WHERE lc.unpriced = 0 AND o.outcome != 'IN_PROGRESS';

-- Deferral metrics
SELECT AVG(has_def) AS deferral_rate FROM (
  SELECT wi.work_item_id,
         EXISTS(SELECT 1 FROM review_findings f
                WHERE f.work_item_id = wi.work_item_id AND f.status='DEFERRED'
                  AND (f.source != 'LLM' OR f.human_state = 'CONFIRMED')) AS has_def
  FROM work_items wi WHERE wi.state = 'MERGED'
    AND wi.merged_at >= :t_from AND wi.merged_at < :t_to);

SELECT COUNT(*) AS open_deferred,
       AVG(julianday('now') - julianday(raised_at)) AS avg_age_days
FROM review_findings WHERE status='DEFERRED' AND cleared_at IS NULL;

-- Routing adherence v1 (mechanical-turn heuristic: tool-only / short-output turns)
-- adherence_score = ROUND(100 * (1 - premium_share_on_mechanical))  [routing adherence v1]
-- Note: extends to a composite score once FW-09/FW-10 land.
WITH ra AS (
  SELECT SUM(CASE WHEN mechanical=1 AND model LIKE '%opus%' THEN cost_equiv_u END)*1.0
         / NULLIF(SUM(CASE WHEN mechanical=1 THEN cost_equiv_u END),0) AS premium_share_on_mechanical
  FROM (SELECT t.*, (t.output_tokens < :short_output_threshold) AS mechanical
        FROM turns t WHERE ts >= :t_from AND ts < :t_to))
SELECT premium_share_on_mechanical,
       ROUND(100 * (1 - premium_share_on_mechanical)) AS adherence_score
FROM ra;

-- Linkage rate (honesty metric)
-- Denominator: RECONCILED sessions with ≥1 Bash tool_event (excludes pure-read / no-op sessions).
SELECT AVG(EXISTS(SELECT 1 FROM session_work_links l WHERE l.session_id = s.session_id))
       AS linkage_rate
FROM sessions s WHERE s.state='RECONCILED'
  AND EXISTS (SELECT 1 FROM tool_events te WHERE te.session_id = s.session_id
              AND te.tool_name = 'Bash');
```

## 2A. Cap-weighted token meter (`metric_definition_version = 'observe-1'`, additive)

**Purpose.** A single scalar that estimates a turn's draw on the *rate-limit cap* (not its dollar cost).
It exists because the frozen `context_tokens` generated column (`turns`, §1) and the spend rollups in §2 sum
`input + cache_read + cache_write_*` at **full weight**, which over-counts cache reads ~10× for cap
attribution (2026-08-25 economics brief, verdict A2; [[economic-model-research-2026-08-25]]). This meter is
**additive and query-side** — it does **not** alter `context_tokens` (frozen) and adds nothing to the schema.

**Definition.**

```
cap_weighted_tokens
  =  full(cache_write_5m + cache_write_1h + cache_write_other)   -- cache CREATES/misses: full weight
  +  COEFF × cache_read_tokens                                    -- cached re-reads: ~0.1× (unverified)
  +  full(input_tokens + output_tokens)                          -- fresh input + generation: full weight
```

Differences from the frozen `context_tokens` (`input + cache_read + cache_write_*`, all 1×) are deliberate:
this meter (a) **adds `output_tokens`** (generation draws on the cap), and (b) **down-weights `cache_read`**
by `COEFF`. The two series are not interchangeable — `context_tokens` stays valid as a UI-suppressed internal
and for `$` cost (priced per-field, §2), never as a cap headline.

**`COEFF` — the pivotal unverified constant.**
- Lives in `user_config` as key `cap_read_coeff` (TEXT; callers cast to REAL). **Default `'0.1'`**, carrying a
  visible "unverified — Anthropic has not published a cap coefficient for cache reads" caveat wherever a
  cap-weighted figure is surfaced. Seed row: `('cap_read_coeff', '0.1', <ts>)`.
- **Ship both regimes and select at runtime:** `0.1×` (default, cached-rate world) and `1.0×` (upper-bound —
  the world where cache reads count at full rate; economics brief contingency). A caller passes the resolved
  value as `:cap_read_coeff`; nothing is hard-coded in SQL.
- Cache *writes* are counted at **full (1×) token weight** here (matching both briefs' `full(creation)`); their
  1.25×/2× figure is a **price** multiplier (§ `pricing_snapshots`), a separate `$` concern, not a token-volume
  weight. If a future reconciliation shows the cap counts writes at their price multiplier, that is a *second*
  unverified coefficient — add it the same way (config key, both regimes), do not bake it in.

**Query (copy-pasteable; touches no frozen column).**

```sql
-- Cap-weighted tokens for a window (:cap_read_coeff resolved from user_config.cap_read_coeff).
-- Additive: reads the raw usage fields directly; never references context_tokens.
SELECT
  SUM( (t.cache_write_5m + t.cache_write_1h + t.cache_write_other)  -- full weight
       + :cap_read_coeff * t.cache_read_tokens                      -- cached rate (~0.1×, unverified)
       + (t.input_tokens + t.output_tokens) )                       -- full weight
    AS cap_weighted_tokens
FROM turns t
WHERE t.ts >= :t_from AND t.ts < :t_to AND t.provisional = 0;
```

Group by `workspace_id` / `session_id` / `model` for the same breakdowns §2 already offers; the expression is
identical. A new query module owns it (mirrors the frozen-file rule for `spend.ts` / `overview.ts`) so callers
opt in without touching §2's frozen queries.

**Cache-efficiency ratio (named diagnostic, not a headline).**

```sql
-- Read-dominated = healthy active session; a falling ratio (rising cache_creation share) = churn/thrash.
SELECT
  SUM(t.cache_read_tokens) * 1.0
  / NULLIF(SUM(t.cache_write_5m + t.cache_write_1h + t.cache_write_other), 0)
    AS cache_read_to_write_ratio
FROM turns t
WHERE t.ts >= :t_from AND t.ts < :t_to AND t.provisional = 0;
```

`cache_read : cache_creation` is the diagnostic input to the D8 cache-write-churn detector (engine spec §2).
It is a diagnostic, never a scoreboard.

**UI contract (tokenmaxxing guard, research B RQ6).** Cap-weighted tokens feed the meter and detectors; they
are **never** surfaced as a raw "tokens" or "tokens saved" headline/leaderboard. User-facing anchors stay
`$/wk` + per-turn delta + (once a limit calibrates) a qualified `% of cap`.

## 3. Rules of the layer (carried and adapted)

1. UI never issues SQL; `LocalQueryAPI` owns denominators and attaches `{n, window, qualification, metric_definition_version, drilldown ids}`.
2. `cost_claim` kinds never sum; `LIST_EQUIV_STALE` downgrades cost observability labels.
3. Provisional turns are excluded from reconciled aggregates and shown only in live views.
4. LLM-source findings enter metrics only when `human_state='CONFIRMED'` (P0.5 rule, encoded now).
5. Modeled savings (`recommendations.modeled_*`) are never aggregated into achieved savings; only `recommendation_effects` rows with verdict `EFFECTIVE` are.
6. Any eligibility/denominator/window change ⇒ new `metric_definition_version`; history keeps its version.
7. Rebuild test: drop DB → re-scan → aggregates equal (dedupe on `message_id` guarantees it).

## 4. Open items

1. `sessions.cost_equiv_u` rollforward vs on-demand SUM — decide after S2 measures tail write rates.
2. Turn-class heuristic v1 threshold (`:short_output_threshold`) — calibrate in S1 against the review's per-model output distributions.
3. Whether D7 needs ordering stronger than `(tool_events.ts, block_index, event_id)` after field calibration.
4. Limit model parameters (`:limit_tokens`, window anchor) — S7 decides observed vs configured.

## Change log

_v0.7.1 point-release — all patches applied 2026-08-21 (Session 12)_

- 2026-08-21 (Session 12): added `MEMORY` to `context_inventory.component` CHECK enum — source: FW-05 / SG-S5-04
- 2026-08-21 (Session 12): added nullable `effort TEXT` column to `turns` table (present in records since 2026-08-14) — source: FW-10 / G-06
- 2026-08-21 (Session 12): added `user_config` key/value table for `:limit_tokens`, `last_warned_jd`, and alerting state; enables Burn-Forecast persistence and detector D5 — source: FW-06 / FW-07
- 2026-08-21 (Session 12): added `adherence_score = ROUND(100 * (1 - premium_share_on_mechanical))` to routing-adherence query (routing adherence v1); noted composite extension pending FW-09/FW-10 — source: FW-08
- 2026-08-21 (Session 12): rewrote burn-forecast query to reflect ADR-107 §D-5 states (EXCEEDED, COLD_START, ON_TRACK); `projected_exhaustion_jd = NULL` on EXCEEDED/COLD_START; added `forecast_state` column — source: ADR-107 D-5 / C-02 / SG-07-03 / SG-07-04
- 2026-08-21 (Session 12): restricted cost-per-success denominator to 1:1 linked sessions; added `excluded_multilink_n` count with documented exclusion note — source: C-03
- 2026-08-21 (Session 12): documented UNLINKED = IMPLICIT in success-rate query denominator contract; added `no_ci_success_n` annotation for `checks_conclusion='NONE'` (not folded into success_rate) — source: OQ-01 / OQ-05
- 2026-08-21 (Session 12): redefined linkage-rate denominator as RECONCILED sessions with ≥1 Bash tool_event — source: SG-01 / FW-01
- 2026-08-21 (Session 12): changed `recommendation_effects` primary key from singleton `rec_id` to composite `(rec_id, measured_at)` to support re-measurement across adoption cycles — source: OQ-04
- 2026-08-21 (Session 12): added note to spend-by-workspace query that per-workspace cost is already supported (cache-split + claim-kind guard + provisional exclusion in effect); no schema change needed — source: FW-12
- 2026-08-21 (Session 12): specified `tool_result_bytes` as the SUM over all tool_result blocks in a turn (not per-block) — source: G-07
- 2026-08-21 (Session 12): added v1 qualification note to `context_inventory` DDL: system-prompt and MCP-schema tokens (~1–3% of context) are not attributable from local files in v1; attributed total may undercount — source: SG-S5-03 / FW-04
- 2026-08-25: added §2A **cap-weighted token meter** (build-ready): expression `full(cache_write_*) + COEFF×cache_read + full(input+output)`, `COEFF` = `user_config.cap_read_coeff` (default `'0.1'`, unverified; ship 0.1× + 1× regimes), copy-pasteable query that touches no frozen column, and the `cache_read:cache_creation` efficiency-ratio diagnostic. Additive/query-side — `context_tokens` unchanged — source: `recommendations-improvement-v2.md` §W0.1 / research briefs A/B / [[economic-model-research-2026-08-25]]
- 2026-08-26: documented migration-005 `tool_event_metadata` for D7: normalized SHA-256 path
  identity, owner message, within-message order, and a structural test-command boolean only. Raw tool content,
  Bash command payloads, and paths remain excluded; legacy `/clear` and `/compact` local-command markers are
  unchanged, and historical enrichment is operator-controlled.
- 2026-08-26: added migration-006 time-first indexes for D7's trailing-window event and turn scans.
