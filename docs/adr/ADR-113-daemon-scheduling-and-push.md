# ADR-113: Daemon scheduling, push and read models

**Status:** Accepted (P3-U6 final pass 2026-10-14, after P3-U1 `9151edea`) · **Date:** 2026-09-29
**Decision of record:** `docs/plans/2026-09-27-api-perf-rearchitecture-plan.md` §2 (operator: D1–D10 on
2026-09-29, D11–D17 on 2026-09-28). **Evidence:** `.claude/audits/perf-audit-2026-09.md`.
**Amends:** ADR-100 (its "one daemon process, direct SQL, no workers").

## Decision

1. **One process, plus workers for CPU passes.** The daemon stays a single Node process on
   `127.0.0.1:2929` with better-sqlite3. Long CPU passes (detector walk, recs and diagnostics
   builds) run in worker threads, each with its own connection. This is already true:
   `8535a09` (ADOPT-1) and `src/daemon/history-worker.ts` contradict ADR-100's "no workers".
2. **In-memory scheduler, gated on evidence (D7).** No jobs table, no slices table, no external queue.
   Every job is idempotent and resumes from state already on disk (`ingest_offsets`,
   `detector_week_results`, `turns_rowid_hwm`). Phase 2 first uses the existing coalescing runner plus
   `notBefore` rules and a per-Ingestor ingest mutex (P2-U4). The full two-lane scheduler (P2-U3) was
   gated on `perf:backfill` evidence and is **cut** (plan commit `85677915`): the coalescing runner,
   `notBefore` rules and ingest mutex were enough.
3. **Push and invalidation: `data_version` poll first (D6).** One shared poller reads `data_version`
   and `progress` from `/api/status` every 2 s. One leader tab polls, chosen with `navigator.locks`.
   SSE is added only on measured need. **D6 supersedes D3 (SSE), and supersedes the "SSE for
   invalidation" wording in the plan's P0-U8 goal line.** The poll avoids SSE's shutdown hang and
   6-connection limit, and costs at most 2 s of latency on data already coalesced to 2–5 s.
4. **Read models, gated on evidence.** A route moves onto a per-day rollup or a worker snapshot only
   if it misses its budget on the large dataset (P3-U2 entry condition). No read model is built on
   assumption. The per-day `spend_daily` rollup (P3-U2/U3) is **cut**: on a live-DB copy the five
   candidate routes had a worst p95 of 120 ms against 250 ms (plan commit `8696a107`). Worker snapshots
   back the recs, diagnostics and efficiency-headroom reads (P3-U4, P3-U5).

## A-10 (one sole-writer worker) is not triggered

Every measured main-thread stall has a named cause that a smaller fix removes (audit §11.1):

- The 26 s pre-listen block moves after `listen` and off the main thread.
- Reading-phase stalls of about 1.5 s become ingest transactions of 50 ms or less (P2-U4a).
- Route stalls of 0.1–20 s go away with memo, snapshots and read models.
- The detector walk already runs in `history-worker.ts`.

One stall has no named cause: N7, a 2,024 ms cold detecting-phase stall with the CPU 99.5% idle.
A-10 is re-evaluated only if P-1 still fails after Stages 3, 6 and 7 ship and P0-U10 attributes the
residual stall to ingest or detector writes. A-10 would also conflict with the multi-worker model. If
ever triggered, the natural shape is to fold main-thread ingest into the history worker's read-write
connection, which already is the second writer.

## D12 and D13

- **D12: keep rows of a deleted source file, marked `source_missing`.** A resumed session's turns are
  stored once under a global `message_id`, owned by whichever file was ingested first (audit §13.3
  D-1). Purging "the deleted file's rows" could delete turns a continuing file still owns. A "purge
  missing sources" Settings action is a separate, later unit.
- **D13: keep better-sqlite3.** The measured cost is main-thread work volume, not the driver.
  `node:sqlite` is also synchronous, so switching would not fix it, and the audit did not verify its
  Node 24 maturity (audit §13.3 D-2). Revisit only after work volume is fixed.

