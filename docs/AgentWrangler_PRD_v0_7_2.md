# AgentWrangler — Product Requirements Document v0.7.2

**Status:** Draft — economics-reconciliation revision  
**Date:** 2026-08-25 (v0.7.2); pivot 2026-08-21 (v0.7.0/v0.7.1)  
**Companion documents:** `AgentWrangler_Technical_Architecture_v4_5_0.md`, `AgentWrangler_Ingestion_and_Findings_Spec_v1.md`, `AgentWrangler_Recommendations_Engine_Spec_v1.md`, `AgentWrangler_Data_Model_and_Metrics_v2.md`  
**Implementation:** tracked in internal build plans (phased roadmap, detector-engine work package, outcomes/findings plan); see the [Recommendations Engine overview](./recommendations-engine-overview.md) for the public summary.  
**Preserved governance specification (now P1):** PRD v0.6.3 + Technical Architecture v4.4.3  
**Product type:** Open-source, local-first AI-agent **observability and spend-effectiveness** tool  
**Primary MVP principle:** Prove that trustworthy visibility plus evidence-backed recommendations can reduce token spend **without reducing observed task success** — before building any control plane.

> **v0.7.2 note.** This revision reconciles the PRD with the project's build plans and the 2026 research passes. The load-bearing correction: **rate-limit headroom, not raw token count, is the resource to optimize** — cache reads draw against the weekly cap at the *cached* rate (~0.1×), so savings are valued cap-weighted, not at full token weight. See §9.1a, §10.1, and the §20 change log.

---

## 1. Product summary

AgentWrangler MVP (the **Observe** release) watches the user's normal, interactive Claude Code usage across all local workspaces and answers three questions:

1. **What is my agent usage costing**, live and over time, by workspace / session / model / turn?
2. **Is the work actually succeeding** — including work the agent created but deferred?
3. **What specific, evidence-backed changes would cut spend without cutting success — and did they work after I adopted them?**

### MVP product promise

> **Run Claude Code exactly as you do today. AgentWrangler shows spend and burn across every workspace, links sessions to observed outcomes (merged PRs, CI, review debt), and produces recommendations whose impact is measured, not asserted.**

### Product principles (carried forward from v0.6.x)

- **Evidence over assertion.** Every number has a versioned definition, an explicit denominator, and drill-down to its contributing rows.
- **Truthful claims.** Costs computed from transcripts are labeled **cost-equivalent (API list price)**, never "billed," unless a billing source is connected. Observed outcomes are labeled *observed*, not enforced/verified — the MVP has no verifier-integrity control (that is the P1 governance layer).
- **Modeled vs measured.** A recommendation's projected savings are *modeled*; only post-adoption deltas are *measured*. The two are never mixed.
- **Observation only.** The MVP never blocks, routes, sandboxes, or modifies agent behavior.

---

## 2. Why v0.7 pivots from v0.6.x

v0.6.x specified a control-and-evidence loop (sandbox, policy, model admission, managed execution, enforced verification). Operating experience reframed the highest-value first problem: in one observed week the operator hit their weekly usage limit several days early, and a one-off transcript analysis located the causes — the large majority of tokens were context cache re-reads, most spend went to a premium model contrary to the operator's own routing rule, oversized always-loaded context, and long full-context sessions. That analysis was ad-hoc; the product opportunity is making it continuous, trustworthy, and closed-loop.

The pivot inverts build order, not vision:

- **MVP (P0 "Observe"):** visibility + outcomes + recommendations over unmanaged interactive usage.
- **P1 "Govern":** the entire v0.6.3/v4.4.3 control loop (Cedar Stage A, sandbox runtime, ModelAdmission, budget enforcement, managed headless execution, verifier integrity), promoted only after Observe proves value. Those documents remain the P1 specification and are not rewritten.

What the pivot deliberately keeps from v0.6.x: metric-definition versioning, denominator contracts, failure/observability qualification, direct-SQL SQLite analytics, aggregate→row traceability, content-capture-off-by-default, and the "no counterfactual savings claims" rule.

### v0.7 scope rule

A feature belongs in the MVP only if it is required to prove one of these five claims:

1. AgentWrangler can **ingest local Claude Code transcripts accurately** across all workspaces (deduplicated, priced under versioned snapshots, incrementally, including live sessions).
2. AgentWrangler can **attribute spend truthfully** to workspace / session / model / turn and surface live burn and limit-exhaustion forecasts.
3. AgentWrangler can **link sessions to observed outcomes** (PR merge, CI status, review threads) and measure **deferred-work debt** without any enforcement machinery.
4. AgentWrangler can **produce recommendations with evidence citations** — deterministic detectors continuously, Claude-powered analysis on demand — and **measure their effect after adoption**.
5. AgentWrangler can show all of this in a **local dashboard** organized global → workspace → session with honest qualification and full drill-down.

---

## 3. Goals

