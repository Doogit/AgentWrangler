# AgentWrangler — Technical Architecture v4.5.1

**Status:** Draft — scope-pivot architecture  
**Date:** 2026-08-21  
**Companion product document:** `AgentWrangler_PRD_v0_7_0.md`  
**Companion design documents:** `AgentWrangler_Ingestion_and_Findings_Spec_v1.md`, `AgentWrangler_Recommendations_Engine_Spec_v1.md`, `AgentWrangler_Data_Model_and_Metrics_v2.md`  
**Preserved governance architecture (now P1):** Technical Architecture v4.4.3  
**Architecture objective:** Implement a trustworthy local observation-and-recommendation loop over unmanaged Claude Code usage, with zero enforcement machinery and content-minimizing storage.

---

# 0. Executive summary

v4.5 replaces the v4.4.x control-plane topology with an **observation pipeline**:

```text
~/.claude/projects/**/<session>.jsonl   (unmanaged, live)
        ↓ incremental tail + dedupe + versioned parser
TranscriptIngestor → SQLite (derived metadata only)
        ↓                         ↑
OutcomeLinker ←── git / GitHub API (read-only)
FindingsExtractor (deterministic)
ContextInventoryProbe (always-loaded file attribution)
        ↓
DetectorEngine (Tier 1 rules, every ingest pass)
ClaudeAnalyzer (Tier 2, button/scheduled, evidence pack → structured proposals)
        ↓
LocalQueryAPI (versioned metric contract)
        ↓
Dashboard: Global → Workspace → Session (+ Recommendations, Settings)
```

Nothing in this topology intercepts, blocks, launches, or modifies agent behavior. The v4.4.3 control plane (Cedar Stage A, SandboxProvider, ModelAdmission, budget ledger, managed execution, verifier sandbox) is **preserved unmodified as the P1 architecture** and is not partially implemented here.

## 0.1 Architectural thesis

AgentWrangler MVP permanently owns:

- transcript-derived **truth about spend** (dedupe, pricing versioning, live vs reconciled);
- **outcome and deferral semantics** over provider-side evidence;
- the **metric definition contract** (versioned denominators, qualification, drill-down);
- **recommendation semantics**: evidence citations, provenance, modeled-vs-measured separation, adoption→effect measurement;
- privacy discipline: **derived metadata only** in storage and in analysis inputs.

