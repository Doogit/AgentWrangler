# AgentWrangler — Pre-Implementation Plan v1.0

**Date:** 2026-08-21 · **Status:** Ready to execute in Claude Code · **Companions:** Spike Plan v2 (exit criteria are authoritative), PRD v0.7.0, Architecture v4.5.0

This plan converts the pre-implementation sequence into discrete Claude Code sessions with paste-ready prompts. Prompt formats follow your `prompt-writer` (Template A) and `prompt-auditor` (Template C) skills; spike sessions use the **Spike Convention** below (Template C + a scratch-code carve-out).

---

## 0. Before any session — user actions checklist

| # | Action | Blocks | Default if undecided |
|---|---|---|---|
| U1 | Choose OSS license | Session 2 | Apache-2.0 (matches ecosystem norms; patent grant) |
| U2 | Create **fine-grained read-only** GitHub token (PRs, checks, contents: read) for your 2–3 active repos; store in your OS keychain, note the keychain ref | Session 7 | — |
| U3 | Confirm Anthropic API key available for Tier 2 spike + set a spike spend cap | Session 10 | $5 cap |
| U4 | Block 1 hour for the 20-PR manual findings audit | Session 9 | — |
| U5 | Privacy ground rule: spikes read real transcripts locally; **committed artifacts contain aggregates/ids only, never content** (SEC-101 discipline starts in spikes) | All | Non-negotiable |

## 1. Session map

| Session | Name | Template | Spike | Depends | Output |
|---|---|---|---|---|---|
| 1 | Stack ADR | C (design) | S0 | — | `docs/adr/ADR-100-stack.md` |
| 2 | Repo scaffold | A | S0 | 1, U1 | repo skeleton, CI, license |
| 3 | Adversarial review of v0.7 docs | C (empirical) | — | — (fresh session; parallel) | `.claude/audits/v0_7-adversarial-review.md` |
| 4 | Transcript fidelity | Spike Conv. | S1 | 2 | `spikes/s1/` findings + `ADR-101-parser.md` |
| 5 | Live tail | Spike Conv. | S2 | 4 | `ADR-102-tail.md` |
| 6 | Limit backtest | Spike Conv. | S7 | 4 | `ADR-107-forecast.md` |
| 7 | Outcome linkage | Spike Conv. | S3 | 4, U2 | `ADR-103-linkage.md` |
| 8 | Context attribution | Spike Conv. | S5 | 4 | `ADR-105-attribution.md` |
| 9 | Findings precision | Spike Conv. | S4 | 7, U4 | `ADR-104-findings.md` |
| 10 | Tier 2 contract | Spike Conv. | S6 | 4, 8, U3 | `ADR-106-tier2.md` |
| 11 | Wireframes | C (design) | — | 4 (real data) | `docs/design/wireframes-v1.md` |
| 12 | Consolidation + Phase 1 gate | C | — | all | open-questions register, doc patches, gate verdict |

Parallelism: after Session 4, run 5/6/7/8 in any order (separate sessions); 3 runs any time in a **fresh context** (it must not share a session with authoring work). Calendar ≈ 2–3 weeks.

## 2. Repo layout (established in Session 2)

```text
agentwrangler/
  LICENSE  README.md  CLAUDE.md          # CLAUDE.md deliberately minimal — dogfood detector D1
  docs/planning/                         # all 8 v0.7-era docs + preserved v0.6.3 / v4.4.3
  docs/adr/                              # ADR-100..; template from Spike Plan v1 §4
  docs/design/
  spikes/s1-transcript-fidelity/ ... s7-limit-backtest/   # disposable by default
  src/                                   # EMPTY until Phase 1 gate passes
  .claude/audits/  .claude/prompts/      # session prompts + outputs live in-repo
```

Convention: paste each prompt below into a **new** Claude Code session started at repo root; also save it to `.claude/prompts/session-NN.md` so the session log is reproducible.