**G-1 — Zero-behavior-change onboarding.** Install, point at `~/.claude/projects/`, connect a read-only GitHub credential, see data within minutes. No change to how the user runs Claude Code.  
**G-2 — Trustworthy spend attribution.** Deduplicated, pricing-snapshot-versioned token accounting by workspace, session, model, day, and turn, with the cache-read / cache-write / input / output split first-class.  
**G-3 — Live burn visibility.** Active sessions (typically a few workspaces, multiple sessions each) are visible with running cost, context size, and a weekly-limit burn forecast — the signal whose absence caused the early limit exhaustion.  
**G-4 — Observed outcome linkage.** Sessions link to work items (PRs) and to observed success/failure via merge state, CI on the final commit, and review-thread resolution.  
**G-5 — Deferred-work debt is measured.** A merged PR that carries unaddressed review findings is distinguished from a clean success and the deferral backlog is tracked with age.  
**G-6 — Evidence-backed recommendations with a measured loop.** Every recommendation carries category, lever, modeled savings, and resolvable evidence citations; adoption is tracked; post-adoption deltas are measured and displayed.  
**G-7 — Claude-in-the-loop analysis, on demand and honestly costed.** A dashboard action runs the ad-hoc analysis pattern (evidence pack → Claude → structured proposals) with the analysis's own cost displayed.  
**G-8 — Privacy by construction.** The metrics database stores derived metadata (counts, sizes, hashes, ids), never prompt/code content; evidence packs exclude content by default.

---

## 4. Non-goals for MVP

The MVP will **not**:

- enforce anything: no sandbox, no policy engine, no model admission, no budget enforcement, no managed/headless task execution, no containment (all P1, per v0.6.3/v4.4.3);
- route model changes, or apply *any* recommendation automatically — the MVP may *assist* an apply through the local CLI, but only as a dry-run → explicit-confirm → rollback job (§10.2); nothing lands without the user's per-change confirmation and nothing is auto-applied;
- claim billing-accurate dollar amounts without a billing source (figures are list-price equivalents; tokens are the currency of rate limits);
- claim enforcement-grade "verified" success (observed outcomes can be gamed by a misbehaving agent; verifier integrity is P1 and this limitation is documented in-product);
- capture or store prompt/code content in the metrics DB, or ship content to any cloud;
- implement LLM-based findings extraction from prose (deterministic sources only in MVP; LLM extraction is an evidence-gated P0.5/P1 candidate);
- support agents other than Claude Code (ingestion seam retained);
- provide cloud sync, remote dashboards, teams, SSO, or fleet features;
- run an always-on Claude analysis loop (Tier 2 is button-triggered or a scheduled weekly report at most).

---

## 5. Primary user and usage reality

Same persona as v0.6.x — solo AI-assisted developer — with the observed usage profile the design must serve:

- several workspaces active concurrently, multiple sessions per workspace, many thousands of assistant turns per week across 100+ sessions;
- interactive Claude Code (terminal/IDE), long sessions, heavy context caching (the large majority of tokens are cache reads at very high context/turn);
- subscription (rate-limited) billing, so **tokens ≈ quota**, and week-day burst patterns matter (spend heavily concentrated in a single day; the weekly limit exhausted several days early);
- an existing personal routing rule (CLAUDE.md: cheap models for search/extraction, premium for hard reasoning) that is **not being followed** (premium-model spend dominates) — adherence is therefore a measurable metric, not a hypothetical.

---

## 6. MVP reference scenario

```text
one developer
+ Claude Code used normally (interactive, unmanaged)
+ ~/.claude/projects/**/<session>.jsonl transcripts (primary source)
+ 2–3 registered workspaces mapped to GitHub repositories
+ read-only GitHub credential (PRs, checks, review threads)
+ context inventory probe over always-loaded files (CLAUDE.md, rules, MCP schemas)
+ local AgentWrangler dashboard: Global → Workspace → Session
+ on-demand "Analyze with Claude" using the user's existing Anthropic access
```

No managed runtime, no gateway, no enforcement boundary exists in the MVP path.

---

## 7. Data sources

| Source | Role | Notes |
|---|---|---|
| Claude Code transcripts (`~/.claude/projects/<slug>/<session>.jsonl`) | Primary: per-turn `message.usage` (input, output, cache_read, cache_creation incl. 5m/1h split), model, timestamps, session/workspace attribution, tool-call/result sizes, subagent markers | Schema is not a stable public contract → versioned parser, unknown-field tolerance, quarantine on parse failure (FR-INGEST-006) |
| Pricing snapshots | Convert tokens → cost-equivalent | Versioned; staleness downgrades cost observability labels |
| Git (local) | Session → commit linkage (cwd + commit SHAs) | read-only |
| GitHub API (read-only) | Work items (PRs), merge state, CI/check conclusions on final commit, review threads + resolution state, diff for TODO/FIXME detection | fine-grained read-only token in OS vault |
| Context inventory probe | Tokenized sizes of always-loaded files (CLAUDE.md, rules files, MCP tool schemas) to explain context composition | local read only |
| Billing source (optional, if available) | Upgrade cost labels from LIST_EQUIV to BILLED | Spike S7 investigates official usage/limit endpoints |

---

## 8. Observed outcomes and deferred findings

### 8.1 Work items and linkage

The **work item** (GitHub PR) is the primary outcome unit. Sessions link to work items many-to-many via cwd → repository and commit SHAs appearing in both transcript activity and PR history. Unlinkable sessions remain first-class (`UNLINKED`) and are surfaced, not hidden — linkage rate is itself a displayed quality metric.