## New units from the audit (9)

| Unit | What |
|---|---|
| P0-U10 | Detector and boot counters: attribute N7 and the idle timer churn |
| P0-U11 | R-1/R-2 harness: independent oracle for ingest correctness and crash resume |
| P0-U12 | Atomic ingest: offset and baselines written inside the chunk transaction |
| P0-U13 | Idle cost: profile the 25% idle CPU and RSS growth before designing a fix |
| P1-U0 | `data_version` GET memo: idle repeat reads become memo hits |
| P1-U7 | Limits off the request path: serve cache, refresh in the background (D15) |
| P2-U4a | Time-sliced ingest transactions of 50 ms or less |
| P2-U8 | Detector contract v2: declared id, version, scope, inputs; per-detector isolation and quarantine |
| P3-U7 | File identity and versions: content-keyed files instead of path-keyed |

## Perf invariants

1. **Nothing heavy runs before `listen`.** Boot work moves after `listen` or into a worker.
2. **Every route, recurring job and detector registers a budget** (route registry P0-U9; job and
   detector registry P0-U14). An unregistered one fails a test.
3. **Ingest writes are atomic** (R-1, R-2): the chunk rows, offset and baselines commit together, so a
   kill leaves no replayed chunk. Proved by the P0-U11 harness.
4. **The idle census runs at every phase gate** with a same-day `main` control, so idle CPU and RSS
   cannot drift unnoticed. The 10 ms loop-lag sampler (`perf.loop-sample`) is on-demand: a
   `/api/perf?since=` read arms it and it stops 10 min after the last read. Always on it cost +0.21–0.34 %
   of one core at idle against the < 1 % M18 budget, so an idle daemon runs it zero times.
5. **Budget rule.** A new GET reads from a rollup or snapshot, or declares a `direct` budget in
   `src/daemon/route-budgets.ts` and passes it on X.

## Route budgets

`src/daemon/route-budgets.ts` is the source of truth for the numbers. Default and floor: 250 ms p95.
A route's initial budget is `max(250, ceil(1.2 × audit idle c=1 p95))`; raising it later needs a
linked measurement (`raised`). `stream` routes are exempt from latency checks. Today these are idle
budgets, and since P3-U1 (`9151edea`) they are enforced during backfill by verify:app step (g): 63 routes
× 50 samples × 3 attempts against a fresh 280 MB scan root, route p95 judged on the median of 3, loop p99
≤ 50 ms judged per attempt over that attempt's own span (the whole-span p99 read at its end; `covered: false`
fails). Numbers on `main` `9151edea` (2026-10-14, 3 green runs): 63/63 routes within p95 budget; loop p99 of
the ingest-overlapped attempt 35.7 / 35.9 / 41.1 ms (about half its requests sent while ingest ran), later
attempts 25.8–29.1 ms. Slowest route `/api/agents-liveness` p95 ~600 ms vs a 2,460 ms budget.

### Gate rules for verify:app step (g) (operator, 2026-10-14)

These are binding. A gate made green by breaking one is a defect; a red gate with honest numbers is not.

1. **Every budgeted GET is in the event-loop gate.** No route moves to a tail, print-only or ungated pass.
   Enforced by a test in `test/daemon/route-budgets.test.ts`.
2. **Loop p99 ≤ 50 ms is gated per attempt.** The attempt that overlaps the scan-root backfill is gated on its
   own. Median of 3 applies only to route p95 budgets, never to hide a failing loop attempt.
3. **No waiting out the 60 s lag window** before an attempt to let ingest lag age out. Each attempt's loop p99
   is measured over that attempt's own time span only (`/api/perf` since its start), so a later attempt is not
   charged for an earlier attempt's lag; nothing inside the span is dropped (operator, 2026-10-14).
4. **Step (g) samples during real ingest:** fresh scan root and fresh `.verify/backfill.sqlite` every run, a
   corpus large enough to overlap (280 MB today), overlap printed per attempt.
