# PERF0 performance baseline and budget freeze

## Status and measurement contract

This is preparatory benchmark tooling for the acceptance-budget freeze. PERF0 is
not complete and no performance budget is frozen in this checkout. A value is
accepted only after it has been filled from **at least three repeated runs**,
with **30 samples per measured distribution**. Until then, every `TBD` below is
an intentionally unfilled acceptance threshold, not permission to infer one
from an observation.

Single-run times from a one-off planning probe are **NOT thresholds**. Budgets
come from the repeated 30-sample distributions described here, with platform,
versions, commit, fixture dimensions, cache state, and spread recorded with
the result. Do not use a best run, a cache-hit result, or an empty-root idle
sample as a replacement for the applicable phase budget.

All measurements use synthetic data and isolated loopback resources. The
committed evidence contains synthetic aggregates only: **no transcript bytes or
raw content (SEC-101)**.

## Frozen scenario metadata

Before filling or comparing a budget, record the following with every run set:

- commit SHA; operating system, CPU/RAM, Node, npm, SQLite/better-sqlite3,
  browser, and `tsx` versions; and relevant machine-load limits;
- fixture scale (1k, 10k, and 100k turns), session count/skew, idle-file
  count, large-single-file size, recent tool/test events, recommendation
  effects, context inventory, and nonzero eligible populations;
- fixed clock/run anchor, explicit `from`/`to` window or preset definition,
  cache state, production-asset build identity, and browser viewport; and
- each distribution's sample count, median/p95 (where applicable), min/max or
  standard deviation, and failures/exclusions. Do not silently discard slow
  samples.

The synthetic daemon harness defines a cold route as the first request to a
route after a fresh child boot and seed; it is not process startup. Its warm
route distribution is 30 sequential requests using p50 and nearest-rank p95.
The process-startup timer is separately `startup-to-ready`.

## Acceptance budgets by phase

`TBD` fields are numeric threshold slots: replace each with a number and keep
the stated unit and comparison when freezing the baseline. A later unit passes
only when its matched scenario remains within the frozen value (and preserves
the response/counter contract).

### cold-process

| Metric | Acceptance budget |
|---|---|
| Startup-to-ready | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Process CPU through ready | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| RSS at ready | <= **TBD — fill from >=3 repeated 30-sample runs** MiB p95 |
| Ingest catch-up throughput | >= **TBD — fill from >=3 repeated 30-sample runs** turns/s p50 |
| Event-loop delay during startup/catch-up | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |

### cold-query

| Metric | Acceptance budget |
|---|---|
| Route service time (first request after child boot/seed) | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| End-to-end loopback HTTP time | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| SQLite query count | <= **TBD — fill from >=3 repeated 30-sample runs** queries/request |
| Response bytes | <= **TBD — fill from >=3 repeated 30-sample runs** bytes/request |
| `getEsfObservations` CPU / RSS at each scale | <= **TBD — fill from >=3 repeated 30-sample runs** ms CPU p95 / **TBD — fill from >=3 repeated 30-sample runs** MiB RSS p95 |

### warm-explicit-window

This phase uses a fixed, explicit historical `from`/`to` window. Record cache
misses and hits separately; a hit does not stand in for a cold-query result.

| Metric | Acceptance budget |
|---|---|
| Route service time | <= **TBD — fill from >=3 repeated 30-sample runs** ms p50 / **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| End-to-end loopback HTTP time | <= **TBD — fill from >=3 repeated 30-sample runs** ms p50 / **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| SQLite query count | <= **TBD — fill from >=3 repeated 30-sample runs** queries/request |
| Response bytes | <= **TBD — fill from >=3 repeated 30-sample runs** bytes/request |
| Browser warm navigation | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Browser request count / retained cache entries | <= **TBD — fill from >=3 repeated 30-sample runs** requests/navigation / **TBD — fill from >=3 repeated 30-sample runs** entries |

### moving-preset

This phase resolves a rolling/current preset at the recorded clock anchor. It
must exercise advancing effective windows rather than pretending that a new
timestamp is an explicit-window cache hit.

