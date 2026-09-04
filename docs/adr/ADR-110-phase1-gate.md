# ADR-110: Phase-1 Gate — GO with conditions

**Status:** Accepted · **Date:** 2026-08-21 · **Reconciled:** 2026-08-26
**Decision:** **GO for Phase 1a, with named conditions.** `src/` opens. Session 10 / ADR-106 and COND-4 have passed; Session 9 / COND-1 and outcome-linkage COND-3 remain evidence-gated. Wave 2 preparation is approved only within the exact envelope recorded in `docs/plans/spec-evidence-campaigns.md`.

## Context

Session 12 is the terminal pre-implementation session and the only one authorized to edit `docs/planning/*`. It folds the accepted spike ADRs (101/102/103/105/107), the adversarial review (`.claude/audits/v0_7-adversarial-review.md`), and the S11 wireframes findings (`docs/design/wireframes-v1.md` §7/§10.1) into v0.7.1 / v4.5.1 doc patches, consolidates the open register (`docs/planning/OPEN-QUESTIONS.md`), and issues this gate.

At the original gate, S4 findings precision and S6 Tier-2 were resource-blocked and unrun. S6 later passed under accepted ADR-106. S4 remains data-insufficient, although its exact preparation campaign is now approved; no packet, adjudication, or precision result exists yet.

## Spike exit-criteria scorecard

| Spike | Exit criterion | Verdict |
|---|---|---|
| S0 | Harness proof (2/2) | **PASS** |
| S1 (ADR-101) | Transcript fidelity; spec-field presence; review-reproduction exact | **PASS** |
| S2 (ADR-102) | Live-tail latency (NFR-103), rotation/truncation, back-scan (NFR-104), rebuild equality (NFR-107) | **PASS** (4/4) |
| S3 (ADR-103) | Linkage ≥80% & precision ≥95% | **PARTIAL → EXPERIMENTAL** — precision ~100% PASS; linkage 73% FAIL. Outcome metrics ship `EXPERIMENTAL` until branch-name method (SG-02) lifts linkage ≥80%. |
| S5 (ADR-105) | attribution_version 1 with error bar; D1 arithmetic reproduces review figure | **PASS** (D1 validated $874.17 vs $875) |
| S7 (ADR-107) | Trailing-rate forecast; Day-3 warning; C-02 clamp | **PASS** |
| S11 (wireframes v1) | 4 PRD §11 surfaces on real spike data; findings recorded | **PASS** |
| **S4 (Session 9 → ADR-104)** | Per-extractor precision ≥0.8 (E1/E2/E3) | **PENDING** — see COND-1 |
| **S6 (Session 10 → ADR-106)** | Contract-valid ≥80%; per-run cost; failure modes | **PASS / RESOLVED** — 10/10 contract-valid runs (100%), average $0.0124/run, with documented failure modes under the $5 cap. |

## CRITICAL adversarial findings + open questions

| id | Resolution |
|---|---|
| C-01 (sidechain double-count) | **RESOLVED AND EMPIRICALLY VERIFIED** — ADR-101's count + `is_sidechain` flag + global `message.id` dedup is covered by synthetic parser projection and exact-once ingestion fixtures. |
| C-02 (burn-forecast past-date when exceeded) | **RESOLVED** in ADR-107 §D-5 (`EXCEEDED` state → NULL ETA). |
| C-03 (cost-per-success double-count on many-to-many links) | **RESOLVED this session** — cost-per-success restricted to 1:1-linked sessions + displayed `excluded_multilink_n` exclusion note (Data Model). |
| OQ-01 (UNLINKED stored vs implicit) | **RESOLVED this session** — implicit (absence of a `session_work_links` row); denominator excludes unlinked. |
| OQ-02 (REST vs GraphQL) | **RESOLVED** in ADR-103 §D-5 (GraphQL for `isResolved`, hybrid client). |
| OQ-03 (`cache_write_other` pricing) | **RESOLVED** in ADR-101 (priced at 5m rate). |
| OQ-04 (recommendation_effects cardinality) | **RESOLVED this session** — composite PK `(rec_id, measured_at)` now, enabling re-measurement across adoption cycles. |
| OQ-05 (no-CI success rate) | **RESOLVED this session** — separate `no_ci_success_n` annotation, not folded into success. |

