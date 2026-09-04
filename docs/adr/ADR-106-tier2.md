# ADR-106: Tier-2 cheap-model contract (rec-analysis-v1)

**Status:** accepted (EXPERIMENTAL) · **Date:** 2026-08-21
**Spike:** S6 Tier-2 · Session 10
**Decision by:** S6 spike findings (`spikes/s6-tier2/FINDINGS.md`) + Opus disposition below.
**Clears:** COND-2 of ADR-110 (Phase-1 gate). Feeds the ADR-110 re-issue.

---

## Context

S6 tested whether a **configured cheap model** can execute the `rec-analysis-v1` task
(Recommendations Engine Spec v1 §3) well enough to be trusted as **Tier-2**: given an
evidence pack, emit proposals that pass the ContractValidator (§3.4) — schema-valid,
`metric_id`s resolvable, cited values within ±5% of ground truth, `row_ref`s resolvable.
Exit gate: contract-valid ≥ 80% across ≥10 runs, plus per-run cost and failure modes.

The spike was resource-blocked on U3 (an Anthropic **console** API key, stored Generic in
Windows Credential Manager) under a hard $5 spend cap. Key stored & verified 2026-08-21;
spike ran to completion. Cumulative spend ≈ **$0.36** (cap never approached).

**Scope:** this ADR validates the **contract mechanism**, not the accuracy of the
recommendations or of the pack's own numbers. `GROUND_TRUTH` equals the pack's declared
values, so the ±5% check tests faithful copying and non-fabrication, not independent metric
accuracy. Some pack aggregates are documented estimates (see `build-pack.mjs` header).

---

## Opus disposition (2026-08-21)

- **Candidate model → PIN `claude-haiku-4-5-20251001`.** It is the only concrete cheap-model
  candidate named in the docs and the sole model exercised here. Any change of model
  re-opens this ADR.
- **Ship EXPERIMENTAL.** 100% contract-valid on a single `GLOBAL` pack, one prompt version,
  one model, is a strong PASS but a narrow one. Tier-2 ships behind an `EXPERIMENTAL` tag
  until a second pack scope (per-session / per-workspace) and a longer run are exercised in
  Phase 1. Tier-1 (D1–D7) is unaffected and does not depend on this.
- **The pack contract is now load-bearing.** The spike's central finding is that a
  `rec-analysis-v1` pack MUST expose an explicit, citeable `metrics` catalog; this is
  promoted from spike detail to a Phase-1 requirement (D-5 below).

---

## Decisions

### D-1 Contract-valid rate: **PASS**

| Metric | Value |
|---|---|
| Model | `claude-haiku-4-5-20251001` |
| Runs | 10 (`max_tokens=3072`, tolerance ±5%) |
| Contract-valid | **10/10 = 100%** (gate ≥80% → **PASS**) |
| Proposals/run | 3–5 |
| Validator negative control (spec §5.3) | **PASS** — rejects fabricated `metric_id`, value >5% off, unresolved `row_ref`; accepts clean proposal |

The negative-control self-test (`validate.mjs --selftest`) establishes the 100% is not
vacuous: the validator provably fails bad output.

### D-2 Per-run cost

| | Value |
|---|---|
| Input tokens/run | 3,149 (fixed pack) |
| Output tokens/run | 1,269–2,183 (avg ~1,842) |
| Per-run cost | avg **$0.0124** (min $0.0095, max $0.0141) |
| Pricing | Haiku 4.5 published: $1/MTok in, $5/MTok out |

Tier-2 analysis is **fractions of a cent per run** — negligible against the spend it
analyses. Cost is derivable from usage tokens × published price; no metering dependency.

### D-3 Pinned contract config (`rec-analysis-v1`)

| Parameter | Pinned value | Rationale |
|---|---|---|
| `prompt_version` | `rec-analysis-v1` | versioned; changes bump the version |
| `model` | `claude-haiku-4-5-20251001` | candidate validated here |
| `tolerance` | **±5%** | citation-resolution window (spec §3.4 default) |
| `max_tokens` | **3072** | 2048 truncated ~1/10 runs; observed max output ~2,183 |
| output parsing | **strip ```json fence before parse** | Haiku wraps output 100% of the time |
| stop-reason check | **required in Phase 1** | a length-truncated response is invalid → retry |

### D-4 Failure modes (observed)

1. **Fence-wrapping — 100%.** Not a contract violation; the parser must strip code fences.
2. **Truncation at `max_tokens=2048` — 1/10.** Cut off mid-JSON. Fixed by 3072 + a
   Phase-1 stop-reason check.
3. **Pack stripped its metric namespace — 0/10 until fixed (harness defect).** See D-5.

### D-5 A `rec-analysis-v1` pack MUST expose an explicit `metrics` catalog (Phase-1 requirement)

The first build stripped `metric_id`s from the pack, so the model cited aggregate *section*
names (`spend_by_model`) that no registry could resolve → **0/10, unwinnable by
construction**. Adding a flat `metrics: [{metric_id, value}]` catalog (the citeable
namespace) and instructing the model to cite from it lifted the rate to 100%. **Phase-1
obligation:** the pack builder and the `METRIC_REGISTRY`/`GROUND_TRUTH` must derive from one
source; the pack must carry the catalog the ContractValidator checks against.

---

## S6 Exit Criteria Scorecard

| Criterion (Spike Plan v2 L17 / OQ-S10) | Result |
|---|---|
| Contract-valid output rate across ≥10 runs (gate ≥80%) | **PASS (10/10)** |
| Per-run cost | **$0.0124 avg** |
| Citation-resolution failure modes | **Documented (D-4)** |
| Evidence-pack size in practice | **6,679 bytes** (< 20 KB target) |
| Schema test: pack has no content-typed fields (spec §5.4) | **PASS** |
| ADR fixes prompt version, model, tolerance | **Done (D-3)** |

**All S6 exit criteria: PASS.** Tier-2 ships **EXPERIMENTAL** pending Phase-1 breadth.

---

## Spec gaps / Phase-1 obligations

| # | Finding | Action |
|---|---|---|
| SG-S6-01 | Pack must expose an explicit `metrics` catalog (D-5) | Rec-Engine §3.2: require a flat citeable `metrics` catalog; registry + ground truth derive from one source |
| SG-S6-02 | Cheap model wraps output in a ```json fence 100% of the time | Rec-Engine §3.4: ingestion parser strips code fences before `JSON.parse` |
| SG-S6-03 | Length-truncation yields invalid output | Set `max_tokens` ≥ 3072 AND check the API stop reason; truncated ⇒ invalid ⇒ retry |
| SG-S6-04 | Validation breadth is narrow (1 pack, 1 model, 1 prompt) | Phase-1: exercise per-session/per-workspace packs and a longer run before lifting EXPERIMENTAL |

---

## Deferred (not S6 scope)

- Independent verification of pack metric accuracy (S6 tests the contract, not the numbers).
- The §5.3 "duplicate-of-detector merged" downstream merge behaviour (not in the spike validator).
- A/B against a second cheap model or prompt-version.
- Content-inclusion opt-in path (`analysis_runs.content_included`, SEC-104) — off by default; not needed for v1.
