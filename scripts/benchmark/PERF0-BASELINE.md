# PERF0 performance baseline and budget freeze

## Status and measurement contract

The acceptance tables below are filled from the 2026-09-09 baseline campaign
(three repeated runs on the final instrumented commit) and are **FROZEN —
operator sign-off obtained 2026-09-09**. A value is accepted only after it
has been filled from **at least three repeated runs**, with **30 samples per
measured distribution** (structural exceptions recorded below). Any remaining
`TBD` is an intentionally unfilled acceptance threshold, not permission to
infer one from an observation.

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

**Baseline campaign 2026-09-09 (FROZEN — operator sign-off 2026-09-09).**
Filled from 3 repeated sequential runs (`run-campaign.sh`, aggregated by
`aggregate-campaign.mjs`) of all three tools on commit `e3110dc` (branch
`perf0-deferred-coverage`, final instrumented commit). Platform: Windows 11 Pro
10.0.26200, i7-12700H (20 logical) / 32 GB, Node v24.14.0, npm 11.9.0, SQLite
3.53.2 (better-sqlite3 12.11.1), tsx 4.23.12, Chrome headless=new, production
Vite assets (`dist/ui`) plus the separate profiling build (`dist/ui-profiling`)
for React commits only. Fixture: the frozen synthetic fixture at 1k/10k/100k
turns, deterministic window anchor 2026-01-01..15; daemon values are the worst
case across 12 routes x 3 runs; warm/moving distributions are 30 samples per
run. Budgets are worst-observed with ~1.5x headroom (throughput floors ~0.7x
the observed minimum). Scale-qualified cells read `1k / 10k / 100k`.

Caveats recorded with this campaign:

- **Cold phases have 1 sample per boot** (3 boot samples per scale, not
  30-sample distributions — structural; matches the historical proposal's
  recording). **Browser cold/warm navigation is 1 observation per run x3.**
- **Spread (per-run worsts at 100k):** startup-to-ready 475/752/1830 ms; warm
  route service p95 169.5/163.8/374.5 ms; ingest catch-up stall
  6366/15514/6475 ms; catch-up throughput 15708/6446/15445 turns/s. 1k/10k
  spread is narrow (e.g. 10k warm p95 15.6–16.6 ms). No samples discarded.
- **Warm-explicit on `cachedQuery` routes is a cache-HIT distribution**
  (`cold_query` is the miss sample); flavor, hot-sessions, cache-write, and
  session-detail routes re-execute SQL every warm request. hot_sessions
  executes 41 statements/request and recommendations up to 52 — the PERF1/PERF2
  targets.
- **NFR-105 gap retained:** warm 100k route service p95 observed 374.5 ms
  breaches the <=250 ms dashboard-query target. That is the gap PERF1/PERF2
  close, not a relaxed target; the 100k warm budget bounds regression only and
  does not supersede NFR-105.
- **The 100k ingest catch-up stall (worst 15.5 s event-loop block with HTTP
  interference max 15514 ms) is PERF4's "before" evidence**; its budget bounds
  regression until PERF4 lands.
- Live moving-preset cache scenario: `revisit_within_ttl_refetched` was `false`
  in all 3 runs (rolling-preset key reused within TTL; no refetch).

### cold-process

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Startup-to-ready | 789.6 / 500.6 / 1830 ms | <= 1200 / 800 / 2800 ms p95 |
| Process CPU through ready (child vantage, `child_ready`) | 546 / 468 / 1109 ms | <= 850 / 750 / 1700 ms p95 |
| RSS at ready (child vantage) | 86.1 / 86.1 / 86.6 MiB | <= 130 MiB p95 (all scales) |
| Ingest catch-up throughput (`runBackscan` over synthetic corpus) | 20693 / 21834 / 6446 turns/s min | >= 14000 / 15000 / 4500 turns/s p50 |
| Event-loop delay during startup/catch-up (setTimeout(0) stall probe) | 48.3 / 458 / 15514 ms | <= 75 / 700 / 23500 ms |

