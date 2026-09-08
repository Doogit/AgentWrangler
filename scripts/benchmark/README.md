# Synthetic performance measurements

Run `node --import tsx/esm scripts/benchmark/synthetic-history.ts` after installing dependencies and rebuilding better-sqlite3 if needed. The harness validates expected synthetic response counts/identities and rejects helper paths outside its temporary root. It creates and removes temporary synthetic databases, uses a separate HTTP child per scale, and emits aggregate JSON. It never starts the product entrypoint. The seed spans 14 chronological days, up to ten workspaces and 200 turns per session.

## Browser sample (2026-09-07)

One Chromium run on Windows, 1440 x 1000, production assets over local HTTP with repository API fixtures. Baseline was the eager build before this change. Each route had a fresh browser context, followed by a cached reload. These are observations, not timing thresholds. Decoded JS bytes measure parser input, not compilation time; transfer bytes include HTTP overhead. No compression was enabled. Warm reload transferred zero JS bytes on all routes. Heading latency excludes the later network-idle wait.

| Route | Before decoded bytes | After decoded bytes | Cold heading before/after ms | Warm heading before/after ms |
|---|---:|---:|---:|---:|
| overview | 845869 | 224253 | 275/185 | 97/101 |
| recommendations | 845869 | 256135 | 291/173 | 97/96 |
| sessions | 845869 | 182367 | 245/176 | 101/85 |
| workspaces | 845869 | 182228 | 235/145 | 84/79 |
| settings | 845869 | 209490 | 204/150 | 102/75 |
| briefs | 845869 | 199124 | 194/163 | 76/67 |
| glossary | 845869 | 173709 | 201/153 | 114/66 |
| sessions/session-demo | 845869 | 593407 | 259/189 | 164/127 |
| workspaces/ws-alpha | 845869 | 193070 | 310/161 | 78/72 |

Overview cold transfer fell from 846,169 to 226,653 bytes; decoded JS fell 73.5% (845,869 to 224,253). Warm reload retained the same 224,253 decoded bytes. The entry chunk is 167,320 bytes; the largest chart chunk is 351,581 bytes, below the unchanged build warning threshold.

First sidebar navigation adds route chunks (about 4-73 kB); revisits request no additional JS. First transition headings ranged 44-152 ms after splitting versus 40-177 ms before; revisit timings are noisy and do not prove a latency improvement. API request lists matched the baseline except deferred chart headroom. The pre-existing repeated Overview request remains; splitting introduced no new duplicate request pattern in these traces. Clicking the chart load control rendered two visible charts without alerts in a fresh context. Unit coverage exercises suspense, rejected imports, navigation recovery, keyboard-accessible manual loading and settled-layout observation.

## HTTP and background-job sample

Cold means the first request to each route after child startup, not process startup or a fresh process per route. Warm p50/p95 use 30 sequential requests and nearest-rank percentiles. Shared database caches may help later routes. Results below are milliseconds from one Windows Node 24 run.

| Turns | Route | Cold | Warm p50 | Warm p95 |
|---:|---|---:|---:|---:|
| 1000 | overview | 13.215 | 0.745 | 1.177 |
| 1000 | workspaces | 3.591 | 0.74 | 0.985 |
| 1000 | trends | 5.268 | 0.509 | 0.721 |
| 1000 | flavor | 1.949 | 1.234 | 1.471 |
| 1000 | cache_write | 1.547 | 1.209 | 1.365 |
| 1000 | recommendations | 5.113 | 0.649 | 0.809 |
| 1000 | live | 0.817 | 0.64 | 0.803 |
| 1000 | hot_sessions | 2.912 | 2.586 | 3.118 |
| 1000 | status | 2.113 | 0.791 | 1.108 |
| 1000 | workspace_sessions | 1.31 | 0.808 | 0.997 |
| 1000 | session_turns | 2.181 | 1.129 | 2.131 |
| 1000 | session_drivers | 0.991 | 0.52 | 0.612 |
| 10000 | overview | 19.739 | 0.595 | 3.111 |
| 10000 | workspaces | 19.057 | 0.892 | 1.287 |
| 10000 | trends | 37.577 | 0.921 | 1.204 |
| 10000 | flavor | 7.821 | 7.361 | 10.534 |
| 10000 | cache_write | 7.646 | 7.405 | 11.096 |
| 10000 | recommendations | 6.471 | 1.506 | 1.741 |
| 10000 | live | 1.104 | 1.046 | 1.682 |
| 10000 | hot_sessions | 15.608 | 15.78 | 19.055 |
| 10000 | status | 1.664 | 1.011 | 1.194 |
| 10000 | workspace_sessions | 1.89 | 1.097 | 1.643 |
| 10000 | session_turns | 1.658 | 1.327 | 1.603 |
| 10000 | session_drivers | 1.404 | 0.69 | 0.926 |
| 100000 | overview | 151.423 | 0.765 | 2.441 |
| 100000 | workspaces | 205.609 | 0.766 | 1.025 |
| 100000 | trends | 357.475 | 1.334 | 2.067 |
| 100000 | flavor | 99.066 | 100.19 | 145.771 |
| 100000 | cache_write | 132.904 | 127.287 | 142.681 |
| 100000 | recommendations | 20.801 | 7.597 | 8.784 |
| 100000 | live | 1.329 | 0.904 | 1.246 |
| 100000 | hot_sessions | 229.744 | 235.961 | 280.005 |
| 100000 | status | 2.171 | 1.244 | 1.756 |
| 100000 | workspace_sessions | 2.969 | 1.562 | 2.207 |
| 100000 | session_turns | 2.084 | 1.569 | 2.345 |
| 100000 | session_drivers | 1.188 | 0.841 | 1.517 |

