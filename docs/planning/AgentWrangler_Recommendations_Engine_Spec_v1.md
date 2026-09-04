# AgentWrangler — Recommendations Engine Spec v1.0

**Date:** 2026-08-21 · **Status:** Design, pending Spike S6 (Tier 2 contract) · **Companions:** Architecture v4.5.0 §6–7, PRD v0.7.0 §10, Data Model v2

> **⚠️ Economic-model correction — 2026-08-25 (external research pass).** Two adversarial briefs
> (`docs/research/research-prompt-{A,B}-*-output.md`) refuted D1's ranking below: cache reads draw on the
> rate-limit cap at the **cached rate (~0.1×, unverified)**, not full weight, so **D1 is a *secondary*
> lever, NOT "the biggest."** The dominant reducible drivers (cache-miss/write churn, tool-result bloat,
> idle sessions, retry loops) are new detectors to be specced here when built. The go-forward design is
> **`docs/plans/spec-recommendations-engine.md` §W0** (cap-weighted meter + primary detectors + D4
> advisory-gate, sequenced first). Read that before treating the D1/D4 sections below as authoritative.

## 1. Shared contract (both tiers)

Every recommendation row carries: `provenance` (`RULE`|`CLAUDE_ANALYZED`), `category`, `scope` (global/workspace/session-derived), `lever` (the specific change), `modeled_savings` **with its formula inputs** (`modeled_formula_json`) so the projection is reproducible, `evidence_json` (citations that must resolve against the DB), `target_metric` (what effect measurement watches), and lifecycle `state`.

Hard rules (FR-REC-101/103, FR-METRIC-103, AD-106):

- unresolvable evidence ⇒ not displayed (rejected) or displayed flagged, never displayed clean;
- modeled savings are never summed into "achieved"; only `recommendation_effects.verdict = EFFECTIVE` deltas are;
- dismissal sets a cool-down (`dismissed_until`, default 30 d); re-raise early only if evidence strengthens ≥ a configured factor (FR-REC-106).

## 2. Tier 1 — deterministic detector registry v1

All thresholds are config with the listed defaults; every detector is versioned; all run after each ingest/sync pass, read-only.

### 2.0 Detector-id reconciliation (runtime is authoritative) — 2026-08-25

The persisted `rec_id = rec-<detector_id>-<scope>-<sha1(scopeKey)[:16]>` (`src/detector/engine.ts:36`) bakes
**both** `detector_id` and the `scopeKey` prefix into every stored recommendation, and `recommendations.detector_id`
is a plain column. So a shipped detector's runtime id **cannot** change without orphaning its stored recs — their
dismissal cool-downs (`dismissed_until`) and effect history (`recommendation_effects`) key off the id. **Runtime ids
are therefore frozen for every detector that has fired (D1, D2, D4, D5),** and this spec's catalog is reconciled to
them. The collision: the shipped `src/detector/detectors/d4_model_mismatch.ts` runs as **runtime id `D4`
(`MODEL_MISMATCH`)** but is conceptually the spec's **D3 `ROUTING_NON_ADHERENCE`** — it occupies the id the old spec
reserved for cache-write-churn. Resolution:

| Runtime id (authoritative) | Name | Concept | Status | Note |
|---|---|---|---|---|
| **D1** | `CTX_ALWAYS_LOADED_OVERSIZE` | prefix / always-loaded trim | shipped | secondary lever (2026-08-25) |
| **D2** | `SESSION_LONG_FULL_CONTEXT` | long-session hygiene | shipped | |
| **D4** | `MODEL_MISMATCH` ( = spec-D3 `ROUTING_NON_ADHERENCE`) | model routing | shipped | **advisory-gated** (2026-08-25); id frozen |
| **D5** | `LIMIT_BURN_FORECAST` | limit warning | shipped | warning-class (no savings model) |
| **D6** | `TOOL_RESULT_BLOAT` | tool-output bloat | shipped | session/turn attribution |
| **D7** | `LOOP_RETRY_WASTE` | retry / redundant-read | implemented | ingestion-2 metadata; forward-only by default |
| **D8** | `CACHE_WRITE_CHURN` | cache miss / write churn | shipped | **flagship**; fresh id (D4 taken); TTL 5m/1h facet |
| **D9** | `IDLE_BACKGROUND_SESSION` | idle / background burn | shipped | sidechain-share proxy |
| **D10** | `CATALOG_FOOTPRINT` | MCP/plugin/skill catalog footprint | shipped | next issued id after D9 |
| **D11** | `EFFORT_MISMATCH` | over-budgeted thinking / effort | **BLOCKED** | calibration and task-complexity evidence missing; id reserved |
| **D12** | `FORK_CONTEXT_INHERITANCE` | full-history fork re-sends oversize context | **BLOCKED** | parent↔child linkage heuristic (issue #32175); id reserved — see intake `docs/plans/2026-08-26-subagent-routing-finding-intake.md` |
| ~~D3~~ | ~~`ROUTING_NON_ADHERENCE`~~ | — | **RETIRED** | concept realized at runtime `D4`; **do not reuse the `D3` id** |

- **Why D8, not D4, for cache-write-churn:** reusing `D4` collides with the shipped model-routing detector; reusing
  the free `D3` id would attach a *different* concept to a number the old spec strongly identifies with routing —
  fresh churn for future readers. A never-fired, unambiguous id (`D8`) is cleanest. `D6`/`D7` keep their spec numbers
  because those numbers have never persisted a rec (they are only NOT_EVALUATED placeholders) and their concepts are
  unchanged.
- **Code reconciliation (T0 build task, not this pass):** `src/detector/registry.ts` currently declares
  NOT_EVALUATED placeholders with **stale names** — `D3=TOOL_LOOP_BURN`, `D6=RETRY_STORM`, `D7=IDLE_LIVE_SESSION` —
  that disagree with this catalog. When building, reconcile the `registry.ts` entries and each detector's `name`
  field to the names above, and drop the retired `D3` placeholder.
- **scopeKey convention:** every new detector sets `scopeKey` prefix = its runtime id (e.g. `D8|<scope>`), matching
  the shipped `D4|<workspace_id>` convention, so `rec_id`s stay namespaced.

**D1 `CTX_ALWAYS_LOADED_OVERSIZE`** — ~~*the biggest observed lever.*~~ **[SUPERSEDED 2026-08-25: secondary lever — see banner + v2 §W0. Modeled savings below are at full weight; the cap-weighted value is ~0.1× on steady cached turns.]**  
Trigger: `context_inventory` always-loaded total for a workspace > 40k tokens, or > 25% of avg context/turn.  
Evidence: component breakdown (CLAUDE.md/rules/MCP schemas with token counts), avg context/turn.  
Lever: move changelog/history prose out of always-loaded files; keep current-state + pointers (exactly the CLAUDE.md finding from the review).  
Modeled savings: `Δcontext_tokens × turns/wk × cache_read_price(model mix)` — D1 example: always-loaded trim ≈ **$45/wk** (the review's `238k→160k ≈ $875/wk` figure belongs to D2 `SESSION_LONG_FULL_CONTEXT`, not D1).  
Adoption signal: `context_inventory` hash change reducing always-loaded tokens ≥15% (auto-detected).  
Target metric: avg context/turn (workspace).  
> **Note:** D1's trigger (>40k tokens OR >25% avg context) is currently met by **no** registered workspace; D1 is forward-looking and not presently actionable for this user.

**D2 `SESSION_LONG_FULL_CONTEXT`**  
Trigger: ≥ N sessions/wk (default 3) with > 150 turns at context > 180k.  
Lever: `/clear` between unrelated tasks; split work; avoid mid-task `/compact`.  
Modeled: excess turns × per-turn context cost. Adoption: manual. Target: sessions-over-threshold count; $/turn.

**D4 `ROUTING_NON_ADHERENCE`** *(runtime id `D4`, shipped as `MODEL_MISMATCH`; spec-D3 concept — see §2.0)* — **ADVISORY-GATED 2026-08-25.**  
Trigger: premium-model spend share on mechanical turns (heuristic v1) > 40%.  
Evidence: adherence query output + the user's own CLAUDE.md rule reference.  
Lever: default cheap model; deliberate escalation; route subagents cheap.  
Modeled: mechanical premium spend × (1 − cheap/premium price ratio), labeled *directional* (turn-class heuristic error acknowledged in qualification).  
Adoption: manual. Target: premium share on mechanical turns; $/turn.  
> **Advisory gate (W0.3, 2026-08-25 — keep detection, downgrade the rec).** Which cap binds is **not inferable
> from JSONL**: downgrading Opus→Sonnet relieves the all-models / Opus / 5h pools but **does not help — and can
> hurt — if the Sonnet-specific weekly cap is the binding constraint** (research A5 + B routing contingency).
> Therefore: (a) keep the detection logic unchanged (still fires, still stores evidence); (b) **rewrite the Lever
> to the conditional framing** — *"if your all-models/Opus cap is the one binding — check `/usage` — these turns
> are Sonnet-movable"*; (c) **suppress the crisp modeled-savings figure** — emit it as a conditional range or
> `NULL`, never a single `$X/wk` number, until live `/usage` cap-attribution exists. The shipped detector's
> `modeled_savings_u_per_wk` (`d4_model_mismatch.ts:191`) must be gated off / range-ified for the surfaced rec;
> retain the underlying computation as diagnostic evidence only. Never emit a crisp routing number from
> transcripts alone.
> **Subagent-routing facet (reserved, 2026-08-26).** Recon/worker subagents spawned with no model override
> can inherit a premium model (the Codex "55 recon agents on Sol" finding — intake
> `docs/plans/2026-08-26-subagent-routing-finding-intake.md`). On Claude Code JSONL this is buildable as a
> D4 facet, not a new detector: add an evidence field for routing on `is_sidechain = 1` turns and surface it
> under the same advisory-gate/conditional-lever framing. Do **not** emit a crisp savings figure. Not yet
> scheduled.

**D8 `CACHE_WRITE_CHURN`** — **flagship primary detector (research 2026-08-25).** Fresh runtime id; see §2.0. Buildable from ingested fields today (no schema change).  
Trigger (all UNVALIDATED defaults, labeled in every rec): a cache-**creation** spike on a resume turn — `cache_write_5m + cache_write_1h + cache_write_other ≥ 50k` on a turn whose gap from the previous turn in the same session exceeds the effective TTL (`idle_gap_min > 5` when 5m-dominant, `> 60` when 1h-dominant), **and** low `cache_read_tokens` on that turn (`cache_read < 0.2 ×` the creation on that turn) — i.e. a full-price re-write of the whole window rather than a warm read. Fire the workspace/session rec when such events number `≥ 3/wk` **or** their cap-weighted creation tokens are `≥ 15%` of the scope's cap-weighted total (Data-Model §2A).  
Evidence (ids + numbers only, SEC-101): per event — `session_id`, resume-turn `ts`, pre-gap `idle_gap_min` (from consecutive `turns.ts`), `cache_write_5m/1h/other` and `cache_read_tokens` on the resume turn, cap-weighted creation tokens; plus the scope's `cache_read : cache_creation` ratio (Data-Model §2A diagnostic).  
Lever: `/clear` (or resume-from-summary) before idling past the TTL; **batch prefix / CLAUDE.md edits to a session boundary** so they don't invalidate the warm cache mid-session (this is the guard that keeps a D1 prefix-trim rec from backfiring into a full write); where long pauses are unavoidable, prefer the 1h cache regime.  
Modeled savings (**cap-weighted**, not raw tokens): `avoidable_cap_tokens/wk = Σ_events full(cache_write_* on resume) × avoidance_fraction`, `avoidance_fraction` UNVALIDATED default `0.7` (some resumes are unavoidable) — surfaced as a visible, labeled input. Translate to `$/wk` via the write price (`pricing_snapshots`) and to a per-turn delta for display; **never** a raw-token headline.  
Adoption signal (auto-detectable): flagged re-write events fall and/or the `cache_read : cache_creation` ratio rises in the trailing window after adoption.  
Target metric: cache-creation cap-weighted tokens per active hour; `cache_read : cache_creation` ratio.  
> **TTL-regime — a FACET of D8, not a separate detector (decision, 2026-08-25).** Spec-D8 is already "5m/1h aware"
> and the signal is the same `cache_write_5m` / `cache_write_1h` split, so a distinct detector/id would only
> duplicate D8's scope. Facet sub-rule: when a scope's creation tokens are `≥ 80%` (UNVALIDATED) 5m-tier, annotate
> the D8 rec `regime=5m` — every pause now pays a full write — and extend the Lever with *"enable the 1h cache
> regime (`ENABLE_PROMPT_CACHING_1H`) where applicable."* No separate `scopeKey`/`rec_id`.

**D5 `LIMIT_BURN_FORECAST`** (warning-class; no savings model)  
Trigger: projected exhaustion ≥ 24 h before reset.  
Evidence: burn query output. Lever: scope-aware suggestions (top-burn workspace/sessions). Target: forecast margin.

**D6 `TOOL_RESULT_BLOAT`** — build-ready (research 2026-08-25). Buildable now from `turns.tool_result_bytes` (populated by ingest correlation, `ingestor.ts:355`); size only, never content (privacy boundary holds).  
Trigger (UNVALIDATED defaults): in `≥ N` sessions/wk (default `N=3`), the session's summed `tool_result_bytes` is `≥ 30%` of the session's cap-weighted context growth **and** exceeds an absolute floor (`≥ 200 KB`/session, avoids firing on tiny sessions). A tool_result rides in context and is re-processed at the cached rate on every later turn, so "carry cost" = bytes × remaining turns in the session.  
Evidence: session_id; summed `tool_result_bytes`; session cap-weighted context total; bloat share; turn count (for carry cost).  
Lever: scoped reads (line ranges) and `head`/filters over full dumps; truncate/summarize verbose tool output; move exploration to subagents (keeps bloat out of the premium main thread).  
Modeled savings (cap-weighted): `bloat_share × session_cap_weighted_tokens × reduction_fraction`, `reduction_fraction` UNVALIDATED default `0.5`, surfaced as a labeled input; translate to `$/wk` + per-turn delta.  
Adoption: manual. Target: tool-result byte share of session cap-weighted context.  
> **Attribution limit:** D6 currently emits at turn/session grain. Ingestion-2 now correlates
> `tool_events.result_bytes`, but naming and ranking the specific "quiet offender" tool remains a detector/UI
> follow-on; do not imply that attribution until D6 consumes the new event-level field.

**D7 `LOOP_RETRY_WASTE`** — build-ready ingestion and detector contract (2026-08-26).
Trigger (UNVALIDATED defaults): `≥ 3` consecutive near-identical tool calls (same `tool_name` + canonical
`input_hash`), or `≥ 3` consecutive `TEST_FAIL` cycles, or `≥ 3` `Read` calls to the same privacy-safe path
**and input/region identity** with no intervening `Edit`/`Write` to that path. Distinct offset/limit chunks of one
file do not qualify as redundant reads. Overlapping signals count an
owning turn once. Event order is `tool_events.ts`, then the tool block's stable within-message index, then
`event_id` as a deterministic tie-break.
Lever: session-detail annotation + suggestion to break loop patterns (interrupt, restate, or split); read-before-edit discipline.  
Modeled impact: directional cap-weighted exposure for turns owning **repeat-excess** events only; the first
necessary attempt/read is excluded. This is not an avoidable-token or USD savings claim. Target: loop-flagged
turn share.
> **Ingestion gap (historical note):** for tool_use blocks the ingestor wrote `tool_events.input_hash = NULL` and
> `exit_class = NULL` (`ingestor.ts:372-373`), and the tool's `file_path` is **never stored** (only `input_bytes`
> = the JSON length, `parser.ts:217`). So near-duplicate detection (`input_hash`), `TEST_FAIL`-cycle detection
> (`exit_class`), and redundant-`Read` detection (`file_path`) all lack their inputs. **Partial capability that
> DOES exist:** `input_hash` is populated for synthetic `local_command` events (e.g. `/compact`, `reconcile.ts:58`),
> so a `/compact`-mid-task hygiene flag is detectable now. **Action:** D7 stays specced but is a **future-ingestion
> task**. The 2026-08-26 enablement stores canonical input hashes and structural result classes in the existing
> nullable columns and adds a new companion table for only the SHA-256 path identity plus within-message order;
> raw tool inputs, outputs, Bash command payloads, and paths remain unpersisted. Legacy synthetic
> `local_command` hygiene markers remain limited to `/clear` and `/compact`. `TEST_FAIL` requires both a conservatively
> classified test command and a structural error result; other structural errors remain `ERROR`. Existing rows
> remain unenriched by default — no migration may delete offsets or silently replay the operator's corpus.

**D9 `IDLE_BACKGROUND_SESSION`** — new (research 2026-08-25). Partial build now; strict form needs future ingestion.  
Trigger (UNVALIDATED defaults): in the trailing week, a scope where `is_sidechain = 1` turns contribute `≥ 25%` of cap-weighted tokens **and** absolute sidechain cap-weighted tokens `≥ 100k`/wk — background/subagent fan-out that may not convert to forward progress. (Secondary buildable signal: a `LIVE` session still accumulating turns across `> TTL` idle gaps.)  
Evidence: scope id; sidechain cap-weighted tokens; sidechain share; sidechain turn count; parent-linkage confidence when derivable.  
Lever: tighter subagent briefs; cap fan-out in plan mode; kill idle background sessions; `/clear` idle terminals.  
Modeled savings (**cap-weighted, directional**): `sidechain_cap_weighted_tokens × unproductive_fraction`, `unproductive_fraction` UNVALIDATED default `0.5`, labeled — and marked **directional** because fan-out is frequently justified (research B: a *real* quality/throughput tradeoff, not pure waste). Do not emit a crisp headline savings number.  
Adoption: manual. Target: sidechain cap-weighted token share.  
> **Build caveats (2026-08-25):** (a) the *strict* signal — "assistant turn with **no preceding user turn**" —
> is **not** queryable today: `turns` holds one row per **assistant** message only; user messages are not ingested,
> so the "no user turn" join has no left side. That refinement is a future-ingestion task (add user-turn markers).
> Ship D9 v1 on the buildable `is_sidechain` share proxy (populated, `turns.is_sidechain`, `parser.ts:198`).
> (b) parent↔child subagent linkage is **heuristic** (child files carry no parent-session key, issue #32175) —
> present fan-out cost with uncertainty. (c) Idle-*resume* cache churn belongs to **D8**, not D9 — D9 is the
> background/fan-out-volume detector, kept distinct to avoid double-counting.

**D11 `EFFORT_MISMATCH` — BLOCKED (calibration decision, 2026-08-26).** Reserve D11 because D3 is retired and
D10 already exists, but do not register a detector or emit recommendations. `turns.effort` records the requested
effort label; it does not establish that the task was simple or that lower effort would have preserved quality.
`output_tokens` combines thinking and visible output, so it cannot isolate thinking spend, and the current schema
has no independent task-complexity label. The current labeled corpus is also unsuitable for threshold fitting:
47,616 of 48,299 labeled turns (98.6%) are `high`, versus 683 `medium` turns, with no `low` sample. A rule such as
"high effort + short output" would therefore be circular, globally noisy, and unable to distinguish justified
reasoning from mismatch.

No authoritative six-field contract exists while blocked. In particular, modeled savings are `NULL`; a future
implementation may show only a directional generation-token delta and must state the real quality/rework tradeoff.
Unblocking requires the evidence and scratch-copy calibration gate in
`docs/plans/spec-d11-effort-mismatch.md`; passing it must produce a selective six-field
trigger/evidence/lever/model/adoption/target contract before any code or UI status changes.

**D12 `FORK_CONTEXT_INHERITANCE` — BLOCKED (reserved, 2026-08-26).** Reserve D12 for the "full-history fork
re-sends very large context" pattern (intake `docs/plans/2026-08-26-subagent-routing-finding-intake.md`),
distinct from D4 routing (which model) and D8 churn (cache re-writes) — this is about the *inherited context
size* a fork carries. Do not register a detector or emit recommendations. Blocked on the same heuristic
parent↔child linkage gap as D9's strict form: child transcript files carry no parent-session key
(issue #32175), so a fork's context cannot be reliably attributed to its parent today. No six-field contract
exists while blocked; modeled savings are `NULL`. Unblocking requires reliable parent↔child linkage
(shares the dependency with D9's strict "no-user-turn" form) before any code or UI status changes.

Registry is extensible; each new detector ships with all six fields (trigger/evidence/lever/model/adoption/target) or it doesn't ship.

## 3. Tier 2 — "Analyze with Claude"

### 3.1 Trigger and scope

Dashboard button on Overview (global), workspace detail, or session detail; optional weekly schedule producing a stored report artifact (the productized form of `token-usage-review-2026-08-21.md`). Disabled until an Anthropic key is connected; per-run and monthly spend caps in Settings.

### 3.2 Evidence pack (input)

Canonical JSON, target ≤ 20 KB, hash-stored:

```json
{
  "pack_version": 1,
  "scope": "GLOBAL | ws_... | sess_...",
  "window": {"from": "...", "to": "..."},
  "aggregates": { "spend_by_model": [...], "spend_by_workspace": [...],
                  "context_per_turn_by_model": [...], "cache_split": {...},
                  "burn_forecast": {...}, "success": {...}, "deferrals": {...} },
  "detector_hits": [ {"detector_id": "...", "evidence": {...}} ],
  "outliers": { "top_sessions_by_cost": [...], "hygiene_flagged": [...] },
  "context_inventory": [ {"workspace": "...", "components": [...]} ],
  "adopted_recommendations": [ {"rec_id": "...", "effect": {...}} ]
}
```

Derived data and ids only. Content inclusion is a per-run explicit opt-in, recorded on `analysis_runs.content_included` (SEC-104) — off by default and not needed for the v1 prompt.

### 3.3 Run

One Messages API call on the configured cheap model with versioned prompt template `rec-analysis-v1`: role framing (spend-effectiveness analyst), the shared contract, the output JSON schema, and the pack. Later evolution (P0.5): short Agent SDK run with a single read-only LocalQueryAPI drill-down tool — the shelved headless design reused in a read-only, unprivileged setting. Not in v1.

### 3.4 Output contract

```json
{
  "proposals": [{
    "category": "CONTEXT|ROUTING|SESSION_HYGIENE|CACHE|TOOLING|OTHER",
    "lever": "specific change, imperative",
    "modeled_savings_usd_per_week": 0,
    "modeled_formula": {"inputs": {"metric_id": "value_used"}, "expression": "..."},
    "evidence": [{"metric_id": "...", "scope": "...", "value": 0, "window": "..."},
                 {"row_ref": "sess_... | ws_... | rec_..."}],
    "target_metric": "metric_id",
    "confidence": "HIGH|MEDIUM|LOW",
    "relation_to_detectors": ["D1"]
  }]
}
```

**Validation (ContractValidator):** schema parse; every `metric_id` exists in the registry; every cited value matches the DB within tolerance (default ±5% / staleness window); every `row_ref` resolves. Any failure ⇒ proposal rejected (or flagged `UNVALIDATED` if only tolerance-marginal); raw output retained on the run record for inspection, never rendered as a recommendation. Proposals duplicating an active detector hit are merged into it (detector keeps authority; Claude's framing attached as annotation).

### 3.5 Provenance and metering

`analysis_runs` row: scope, model, prompt version, pack hash, content flag, tokens, cost-equivalent, contract result. The run's cost is displayed with its output ("this analysis cost $0.04") and counted in Tier 2 spend caps. Accepted proposals get `provenance = CLAUDE_ANALYZED` + `analysis_run_id`.

## 4. Adoption and effect measurement

```text
PROPOSED ── user adopts ──▶ ADOPTED ──▶ MEASURING ──▶ MEASURED_EFFECTIVE
    │                         (auto)        │              MEASURED_NO_EFFECT
    └── user dismisses ──▶ DISMISSED        └─ window incomplete → stays MEASURING
        (cool-down; auto-adopt detection can revive D1-class recs)
```

- Adoption is manual (FR-REC-104), except detectors with an auto-detectable adoption signal (D1's inventory-hash change) which prompt "looks adopted — start measuring?".
- `EffectMeasurer`: before window = trailing N wks pre-adoption (default 2); after window = N wks post; compares `target_metric`; records `before/after n`, delta, verdict (`EFFECTIVE` if delta exceeds a per-metric materiality threshold with adequate n, `INCONCLUSIVE` if n insufficient). No causal claim beyond before/after — displayed as such ("measured change after adoption," concurrent-change caveat shown when multiple adoptions overlap the same target metric).
- Measured results display next to the recommendation and roll into a per-detector track record (credibility display), and into the pilot's §15 success criteria.

## 5. Test cases

1. D1 fires on fixture inventory; modeled formula reproduces the review's $/wk arithmetic from its inputs.
2. Detector cool-down honored; strengthened evidence re-raises early.
3. Tier 2: valid output accepted; fabricated `metric_id` rejected; value off by >5% flagged; duplicate-of-D4 (routing) merged into detector.
4. Content-exclusion: v1 pack builder output contains no content-typed fields (schema test).
5. Spend cap blocks a run; partial-failure run records cost-so-far.
6. Adoption → windows → verdict transitions incl. `INCONCLUSIVE` on small n; overlapping adoptions flag the concurrency caveat.
7. "Achieved savings" surface sums only `EFFECTIVE` effects; modeled totals never appear in it.

---

## Change log

- 2026-08-21 (Session 12): D1 modeled-savings example corrected from `$875/wk` (misattributed; belongs to D2) to ≈ `$45/wk`; scenario relabeled — source: FW-03 / SG-S5-01
- 2026-08-21 (Session 12): Added forward-looking note to D1: trigger (>40k tokens OR >25% avg context) is met by no current workspace; D1 is not presently actionable for this user — source: SG-S5-02
- 2026-08-25: Economic-model correction (external research pass, briefs A/B). D1 downgraded from "biggest lever" to **secondary** — cache reads count against the cap at ~0.1× (unverified), not full weight; D1 modeled savings below are full-weight. New primary detectors (cache-miss/write churn, TTL-regime, tool-result bloat, idle-session, retry-loop) + a cap-weighted meter + D4 advisory-gate to be specced here when built — source: `spec-recommendations-engine.md` §W0
- 2026-08-25 (W0 spec pass): **detectors made build-ready.** Added §2.0 **detector-id reconciliation** (runtime ids frozen for the fired D1/D2/D4/D5 because `rec_id`/`detector_id` persist them; spec-D3 routing concept realized at runtime `D4`, **advisory-gated**; spec-D4 cache-write-churn renumbered to a fresh **D8** to avoid the shipped-D4 collision; spec-D3 **retired**; `registry.ts` stale placeholder names to reconcile at build). Wrote six-field contracts with UNVALIDATED thresholds in **cap-weighted** terms for **D8 `CACHE_WRITE_CHURN`** (flagship; **TTL 5m/1h is a facet of D8**, not a separate detector) and **D6 `TOOL_RESULT_BLOAT`** (per-turn grain; per-tool attribution flagged as future ingestion since `tool_events.result_bytes` is `NULL`); added **D9 `IDLE_BACKGROUND_SESSION`** (buildable on `is_sidechain` share; strict "no-user-turn" form needs user-turn ingestion). Gated **D4** routing to advisory (conditional lever + crisp savings suppressed until `/usage`). Flagged **D7 `LOOP_RETRY_WASTE`** **BLOCKED** — `tool_events.input_hash`/`exit_class` and tool `file_path` are not ingested (`ingestor.ts:372-373`, `parser.ts:217`); future-ingestion task, out of W0.2 scope — source: `recommendations-improvement-v2.md` §W0 + research briefs A/B + `docs/handoffs/2026-08-25-w0-detector-spec-pass.md`
- 2026-08-26: Reserved **D11 `EFFORT_MISMATCH`** after shipped D10 and marked it **BLOCKED**. Effort is observable, but thinking is not separable from visible `output_tokens`, task complexity is absent, and 98.6% of labeled turns are `high`; no selective threshold or savings claim is defensible without the documented calibration gate.
- 2026-08-26: Added a **subagent-routing facet to D4** (reserved) and reserved **D12 `FORK_CONTEXT_INHERITANCE`** (BLOCKED on issue #32175 parent↔child linkage). Both trace to the Codex "55 recon agents on Sol" finding — source: `docs/plans/2026-08-26-subagent-routing-finding-intake.md`.