### cold-query

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time (child vantage; worst of cold_process/cold_query first requests) | 15.3 / 46.8 / 423.8 ms | <= 25 / 70 / 640 ms p95 |
| End-to-end loopback HTTP time (controller vantage) | 17.8 / 47.4 / 436.7 ms | <= 30 / 75 / 660 ms p95 |
| SQLite query count | 48 / 52 / 52 queries (worst route: recommendations) | <= 75 / 80 / 80 queries/request |
| Response bytes | 41532 / 41532 / 56193 bytes | <= 98304 bytes/request |
| `getEsfObservations` CPU / RSS at each scale | not measurable — `esf-observation-measure.ts` reports `available: false` | TBD — blocked on ESF public reconciliation (deferred item 1) |

### warm-explicit-window

This phase uses a fixed, explicit historical `from`/`to` window. On
`cachedQuery` routes this is a cache-HIT distribution; `cold_query` is the miss
sample. A hit does not stand in for a cold-query result.

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time (child vantage) | p50 3.5 / 15.4 / 176.1 ms · p95 3.7 / 16.6 / 374.5 ms | <= 6 / 25 / 270 ms p50 · <= 6 / 25 / 565 ms p95 |
| End-to-end loopback HTTP time (controller vantage) | p50 4 / 15.9 / 176.6 ms · p95 8.5 / 17.1 / 375.3 ms | <= 6 / 25 / 270 ms p50 · <= 13 / 26 / 570 ms p95 |
| SQLite query count | 41 queries max (hot_sessions) at all scales | <= 65 queries/request |
| Response bytes | 41532 / 41532 / 56193 bytes | <= 98304 bytes/request |
| Browser warm navigation | 27.3 / 32.3 / 33.1 ms | <= 45 / 50 / 50 ms p95 |
| Browser request count / retained cache entries | 25 requests / 12 entries max | <= 40 requests/navigation / <= 18 entries |

### moving-preset

This phase resolves a rolling/current preset at the recorded clock anchor. It
must exercise advancing effective windows rather than pretending that a new
timestamp is an explicit-window cache hit. (The HTTP samples use advancing
explicit windows; live rolling-preset cache behavior is validated by the
browser `live_preset_cache` scenario.)

| Metric | Observed worst (1k / 10k / 100k) | Proposed budget |
|---|---|---|
| Route service time / loopback HTTP time | service p95 3 / 13.3 / 291 ms · HTTP p95 3.5 / 13.6 / 291.5 ms | <= 5 / 20 / 440 ms p95 / <= 6 / 21 / 440 ms p95 |
| SQLite query count / response bytes | 41 queries / 51627 bytes max | <= 65 queries/request / <= 98304 bytes/request |
| Browser cold and warm navigation | cold 31.7 / 40.8 / 48.1 ms · warm 27.3 / 32.3 / 33.1 ms | <= 50 / 65 / 75 ms p95 / <= 45 / 50 / 50 ms p95 |
| Browser request count / retained cache entries | 25 requests / 12 entries max | <= 40 requests/navigation / <= 18 entries |
| Long tasks | 1 task max, 57 ms max | <= 2 tasks/navigation and <= 90 ms p95 |
| Browser layout duration (Chrome aggregate; not React commit time) | 299.7 ms max (worst at 1k) | <= 450 ms p95 (all scales) |
| React commit duration (profiling build `dist/ui-profiling` on `e3110dc`) | 26.3 ms max (warm, run 3) | <= 40 ms p95 |
| Concurrent-read event-loop delay / RSS (controller vantage) | 28.2 ms p95 / 143.7 MiB max | <= 45 ms p95 / <= 220 MiB p95 |

## Reproducible measurement commands

Run these from the repository root after installing the pinned dependencies.
They must write/retain only aggregate synthetic evidence suitable for review.

