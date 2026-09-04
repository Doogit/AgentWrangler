# AgentWrangler — Ingestion & Findings Spec v1.0

**Date:** 2026-08-21 · **Status:** Design, pending Spikes S1–S4 · **Companions:** Architecture v4.5.0 §3–5, Data Model v2, PRD v0.7.0 §7–8

## 1. Transcript ingestion

### 1.1 Discovery

- Roots: configured list, default `~/.claude/projects/`. Each subdirectory = a candidate workspace (`project_slug`); each `*.jsonl` = a session file.
- Scan cadence: filesystem watch where available, else 30 s mtime poll. New slugs auto-register as unmapped workspaces (spend visible immediately; outcome features activate when the user maps slug → repo).
- Back-scan on install processes all existing files; `mtime`-based skip is **not** used for correctness (unlike the ad-hoc script) — offsets + dedupe make full coverage cheap and NFR-107 (rebuild equality) depends on it.

### 1.2 Record processing (per line)

Consume the fields proven by the 2026-08-21 review (§1 of that report) — `timestamp`, `message.id`/`uuid`, `message.model`, the five `usage` token fields incl. the `cache_creation.ephemeral_5m/1h` split, `session_id`/`sessionId` (parser prefers `session_id` when both present; either accepted — source: G-01)/filename, project dir, `effort` (optional; present post-2026-08-14 — source: G-06) — plus: sidechain/subagent markers, tool-use/tool-result blocks (**names and byte sizes only**; `tool_result_bytes` = SUM of all tool_result blocks in a turn — source: G-07), system records of types `local_command` (`type=system subtype=local_command`; covers `/clear`, `/compact`; command name read from the `content` field) and `away_summary` (both ingested and used to populate `sessions.hygiene_flags` — source: G-02 / FW-09), and commit SHAs appearing in tool metadata.

Rules:

- **Dedupe:** upsert-ignore on `message_id`; a repeated line is a no-op.
- **Exclusions:** `<synthetic>`/empty-model records excluded from cost attribution, counted in parser-health stats.
- **Projection (SEC-101):** content fields are read for sizes, canonical hashes, structural result classes,
  and SHAs, then discarded in-process. Ingestion-2 persists no tool input/output, Bash command, or file path:
  D7 receives only canonical SHA-256 input/path identities, within-message block order, an owner message id,
  result bytes, and `OK | ERROR | TEST_FAIL`. The test-command classifier is stored as a boolean only. Existing
  synthetic `local_command` markers remain an explicit exception: `/clear` and `/compact` are persisted in the
  legacy `tool_events.input_hash` field for session-hygiene detection.
- **Pricing:** each turn priced against the freshest non-stale snapshot for its model tier; no snapshot ⇒ `cost_equiv_u = NULL` (tokens still counted); stale ⇒ `cost_claim = LIST_EQUIV_STALE`.
- **Parser versioning:** `parser_version` on every row; unknown fields ignored; a line that fails JSON parse or lacks required fields ⇒ `ingest_quarantine` pointer (file, line, error class — no content).

### 1.3 Incremental tail and live sessions

- Per-file byte offset persisted in a SQLite `ingest_offsets` table (source: G-09, ADR-102 F1); only complete lines consumed; a partial trailing line waits for the next pass.
- Rotation/truncation detected via head-hash + size regression ⇒ offset reset + safe re-scan (idempotent by dedupe). Rotation-with-smaller-replacement: if the replacement file is smaller than the stored offset AND the head-hash differs, treat as rotation (reset offset) rather than truncation of the same file (source: G-10, ADR-102 F2).
- Session `LIVE` while `last_turn_at` within the activity window (default 5 min); close ⇒ `RECONCILED`: final aggregates computed, provisional flags cleared, hygiene flags evaluated (`LONG_FULL_CONTEXT`: > N turns above X context tokens; `COMPACT_MID_TASK`: compact event between tool-activity bursts).
- Tail poll cadence (byte-offset advance check per active file, default 2 s) is distinct from file-discovery poll cadence (new-slug / new-JSONL scan, default 30 s) (source: G-11, ADR-102 F3).
- Concurrent JSONL sessions are tailed in parallel (one loop per active file); lines within a single file are consumed serially in order; no cross-file ordering assumptions (per-row timestamps with monotonic guards; anomalies → parser health) (source: G-12, ADR-102 F4).
- Upgrades do not delete offsets or silently replay historical transcripts. D7 metadata is forward-only by
  default; an explicit operator-controlled replay can enrich existing event rows idempotently.

### 1.4 Parser health (first-class metric)