### 8.2 Observed outcome states

- `OBSERVED_SUCCESS` — PR merged, required checks green on the final commit, all review threads resolved.
- `OBSERVED_SUCCESS_WITH_DEFERRALS` — merged and green, but ≥1 deferred finding (§8.3).
- `OBSERVED_FAILURE` — PR closed unmerged, or abandoned with failing checks (inactivity window, configurable).
- `IN_PROGRESS` — open PR.
- `UNLINKED` — session/work not attributable to a work item.

Naming is deliberate: **observed**, not verified. The MVP cannot detect verifier weakening; the dashboard states this limitation wherever success rates appear.

### 8.3 Deferred findings (review debt)

A finding is a discrete issue raised during review of a work item. MVP extraction is **deterministic only**:

1. **Unresolved review threads at merge** (GitHub-native resolved/unresolved state) — primary source;
2. **Explicit deferral sections** in the PR description (`Deferred`, `Follow-up`, `Known issues` headings and list items under them);
3. **TODO/FIXME lines added by the PR diff.**

Finding states: `ADDRESSED` (resolution evidence: resolving commit or thread resolved pre-merge) / `DEFERRED` (unresolved at merge or explicitly deferred) / `UNKNOWN`. A deferred finding is later **cleared** when a subsequent commit/PR resolves its thread or removes its marker; clearance latency is tracked.

LLM extraction of findings from prose (review comments in transcripts, agent statements like "deferring the race-condition fix") is P0.5/P1: versioned extractor on a cheap model, confidence scores, one-click human confirm/reject. Deterministic and LLM-extracted findings are never mixed in one metric without labeling.

### Functional requirements

**FR-OUTCOME-101** Link sessions to work items via repository identity + commit SHA overlap; expose per-workspace linkage rate (denominator: sessions with ≥1 Bash call).  
**FR-OUTCOME-102** Derive observed outcome states exclusively from provider-side evidence (merge state, checks on final commit, thread resolution) — never from agent self-report in transcripts. Sessions merging with no CI (`checks NONE`) are surfaced as a separate `no_ci_success_n` annotation and are not folded into the success count.  
**FR-OUTCOME-103** `OBSERVED_SUCCESS_WITH_DEFERRALS` never silently degrades the success denominator: headline success rate counts it as success, with the clean/with-deferrals split always displayed alongside.  
**FR-OUTCOME-104** Findings extraction in MVP uses only the three deterministic sources; each finding records source, work item, severity where derivable, state, and resolution evidence.  
**FR-OUTCOME-105** Deferred findings persist across work items until cleared; clearance links the resolving commit/PR.  
**FR-OUTCOME-106** All outcome-bearing surfaces carry the "observed, not enforced" qualification.

---

## 9. Metrics — catalog and calculation contract

All metrics are versioned (`metric_definition_version`), expose `n` / time range / observability qualification, and drill down to contributing rows (workspaces → sessions → turns). Exact-cost and inexact rows never silently mix. Full denominators: `AgentWrangler_Data_Model_and_Metrics_v2.md`.

### 9.1 Spend and burn

- Total cost-equivalent and tokens by workspace / session / model / day, with the input / output / cache-read / cache-write (5m vs 1h) split;
- **$/turn** and **context-per-turn** (`input + cache_read + cache_creation`) by model;
- **Live burn**: active sessions (transcript mtime window) with running cost and current context size;
- **Weekly-limit burn forecast**: projected exhaustion date vs reset date from trailing burn rate (upgraded by S7 if an official limit signal exists);
- **Context composition**: share of per-turn baseline attributable to always-loaded files (CLAUDE.md, rules, MCP schemas) vs tool results vs conversation;
- **Tool-result bloat share**; **cache-write churn** (writes expiring unread across idle gaps, 5m/1h aware).

### 9.1a Cap-weighted accounting — the resource is headroom, not raw tokens

Subscription billing rate-limits on a weekly token cap, but token classes do **not** draw against that cap equally: cache reads draw at the **cached rate (~0.1×)**, while input, output, and cache **writes** draw at full weight. Because the large majority of observed tokens are cache reads, a raw-token or full-weight "tokens saved" figure overstates recoverable headroom by roughly an order of magnitude (the economics research pass; the "tokenmaxxing" trap).

Therefore:

- The product computes a **cap-weighted token meter** alongside raw and cost-equivalent totals:
  `cap_weighted = full(input + output + cache_write) + COEFF × cache_read`.
- **`COEFF`** is a runtime configuration constant, **default `0.1`, labeled *unverified*** (Anthropic has not published a cap coefficient). Both `0.1×` and `1×` rankings are computed; the active one is selectable, and its provenance is displayed.
- **No surface headlines raw tokens or "tokens saved."** User-facing savings anchors are **$/wk (cost-equivalent)**, **per-turn context delta**, and — once the weekly limit is calibrated (FU-1) — a **qualified % of cap** labeled estimate-over-estimate.
- The frozen `turns.context_tokens` generated column (full-weight sum) is **not** the cap meter; cap-weighting is a query-side expression in a new module, leaving the schema unchanged.

### 9.2 Effectiveness