## Disposition summary

28 open items (deduped from S1–S7 gaps G-*/SG-*, S11 FW-01..12, and audit C-*/OQ-*). Buckets:
- **6 RESOLVED-in-ADR** — cited above; no new action.
- **18 FIX** — applied this session as v0.7.1/v4.5.1 spec patches with sourced change-log entries (Data Model v2, Ingestion & Findings v1, Recommendations Engine v1, Technical Architecture v4.5.1, PRD v0.7.1, ADR-100 cross-ref). Every change traces to a numbered source.
- **4 DEFER + Phase-1 obligations** — recorded in `docs/planning/OPEN-QUESTIONS.md` with owner / blocks-what / default.

## Verdict: GO with conditions

Phase 1a implementation may begin; `src/` opens. The following conditions ride the gate and must be tracked:

- **COND-1 — Session 9 / S4 (ADR-104).** **PREPARATION APPROVED; EVIDENCE STILL DATA-INSUFFICIENT.** Findings and deferral-rate metrics remain `EXPERIMENTAL` until each extractor clears ≥0.8 precision on every emitted finding in the frozen allowlisted full merged-PR corpus. The historical 219-PR count and E1 expectation of about four findings are planning context only. A non-sparse extractor result requires at least 20 emitted findings and uses the fixed limitation vocabulary. One adjudicator is approved at five minutes per finding within the exact Wave 2 envelope; promotion is not approved.
- **COND-2 — Session 10 / S6 (ADR-106).** **PASSED / RESOLVED.** The accepted contract achieved 10/10 valid runs at an average $0.0124/run with documented failure modes under the $5 cap. Tier-2 remains `EXPERIMENTAL` for breadth, not resource-blocked.
- **COND-3 — Outcome-metric EXPERIMENTAL tag.** S3 linkage is 73% (<80%). Outcome metrics carry `EXPERIMENTAL` until the branch-name (`BRANCH`) linkage method (SG-02) lifts coverage ≥80%.
- **COND-4 — C-01 verification.** **PASSED / RESOLVED.** Synthetic `isSidechain=true` fixtures exercise parser projection and exact-once ingestion/deduplication.

**Re-issue rule:** this reconciliation folds ADR-106 and COND-4 into the scorecard. Re-issue again when the approved Session 9 / COND-1 campaign produces an adjudicated result.

## First three Phase-1a implementation prompts (titles + one-line scopes)

To be drafted with the prompt-writer, then built under `src/`:

1. **Ingestion pipeline** — JSONL streaming + incremental file tail + parser (per ADR-101/102): quarantine bad JSON (pointer only), 5m/1h cache-write pricing split, provisional→reconciled transition, rebuild-equality test.
2. **Spend queries + LocalQueryAPI** — `cost_equiv_usd` (global + per-workspace), context-attribution reads, served read-only over 127.0.0.1; no transcript content leaves the box.
3. **Overview spend views** — the wireframes-v1 Overview surface (spend cards, workspace comparison table, live strip) wired to the spend metrics; honesty rules (live vs reconciled, N/A rendering).

## Opus disposition (2026-08-21)

Accepted as GO-with-conditions under Path B (user decision). Genuine gate decisions (OQ-04 composite PK, C-03 1:1 restriction) taken with the user; OQ-01/OQ-05 and the FW-06/07/08 design decisions adopted per the S11 recommendations. Session 10 later passed and COND-4 is empirically verified. Session 9 preparation is approved but its runners, packet, adjudication, and result remain unfinished; COND-1 and COND-3 therefore remain active.