`files_seen / files_parsed / lines_quarantined / synthetic_excluded / unknown_field_kinds / parser_version mix / duplicate_drops` (within-file duplicate assistant records — source: G-08) — surfaced in Settings. Drift in any of these is the early-warning that a Claude Code update changed the schema (NFR-106).

## 2. Workspace mapping

`project_slug → repo_path → owner/repo` set at registration (auto-suggested by reading the checkout's `origin`; normalized per the v4.4.x rules — canonical host/owner/repo, case rules). Remote change re-prompts mapping confirmation. Unmapped workspaces show spend only, flagged "outcomes unavailable — map repository."

## 3. Outcome linkage

### 3.1 SHA harvesting

Sources: (1) `pr-link` records (`prNumber`, `prRepository`, `prUrl`) emitted directly by the agent — PRIMARY linkage source (source: G-04); (2) `tool_events.commit_sha` scoped to git push/commit Bash results only — `git log --format=%H` history is excluded (caused ~20% precision loss — source: SG-03). Sessions accumulate a SHA set.

### 3.2 Link algorithm

```text
candidate PRs = synced PRs for the workspace's repo (or multiple repos if session pr-links to >1 — source: SG-05)
link(session, PR) if session has a pr-link record matching PR       (method=PR_LINK, conf=1.0 — PRIMARY — source: G-04)
else if session.SHA_set ∩ PR.commit_SHAs ≠ ∅                       (method=SHA_OVERLAP, conf=f(|∩|))
else if session's active branch (from tool metadata) == PR.head    (method=BRANCH, lower conf — currently unimplemented; improvement path to ≥80% — source: SG-02 / FW-02)
ambiguous (multiple PRs, weak signals) → no link (UNLINKED)        — honesty over guessing
manual link/unlink in session detail                               (method=MANUAL, conf=1.0)
```

Linkage-rate denominator: sessions with ≥1 Bash call (source: SG-01 / FW-01). Linkage rate displayed per workspace (FR-OUTCOME-101). Spike S3 measures accuracy on the past month's real history; target ≥80% linked with ≥95% link precision before outcome metrics drop an `EXPERIMENTAL` tag.

### 3.3 GitHub sync

Poll (default 10 min; on-demand refresh): PRs updated since watermark; per PR — state, head/merge SHAs, check runs for the final commit, review threads with `isResolved`, body text (parsed in-memory for deferral sections; not stored), diff (scanned in-memory for added TODO/FIXME; file:line anchors stored). Conditional requests/ETags; rate-limit budget shown in Settings. Note: the `BRANCH` linkage method (§3.2) depends on syncing PR head branch names and is currently unimplemented; implementing it is the primary path to reach ≥80% linkage (current coverage: 73%) (source: SG-02 / FW-02).

### 3.4 Outcome derivation (pure function, versioned)

```text
MERGED + checks SUCCESS|NONE + no DEFERRED findings → OBSERVED_SUCCESS
MERGED + checks SUCCESS|NONE + ≥1 DEFERRED          → OBSERVED_SUCCESS_WITH_DEFERRALS
CLOSED unmerged                                      → OBSERVED_FAILURE
OPEN, checks FAILURE, inactive > :abandon_window     → OBSERVED_FAILURE
OPEN otherwise                                       → IN_PROGRESS
```

`checks NONE` (no CI configured) is allowed but recorded — the success is labeled "no checks" in qualification. Never derived from transcript self-report (FR-OUTCOME-102).

**Post-processing pass (S3 harvest, PROVISIONAL, EXPERIMENTAL — source: FW-11):** A post-processing pass writes `observed_outcomes` from the S3 outcome harvest using the derivation above; this enables a PROVISIONAL, EXPERIMENTAL session success-rate for the linked cohort with no new fetch. Linkage coverage is 73% — unlinked sessions are excluded from this rate; this limitation must be disclosed at every metric surface where the rate is shown.

## 4. Findings extraction (deterministic, MVP)

### 4.1 Extractors

**E1 — Unresolved threads (primary).** Review threads on the PR: unresolved at merge ⇒ `DEFERRED`; resolved before merge ⇒ `ADDRESSED`. Evidence = thread id. Severity: `UNKNOWN` (thread labels/keywords may map HIGH/MEDIUM later — not in v1).

**E2 — Deferral sections.** PR body headings matching `(?i)^#{1,4}\s*(deferred|follow[- ]?ups?|known issues|out of scope)\b`; each list item beneath ⇒ one `DEFERRED` finding. Evidence = body anchor (heading + item index). Body text parsed in-memory only.

**E3 — Diff markers.** Added lines matching `\b(TODO|FIXME)\b` in the PR diff ⇒ `DEFERRED`, severity `LOW`. Evidence = `file:line@commit`. Excludes vendored paths and lockfiles (configurable ignore globs).

Each finding: `source`, `extractor_version`, `evidence_ref`, `raised_at = merge time (E1/E2) | commit time (E3)`.

### 4.2 Clearance

- E1: thread later resolved ⇒ cleared (`cleared_by` = resolving comment's commit if referenced, else work item of resolution).
- E3: a later commit removing the marker line ⇒ cleared by that SHA.
- E2: cleared manually or by a linked follow-up PR merge referencing the item (v1: manual + `Fixes #`-style reference detection).
- Clearance latency = `cleared_at − raised_at`; open findings age from `raised_at`.

### 4.3 Precision gate (Spike S4)

20-PR manual audit; per-extractor precision target ≥0.8. Below target ⇒ that extractor ships flagged `EXPERIMENTAL` and its findings are excluded from deferral-rate denominators until fixed. Recall is reported but not gated in MVP (missed findings understate debt — stated in qualification).

### 4.4 LLM extraction seam (P0.5, not built)

`FindingsExtractor` accepts additional extractors emitting `source='LLM'` with `confidence` and mandatory `human_state` confirm/reject before metric inclusion (encoded in the v2 schema now). Candidate inputs: review-comment prose, agent deferral statements in transcripts. Promotion requires an ADR + measured deterministic-coverage gap.

## 5. Test cases

**Ingestion:** duplicate replay no-op; partial line completes next pass; rotation re-scan equality; unknown field tolerated; bad JSON quarantined with pointer only; synthetic excluded; 5m/1h cache-write split priced distinctly; provisional→reconciled transition; rebuild equality.  
**Linkage:** seeded repo with 3 sessions × 2 PRs → correct links; SHA in two PRs → UNLINKED; manual override persists; branch-method lower confidence recorded.  
**Outcomes:** all five derivation branches incl. `checks NONE` labeling and abandon-window failure.  
**Findings:** fixture PRs for E1/E2/E3 incl. resolved-pre-merge ⇒ ADDRESSED; TODO in vendored path ignored; marker-removal clearance; deferral-rate excludes `EXPERIMENTAL` extractors; LLM finding without `CONFIRMED` never enters metrics.

## Change log

- 2026-08-21 (Session 12): §1.2 — added `session_id` as accepted alias for `sessionId`; parser prefers `session_id` when both present — source: G-01
- 2026-08-21 (Session 12): §1.2 — specified `type=system subtype=local_command` and `away_summary` record types, and their population path into `sessions.hygiene_flags` (also covers FW-09 path) — source: G-02 / FW-09
- 2026-08-21 (Session 12): §3.1 / §3.2 — added `pr-link` record (`prNumber`, `prRepository`, `prUrl`) as PRIMARY linkage source — source: G-04
- 2026-08-21 (Session 12): §1.2 — added `effort` as known optional field (present post-2026-08-14) — source: G-06
- 2026-08-21 (Session 12): §1.2 — specified `tool_result_bytes` = SUM of all tool_result blocks in a turn — source: G-07
- 2026-08-21 (Session 12): §1.4 — added `duplicate_drops` named health stat (within-file duplicate assistant records) — source: G-08
- 2026-08-21 (Session 12): §1.3 — (a) `ingest_offsets` persistence format = SQLite table (G-09 / ADR-102 F1); (b) rotation-with-smaller-replacement-file detection case (G-10 / ADR-102 F2); (c) tail poll cadence distinct from file-discovery poll cadence (G-11 / ADR-102 F3); (d) serial within-file / parallel cross-file tail ordering (G-12 / ADR-102 F4) — source: G-09, G-10, G-11, G-12
- 2026-08-21 (Session 12): §3.2 — defined linkage-rate denominator as sessions with ≥1 Bash call — source: SG-01 / FW-01
- 2026-08-21 (Session 12): §3.1 — narrowed SHA extraction to git push/commit Bash results; excluded git-log history (~20% precision loss) — source: SG-03
- 2026-08-21 (Session 12): §3.2 — specified multi-repo session handling (session may pr-link to multiple repos) — source: SG-05
- 2026-08-21 (Session 12): §3.4 — added outcome-derivation post-processing pass (S3 harvest → `observed_outcomes`), PROVISIONAL EXPERIMENTAL success-rate, 73% linkage coverage disclosure — source: FW-11
- 2026-08-21 (Session 12): §3.2 / §3.3 — noted `BRANCH` method is currently unimplemented; improvement path to ≥80% linkage (current: 73%) — source: SG-02 / FW-02