- **Observed Success Rate** (work items) with clean vs with-deferrals split;
- **Cost per Observed Success** — total linked cost (including failed/abandoned linked work) ÷ observed successes, in the exact-cost cohort; strictest variant: **Cost per Clean Success**;
- **Deferral Rate** (share of merged work items with ≥1 deferred finding), **Open Deferred Findings** backlog with age distribution, **Deferral clearance latency**;
- **Rework rate**: a follow-up session touching the same files/work item within N days of an observed success (hidden-failure proxy);
- **Loop/retry waste**: near-identical repeated tool-call sequences and failing-test loops, costed at full context-per-turn.

### 9.3 Behavior and adherence

- **Model-routing adherence** *(advisory)*: premium-model spend share on mechanically-classified turns vs the user's own routing rule (turn-class heuristic v1: tool-only turns, short-output turns). **This metric is advisory and must not emit a crisp routing-savings dollar figure from transcripts alone**: which cap binds (e.g. a per-model weekly cap) is not inferable from JSONL, and switching models can *increase* cap pressure if the cheaper model's cap is the binding one. Report the observed share and rule-deviation; express any savings only as a conditional range until live cap attribution exists (2026-08-25 telemetry brief);
- **Session hygiene**: session length distribution, long-full-context sessions, `/clear` vs mid-task `/compact` usage;
- **Subagent offload share**: portion of exploration/search executed in subagent sidechains vs the premium main thread;
- **Recommendation impact**: per adopted recommendation, the measured before/after delta on its target metric (§10).

### Functional requirements

**FR-METRIC-101** Every displayed metric maps to a versioned definition and persisted source rows; definition changes create a new version rather than recomputing history silently.  
**FR-METRIC-102** Cost figures carry a claim label: `LIST_EQUIV` (computed) or `BILLED` (billing source connected); the two are never summed.  
**FR-METRIC-103** Modeled savings and measured deltas are separate fields with separate visual treatment, and modeled figures are never aggregated into "savings achieved."  
**FR-METRIC-104** Live-session figures are labeled provisional until the session closes and reconciles.  
**FR-METRIC-105** Every aggregate drills to its contributing sessions and turns (bidirectional traceability, as in v0.6.x).  
**FR-METRIC-106** Every response carries the versioned meta envelope `{ n, window, qualification, metric_definition_version, claim_kind, drilldown_ids }` (`metric_definition_version` starts at `observe-1`). The honesty-label vocabulary is fixed: `LIST_EQUIV` / `LIST_EQUIV_STALE`, `PROXY`, `OBS PROXY ±BPE`, `EXPERIMENTAL`, `MODELED`, and `N/A`; **`MODELED` is a per-figure UI label, not a `claim_kind`** (it never enters the envelope enum), and every label pairs color with text (WCAG 1.4.1).

---

## 10. Recommendations — two tiers

Full specification: `AgentWrangler_Recommendations_Engine_Spec_v1.md`.

### 10.1 Tier 1 — deterministic detectors (continuous, free)

Versioned rules over ingested metrics, run on every ingestion pass. Each detector defines: trigger predicate, evidence fields, modeled-savings formula, adoption signal, and measured-effect definition. **Canonical detector IDs and specs: `AgentWrangler_Recommendations_Engine_Spec_v1.md` §2.** Savings are valued **cap-weighted** (§9.1a), so the registry is ordered by *recoverable headroom*, not raw token volume — a correction from the flat 2026-08-21 list after the 2026-08-25 research:

**Primary drivers (highest recoverable headroom — full-weight cap draw):**
- **D8 — cache-write / miss churn** *(flagship)*: cache-write spikes after idle-gap/resume with low subsequent cache read; levers include a pre-idle `/clear` nudge, batching prefix edits to a session boundary, and a 5m-vs-1h TTL-regime alert (the TTL split is a facet of D8).
- **D6 — tool-result byte bloat**: large tool_result payloads carried across remaining turns (size only, never content).
- **D9 — idle / background sessions**: assistant turns with no preceding user turn.
- **D7 — loop / retry waste**: repeated reads of the same path with no intervening edit, and `tool_use → error → retry` density. *(BLOCKED until `input_hash`/`exit_class`/`file_path` are ingested — a parser change; tracked, not yet firing.)*