| Metric | Acceptance budget |
|---|---|
| Route service time / loopback HTTP time | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 / **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| SQLite query count / response bytes | <= **TBD — fill from >=3 repeated 30-sample runs** queries/request / **TBD — fill from >=3 repeated 30-sample runs** bytes/request |
| Browser cold and warm navigation | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 / **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Browser request count / retained cache entries | <= **TBD — fill from >=3 repeated 30-sample runs** requests/navigation / **TBD — fill from >=3 repeated 30-sample runs** entries |
| Long tasks | <= **TBD — fill from >=3 repeated 30-sample runs** tasks/navigation and **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Browser layout duration (React commit profiling unavailable) | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Concurrent-read event-loop delay / RSS | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 / **TBD — fill from >=3 repeated 30-sample runs** MiB p95 |

## Reproducible measurement commands

Run these from the repository root after installing the pinned dependencies.
They must write/retain only aggregate synthetic evidence suitable for review.

```powershell
node --import tsx/esm scripts/benchmark/synthetic-history.ts
node --import tsx/esm scripts/benchmark/browser-measure.ts
node --import tsx/esm scripts/benchmark/esf-observation-measure.ts
```

- Build production assets with `npm run build:ui` before the browser command.
- `synthetic-history.ts` emits controller-observed HTTP timing/bytes, startup
  wall time, controller CPU/RSS/event-loop samples, child safe-job CPU/RSS,
  child idle delay, and seed insertion throughput. It does **not** measure
  route service time, SQLite query count/plans, or real ingest catch-up.
- Its moving-window samples use advancing explicit windows anchored to the
  populated fixture. They do not validate the UI's live preset/cache behavior.
- `browser-measure.ts` measures a 1k-turn Overview navigation with production
  assets and rewrites preset API requests to the fixed fixture window. This
  does not validate real-clock preset resolution. Browser layout time is not React commit duration; resource cache
  hits are not the application's retained query-cache cardinality.
- `esf-observation-measure.ts` reports `available: false`: this branch contains
  no `getEsfObservations` implementation. No CPU/RSS measurement is claimed.
- Cold route samples and browser cold/warm navigation have one observation
  per invocation. Only the HTTP warm/moving distributions contain 30 samples.
  Repetition and the missing coverage below are required before any freeze.

## Deferred coverage and completion conditions

The review found that the original coverage description exceeded the executable
harness. These items remain in this governing baseline plan; none are passing
performance evidence:

1. Integrate the real ESF observations query and its verified accounting-source
   watermark, then add scale measurements and executable integration coverage.
2. Instrument child route service time and SQLite query counts/plans. Exercise
   real populated ingest catch-up and concurrent HTTP interference; seed insert
   throughput and parent event-loop delay cannot substitute for those metrics.
3. Measure application query-cache retention and React commits, extend browser
   scenarios to the required scales/routes, and verify live moving-preset cache
   behavior. CDP layout time/resource cache hits cover different quantities.
4. Collect at least three matched runs of 30 observations for every required
   distribution, record metadata/spread, and replace TBD thresholds only then.

## Frozen before/after protocol

Every PERF unit must perform this protocol before claiming a performance
change.

1. **Before:** on the exact pre-change commit, run all three commands for the
   matched phase and fixture matrix. Capture the frozen metadata and the full
   30-sample distribution for each of at least three repeated runs.
2. Make only the unit's scoped change. Preserve response bodies/counters and
   fixture identities; if a contract intentionally changes, record and obtain
   approval for the new contract before comparing performance.
3. **After:** rebuild production assets for browser runs, then repeat the same
   commands, clock/window, fixture dimensions, cache state, and run count on
   the post-change commit. Capture shutdown/cleanup success and any failed
   samples.
4. Compare p50/p95, spread, query count/plan, response bytes, CPU/RSS,
   event-loop delay, ingest throughput, browser requests/cache retention/long
   tasks/layout duration against the matching frozen phase budget. Include
   concurrent one-tab burst and repeated two-tab reads when daemon work is
   touched.