5. **A route that blocks the loop is fixed, not excluded:** move its work off the main thread (the scan
   worker, `src/daemon/scan-offload.ts`), still fresh per request. Known cases: `judge-setup`,
   `judge-setup/consent`, `idle-sessions` (offloaded), `agents-liveness` (spawns `claude` per call).
   No cache that serves data older than the request.
6. **Budgets and the 50 ms bar are never loosened** without a linked measurement and operator OK.
7. **O-3 counter baseline** (`scripts/benchmark/o3-baseline.json`) is reset only with a per-route breakdown
   showing each rise is an intended feature or a first-touch artifact. Any regression stops the rebaseline.
8. **No warn-only exceptions.** The M17 timing asserts in verify:app check 8 are enforcing since the M17 UI
   unit (2026-10-14) cut the Sessions and Workspaces click long tasks. Checks 13 and 14 were listed here
   too, but were never built (P1-U6b/U6c); there is nothing to enforce until they are.
9. **Still red after fixing causes:** stop and report the numbers; the operator decides whether to accept a
   deviation (as for G-P2's M1 misses).

## Final picks

| ID | Pick |
|---|---|
| D1 | Phase 0 starts next; rec-lane and Diagnostics units wait for T11 and P4 U7 |
| D2 | TanStack Query and zod approved but isolated; react-error-boundary not used |
| D3 | Superseded by D6 |
| D4 | First slice is a strict 7 days by file mtime, with a 15 s time guard replacing the byte cap |
| D5 | Suppress new recs whose lookback crosses incomplete history, then caption |
| D6 | `data_version` poll first (shared 2 s poller, leader tab); SSE only on measured need |
| D7 | Two-lane scheduler gated on `perf:backfill` evidence; resolved: cut (`85677915`) |
| D11 | This plan's M-targets stay the gates; requirement P-2 (50 ms) is an end-state target only |
| D12 | Keep rows of deleted source files, marked `source_missing` |
| D13 | Keep better-sqlite3 |
| D14 | Record X = 6 MB/s, Y = 2,600 KB per 1k turns, k = 5, N = 2,000; gates only after an AC-power re-measure |
| D15 | Serve cached limits; single-flight refresh when over 60 s old and a tab is visible |
| D16 | Add `GET /api/version` returning only the `data_version` counter |
| D17 | D9 resolved: trim P1-U6b to the optimistic write, `ImpactLedger` no-remount and the headroom memo |

D8, D9 and D10 are not architecture decisions: keep the 5 s undo window, D9 resolved by D17, and
verify:app may write on a disposable seed copy.

## Consequences

- One process keeps distribution simple; the cost is discipline about what may run on the main thread.
- Polling costs up to 2 s of freshness; it is the cheaper, safer transport.
- Every gate in this ADR is evidence-first: a scheduler, SSE or read model is built only when a
  measurement shows the need, and the measurement is recorded either way.

## Revisit triggers

- P-1 still fails after Stages 3, 6 and 7 and the residual stall is write-attributed: reopen A-10.
- A poll latency complaint, or a measured poll cost: add SSE (D6).
- `perf:backfill` shows overlapping-job misses: build the two-lane scheduler (D7).
- Main-thread work volume is fixed and driver cost still shows: evaluate `node:sqlite` (D13).

## Change log

- 2026-09-29: Draft. Finalized in P3-U6.
- 2026-10-13: P3-U6 pass. Budget rule and budget section added; P2-U3 and P3-U2/U3 recorded as cut.
  Stays Proposed until P3-U1 sets the enforced backfill numbers.
- 2026-10-14: P3-U6 final pass. P3-U1 merged (`9151edea`, operator sign-off); enforced step (g) numbers
  added; loop-lag sampler is on-demand (invariant 4). Status → Accepted. Nav-dot DESIGN_GUIDE entry still
  lands with P2-U6 (not built).
