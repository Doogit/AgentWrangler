# AgentWrangler — Phase 0 Spike Execution Plan v2.0

**Date:** 2026-08-21 · **Status:** Ready to execute · **Supersedes v1.0 for MVP scope** (v1.0 spikes S1–S9 are shelved with the P1 governance layer and resume at P1 promotion) · **Companions:** PRD v0.7.0 §17, Architecture v4.5.0 §17

Rules carried from v1: hard timeboxes, every spike ends in an ADR (same template), spike code disposable unless promoted, pins recorded. Reference environment: the operator's own machine and transcript corpus (26 project dirs, ~16k turns) — the MVP's data is already on disk, so spikes validate against reality, not fixtures.

## Spikes

| # | Spike | Question | Timebox | Depends |
|---|---|---|---|---|
| S0 | Stack ADR | Confirm TS/Node + better-sqlite3 + Tauri (or document deviation); note P1 daemon may differ; SQLite schema + LocalQueryAPI are the stable seams | 1 d | — |
| S1 | Transcript fidelity | Does the v2 parser reproduce the 2026-08-21 review's numbers from the same corpus (dedupe tolerance)? Are sidechain markers, command events, tool sizes, commit SHAs, and the 5m/1h cache split reliably extractable? What schema variance exists across Claude Code versions in the corpus? | 3 d | S0 |
| S2 | Live tail | Offsets, partial lines, rotation, concurrent sessions, LIVE detection latency vs NFR-103; back-scan time vs NFR-104 | 2 d | S1 |
| S3 | Outcome linkage accuracy | SHA-overlap linkage on the past month of real history: linkage rate ≥80%, link precision ≥95%? Where does branch-method help? | 4 d | S1 |
| S4 | Findings precision | E1/E2/E3 against a 20-PR manual audit: per-extractor precision ≥0.8? Reasonable recall report | 3 d | S3 |
| S5 | Context attribution | Tokenizer choice; attribute always-loaded files + tool-result sizes to the per-turn baseline; reconcile against observed context/turn within a stated error bar; fix `attribution_version = 1` | 3 d | S1 |
| S6 | Tier 2 contract | Evidence-pack size in practice; contract-valid output rate across ≥10 runs on the candidate cheap model; citation-resolution failure modes; cost per run | 3 d | S1, S5 |
| S7 | Limit observability | Is there an official usage/limit signal (endpoint, headers, local files)? Else: fit the trailing-rate model to the week that exhausted the limit — would it have warned by day 3? | 2 d | S1 |

Sequencing: S0 → S1 → {S2, S3, S5, S7} parallel → S4 (after S3), S6 (after S5). Critical path ≈ **2–3 weeks** with 1–2 engineers. Ingestion + spend views (Phase 1 start) can begin the moment S1/S2 pass — they don't wait for S3–S7.

## Exit criteria

**S0.** ADR-100 accepted; repo scaffold with the chosen stack builds a hello-world daemon + UI shell.  
**S1.** ADR: parser v1 fixed. Evidence: model/day/project/project×model tables match the review within dedupe tolerance (documented delta); field-extraction coverage stats; schema-variance inventory across the corpus; turn-class threshold calibrated from the corpus' output distributions (data-model open item 2).  
**S2.** ADR: tail design fixed. Evidence: live turn latency ≤60 s measured during a real session; rotation test; back-scan of full corpus timed; rebuild-equality demonstrated.  
**S3.** ADR: linkage v1 fixed with measured rate/precision; below-target ⇒ outcome metrics ship `EXPERIMENTAL` and the ADR states the improvement path.  
**S4.** ADR: extractor set fixed with per-extractor precision; sub-0.8 extractors flagged `EXPERIMENTAL` and excluded from deferral denominators.  
**S5.** ADR: `attribution_version 1` fixed with stated error bar; D1's modeled-savings formula validated against the review's $875/wk arithmetic.  
**S6.** ADR: prompt `rec-analysis-v1` + model choice fixed. Evidence: ≥80% contract-valid runs, per-run cost, tolerance setting justified by observed citation drift.  
**S7.** ADR: forecast model fixed (observed-signal or trailing-rate); backtest shows a ≥day-3 warning on the exhaustion week, or documents why not and what margin is achievable.

## Phase 1 gate

Phase 1 slice order (ship value early): **(a)** ingestion + spend views after S1/S2 → **(b)** live strip + forecast after S7 → **(c)** outcomes + findings after S3/S4 → **(d)** detectors + effects after S5 → **(e)** Tier 2 after S6. The full MVP gate = all ADRs accepted + the §15 PRD success-criteria harness in place (report-reproduction test, rebuild-equality test, reconciliation tests).