**Secondary / supporting:**
- **D1 — oversized always-loaded context** (CLAUDE.md, rules, MCP schemas): a *secondary* lever — because the trimmed prefix is re-read from cache at ~0.1× cap weight, its full-weight modeled value is ~10× too optimistic. Every D1 rec carries a cache-invalidation caveat (batch the edit to a `/clear`/session boundary or it backfires).
- **D2 — long full-context sessions**: cache-read spend on `turn_count > 150` ∧ `avg context > 180k` sessions; savings use an explicit, visibly-labeled **`reduction_fraction` (unvalidated config default 0.33)**.
- **D4 — model-routing non-adherence** *(advisory-gated)*: detection retained; the recommendation is advisory and its crisp savings figure is suppressed/ranged per §9.3. *(Registry-ID note: the shipped `d4_model_mismatch` detector is conceptually the Rec-Spec's D3 `ROUTING_NON_ADHERENCE`; spec-D3 is retired and routing is tracked as runtime D4. IDs are frozen for evidence stability.)*
- **D5 — burn-forecast limit warning**: warning-class, **no savings model** (fires only once `:limit_tokens` is set).

### 10.2 Tier 2 — "Analyze with Claude" (on demand)

A dashboard button (global, or scoped to a workspace/session) runs the productized version of the ad-hoc analysis:

- Input is a compiled **evidence pack** — aggregates, detector hits, top-N outlier sessions, context composition — a few KB of derived data, **no prompt/code content by default**;
- **Engine: the user's local Claude Code CLI** (their existing subscription — **no console API key required**). Evidence is serialized as inert JSON inside delimited data fences (read-only data, never instructions) to close the prompt-injection surface; a configured cheap-model API key with a ≤$5/week cap remains an alternative path (COND-2), and if no CLI is present the flow degrades to a copy-prompt hand-off;
- Output must satisfy a **structured contract**: each proposal carries category, lever, modeled savings with formula inputs, and **evidence citations that must resolve against the local DB** — otherwise the proposal is rejected or flagged;
- Provenance recorded: `RULE` vs `CLAUDE_ANALYZED`, model (e.g. `claude-code-cli:<ver>`), prompt version, evidence-pack hash; **the analysis run's own cost is displayed**;
- Optional scheduled weekly run producing a stored report artifact (the repeatable form of the attached review).

**Assisted apply (opt-in, never automatic).** Beyond proposing, a recommendation may be *applied* through the local CLI as a guarded job (new append-only `apply_jobs` table): **dry-run (`plan` mode) → diff/changed-files preview → explicit user confirm → apply (`acceptEdits`, `Edit,Read` only) → rollback**. Edits are confined to the target workspace by a native path allowlist plus a post-apply audit; global files (`~/.claude/CLAUDE.md`, `MEMORY.md`) route to copy-prompt first. No change lands without the confirm step, and nothing is ever auto-applied (§4).

### 10.3 Adoption and measured effect

Recommendation lifecycle: `PROPOSED → ADOPTED | DISMISSED`; adopted → `MEASURED_EFFECTIVE | MEASURED_NO_EFFECT | MEASURING` after a defined observation window on the target metric. Measured results feed back into detector credibility display. No recommendation is ever auto-applied in MVP.

**Realized-savings signal (Impact Ledger).** Modeled and realized savings are shown side by side. The **authoritative realized signal for context/prefix recommendations is the `context_inventory` on-disk byte delta** (an append-on-change history, stored in a new sibling table so the frozen `context_inventory` is untouched) — **not** average context-per-turn, which is dominated by session depth and cannot isolate a prefix change. The turns-based figure is a weak, confounded cross-check only, never headlined. When multiple changes fall in one observation window (a **confounded window**), effect is attributed per source via the byte deltas where possible and reserved as `INCONCLUSIVE` for the dollar rollup otherwise. Realized `<` modeled is framed as a measurement/modeling limit, not a failure.

### Functional requirements

**FR-REC-101** Every recommendation (either tier) carries resolvable evidence citations; unresolvable citations block display or force a flagged state.  
**FR-REC-102** Tier 2 evidence packs exclude content by default; any content inclusion is explicit, per-run, and logged.  
**FR-REC-103** Tier 2 runs are metered and their cost displayed alongside their output.  
**FR-REC-104** Adoption is a manual user action; the system records it and begins effect measurement automatically.  
**FR-REC-105** Measured effects compare defined before/after windows on the recommendation's declared target metric and are labeled with both windows' `n`.  
**FR-REC-106** Dismissed recommendations are not re-raised for a configurable cool-down unless their evidence materially strengthens.

---

## 11. Dashboard

Hierarchy: **Global → Workspace → Session**, plus Recommendations and Settings. Four primary surfaces:

### 11.1 Overview (global)

- Cards: 7-day spend-equivalent; burn forecast vs weekly limit; Observed Success Rate (clean / with-deferrals split); context-per-turn trend.
- **Workspace comparison table** (the 2–3-concurrent view): per workspace — spend, share, active sessions now, $/turn, model mix, top open recommendation.
- **Live strip**: currently active sessions across all workspaces with running cost and context size.
- **Trend charts** (Recharts): spend and cap-weighted headroom over time (day / week / month), stacked by workspace/model, with recommendation-adoption markers overlaid once the Impact Ledger is live. The headroom-vs-cap-over-time chart lands once the weekly limit is calibrated (FU-1).
- Cross-workspace recommendations feed (top items).

### 11.2 Workspaces (list → detail → session)

Workspace detail: session list (live + historical) with cost, turns, context/turn, model mix, duration, hygiene flags, linked work item/outcome; workspace spend by day/model; context composition; adherence score (`adherence_score` — routing adherence v1; definition in Data Model §A metric catalog); deferred-findings backlog for that repository.  
Session detail (drill-down terminus): turn timeline with per-turn cost, cache read/write, tool-result sizes, model; loop/retry annotations; membership links back to every aggregate that includes it.

### 11.3 Recommendations

Active proposals as a ranked, progressively-disclosed list (collapsed row = human `title` + one headline + primary action; details/methodology behind expand — jargon such as raw `detector_id`/`target_metric` and absolute paths stays hidden); the **Impact Ledger** (modeled vs realized side by side, §10.3); adopted-with-measured-effect and dismissed sections; the **Analyze with Claude** action with scope selector and last-run cost; **assisted-apply** affordances (dry-run → confirm → rollback, §10.2) where a rec is workspace-local; weekly report artifacts.

### 11.4 Settings

Transcript roots and workspace registrations; GitHub connection (no secret display); pricing snapshot status/staleness; limit configuration (weekly window, reset day); analysis model + spend cap for Tier 2; privacy toggles (content inclusion default-off).

### UI requirements

**FR-UI-101** Every metric surface maps to a documented definition (bidirectional traceability check at release, as in v0.6.x FR-UI-008).  
**FR-UI-102** Comparative metrics show `n` and qualification; unavailable data shows `N/A`/`Partial`, never invented estimates.  
**FR-UI-103** Global numbers drill to workspaces, workspace numbers to sessions, session numbers to turns.  
**FR-UI-104** Live figures are visually distinguished from reconciled figures.  
**FR-UI-105** Fully offline/local except the GitHub sync and explicit Tier 2 analysis calls.  
**FR-UI-106** Keyboard accessible; text labels accompany color states.

---

## 12. Security and privacy requirements

**SEC-101** The metrics database stores derived metadata only (counts, sizes, timings, ids, hashes); no prompt, code, or model-response content.  
**SEC-102** Transcript files are read in place; AgentWrangler never modifies, moves, or re-permissions them.  
**SEC-103** The GitHub credential is read-only, stored in OS-protected storage, referenced by opaque id, and never appears in logs, DB rows, or UI payloads.  
**SEC-104** Tier 2 evidence packs contain derived data only by default; content inclusion requires an explicit per-run opt-in and is recorded in the analysis run's provenance.  
**SEC-105** Analysis prompts/templates are versioned and stored; analysis outputs are validated against the structured contract before display.  
**SEC-106** No network egress except: GitHub API (read-only), Anthropic API for explicit Tier 2 runs, and pricing-source refresh if configured. Each is user-visible in Settings.  
**SEC-107** Parse-failed transcript lines are quarantined with file/line reference, without copying content into the DB.

---

## 13. Nonfunctional requirements

**NFR-101** No Docker, PostgreSQL, Redis, or cloud account; single install; SQLite storage.  
**NFR-102** Install → first populated dashboard in under 10 minutes, including initial back-scan of existing transcripts.  
**NFR-103** Ingestion keeps pace with live usage: a new assistant turn is reflected in live views within 60 s; active-session detection within its mtime window (~5 min).  
**NFR-104** Initial back-scan of a corpus at the observed scale (dozens of project dirs, tens of thousands of turns) completes in minutes, not hours.  
**NFR-105** Dashboard query p95 ≤ 250 ms at pilot-scale volume (direct SQL, no rollup workers — same rule as v0.6.x AD-009).  
**NFR-106** Ingestion tolerates transcript schema drift: unknown fields ignored, unparseable lines quarantined, parser version recorded per row; a Claude Code update must never silently zero the metrics.  
**NFR-107** Deleting the AgentWrangler DB and re-scanning reproduces the same aggregates (deterministic re-ingestion, dedupe by message id).

---

## 14. Build vs reuse

| Capability | MVP strategy | Reuse | AgentWrangler owns |
|---|---|---|---|
| Transcript parsing/aggregation | productize the proven scripts | user's `analyze.mjs`/`sessions.mjs` logic; JSONL streaming libs | dedupe, schema-version tolerance, quarantine, incremental tail |
| Token accounting cross-check | coexist, don't rebuild blindly | `ccusage` as reference implementation for validation | canonical DB, outcome linkage, recommendations |
| Tokenization for context inventory | OSS tokenizer | model-appropriate tokenizer lib | attribution of always-loaded files to per-turn baseline |
| GitHub outcome data | provider API | GitHub REST/GraphQL, `gh` | linkage algorithm, outcome/finding semantics |
| Storage / analytics | commodity | SQLite (WAL) | schema, metric contract |
| Tier 2 analysis / assisted apply | local **Claude Code CLI** (user subscription; cheap-model API + $5 cap as alternative) | Claude Code CLI headless (`stream-json`, `plan`/`acceptEdits` modes), Anthropic API | evidence pack, inert-JSON injection-safe framing, output contract, provenance, cost metering, `apply_jobs` job model + rollback |
| Dashboard | custom UI on standard web libs | React, **Recharts** (offline-bundled) for trends | hierarchy, truthfulness, drill-down |
| Governance layer | **not built in MVP** | — | preserved as P1 spec (v0.6.3/v4.4.3) |

---

## 15. Success criteria (self-hosted pilot, 2–4 weeks)

1. The attached weekly review is **reproduced automatically** (same cuts, same numbers within dedupe tolerance) with zero manual scripting.
2. Live burn + forecast would have flagged the limit-exhaustion week **before** it hit.
3. ≥80% of sessions in registered workspaces link to work items; unlinked share is displayed, understood, and stable.
4. Deferred findings appear for real PRs and match manual inspection on a 20-PR audit (precision ≥0.8 for the deterministic sources).
5. At least 3 recommendations adopted with **measured** effects; the review's estimated weekly-reduction envelope is confirmed, revised, or falsified by measured data — any of those outcomes is a valid product-learning result and is not masked.
6. Success rate does not degrade over the pilot (the "without reducing success" half of the promise, on observed outcomes).
7. Metrics reconcile: every Overview number recomputes from raw rows; a DB rebuild reproduces aggregates (NFR-107).

---

## 16. Roadmap after MVP

**MVP build status (2026-08-25).** The Observe MVP is mid-build; execution phasing and gates live in `docs/plans/roadmap-to-prd.md`. **Phase-1a shipped** (ingestion, spend/burn Overview, Settings, live strip). **Phase-1b in progress** (limit calibration FU-1; DetectorEngine + Recommendations Tier-1). **Phase-1c** (outcomes/findings, EXPERIMENTAL) is gated on COND-1 (findings precision ≥0.8) + COND-3 (linkage ≥80%); **1d** (Tier-2) on COND-2 (≤$5-cap key) — though the local-CLI engine (§10.2) is the credential-free default; **1e** packaging on the ADR-100 spike. The post-MVP phases below map onto this: P0.5 = evidence-gated additions, P1 = "Govern."

- **P0.5 (evidence-gated):** LLM findings extraction with confirm/reject; billing-source integration if an official endpoint exists; additional turn-class heuristics for adherence.
- **P1 — Govern:** the preserved v0.6.3/v4.4.3 control loop (Task Plans, Cedar Stage A, sandbox runtime, ModelAdmission + hard budget, managed headless execution, verifier integrity, containment). Promotion requires an explicit ADR citing Observe-era evidence (e.g., recommendations alone plateau, or enforcement-grade verification is needed to trust success rates).
- **P2:** additional agents/ingestion sources; routing automation informed by measured adherence data; durability/rework attribution.
- **P3:** teams/cloud, per v0.6.x.

---

## 17. Open decisions / required spikes

See `AgentWrangler_Spike_Plan_v2.md`. Headlines: implementation stack (the Rust/Go analysis from v4.4.x is obsolete — its drivers were Cedar and sandbox FFI, both now P1; TypeScript/Node is the presumptive fit given the JSONL ecosystem and the proven scripts); transcript schema fidelity; linkage accuracy; findings precision; context-inventory attribution method; Tier 2 contract validity/cost; weekly-limit observability.

---

# 18. Decision / change log — PRD v0.6.3 → v0.7.0

**Date:** 2026-08-21  
**Review type:** Operator-directed scope pivot + integration of the 2026-08-21 token-usage review

1. **Pivoted MVP to visibility + recommendations; deferred all governance — ACCEPTED.** Control/enforcement (Cedar, sandbox, ModelAdmission, budget enforcement, managed execution, GitHub action boundary, verifier sandbox, Task Plans) moves to P1 intact; PRD v0.6.3 and Architecture v4.4.3 are preserved as the P1 specification. Retained DNA: metric versioning, denominator contracts, truthfulness rules, SQLite direct-SQL analytics, drill-down traceability, content-off-by-default.
2. **Primary data source becomes unmanaged Claude Code transcripts — ACCEPTED.** The managed-runtime evidence pipeline is unnecessary for the MVP questions; `~/.claude/projects/**/*.jsonl` + read-only GitHub API + a context inventory probe suffice, as demonstrated by the operator's ad-hoc review.
3. **"Verified" recast as "observed" for MVP — ACCEPTED.** Without the P1 verifier-integrity layer, success is observed from provider-side evidence (merge/CI/threads) and labeled accordingly; the limitation is displayed in-product.
4. **Deferred review findings added as an orthogonal quality dimension — ACCEPTED (§8.3).** Merged-with-deferrals stays in the success numerator (honest denominator) with a mandatory clean/with-deferrals split; deferral rate, backlog age, and clearance latency become first-class metrics. MVP extraction is deterministic only (unresolved threads at merge, explicit deferral sections, TODO/FIXME added in diff); LLM extraction is evidence-gated P0.5/P1 — the same deterministic-first principle previously applied to verifier-integrity classification.
5. **The ad-hoc token review becomes the product's recommendation engine — ACCEPTED (§10).** Tier 1 deterministic detectors derived from the review's findings run continuously; Tier 2 "Analyze with Claude" productizes the ad-hoc run: evidence pack (derived data only), structured output contract with resolvable evidence citations, RULE vs CLAUDE_ANALYZED provenance, displayed analysis cost, and a mandatory adopted→measured-effect loop. Modeled vs measured savings are never mixed (extends the v0.6.x "no counterfactual claims" rule).
6. **Dashboard hierarchy set to Global → Workspace → Session — ACCEPTED (§11).** Matches the operator's 2–3-concurrent-workspace reality; adds the workspace comparison table and live burn strip; preserves four-surface discipline (Overview, Workspaces, Recommendations, Settings) and bidirectional traceability.
7. **Cost-claim labeling made a hard rule — ACCEPTED (FR-METRIC-102).** List-price equivalents vs billed amounts are distinct claims; the review's own caveat is promoted to product law.
8. **Success criteria anchored to the operator's real incident — ACCEPTED (§15).** Reproduce the weekly review automatically; demonstrate the forecast would have pre-empted the early limit exhaustion; confirm/revise/falsify the estimated reduction envelope with measured data.
9. **Stack decision reopened — ACCEPTED.** The Rust-vs-Go analysis was driven by Cedar/nono integration, both now P1; the MVP's constraints (JSONL streaming, GitHub API, desktop UI, reuse of proven Node scripts) point presumptively to TypeScript/Node, to be confirmed by a 1-day ADR (Spike S0).
10. **Planning-artifact set rotated — ACCEPTED.** Cedar Policy Draft and Consequential Action Spec are shelved with the governance layer; Ingestion & Findings Spec and Recommendations Engine Spec replace them as top planning artifacts; Data Model & Metrics and the Spike Plan are reissued as v2.

---

# 19. Decision / change log — PRD v0.7.0 → v0.7.1

**Date:** 2026-08-21  
**Review type:** Session 12 spec patches

- 2026-08-21 (Session 12): Bumped version title to v0.7.1.
- 2026-08-21 (Session 12): §11.2 — added `adherence_score` definition reference ("routing adherence v1"; Data Model §A metric catalog) alongside the adherence score display item — source: FW-08
- 2026-08-21 (Session 12): FR-OUTCOME-101 — clarified linkage-rate denominator: sessions with ≥1 Bash call — source: FW-01 / SG-01
- 2026-08-21 (Session 12): FR-OUTCOME-102 — added no-CI annotation: sessions merging with `checks NONE` are surfaced as `no_ci_success_n`, not folded into the success count — source: OQ-05

---

# 20. Decision / change log — PRD v0.7.1 → v0.7.2

**Date:** 2026-08-25  
**Review type:** Reconciliation of the PRD with the four build plans (`recommendations-improvement-v2`, `phase-1a-implementation-plan`, `detector-engine-wp`, `wp5-t4-build-plan`) + `roadmap-to-prd`, and the 2026-08-21/25 research passes. No product-scope reversal — the MVP remains Observe; these are corrections and specifications the plans made after v0.7.1 was written.

1. **Cap-weighted accounting added — ACCEPTED (§9.1a, header note).** The resource to optimize is weekly rate-limit *headroom*, not raw token count; cache reads draw at the cached rate (~0.1×). Introduced the cap-weighted meter, the `COEFF` constant (default 0.1, *unverified*, both 0.1×/1× ranked), and the rule that no surface headlines raw tokens or "tokens saved." *Source: recs-v2 §W0.1; research brief A.*
2. **Tier-1 detector registry reranked with canonical IDs — ACCEPTED (§10.1).** D1 prefix-trim demoted to *secondary* (~10× overstated at full weight); primary drivers are D8 cache-write/miss churn (flagship), D6 tool-result bloat, D9 idle/background sessions, D7 loop/retry waste (D7 BLOCKED pending parser fields). Recorded the D3/D4 routing ID reconciliation and spec-D3 retirement; D5 is warning-class (no savings). *Source: recs-v2 §W0.2; Rec Engine Spec §2; detector-engine-wp.*
3. **Model-routing adherence gated to advisory — ACCEPTED (§9.3, §10.1 D4).** Which cap binds is not inferable from JSONL, so no crisp routing-savings dollar figure is emitted from transcripts alone; detection stays, the rec is advisory/ranged. *Source: recs-v2 §W0.3; research brief B.*
4. **Impact-Ledger realized-savings signal corrected — ACCEPTED (§10.3).** Authoritative realized signal = `context_inventory` on-disk byte delta (append-on-change history in a new sibling table); avg context/turn is a weak confounded cross-check only. Added "confounded window" handling. *Source: recs-v2 §W4.*
5. **Tier-2 engine settled + assisted apply specified — ACCEPTED (§10.2, §4, §14).** Engine is the local Claude Code CLI (no console API key; cheap-model API + $5 cap as alternative), injection-safe inert-JSON framing. Added the guarded assisted-apply job model (`apply_jobs`: dry-run → confirm → apply → rollback); §4 non-goal nuanced accordingly — nothing is auto-applied. *Source: recs-v2 §W3.*
6. **Envelope + honesty-label vocabulary fixed — ACCEPTED (FR-METRIC-106).** Documented the `meta` envelope (`metric_definition_version='observe-1'`) and the label set (LIST_EQUIV[_STALE], PROXY, OBS PROXY ±BPE, EXPERIMENTAL, MODELED, N/A); `MODELED` is a UI label, not a `claim_kind`. *Source: phase-1a WP0–WP3; detector-engine-wp §5.*
7. **Trends surface + build status added — ACCEPTED (§11.1, §14, §16).** Recharts trend charts (spend + cap-weighted headroom over time, adoption markers); §16 now references the 1a–1e phase structure and current status. *Source: recs-v2 §W1; roadmap-to-prd; phase-1a.*
8. **No schema break, no scope reversal.** Every storage addition (`context_inventory_history`, `apply_jobs`) is a new append-only table; the frozen `001_observe.sql` tables and the response-envelope contract are unchanged. Governance remains the preserved P1 spec (v0.6.3/v4.4.3).
