# PERF0 performance baseline and budget freeze

## Status and measurement contract

This is the acceptance-budget freeze point for the performance work. A value is
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
| React commit duration | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 |
| Concurrent-read event-loop delay / RSS | <= **TBD — fill from >=3 repeated 30-sample runs** ms p95 / **TBD — fill from >=3 repeated 30-sample runs** MiB p95 |

## Reproducible measurement commands

Run these from the repository root after installing the pinned dependencies.
They must write/retain only aggregate synthetic evidence suitable for review.

```powershell
node --import tsx/esm scripts/benchmark/synthetic-history.ts
node --import tsx/esm scripts/benchmark/browser-measure.ts
node --import tsx/esm scripts/benchmark/esf-observation-measure.ts
```

- `synthetic-history.ts` is the daemon/HTTP harness: phase-tagged route service
  time, HTTP p50/p95, query count, response bytes, startup-to-ready, ingest
  catch-up, CPU/RSS, and event-loop delay.
- `browser-measure.ts` measures production-asset cold/warm navigation, request
  counts, retained cache entries, long tasks, and commit duration.
- `esf-observation-measure.ts` measures `getEsfObservations` CPU/RSS at scale.

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
   tasks/commit duration against the matching frozen phase budget. Include
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
| PERF3 | Document-local cache cardinality/payload retention, duplicate eligible requests, and browser rendering work | `warm-explicit-window` and `moving-preset` browser navigation, request count, retained cache entries, long tasks, commit duration, and retained-memory budgets |
| PERF4 | Ingest tail/legacy-prefix catch-up, bounded batch CPU/RSS, and HTTP responsiveness while populated ingest work runs | `cold-process` startup/catch-up throughput and CPU/RSS; `moving-preset` concurrent-read HTTP/service time and event-loop-delay budgets |
| PERF5 | Each recurring job's own elapsed time, CPU/RSS, event-loop delay, and concurrent-read interference | `cold-process` readiness/catch-up and `moving-preset` concurrent-read budgets, plus **per-job attribution** for boot/initial scan, 2s tail, 30s discovery, reconciliation, post-ingest detectors, probes, reports, effect evaluation, outcomes, calibration, and weekly callbacks |

PERF5 must not report only an aggregate timer total: it records every job family
and invocation boundary separately, including registration, cadence,
non-overlap/cancellation, and shutdown. Direct representative weekly-job cost
plus fake-clock lifecycle evidence is acceptable; an accelerated cadence is
separate stress evidence, not a substitute for the original-cadence budget.