## 3. Spike Convention (applies to Sessions 4–10)

Amendments to Template C, stated in every spike prompt:

- MAY create disposable scripts **only under `spikes/sNN-*/`**. NO files under `src/`. No dependencies added to any root manifest; spike-local `package.json` only.
- Reads of `~/.claude/projects/**` are permitted; **no transcript content may appear in any committed file, findings doc, or console output pasted into artifacts** — aggregates, counts, ids, hashes only (U5).
- The session ends by writing the findings doc **incrementally per step**, then the ADR, then stops. No "while I'm here" implementation.
- Exit criteria are copied verbatim from `docs/planning/AgentWrangler_Spike_Plan_v2.md` — the spike passes or the ADR says why not and what changes.

---

## 4. Session prompts

### Session 1 — Stack ADR (S0)

```text
# Design: ADR-100 — MVP implementation stack

**Mode:** Design
**Output:** docs/adr/ADR-100-stack.md
**Feeds into:** Session 2 (repo scaffold)

## Constraints
- READ ONLY except creating the output file (and docs/adr/ if absent).
- Do not scaffold code. Do not install anything.
- Timebox: this is a 1-day decision, not research. Decide from the stated drivers.

## Objective
Confirm or refute the presumptive stack (TypeScript/Node daemon + better-sqlite3 +
Tauri shell, Electron acceptable) and record it as ADR-100.

## Context
Load in order:
1. docs/planning/AgentWrangler_Technical_Architecture_v4_5_0.md — §16 (stack drivers), §18 AD-110
2. docs/planning/AgentWrangler_Spike_Plan_v2.md — S0 exit criteria, ADR template (v1 §4 referenced there)
3. docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md — §1 headers only (what the DB layer must support)

Confirmed decisions (do not re-open):
- SQLite + direct SQL; single daemon; no rollup workers (AD-107)
- SQLite schema + LocalQueryAPI are the stable seams; a future P1 daemon may be a different language (AD-110)
- The Rust-vs-Go analysis from v4.4.x is obsolete for MVP — do not relitigate it

## Step 1: Decision (design)
Work only from: JSONL streaming, incremental file tailing, GitHub REST/GraphQL,
tokenizer availability, desktop shell footprint, reuse of the operator's proven
Node scripts, single-binary-ish distribution.
Evaluate: (a) TS/Node + better-sqlite3 + Tauri, (b) same + Electron, (c) one
credible alternative only if a driver above genuinely fails under (a)/(b).
Write ADR-100 using the standard template: question, options, evidence,
decision, consequences (incl. pinned major versions to use in Session 2),
revisit trigger.

## Final Output
- Path to ADR-100
- Open questions requiring human decision (state "None" if none)
- Handoff: Session 2 must read ADR-100 first.
```

### Session 2 — Repo scaffold (S0 completion)