AgentWrangler MVP does **not** own: transcript file formats (Anthropic's, tolerated defensively), tokenizers, Git/GitHub mechanics, SQLite, charting, or any enforcement primitive.

## 0.2 Component strategy at a glance

| Capability | Strategy | Reuse | Owned layer |
|---|---|---|---|
| Transcript ingestion | custom, small | JSONL streaming; logic from the proven `analyze.mjs`/`sessions.mjs` | dedupe, parser versioning, quarantine, incremental tail, live detection |
| Pricing | custom table + snapshots | published list prices | snapshot versioning, staleness labels |
| Outcome linkage | thin custom | git CLI/lib, GitHub REST/GraphQL | linkage algorithm, outcome states, linkage-rate honesty |
| Findings | custom deterministic rules | GitHub review-thread state, diffs | finding states, clearance tracking |
| Context inventory | thin custom | OSS tokenizer | attribution model (always-loaded vs tool results vs conversation) |
| Detectors | custom registry | — | versioned predicates, modeled-savings formulas, effect definitions |
| Tier 2 analysis | thin custom | Anthropic API / Agent SDK | evidence pack, output contract validation, provenance, cost metering |
| Storage/analytics | commodity | SQLite WAL, direct SQL | schema + metric contract (v2 data model doc) |
| Dashboard | custom UI | standard web/desktop libs | hierarchy, traceability, truthful labeling |
| Enforcement | **absent** | — | P1 (v4.4.3) |

---

# 1. PRD v0.7 traceability

| PRD requirement | Architecture owner |
|---|---|
| G-1 onboarding | installer + first back-scan pipeline |
| G-2 spend attribution | `TranscriptIngestor` + `PricingSnapshotStore` + schema §(data model v2) |
| G-3 live burn | live tail + mtime activity detection + `BurnForecaster` |
| G-4 outcome linkage | `OutcomeLinker` |
| G-5 deferral debt | `FindingsExtractor` + clearance tracker |
| G-6 recommendations loop | `DetectorEngine` + `RecommendationStore` + `EffectMeasurer` |
| G-7 Claude analysis | `ClaudeAnalyzer` + evidence-pack builder + contract validator |
| G-8 privacy | ingestion projection rules (SEC-101/104) enforced at write time |
| FR-INGEST-* | `TranscriptIngestor` |
| FR-OUTCOME-1xx | `OutcomeLinker`, `FindingsExtractor` |
| FR-METRIC-1xx / FR-UI-1xx | `LocalQueryAPI` + dashboard |
| FR-REC-1xx | recommendation subsystem |

No MVP component exists solely to satisfy a P1 requirement.

---

# 2. Process topology

```text
AgentWrangler Desktop (UI)
        │ local IPC / loopback
        ▼
AgentWrangler Daemon
  ├─ TranscriptIngestor (tailer + back-scan)
  ├─ PricingSnapshotStore
  ├─ WorkspaceRegistry (slug ↔ repo identity)
  ├─ OutcomeLinker (git + GitHub sync)
  ├─ FindingsExtractor
  ├─ ContextInventoryProbe
  ├─ DetectorEngine
  ├─ ClaudeAnalyzer (on demand)
  ├─ BurnForecaster
  ├─ EffectMeasurer
  └─ LocalQueryAPI
        │
        ├── SQLite (WAL, derived metadata only)
        ├── OS credential vault (GitHub read-only token; Anthropic key for Tier 2)
        ├── read-only: ~/.claude/projects/**  and registered git repos
        └── network: GitHub API · Anthropic API (Tier 2 only) · pricing refresh (optional)
```

One daemon, one SQLite DB, no workers, no queues, no cloud — the v4.4.x process-count discipline carries over. The daemon requires only read access to transcript and repo paths (SEC-102).

---

# 3. Ingestion pipeline

Detailed spec: `AgentWrangler_Ingestion_and_Findings_Spec_v1.md`. Architectural properties:

- **Incremental tail per file** with byte offsets persisted; partial trailing lines held until complete; mtime-scan discovery of new sessions/workspaces. Concurrent sessions are concurrent tails.
- **Dedupe key** `message.id` (fallback `uuid`) — re-ingestion is idempotent (NFR-107).
- **Versioned parser**: `parser_version` recorded per row; unknown fields ignored; unparseable lines quarantined with file/line pointer and error class, never content (SEC-107). A Claude Code schema change degrades gracefully and visibly, never silently zeroes metrics.
- **Projection at write time**: only usage numbers, model, timestamps, ids, sizes (content lengths), tool names, subagent/sidechain markers, command events, and commit SHAs are persisted. Prompt/response text never crosses into the DB (SEC-101 enforced structurally — the row types have no content columns).
- **Live vs reconciled**: rows from an active session are marked provisional; session close (inactivity or summary record) triggers reconciliation and final session aggregates (FR-METRIC-104).
- Synthetic/empty-model records excluded from cost attribution, counted separately (matches the review's method).

---

# 4. Outcome linkage

- `WorkspaceRegistry` maps `~/.claude/projects/<slug>` → local repo path → canonical `owner/repo` (normalized as in v4.4.x §7.2).
- Commit SHAs are harvested from transcript tool events (git commands/results metadata) and local `git log`; a session links to a PR when its SHAs intersect the PR's commits, with cwd/repo as a precondition. Confidence recorded per link; ambiguous links surface as `UNLINKED` rather than guessed (FR-UI-102 spirit).
- GitHub sync is polling-based (configurable interval; default 10 min) over: PRs touching linked branches, check conclusions for final commits, review threads with resolution state, PR bodies and diffs (for findings). Read-only token; ETag/conditional requests for rate-limit hygiene.
- Outcome derivation (`OBSERVED_*` states) is a pure function of synced provider evidence + linkage — never transcript self-report (FR-OUTCOME-102), preserving the v0.6.x claim-vs-evidence separation in observation-only form.

---

# 5. Findings extraction (deterministic)

Three extractors, each versioned, each emitting `review_findings` rows with source + evidence pointers:

1. **Thread extractor**: review threads unresolved at merge ⇒ `DEFERRED`; resolved pre-merge ⇒ `ADDRESSED`.
2. **Deferral-section extractor**: PR-body headings (`Deferred|Follow-up|Known issues`, case-insensitive) → list items ⇒ `DEFERRED`.
3. **Diff-marker extractor**: `TODO|FIXME` lines added by the PR diff ⇒ `DEFERRED` (low severity default).

Clearance: a later commit/PR that resolves the thread or removes the marker clears the finding and records latency. Extractor precision is validated in Spike S4 against a manual 20-PR audit before the deferral metrics are labeled non-experimental. LLM extraction is a P0.5 seam (`FindingsExtractor` interface accepts additional extractors with `extraction_kind = LLM`, confidence, and human confirm/reject state) — no MVP implementation.

---

# 6. Detector engine (Tier 1)

- Registry of versioned detectors; each declares: `detector_id`, trigger predicate (SQL/expression over the metric layer), evidence fields, modeled-savings formula, adoption signal, measured-effect definition (target metric + windows), cool-down.
- Runs after each ingest/sync pass; emits/updates `recommendations` rows with `provenance = RULE`.
- Initial registry (from the 2026-08-21 review): `CTX_ALWAYS_LOADED_OVERSIZE`, `SESSION_LONG_FULL_CONTEXT`, `ROUTING_NON_ADHERENCE`, `CACHE_WRITE_CHURN`, `LIMIT_BURN_FORECAST`, `TOOL_RESULT_BLOAT`, `LOOP_RETRY_WASTE`. Definitions in the Recommendations spec.
- Detectors are read-only over the DB; they never mutate metrics.

---

# 7. ClaudeAnalyzer (Tier 2)

- **EvidencePackBuilder**: compiles scope-filtered aggregates, detector hits, top-N outlier sessions, context composition into a canonical JSON pack (target ≤ 20 KB); pack hash stored. Content excluded by default; explicit per-run opt-in is logged (SEC-104).
- **Runner**: one Anthropic API call (configured cheap model) with a versioned prompt template; optional later evolution to a short Agent SDK run with a single read-only LocalQueryAPI drill-down tool — a deliberately low-stakes reuse of the shelved headless-execution design, read-only and unprivileged.
- **ContractValidator**: output must parse against the proposal JSON schema; every evidence citation (metric ids, values-at-time, session/workspace ids) must resolve against the DB within tolerance; failures reject or flag the proposal (FR-REC-101). This is the observation-layer analogue of "agent claim is evidence, not ground truth."
- **Metering**: the analysis run is recorded like any session (tokens, cost-equivalent, model) and its cost displayed with its output (FR-REC-103). A per-run and monthly Tier 2 spend cap lives in Settings.
- Scheduling: optional weekly run producing a stored markdown report artifact reproducing the ad-hoc review's structure.

---

# 8. Context inventory probe

- Tokenizes always-loaded inputs per workspace: `CLAUDE.md` (+ imports), rules files, active MCP tool schemas, settings-injected system content where locally reconstructable.
- Attributes the per-turn context baseline: `always_loaded + tool_results (sizes from transcript) + conversation (residual)`. Attribution method and its error bars are fixed in Spike S5 and versioned; until validated, composition figures carry an `ESTIMATED` label (FR-UI-102).
- **v1 attribution limit:** system-prompt tokens injected by the Claude Code harness and MCP-schema tokens (~1–3% of context) are not locally reconstructable and are therefore NOT attributable from local files in v1; the displayed attribution total may undercount by this margin.
- Re-probes on file change (hash-triggered), producing a time series that the CLAUDE.md-trim detector and effect measurement consume.

---

# 9. Storage

SQLite WAL, single DB outside any repo; schema and metric SQL in `AgentWrangler_Data_Model_and_Metrics_v2.md`. Carried rules: direct SQL, no rollup workers until measured need (AD-009 lineage); foreign keys on; deterministic rebuild from sources (NFR-107); micro-USD integers; `metric_definition_version` on aggregates; money rows carry claim labels (`LIST_EQUIV`/`BILLED`).

---

# 10. LocalQueryAPI and dashboard

```text
getGlobalOverview(filters)
listWorkspaces(filters) / getWorkspace(id)
listSessions(workspace_id, filters, cursor) / getSession(session_id)
getTurnTimeline(session_id, cursor)
listRecommendations(filters) / getRecommendation(id)
runAnalysis(scope, options)        // Tier 2 trigger
adoptRecommendation(id) / dismissRecommendation(id)
getSettings() / updateSettings(...)
```

- The API owns denominators and qualification (UI never issues SQL) — unchanged v4.4.x rule.
- Hierarchy contract: every global aggregate resolves to workspace members; workspace → sessions; session → turns (FR-UI-103).
- Live strip: sessions with transcript mtime within the activity window, running provisional cost, current context size.
- **Burn-forecast display:** the weekly-limit forecast carries a `PROXY` label — subscription utilization is tracked in internal units and the total-token figure derived from the JSONL is approximate, not authoritative. `:limit_tokens` is a USER-CONFIGURED proxy value; there is no local quota-remaining signal in the JSONL itself. Browser-assisted sync (reading the limit from the Claude.ai UI) is flagged as a future option.
- Surfaces: Overview / Workspaces / Recommendations / Settings per PRD §11.

---

# 11. Security and privacy

- Derived-metadata-only storage is enforced at the type level: ingestion row schemas have no content fields; code review + a test asserting no content-bearing column exists (SEC-101).
- Credentials: GitHub read-only token and Anthropic key in OS vault, opaque references in DB (SEC-103); Tier 2 disabled until a key is connected.
- Egress allowlist is explicit and shown in Settings: GitHub API, Anthropic API (Tier 2), optional pricing refresh (SEC-106).
- The daemon binds loopback/user-local IPC only; destructive actions (DB reset) require confirmation. No admin-vs-agent IPC split exists because there is no managed agent.
- Quarantine stores pointers, not content (SEC-107).

---

# 12. Degraded / failure behavior

| Failure | MVP behavior |
|---|---|
| Transcript schema drift / parse errors | quarantine lines with pointers; surface parser-health metric; never silently zero aggregates |
| Transcript file rotated/truncated | offset invalidation → safe re-scan of that file (dedupe makes it idempotent) |
| Pricing snapshot stale | cost labels downgrade (`LIST_EQUIV, STALE_PRICING`); token metrics unaffected |
| GitHub unavailable / rate-limited | outcomes/findings go stale with a staleness banner; spend metrics unaffected |
| GitHub token revoked | outcome features disabled with explicit state; no crash of spend pipeline |
| Anthropic API failure during Tier 2 | run fails visibly with cost-so-far; Tier 1 unaffected |
| Contract validation fails on Tier 2 output | proposals rejected/flagged; raw output retained for inspection, not displayed as recommendations |
| SQLite write failure | ingestion pauses and alerts; source files are untouched, so recovery is re-scan |
| Clock skew across files | per-row timestamps trusted with monotonic guards; anomalies flagged in parser health |

---

# 13. Threat model (MVP)

The MVP's threats are to **honesty of numbers** and **privacy**, not containment:

1. double counting (repeated lines, re-scans) → message-id dedupe, idempotent ingestion;
2. silent undercounting (schema drift, skipped files) → parser health metric, quarantine visibility, coverage stats (files seen vs parsed);
3. misattribution (wrong workspace/PR linkage) → confidence-scored links, `UNLINKED` honesty, displayed linkage rate;
4. stale pricing presented as precise → claim labels + staleness downgrade;
5. content leakage into DB / evidence packs / logs → structural projection, SEC-101/104/107 tests;
6. Tier 2 fabrication (plausible prose without basis) → citation resolution, modeled-vs-measured separation, provenance;
7. gamed observed success (agent weakens tests/CI) → **acknowledged residual**, labeled in-product; the P1 verifier-integrity layer is the mitigation;
8. GitHub token over-scope → read-only fine-grained token, scope checked at connect;
9. malicious/compromised transcript content influencing Tier 2 via the evidence pack → packs contain derived numbers/ids only by default, and Tier 2 output is validated data, never executed instructions.

Root/host-admin compromise remains out of scope, as in v4.4.x.

---

# 14. Test corpus

**Ingestion:** duplicate-line replay; interleaved concurrent-session writes; partial trailing line; rotated file; unknown fields; unparseable line quarantined; synthetic-model exclusion; rebuild-equality (NFR-107); back-scan at reference scale within NFR-104.  
**Pricing/cost:** snapshot versioning; stale downgrade; 5m vs 1h cache-write pricing split; LIST_EQUIV/BILLED never summed.  
**Linkage/outcomes:** SHA-overlap linkage on a seeded repo; ambiguous link → UNLINKED; outcome states across merge/close/CI permutations; linkage-rate computation.  
**Findings:** the three extractors against fixture PRs (threads, deferral sections, TODO diffs); clearance + latency; the S4 precision audit harness.  
**Detectors/recommendations:** each detector's predicate on fixture data; cool-down; adoption → effect windows; modeled never counted as achieved.  
**Tier 2:** contract-valid output accepted; unresolvable citation rejected; cost metering; content-exclusion default (pack contains no content fields); spend cap honored.  
**Dashboard:** aggregate↔row reconciliation at all three hierarchy levels; live vs reconciled labeling; N/A rendering.

---

# 15. Performance targets

```text
new turn → live view:            ≤ 60 s (NFR-103)
active-session detection:        mtime window ≈ 5 min
initial back-scan (ref. scale):  minutes (NFR-104)
dashboard query p95:             ≤ 250 ms (NFR-105)
GitHub sync cadence:             10 min default, on-demand refresh
Tier 2 run:                      interactive (≤ ~60 s), cost displayed
```

Direct SQL until these targets fail at measured volume — no pre-emptive rollups.

---

# 16. Implementation stack

The v4.4.x Rust-vs-Go decision rule was driven by Cedar embedding and nono FFI — both now P1. MVP drivers are: JSONL streaming, GitHub API, tokenizers, desktop UI, and reuse of the proven Node analysis scripts. **Presumptive stack: TypeScript/Node daemon + better-sqlite3 + a lightweight desktop shell (Tauri preferred for footprint; Electron acceptable), UI on standard web charting/table libs.** Spike S0 is a 1-day ADR confirming this (or documenting a deviation), explicitly noting that a later P1 governance daemon may be a separate process/language without disturbing the MVP — the SQLite schema and LocalQueryAPI are the stable seams.

---

# 17. Development sequence

**Phase 0 — spikes (see Spike Plan v2):** S0 stack ADR; S1 transcript fidelity; S2 live tail; S3 linkage accuracy; S4 findings precision; S5 context attribution; S6 Tier 2 contract; S7 limit observability. Critical path ≈ 2–3 weeks, parallelizable.  
**Phase 1 — MVP vertical slice:** ingestion + pricing + spend views (global/workspace/session) → live strip + burn forecast → outcome linkage + findings → detectors → Tier 2 → effect measurement. Ship spend visibility first; it is independently useful on day one.  
**Phase 2 — P0.5 evidence-gated:** LLM findings extraction, billing integration, adherence heuristic v2.  
**Phase 3 — P1 Govern:** promote v4.4.3 by ADR citing Observe-era evidence.

---

# 18. Architecture decisions

**AD-101 — Observation only.** No MVP component intercepts or modifies agent behavior; enforcement is structurally absent, not disabled.  
**AD-102 — Transcripts are the source of truth for spend; provider evidence for outcomes.** Agent self-report is never an outcome input.  
**AD-103 — Derived-metadata-only storage.** Content cannot enter the DB by construction; evidence packs inherit the same projection.  
**AD-104 — Versioned tolerant parser.** Transcript schema is external and unstable; parser version per row, quarantine over silent loss.  
**AD-105 — Two-tier recommendations.** Deterministic detectors continuously; Claude analysis on demand with contract validation, provenance, and metered cost.  
**AD-106 — Modeled vs measured separation.** Projected savings are never presented or aggregated as achieved savings; adoption triggers automatic effect measurement.  
**AD-107 — SQLite + direct SQL, single daemon.** Rollups/workers only on measured need (AD-009 lineage).  
**AD-108 — Deferral debt is orthogonal to success.** Success denominators stay honest; deferrals are a mandatory adjacent dimension (clean vs with-deferrals).  
**AD-109 — Governance preserved, not diluted.** v4.4.3 is the P1 architecture verbatim; no MVP half-implementations of its components.  
**AD-110 — Stack chosen by MVP constraints.** TS/Node presumptive (S0 ADR); the P1 daemon may differ; SQLite schema + LocalQueryAPI are the stable seams.

---

# 19. What is preserved for P1 (Govern)

Unchanged and ready: Cedar policy draft + Stage A semantics; SandboxProvider selection plan (nono vs Anthropic Sandbox Runtime); ModelAdmission + budget-ledger invariants; managed headless execution design (Agent Interaction Design v1); consequential-action spec; verifier-integrity + verifier-sandbox design; the v4.4.3 threat model and test corpus. Observe-era data that will feed Govern: verified task history for router benchmarking, adherence data for routing defaults, deferral data for Outcome Contract templates.

---

# 20. Decision / change log — Technical Architecture v4.4.3 → v4.5.0

**Date:** 2026-08-21  
**Review type:** Operator-directed scope pivot

1. **Topology replaced: control plane → observation pipeline — ACCEPTED.** Removed from MVP: SandboxProvider, CedarPolicyAdapter, ModelAdmission/BudgetLedger, GitHubActionCoordinator, VerifierCoordinator/verifier sandbox, Containment, managed runtime, Task Plan machinery. Added: TranscriptIngestor, OutcomeLinker, FindingsExtractor, ContextInventoryProbe, DetectorEngine, ClaudeAnalyzer, BurnForecaster, EffectMeasurer. Process count remains one daemon + UI + SQLite.
2. **v4.4.3 preserved verbatim as the P1 architecture — ACCEPTED (AD-109).** No component is partially implemented in MVP.
3. **Ingestion contract defined — ACCEPTED (§3, AD-104).** Idempotent dedupe by message id, per-row parser versioning, quarantine with pointers, live-vs-reconciled row states, structural content exclusion.
4. **Outcome/finding derivation bound to provider evidence — ACCEPTED (§4–5, AD-102).** Deterministic extractors with a precision gate (S4) before deferral metrics drop their experimental label.
5. **Recommendation subsystem specified — ACCEPTED (§6–7, AD-105/106).** Detector registry; Tier 2 evidence packs, contract validation with citation resolution, provenance, metered cost, adoption→effect measurement.
6. **Threat model recast to honesty-of-numbers + privacy — ACCEPTED (§13).** Gamed observed success acknowledged as residual with the P1 layer as mitigation.
7. **Stack decision reopened and re-scoped — ACCEPTED (§16, AD-110).** TS/Node presumptive via S0 ADR; SQLite schema and LocalQueryAPI designated the stable seams for a possibly-different P1 daemon.
8. **Carried forward unchanged:** metric-definition versioning, direct-SQL analytics discipline, drill-down traceability, truthful labeling, content-off-by-default, no-counterfactual-savings rule, single-DB/no-worker process discipline.

---

# 21. Decision / change log — Technical Architecture v4.5.0 → v4.5.1

**Date:** 2026-08-21  
**Review type:** Session 12 spec patches

- 2026-08-21 (Session 12): Bumped version title to v4.5.1.
- 2026-08-21 (Session 12): §8 — added v1 attribution limit note: system-prompt + MCP-schema tokens (~1–3% of context) are not attributable from local files; displayed attribution total may undercount — source: FW-04 / SG-S5-03
- 2026-08-21 (Session 12): §10 — burn-forecast display must carry a `PROXY` label; subscription utilization is internal units and the total-token figure is approximate — source: SG-07-02
- 2026-08-21 (Session 12): §10 — noted that `:limit_tokens` is a USER-CONFIGURED proxy; no local quota/remaining signal exists in the JSONL; browser-assisted sync flagged as a future option — source: SG-07-01