Jobs run once each after a timer boundary; they are not production recurring timers. At 100k turns, context_probe_empty_temp: 9.332 ms elapsed / 0 ms process CPU; detectors: 309.64 ms elapsed / 329 ms process CPU; measurement_force: 0.9 ms elapsed / 0 ms process CPU; weekly_report: 92.219 ms elapsed / 93 ms process CPU. These synthetic jobs do not represent populated recommendation, tool-event or context inventories. No query/index change is justified by this one run.

| Turns | Idle duration ms | CPU ms | RSS MB | Event-loop p50/p95 ms |
|---:|---:|---:|---:|---:|
| 1000 | 1009.8 | 0 | 88.6 | 15.286/15.966 |
| 10000 | 1006.7 | 0 | 91.95 | 15.409/16.073 |
| 100000 | 1011.8 | 0 | 132.15 | 15.344/16.146 |

Idle is a one-second post-job child sample with no production interval timers. CPU precision and scheduler noise are visible at this duration; zero measured CPU is not a universal zero-cost claim. The harness excludes product index startup, ingestion/tailers, operator paths/settings, credential discovery, GitHub outcomes and git churn. Context probing receives an empty temporary Claude directory; synthetic workspaces have no repository path. Full-daemon idle and periodic collector attribution remain separate validation work. No live transcript, credential or operator database is included.

## Isolated production entrypoint checkpoint (2026-09-07)

Run `node --import tsx/esm scripts/benchmark/production-daemon-profile.ts` from the repository root. The harness seeds aggregate-only synthetic histories, boots `src/daemon/index.ts` with an isolated home/config/database and empty scan root, and blocks child processes, global fetch and non-loopback sockets. Independent privacy review accepted this harness before execution.

One Windows / Node v24.14.0 run completed at 2026-09-07T16:53:01Z with confirmed child shutdown and empty stderr:

| Synthetic turns | Startup ms / CPU ms | Paused idle CPU ms | Original cadence 5s CPU ms | Accelerated 2s CPU ms | Cadence RSS MB |
|---:|---:|---:|---:|---:|---:|
| 1000 | 1048.013 / 62 | 0 | 15 | 47 | 105.11 |
| 10000 | 947.303 / 78 | 15 | 0 | 48 | 105.51 |
| 100000 | 1175.547 / 62 | 0 | 32 | 77 | 108.92 |

Each scale registered 2s, 30s, 10m and two weekly callbacks; the accelerated window fired each callback twice and recorded four blocked boundary attempts. The five-second original-cadence sample reaches only the two-second tail timer. CPU precision, short sampling windows and scheduler noise limit interpretation.

The fixed January 1-15, 2026 seed falls outside the September current-week and trailing detector windows. Accelerated results measure production callback orchestration and fail-closed overhead, not populated recent-window report/detector workloads. Empty roots exclude transcript parsing, filesystem churn and populated repository mapping. Credentials, Git, network and operator settings are excluded. This source-entrypoint run does not establish installed-package, cross-platform or real production-load acceptance and does not justify an optimization by itself.