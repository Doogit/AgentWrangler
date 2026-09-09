// Aggregate PERF0 campaign runs into worst-observed values per budget row.
// Usage: node scripts/benchmark/aggregate-campaign.mjs <campaign-output-dir>
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/benchmark/aggregate-campaign.mjs <campaign-output-dir>");
  process.exit(2);
}
const histories = [1, 2, 3].map((n) => JSON.parse(fs.readFileSync(path.join(dir, `run${n}-history.json`), "utf8")));
const browsers = [1, 2, 3].map((n) => JSON.parse(fs.readFileSync(path.join(dir, `run${n}-browser.json`), "utf8")));

const SCALES = [1000, 10000, 100000];
const max = (xs) => Math.max(...xs);
const min = (xs) => Math.min(...xs);
const r1 = (x) => Math.round(x * 10) / 10;

for (const scale of SCALES) {
  const runs = histories.map((h) => h.results.find((r) => r.scale_turns === scale));
  const routes = runs.flatMap((r) => r.routes);
  const out = { scale };

  out.startup_to_ready_ms = r1(max(routes.map((r) => r.startup_to_ready_ms)));
  out.child_ready_cpu_ms = r1(max(routes.map((r) => r.child_ready.cpu_ms)));
  out.child_ready_rss_mb = r1(max(routes.map((r) => r.child_ready.rss_mb)));

  for (const phase of ["cold_process", "cold_query", "warm_explicit_window", "moving_window"]) {
    out[phase] = {
      ctrl_elapsed_p50: r1(max(routes.map((r) => r.phases[phase].elapsed_ms.p50_ms))),
      ctrl_elapsed_p95: r1(max(routes.map((r) => r.phases[phase].elapsed_ms.p95_ms))),
      child_service_p50: r1(max(routes.map((r) => r.child_phases[phase].service_time_ms.p50_ms))),
      child_service_p95: r1(max(routes.map((r) => r.child_phases[phase].service_time_ms.p95_ms))),
      query_count_max: max(routes.map((r) => r.child_phases[phase].sqlite_query_count.max_queries)),
      response_bytes_max: max(routes.map((r) => r.phases[phase].response_bytes.max_bytes)),
    };
  }
  // Per-route worst warm query counts (top offenders for the doc)
  const byRoute = {};
  for (const r of routes) {
    byRoute[r.name] = Math.max(byRoute[r.name] ?? 0, r.child_phases.warm_explicit_window.sqlite_query_count.max_queries, r.child_phases.cold_query.sqlite_query_count.max_queries);
  }
  out.query_count_by_route = byRoute;

  out.ingest = {
    turns_per_second_min: r1(min(runs.map((r) => r.ingest_catchup.child.turns_per_second))),
    elapsed_ms_max: r1(max(runs.map((r) => r.ingest_catchup.child.elapsed_ms))),
    cpu_ms_max: r1(max(runs.map((r) => r.ingest_catchup.child.cpu_ms))),
    rss_mb_max: r1(max(runs.map((r) => r.ingest_catchup.child.rss_mb))),
    stall_ms_max: r1(max(runs.map((r) => r.ingest_catchup.child.event_loop_stall_ms))),
    interference_http_max_ms: r1(max(runs.map((r) => r.ingest_catchup.concurrent_http_interference.http_elapsed_ms.max_ms))),
  };
  out.concurrent_reads = {
    ctrl_event_loop_p95_max: r1(max(routes.map((r) => r.concurrent_reads.controller_event_loop_delay.p95Ms ?? r.concurrent_reads.controller_event_loop_delay.p95_ms ?? 0))),
    ctrl_rss_mb_max: r1(max(routes.map((r) => r.concurrent_reads.controller_rss_mb))),
    child_service_p95_max: r1(max(routes.map((r) => r.concurrent_reads.child_samples.service_time_ms.p95_ms))),
  };
  out.idle_event_loop_p95_max = r1(max(runs.map((r) => r.idle.event_loop_p95_ms)));
  out.idle_rss_mb_max = r1(max(runs.map((r) => r.idle.rss_mb)));

  const bruns = browsers.map((b) => b.scales.find((s) => s.scale_turns === scale));
  const broutes = bruns.flatMap((b) => b.routes);
  out.browser = {
    cold_nav_max: r1(max(broutes.map((r) => r.cold_navigation_ms))),
    warm_nav_max: r1(max(broutes.map((r) => r.warm_navigation_ms))),
    cold_ready_max: r1(max(broutes.map((r) => r.cold_overview_ready_ms))),
    warm_ready_max: r1(max(broutes.map((r) => r.warm_overview_ready_ms))),
    requests_max: max(broutes.map((r) => Math.max(r.cold_request_count, r.warm_request_count))),
    retained_entries_max: max(broutes.map((r) => r.retained_cache_entries)),
    long_tasks_max: max(broutes.map((r) => r.long_task_count)),
    long_task_max_ms: r1(max(broutes.map((r) => r.long_task_max_ms))),
    layout_ms_max: r1(max(broutes.map((r) => r.layout_duration_ms))),
    app_cache_entries_max: max(bruns.map((b) => b.app_cache_retention.entries)),
    app_cache_bytes_max: max(bruns.map((b) => b.app_cache_retention.approx_payload_bytes)),
  };
  console.log(JSON.stringify(out, null, 1));
}
console.log("live_preset consistent:", JSON.stringify(browsers.map((b) => b.live_preset_cache.revisit_within_ttl_refetched)));
console.log("react commits:", JSON.stringify(browsers.map((b) => ({ cold: b.react_commit_profiling.cold_commits, warm: b.react_commit_profiling.warm_commits }))));
