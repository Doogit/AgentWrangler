# ADR-101: Parser v1 Design

**Status:** accepted · **Date:** 2026-08-21
**Spike:** S1 transcript fidelity
**Decision by:** Opus orchestrator review (4 flagged decisions resolved 2026-08-21 — see RESOLVED notes)

---

## Context

S1 empirically validated the transcript schema across 227 JSONL files / 134,622 records
from 27 project directories. All numbers grounded in the corpus; no assumptions carried forward
without evidence. Two pre-decided resolutions (OQ-03 and C-01) are implemented as specified.

---

## Decisions

### D-1 Required vs optional fields

**Finding:** All fields the ingestion spec names are present at 100% on usage records.
No fallback UUID logic is needed for `message.id`.

| Field | Required | Presence | Fallback |
|---|---|---|---|
| `message.id` | yes | 100% | top-level `uuid` if absent (see D-3) |
| `uuid` (top-level) | no (redundant) | 100% | serves as dedup fallback for `message.id` |
| `timestamp` | yes | 100% | none needed |
| `message.model` | yes | 100% | — |
| `message.usage.*` (5 fields) | yes | 100% | — |
| `cache_creation.ephemeral_5m/1h` | yes | 100% | — |
| `sessionId` OR `session_id` | yes | 100% (combined) | prefer `session_id` if present |
| `parentUuid` | optional | 100% | — |

**[FLAG-1 — RESOLVED, Opus 2026-08-21]:** Dedup key is `message.id`, **falling back to the
existing top-level `uuid`** when `message.id` is absent; quarantine (`MISSING_DEDUP_KEY`) only
when BOTH are absent. Rationale: `uuid` is present at 100% and is a stable existing field (not a
generated value — no NFR-107 violation), and this matches the proven reference-script behavior
(`message.id ?? uuid`). Quarantining on missing `message.id` alone would DROP that record's tokens
from spend totals — unacceptable for a spend tracker. Moot in the current corpus (0% missing
`message.id`), but this is the stated policy.

### D-2 Schema variant handling and quarantine classes

Five quarantine classes defined from empirical observation:

| Class | Trigger | Action |
|---|---|---|
| `JSON_PARSE_FAILURE` | Line fails JSON.parse | Quarantine with pointer; 0 in corpus |
| `MISSING_DEDUP_KEY` | `message.id` AND top-level `uuid` both absent | Quarantine; 0 in corpus |
| `MISSING_USAGE` | No `message.usage` on assistant type record | Skip (not quarantine); counted in parser health |
| `UNKNOWN_FIELD` | Field not in known schema for its variant | Tolerate silently; log distinct unknown fields to parser health |
| `SYNTHETIC_EXCLUDED` | `message.model = '<synthetic>'` | Exclude from cost; count in parser health (20 in corpus) |

Schema variant evolution is tracked by hashing sorted top-level field names (126 variants in
corpus). Variants appearing after a software update trigger an `UNKNOWN_FIELD_KIND` health event.
The two eras are: pre-2026-08-14 (no `effort`/`session_id`/`slug`) and 2026-08-14+ (adds them).

### D-3 Dedupe key policy

Primary key: `message.id` (present universally). Scope: **global across all files** (not per-file).

**[FLAG-2 — RESOLVED, Opus 2026-08-21]:** Log cross-file duplicates (a `message.id`/`uuid` seen in
a second file) to parser health at DEBUG level, then upsert-ignore. The finding (32 unique IDs × 2
files, both within helpdesk-web) is benign file-overlap within one project dir, not sidechain rollup —
but the health event aids debugging if a real double-count vector appears later.

Fallback: dedup key falls back to the existing top-level `uuid` when `message.id` is absent (per
D-1); quarantine only if both are absent. No *generated* UUIDs — the fallback uses a field already
present in the record, so NFR-107 idempotency (rebuild equality) holds.

### D-4 Mechanical-turn threshold

`:short_output_threshold = 200` output tokens, calibrated from corpus percentiles:
- opus: p10=169, p25=291 → 200 sits at ~p15
- sonnet: p10=133, p25=209 → 200 sits at ~p18-p22

Below 200 tokens: brief outputs typical of tool confirmations, status updates.
Captures ~20% of turns as mechanical; conservative against false positives.