```powershell
node --import tsx/esm scripts/benchmark/synthetic-history.ts
node --import tsx/esm scripts/benchmark/browser-measure.ts
node --import tsx/esm scripts/benchmark/esf-observation-measure.ts
```

- Build production assets with `npm run build:ui` **and**
  `npm run build:ui:profiling` before the browser command.
- `synthetic-history.ts` emits controller-observed HTTP timing/bytes, startup
  wall time, controller CPU/RSS/event-loop samples, child safe-job CPU/RSS,
  child idle delay, and seed insertion throughput. It also measures, from the
  child's vantage: per-request route service time (request arrival to response
  finish), per-request SQLite statement-execution counts, per-scale
  `EXPLAIN QUERY PLAN` output for every distinct executed statement, and a real
  populated ingest catch-up (`runBackscan` over a synthetic JSONL corpus) with
  sequential HTTP interference reads while the synchronous scan blocks the
  child event loop (`event_loop_stall_ms` and the interference max latency
  bound the stall).
- The daemon holds a 45s-TTL in-process query cache keyed by concrete window
  (`cachedQuery`). On routes it covers, the warm-explicit distribution is a
  cache-HIT distribution (query count ~1) and `cold_query` is the miss sample;
  routes outside it (e.g. flavor, hot-sessions, cache-write, session detail)
  re-execute their SQL on every warm request. Record which one a budget bounds.
- Its moving-window samples use advancing explicit windows anchored to the
  populated fixture. Live preset/cache behavior is validated separately by the
  browser tool's `live_preset_cache` scenario.
- `browser-measure.ts` measures cold (cleared browser cache) and warm
  navigations for the overview, hot-sessions, workspaces, and recommendations
  routes at 1k/10k/100k turns, rewriting preset API requests to the fixed
  fixture window. It also reports: application query-cache retention (the
  document-local `responseCache` cardinality and approximate payload bytes
  after visiting every measured route in one document), a live moving-preset
  cache scenario (rewriting disabled; a SPA revisit within the 45s response
  cache TTL issuing no new overview request shows the rolling-preset key is
  reused while its effective window advances), and React commit durations from
  the separate `dist/ui-profiling` build (react-dom/profiling; its own build
  identity — not the frozen navigation-budget assets). Chrome LayoutDuration
  remains a distinct, aggregate renderer metric.
- `esf-observation-measure.ts` reports `available: false`: this branch contains
  no `getEsfObservations` implementation. No CPU/RSS measurement is claimed.
- Cold route samples and browser cold/warm navigation have one observation
  per invocation. Only the HTTP warm/moving distributions contain 30 samples
  per run. Run repetition per the freeze protocol is required before any freeze.

## Deferred coverage and completion conditions

The review found that the original coverage description exceeded the executable
harness. Status of the four items:

1. **Still blocked.** Integrate the real ESF observations query and its
   verified accounting-source watermark, then add scale measurements and
   executable integration coverage. Blocked on the ESF public reconciliation
   landing on main; `esf-observation-measure.ts` stays `available: false`.
2. **Implemented.** Child route service time and SQLite query counts/plans are
   instrumented (child-vantage `child_phases` + per-scale `query_plans`), and a
   real populated ingest catch-up with concurrent HTTP interference runs per
   scale (`ingest_catchup`). Seed insert throughput remains reported separately
   and is not used for the catch-up metric.
3. **Implemented.** Browser scenarios cover 1k/10k/100k across the overview,
   hot-sessions, workspaces, and recommendations routes; application
   query-cache retention, live moving-preset cache behavior, and React commit
   durations (profiling build) are measured. CDP layout time and resource cache
   hits are still reported as their own distinct quantities.
4. **Complete — frozen.** The 2026-09-09 campaign collected three matched runs
   on the final instrumented commit `e3110dc` (30-sample warm/moving
   distributions; cold and browser navigation structurally 1 observation per
   run x3, recorded as such). Metadata and spread are recorded with the tables
   above, which were frozen with operator sign-off on 2026-09-09.

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
