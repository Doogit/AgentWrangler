# ADR-102: Live Tail Design

**Status:** accepted · **Date:** 2026-08-21
**Spike:** S2 live tail
**Decision by:** S2 spike findings + Opus disposition 2026-08-21 (below; supersedes inline `[FLAG]` markers).

---

## Opus disposition (2026-08-21)

- **D-1 offset store → SQLite `ingest_offsets` table.** The ingestion spec already names this table;
  SQLite is the existing datastore (atomic via WAL, co-located, queryable, survives rebuild-equality
  auditing). A separate JSON file would add a second persistence mechanism with its own atomicity
  concerns. Not more complex — more correct.
- **D-3 head-hash window → hash the first complete JSONL line (cap 4 KB), not a fixed 256 B.** A full
  first record is guaranteed to contain the session's unique ids (uuid/sessionId/timestamp), so
  rotation detection can't false-negative on a templated fixed-length prefix. Cheap and robust.
- **D-4 cadence → 30 s mtime poll for Phase 1a; fswatch deferred.** 30 s satisfies NFR-103 (≤ 60 s)
  with zero deps. Filesystem-watch (sub-second) is a later UX slice, not MVP.
- **D-5 concurrency → sequential tail within a poll cycle for Phase 1a.** 7.9 s cold scan is ample;
  revisit parallelism only if the corpus exceeds ~1,000 files or cold-scan time exceeds 60 s.
- **D-2 partial-line → hold-at-offset** (adopt as-is; not a flag).

---

## Context

S2 empirically validated the offset-persisting tailer against a 227-file / 135,062-line real corpus.
All numbers from actual measurements; no assumptions carried forward without evidence.
NFR-103 (≤ 60 s live detection), NFR-104 (back-scan in minutes), NFR-107 (rebuild equality) all confirmed PASS.

---

## Decisions

### D-1 Offset store format → SQLite `ingest_offsets` table (resolved above)

Spike prototype used a flat JSON file for speed; production uses the SQLite `ingest_offsets` table
named in ingestion spec §1.3 (atomic via WAL, co-located with all persisted state).

### D-2 Partial-line policy → hold-at-offset

Do not advance the byte offset until a complete `\n`-terminated line is available. Partial trailing
bytes are re-read on the next poll. No in-memory buffer required. Simple, correct, negligible re-read
cost (a partial line is typically < 1 KB via one cheap pread).

### D-3 Rotation/truncation detection rule

Sequence (per `s2-core.mjs`):
1. Compute current head hash (SHA-256 of the first complete JSONL line, cap 4 KB) — always, before any offset check.
2. If `storedOffset > fileSize` AND head hash unchanged → `TRUNCATION` (file shrank in place).
3. If `storedOffset > fileSize` AND head hash changed → `ROTATION` (replaced with smaller).
4. If `storedOffset ≤ fileSize` AND head hash changed → `ROTATION` (replaced with larger/equal).
5. On either event: offset → 0, stored head → current head, re-scan from top. Dedup makes re-scan idempotent.

**Design bug found in spike:** checking size regression before head hash misclassified
rotation-with-smaller-replacement as TRUNCATION. Fixed in the rule above (head hash first).
Functional behavior is identical (both events reset the offset); the event name matters for health
metrics only.

### D-4 Poll cadence → 30 s mtime poll (Phase 1a); fswatch deferred

30 s poll: simple, zero deps, deterministic, max live-detection latency 30 s (< NFR-103 60 s).
Filesystem watch (chokidar / native) gives sub-second latency and is a later slice for the live-session strip.

### D-5 Concurrent-session handling → sequential (Phase 1a)

Each file has an independent entry in the offset store; tails are processed sequentially within a poll
cycle; no cross-file ordering assumptions. Sequential avoids shared-state complexity on the dedup Set
and is fast enough (7.9 s cold for 227 files). Parallelism (with a protected/pre-populated dedup set)
is deferred until the corpus grows beyond ~1,000 files.

### D-6 S2 exit-criteria scorecard

| Criterion | Result |
|---|---|
| Live turn latency ≤ 60 s measured | **PASS** (harness p90 = 454 ms at 500 ms poll; 30 s production poll → ≤ 30 s) |
| Rotation/truncation test | **PASS** (TRUNCATION + ROTATION events; offset reset; idempotency) |
| Back-scan of full corpus timed | **PASS** (7.9 s for 227 files / 135k lines / 27 dirs) |
| Rebuild equality demonstrated | **PASS** (NFR-107: all aggregates identical across 2 cold scans) |

**All four S2 exit criteria: PASS.**

### D-7 Spec gaps (additive; for Session 12 spec edits)

| # | Gap | Spec location | Fix needed |
|---|---|---|---|
| G-09 | `ingest_offsets` storage format not specified | §1.3 | Specify the SQLite `ingest_offsets` table (per D-1) |
| G-10 | Rotation-with-smaller-replacement case missing | §1.3 | Add: head-hash check precedes size-regression classification |
| G-11 | Tail poll cadence implicit | §1.1, §1.3 | Explicit "30 s mtime poll (fswatch later)" in §1.3 |
| G-12 | Serial vs. parallel tail ordering not specified | §1.3 | Add: "files tailed sequentially within a poll cycle for Phase 1a" |

---

## Positive findings

- Back-scan at reference scale (227 files, 135k lines, 27 dirs): **7.9 s** — well within NFR-104.
- Parse error count: **0** across both full-corpus passes.
- Rebuild equality: **exact** across 2 cold scans (all 8 aggregate dimensions).
- Partial-line handling correctly holds a trailing partial line across poll cycles without corrupting the parser.

---

## Deferred

- Filesystem watch integration (D-4) — Phase 1a follow-up.
- Parallel file processing (D-5) — revisit when corpus > 1,000 files.
- Sidechain JSONL session files — G-03 from S1: none seen; the tailer handles them identically
  (each file gets its own offset entry).