5. Report the before/after distributions and parity evidence. A claim requires
   a repeatable improvement in the unit's attributed cost, no budget breach in
   affected phases, and no material regression in concurrent HTTP latency,
   ingestion throughput, retained memory, or response/counter parity.

## Downstream budget coverage

| Unit | Attributed cost that must improve or remain bounded | PERF0 evidence/budget used |
|---|---|---|
| PERF1 | Hot Sessions selected-window ranking and enrichment, including per-returned-row percentile work | `cold-query` and `warm-explicit-window` route service/HTTP time, query count/plan, response bytes, and `getEsfObservations` CPU/RSS where the shared query path applies |
| PERF2 | Flavor/cache-write aggregation, cold Overview/trend scans, and explicit-window versus rolling-preset cache behavior | `cold-query`, `warm-explicit-window`, and `moving-preset` service/HTTP time, query count/plan, response bytes, cache state, and freshness-effective-window evidence |
| PERF3 | Document-local cache cardinality/payload retention, duplicate eligible requests, and browser rendering work | `warm-explicit-window` and `moving-preset` browser navigation, request count, retained cache entries, long tasks, layout duration, and retained-memory budgets |
| PERF4 | Ingest tail/legacy-prefix catch-up, bounded batch CPU/RSS, and HTTP responsiveness while populated ingest work runs | `cold-process` startup/catch-up throughput and CPU/RSS; `moving-preset` concurrent-read HTTP/service time and event-loop-delay budgets |
| PERF5 | Each recurring job's own elapsed time, CPU/RSS, event-loop delay, and concurrent-read interference | `cold-process` readiness/catch-up and `moving-preset` concurrent-read budgets, plus **per-job attribution** for boot/initial scan, 2s tail, 30s discovery, reconciliation, post-ingest detectors, probes, reports, effect evaluation, outcomes, calibration, and weekly callbacks |

PERF5 must not report only an aggregate timer total: it records every job family
and invocation boundary separately, including registration, cadence,
non-overlap/cancellation, and shutdown. Direct representative weekly-job cost
plus fake-clock lifecycle evidence is acceptable; an accelerated cadence is
separate stress evidence, not a substitute for the original-cadence budget.

## Historical proposal from concurrent author campaign (not accepted)

The author's concurrent commit `2fdcf8a` supplied the proposal below from private
commit `d8f7dad`. It is preserved verbatim for traceability, not as verified PR
baseline evidence. Its source artifacts were not supplied in this PR. The
reviewed branch has no ESF query; real-clock presets miss the January fixture;
CDP layout is not React commit time; parent resources/seed inserts are not daemon
startup resources/ingest catch-up. Three single observations do not satisfy the
required 30-sample distributions. The review fixes also change fixture accounting
and browser readiness, so the scenarios differ. Re-run on the final reviewed
commit with correct attribution and the required sample counts before proposing
replacement budgets. The active thresholds above therefore remain TBD.