```text
# Implementation: Repository scaffold per ADR-100

## Constraints
- Branch required: no — this is the initial commit series on main.
- Do not touch: nothing exists yet; create ONLY what is listed. src/ stays EMPTY
  except a .gitkeep.
- CLAUDE.md must be ≤ 40 lines. This project ships a detector (D1) that flags
  oversized always-loaded context; we will not be its first offender.
- License: [U1 decision — default Apache-2.0].

## Objective
Initialize the repo so every later session has a stable home: docs imported,
ADR/spike/prompt directories, minimal CI, hello-world daemon+shell proving the
ADR-100 toolchain builds.

## Context
Load in order:
1. docs/adr/ADR-100-stack.md — stack + pinned versions (if docs aren't imported yet, read it from the staging folder listed below)
2. AgentWrangler_PreImplementation_Plan_v1.md §2 — target layout

Current state: planning docs exist as loose files in [FOLDER — fill in where you
saved the doc set]; no repo structure.

## Pre-flight Checks
- [ ] `git rev-parse --is-inside-work-tree` — expected: true (else `git init` and continue)
- [ ] node --version matches ADR-100 pin — if FAIL: stop and report.

## Task 1: Structure + docs import
Create the §2 layout. Copy all planning docs (v0.7 set, preserved v0.6.3 PRD +
v4.4.3 architecture, Agent Interaction Design v1, Consequential Action Spec v1,
Spike Plan v1) into docs/planning/. Add LICENSE, README.md (one paragraph +
doc index), .gitignore (node, spike scratch DBs, .claude/local).

## Task 2: CLAUDE.md (minimal)
Contents only: project one-liner; doc index table (path + one-line purpose — no
changelog prose); the Spike Convention rules; "src/ is empty until the Phase 1
gate"; pointer to .claude/prompts/ for session logs.

## Task 3: Toolchain proof
Per ADR-100: minimal daemon entrypoint printing version + opening an in-memory
better-sqlite3 DB; shell hello-window; CI workflow running lint + the daemon
smoke test. No product code.

## Verification Checklist
- [ ] Layout matches plan §2: `find . -maxdepth 2 -type d | sort` → expected list
- [ ] `wc -l CLAUDE.md` → ≤ 40
- [ ] CI passes locally: [exact command per ADR-100 toolchain]
- [ ] Docs index in README links resolve: `ls docs/planning | wc -l` → expected count

## Final Output
Files created; verification outputs; commit list; handoff: Session 4 reads
docs/planning/AgentWrangler_Ingestion_and_Findings_Spec_v1.md first.
```

### Session 3 — Adversarial review of the v0.7 doc set (fresh session, run in parallel)

```text
# Audit: Adversarial review — AgentWrangler v0.7 planning set

**Mode:** Empirical
**Output:** .claude/audits/v0_7-adversarial-review.md
**Feeds into:** Session 12 (consolidation)

## Constraints
- READ ONLY. Do not edit any planning doc.
- Review the documents as written; do not assume unstated author intent.
- Findings must cite doc + section. Severity per finding: CRITICAL (blocks
  Phase 1) / SIGNIFICANT (fix in a point release) / MINOR.
- Do not re-open the scope pivot itself (governance deferred to P1 is settled),
  and do not propose scope expansion.

## Objective
Independent adversarial pass over the v0.7 set — seam consistency, unverified
assumptions, metric-contract soundness, privacy holes, and missing failure
modes — mirroring the review rigor the v0.6.x docs received.

## Context
Load in order:
1. docs/planning/AgentWrangler_PRD_v0_7_0.md
2. docs/planning/AgentWrangler_Technical_Architecture_v4_5_0.md
3. docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md
4. docs/planning/AgentWrangler_Ingestion_and_Findings_Spec_v1.md
5. docs/planning/AgentWrangler_Recommendations_Engine_Spec_v1.md
6. docs/planning/AgentWrangler_Spike_Plan_v2.md

## Step 1: Cross-document seam check (empirical)
Enum/state/id consistency across docs (outcome states, finding sources, cost
claims, FR/SEC/NFR references); lifecycle coverage (every state reachable and
terminal-handled); metric denominators vs schema fields (can every §9 PRD metric
be computed from the v2 DDL as written?). Write Section 1 before continuing.

## Step 2: Assumption hunt (empirical)
List every claim about external systems (transcript fields, GitHub API
capabilities, tokenizers, limit signals) and classify: verified by cited
evidence / covered by a named spike / UNCOVERED. Section 2.

## Step 3: Failure-mode and privacy probe (empirical)
Attack the honesty-of-numbers and SEC-101/104/107 rules: find a path by which
content could reach the DB, an aggregate could silently drop data, or modeled
savings could masquerade as measured. Section 3.

## Step 4: Verdict (design)
Findings table (id, severity, doc§, description, proposed disposition);
overall verdict: fit for Phase 1 after listed fixes, or not.

## Final Output
Path to audit file; count by severity; open questions for the human; recommended
disposition order for Session 12.
```