**[FLAG-3 — RESOLVED, Opus 2026-08-21]:** Ship the token-only threshold (`output_tokens < 200`)
for MVP — simpler, no extra column, calibrated to corpus p15–p22. Documented upgrade path: if
mechanical-turn precision proves insufficient, add a `has_tool_use` boolean to the `turns` table
and require short-output AND tool-only for the mechanical class (the corpus has 22,924 tool_use
blocks to calibrate against). Deferred, not built now.

### D-5 C-01 sidechain rule as implemented

**Empirical finding:** `isSidechain` is always `false` in the corpus. No actual sidechain turns.
The field is a universal metadata field on ALL modern records (not a sidechain marker per se).

**Implemented policy:**
1. COUNT all turns (is_sidechain handling is for when the field is eventually `true`)
2. SET `is_sidechain = 1` when `d.isSidechain === true` (currently never)
3. DEDUP globally by `message.id` across all files
4. No rollup records found — global-id dedup is sufficient

**C-01 verdict: no double-count verified** (no sidechain sessions in corpus).

**[FLAG-4 — RESOLVED, Opus 2026-08-21]:** Proceed as-specified (set flag, count turn, dedup by
`message.id`), AND a **synthetic sidechain fixture is REQUIRED** in the Phase 1 ingestion test
suite before the ingestion slice ships — not optional. Reason: the C-01 "no double-count verified"
PASS holds only because this corpus contains **zero** `isSidechain=true` records, so the
double-count vector (the whole point of C-01, a CRITICAL finding) was never exercised against real
data. The fixture is how the policy actually earns confidence: it must assert that a sidechain turn
present both inline and as a hypothetical parent rollup collapses to one count under global-id
dedup. Extend ingestion spec §5's "duplicate replay no-op" case to cover it. **Carry this into
Session 12 (spec edit) and the Phase-1a test plan.**

### D-6 Which ingestion-spec assumptions failed (concrete spec edits for Session 12)

No required-field assumptions failed (all at 100%). The following ADDITIONS are needed:

1. **G-01** `session_id` alias: parser must accept both `sessionId` and `session_id`.
2. **G-02** Command events via `system:local_command`: specify record type and field in spec §1.2.
3. **G-04** `pr-link` records: add as primary outcome-linkage source in spec §3.1/§3.2.
4. **G-07** `tool_result_bytes` SUM semantics: specify as sum of all tool_result blocks per message.
5. **G-08** Extend ingestion spec §5 test cases with a **required synthetic sidechain fixture**
   (per D-5 FLAG-4) — C-01 is only verified once the `isSidechain=true` path is exercised by a test.

These are additive changes; no existing assumptions need removal.

### D-7 S1 exit-criteria scorecard

| Criterion (Spike Plan v2 line 25) | Result |
|---|---|
| model/day/project/project×model tables match review within dedupe tolerance | **PASS** (exact for 08-14–08-18; 08-21 delta = post-review activity) |
| Delta documented and attributed | **PASS** (+224 turns, +$112, entirely from 2026-08-21 activity) |
| Field-extraction coverage stats | **PASS** (all spec fields at 100%) |
| Schema-variance inventory across corpus | **PASS** (126 variants; 2 eras; date ranges documented) |
| Turn-class threshold calibrated from corpus output distributions | **PASS** (200 output tokens; p15–p22; grounded in empirical percentiles) |
| C-01 sidechain census + "no double-count verified" line | **PASS** (see §3.1 — isSidechain always false; global dedup sufficient) |

**All six S1 exit criteria: PASS.**

---

## Positive surprises (not in spec, worth ADR attention)

**`pr-link` records (2,356):** Claude Code already embeds PR linkage data in the transcript
(`prNumber`, `prRepository`, `prUrl`, `sessionId`). This is a higher-confidence linkage
source than SHA-overlap and should be harvested in the ingestion pipeline. It was not in any
planning document. Recommendation: add `pr-link` to ingestion spec §3 and update the S3
spike scope to include validating these records.

**`file-history-snapshot` / `file-history-delta` (3,205 records):** Detailed file-change
tracking already exists in transcripts. This may enable the "files-touched per session" data
needed for the file-overlap rework metric (currently blocked in §1.3 of the adversarial review
because "the schema has no files-touched table"). Recommend evaluating in S3 scope.

---

## Deferred (not S1 scope)

- GitHub REST vs GraphQL (S3 scope) — A-07, S-11 from adversarial review
- Pricing snapshot refresh mechanism — A-18 (out of scope for parser)
- Live tail byte-offset behavior — S2 scope
- Context attribution / tokenizer — S5 scope