```text
**Baseline campaign 2026-09-08 (PROPOSED — pending operator sign-off).** Filled
from 3 repeated sequential runs of all three tools on commit `d8f7dad` (private
main; browser navigation fix included). Platform: Windows 11 Pro 10.0.26200,
i7-12700H (20 logical) / 32 GB, Node v24.14.0, SQLite 3.53.2 (better-sqlite3),
Chrome headless=new, production Vite assets, `tsx` loader. Fixture: the frozen
synthetic fixture at 1k/10k/100k turns (deterministic window anchor
2026-01-01..15); daemon values are the worst case across 12 routes x 3 runs;
warm/preset distributions are 30 samples each. Budgets are worst-observed with
~1.5x headroom (throughput floors ~0.7x the observed minimum). Scale-qualified
cells read `1k / 10k / 100k`.

Caveats recorded with this campaign:
- **Cold phases have 1 sample per boot**, so cold budgets rest on 3 boot
  samples per scale, not 30-sample distributions — structurally unavoidable;
  tighten them after more boots accumulate.
- **SQLite query count is BLOCKED**: the harness child protocol does not expose
  trace/EXPLAIN output (`query_instrumentation.available=false`). Those cells
  stay TBD until the child protocol grows query instrumentation.
- **NFR-105 gap**: warm 100k route p95 observed 839.9 ms breaches the retained
  <=250 ms dashboard-query target. Per the architecture addendum this is an
  identified gap for PERF1/PERF2 to close, not a relaxed target; the 100k warm
  budget below bounds regression only and does not supersede NFR-105.
- **Browser measurements run at the tool's fixed 1k-turn fixture** and one
  viewport; warm navigation showed high spread (38.6–109.1 ms across runs).

### cold-process

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Startup-to-ready | 956.2 / 597.7 / 5590.1 ms | <= 1500 / 1500 / 8500 ms p95 |
| Process CPU through ready (controller) | <=16 ms (Windows ~15.6 ms timer granularity) | <= 150 ms p95 |
| RSS at ready | 147.4 / 153.6 / 182.9 MiB | <= 225 / 235 / 280 MiB p95 |
| Ingest catch-up throughput (seed insert) | 47017 / 14519 / 10552 turns/s min | >= 30000 / 10000 / 7000 turns/s p50 |
| Event-loop delay during startup/catch-up | 16.3 / 23.1 / 40.2 ms p95 | <= 30 / 40 / 60 ms p95 |

### cold-query

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time (first request after child boot/seed; controller-observed loopback HTTP) | 31.9 / 139.9 / 3342.8 ms | <= 50 / 210 / 5000 ms |
| End-to-end loopback HTTP time | same vantage as above (single controller-observed measure) | same cells |
| SQLite query count | BLOCKED — child protocol exposes no trace/EXPLAIN | TBD (instrumentation follow-up) |
| Response bytes | <= 56351 bytes max (all phases) | <= 131072 bytes/request |
| `getEsfObservations` elapsed / CPU / RSS | 8.0 / 71.5 / 1358.3 ms p95 · 16 / 78 / 1532 ms CPU · 89.7 / 108.5 / 259.3 MiB | <= 15 / 120 / 2100 ms p95 · <= 30 / 120 / 2300 ms CPU · <= 135 / 165 / 390 MiB |

### warm-explicit-window

This phase uses a fixed, explicit historical `from`/`to` window. Record cache
misses and hits separately; a hit does not stand in for a cold-query result.

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time (controller-observed loopback HTTP) | p50 15.5 / 64.7 / 594.4 ms · p95 22.5 / 84.5 / 839.9 ms | <= 25 / 100 / 900 ms p50 · <= 35 / 130 / 1300 ms p95 |
| End-to-end loopback HTTP time | same vantage as above | same cells |
| SQLite query count | BLOCKED — see cold-query | TBD (instrumentation follow-up) |
| Response bytes | <= 56351 bytes max | <= 131072 bytes/request |
| Browser warm navigation (1k fixture) | 38.6–109.1 ms across runs | <= 170 ms p95 |
| Browser request count / retained cache entries | 35 max / 10 | <= 45 requests/navigation / <= 32 entries |

### moving-preset

This phase resolves a rolling/current preset at the recorded clock anchor. It
must exercise advancing effective windows rather than pretending that a new
timestamp is an explicit-window cache hit.

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time / loopback HTTP time | p95 9.5 / 5.6 / 26.7 ms | <= 15 / 15 / 45 ms p95 |
| SQLite query count / response bytes | BLOCKED / <= 56351 bytes | TBD / <= 131072 bytes/request |
| Browser cold and warm navigation (1k fixture) | cold <= 65.9 ms / warm <= 109.1 ms | <= 100 ms p95 / <= 170 ms p95 |
| Browser request count / retained cache entries | 35 max / 10 | <= 45 requests/navigation / <= 32 entries |
| Long tasks | 0 observed | <= 2 tasks/navigation and <= 100 ms p95 |
| React commit duration | <= 18.5 ms | <= 50 ms p95 |
| Concurrent-read event-loop delay / RSS | 24.6 ms p95 / 182.4 MiB | <= 40 ms p95 / <= 280 MiB p95 |
```