### Session 4 — Spike S1: Transcript fidelity (critical path)

```text
# Audit/Spike S1: Transcript fidelity against the real corpus

**Mode:** Empirical → Design  ·  **Spike Convention applies** (scratch code in
spikes/s1-transcript-fidelity/ only; NO transcript content in any artifact)
**Output:** spikes/s1-transcript-fidelity/FINDINGS.md + docs/adr/ADR-101-parser.md
**Feeds into:** Sessions 5–10; Phase 1a

## Constraints
- READ ONLY outside spikes/s1-transcript-fidelity/.
- Artifacts contain aggregates, field names, counts, ids, hashes — never message
  content, prompts, code snippets from transcripts, or file bodies.
- If a field assumed by the specs is absent from the corpus, document the gap —
  do not invent a fallback silently; propose it in the ADR.

## Objective
Prove (or correct) the ingestion spec's data-availability assumptions on the
real corpus, and reproduce the 2026-08-21 review's numbers with the v2 parser
rules. This is the go/no-go for the outcome layer's data assumptions.

## Context
Load in order:
1. docs/planning/AgentWrangler_Ingestion_and_Findings_Spec_v1.md — §1 (record fields, rules)
2. docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md — turns/tool_events DDL
3. docs/planning/AgentWrangler_Spike_Plan_v2.md — S1 exit criteria (authoritative)
4. docs/planning/token-usage-review-2026-08-21.md — §1 method + §3 tables (the reproduction target); import this file into docs/planning/ if not present

Known state: the review counted 11,751 in-window turns across 26 project dirs
using mtime-skip; v2 forbids mtime-skip for correctness.

## Pre-flight Checks
- [ ] `ls ~/.claude/projects | wc -l` — expected ≥ 20; if 0: stop, wrong machine.
- [ ] `ls spikes/s1-transcript-fidelity/` — create if absent.

## Step 1: Schema census (empirical)
Script: stream every .jsonl line across the full corpus (no window filter).
Emit to FINDINGS.md §1: record-type distribution; per-field presence rates for
every field named in the ingestion spec (usage fields incl. cache_creation
5m/1h split, message.id/uuid, sessionId, model, sidechain markers, tool
use/result blocks + sizes, command events, commit SHAs in tool metadata);
distinct schema variants (field-set hashes) and their date ranges; parse-failure
count by error class. Aggregates only.

## Step 2: Review reproduction (empirical)
Re-implement the §1 pricing + dedupe rules; window 2026-08-14→21. Compare
model/day/project totals against the review's §3 tables. Document deltas and
attribute each (mtime-skip vs full scan, dedupe, synthetic handling). FINDINGS §2.

## Step 3: Derived-signal viability (empirical)
Measure extraction rates for: commit SHAs per session (sessions with ≥1 SHA),
sidechain turn share, command events (/clear, /compact) per session, tool_result
byte sizes. Calibrate the mechanical-turn heuristic threshold from the corpus'
per-model output-token distribution (data-model open item 2). FINDINGS §3.

## Step 4: ADR-101 (design)
Fix parser v1: required vs optional fields, variant handling, quarantine
classes, dedupe key policy, calibrated threshold; state which spec assumptions
FAILED and the concrete spec edits needed (list for Session 12 — do not edit
specs here). Map results to the S1 exit criteria: PASS/FAIL each.

## Final Output
Paths; S1 exit-criteria scorecard; spec-impacting gaps; open questions; handoff:
Sessions 5–8 read FINDINGS.md §1 + ADR-101 first.
```

### Sessions 5–10 — remaining spikes (compact prompts, same convention)

Each uses the Session 4 prompt as the structural model: same constraints block, context load = the relevant spec sections + `Spike Plan v2` exit criteria + `spikes/s1/FINDINGS.md` + prior ADRs, steps per the Spike Plan, findings doc written incrementally, ADR last, exit-criteria scorecard in the final output. Deltas per session:

```text
Session 5 — S2 Live tail → ADR-102
  Scratch dir spikes/s2-live-tail/. Steps: offset-persisting tailer prototype
  against a LIVE real session (run one deliberately); measure turn→visible
  latency (target ≤60s); rotation/truncation test on a COPY of a transcript in
  the scratch dir (never touch originals — hard stop condition); full-corpus
  back-scan timing; rebuild-equality (two scans, identical aggregates).

Session 6 — S7 Limit backtest → ADR-107
  Steps: (empirical) search for any official usage/limit signal — API headers,
  local Claude Code state files, documented endpoints; web research allowed,
  cite sources. (empirical) Fit the trailing-rate model to the exhaustion week
  in the corpus; compute the earliest day a ≥24h warning would have fired.
  (design) ADR fixes the forecast model + parameters; PASS requires a ≤day-3
  warning on the backtest or a documented achievable margin.

Session 7 — S3 Outcome linkage → ADR-103   [needs U2 token]
  Scratch dir spikes/s3-linkage/. Stop condition: token must be read-only;
  verify scopes via the API before any other call, else stop. Steps: pull the
  past month of PRs/checks/review threads for the 2–3 mapped repos (GraphQL for
  thread resolution — confirm availability + rate-limit cost, per the plan's
  named risk); harvest session SHA sets per ADR-101's method; run the linkage
  algorithm; manually adjudicate a 25-link sample for precision. PASS: ≥80%
  linkage, ≥95% precision; else ADR states the EXPERIMENTAL label + improvement path.

Session 8 — S5 Context attribution → ADR-105
  Steps: tokenizer selection (measure agreement of candidates on the corpus'
  CLAUDE.md files); probe always-loaded files for each workspace; reconcile
  attributed baseline vs observed context/turn, state the error bar; validate
  detector D1's modeled-savings arithmetic reproduces the review's $875/wk
  figure from its recorded inputs. ADR fixes attribution_version 1.

Session 9 — S4 Findings precision → ADR-104   [needs Session 7 + U4]
  Steps: run extractors E1/E2/E3 on the last 20 merged PRs; produce a blinded
  adjudication sheet (finding, source, evidence_ref — no verdict column filled);
  PAUSE for the human 1-hour audit; resume: compute per-extractor precision +
  recall notes. PASS gate ≥0.8 precision per extractor; failures ship
  EXPERIMENTAL per the spec. (Two-part session: end part 1 at the pause with a
  handoff; part 2 is a resume.)

Session 10 — S6 Tier 2 contract → ADR-106   [needs U3; spend cap enforced]
  Scratch dir spikes/s6-tier2/. Stop condition: abort when cumulative spike
  spend reaches the U3 cap; report cost-so-far. Steps: build the evidence-pack
  builder against S1/S5 outputs (schema test: no content-typed fields); run
  rec-analysis-v1 ≥10 times on the candidate cheap model; validate outputs
  against the contract (schema + citation resolution at ±5%); tabulate
  contract-valid rate (PASS ≥80%), per-run cost, and failure modes; ADR fixes
  prompt version, model, tolerance.
```

### Session 11 — Wireframes (after S1; real data available)

```text
# Design: Dashboard wireframes v1

**Mode:** Design  ·  **Output:** docs/design/wireframes-v1.md (+ optional static
HTML mockups under docs/design/mockups/ — no product code, no src/)
**Feeds into:** Phase 1 UI build

## Constraints
- READ ONLY outside docs/design/.
- Populate every mockup with REAL aggregate values from spikes/s1/FINDINGS.md —
  no lorem-ipsum numbers. No transcript content.
- Every widget must name its metric_definition_version source; if a widget has
  no backing metric in the v2 data model, that is a finding, not a license to invent one.

## Objective
Wireframe the four surfaces (Overview, Workspaces incl. session detail,
Recommendations, Settings) per PRD §11, proving the hierarchy and honesty rules
(live vs reconciled, N/A rendering, clean/with-deferrals split, drill-down affordances).

## Context
1. docs/planning/AgentWrangler_PRD_v0_7_0.md — §11 + FR-UI-101..106
2. docs/planning/AgentWrangler_Data_Model_and_Metrics_v2.md — metric outputs
3. spikes/s1-transcript-fidelity/FINDINGS.md — real values
4. docs/planning/AgentWrangler_Recommendations_Engine_Spec_v1.md — card fields

Steps: 1 Overview (cards, workspace comparison table, live strip) · 2 Workspace
+ session detail (turn timeline, hygiene flags, loop annotations) · 3
Recommendations (proposal card with evidence/modeled/measured separation,
Analyze-with-Claude flow incl. displayed cost) · 4 Settings (parser health,
connections, caps, privacy toggles) · 5 traceability check: widget ↔ metric
table both directions (FR-UI-101/§20.5 lineage).

## Final Output
Paths; widgets lacking a backing metric (findings); open questions; handoff to
Phase 1 UI.
```

### Session 12 — Consolidation and Phase 1 gate

```text
# Audit/Design: Pre-implementation consolidation + Phase 1 gate

**Mode:** Empirical → Design
**Output:** docs/planning/OPEN-QUESTIONS.md, docs/adr/ADR-110-phase1-gate.md,
and point-release patches to the v0.7 docs (v0.7.1 / v4.5.1 with change logs)
**Feeds into:** Phase 1a implementation prompts

## Constraints
- Doc edits are IN scope (the one session allowed to modify docs/planning);
  src/ remains untouched.
- Every doc change traces to a numbered source: an ADR, an adversarial-review
  finding id, or a spike FINDINGS section. No editorial drift.
- Confirmed decisions in accepted ADRs are not re-opened.

## Objective
Fold spike ADRs + the adversarial review into the doc set, consolidate scattered
open items into one register with owners, and issue the Phase 1 go/no-go.

## Context
1. All docs/adr/ADR-10x files
2. .claude/audits/v0_7-adversarial-review.md
3. All spikes/*/FINDINGS.md (final sections only)
4. docs/planning/AgentWrangler_Spike_Plan_v2.md — Phase 1 gate definition

Steps: 1 (empirical) disposition table — every review finding and every
FAILED/amended spec assumption → accept/fix/defer with target doc§ · 2 (design)
apply fixes as v0.7.1/v4.5.1 with change-log entries citing sources · 3 (design)
OPEN-QUESTIONS.md: consolidate items from data-model §4, ingestion spec,
rec-engine spec, and all ADR open questions — columns: id, question, owner
(human/session), blocks-what, default · 4 (design) ADR-110: gate scorecard
(all S-spike exit criteria + CRITICAL review findings resolved) → GO / NO-GO
with conditions; if GO, list the first three Phase 1a implementation prompts to
write next (ingestion pipeline, spend queries + LocalQueryAPI, Overview spend
views) — titles and one-line scopes only, drafted later with prompt-writer.

## Final Output
Paths; gate verdict; unresolved human decisions; recommended first Phase 1a
prompt.
```

---

## 5. Standing risks while executing

- **Session 3 must be context-clean** — never run the adversarial review in a session that has authored or ingested these docs' drafting history.
- **Spikes touch real data**: originals are read-only; destructive tests (rotation) run on copies in scratch dirs only; U5 applies to everything committed.
- **ADR discipline**: a spike without an accepted ADR is not done; a spike that wants to keep its code must say so in the ADR's consequences, else the code is deleted at Session 12.
- **Effect-attribution caveat carries forward**: if you adopt CLAUDE.md changes to *this* repo mid-spikes (D1 dogfooding), note the date — it will matter when the product later measures your own before/after.
