/**
 * src/daemon/job-budgets.ts — P0-U14: budget registry for recurring daemon work.
 *
 * Every recurring timer goes through `scheduleJob` (schedule-job.ts) and must
 * have a JOB_BUDGETS entry; every registered detector must have a
 * DETECTOR_BUDGETS entry (test/daemon/job-budgets.test.ts enforces both, plus
 * "no raw setInterval / re-arming setTimeout"). Budgets are warn-only in P0
 * (detector overruns log one aggregate line; job run time is exposed on
 * /api/perf `jobs`); they become enforcing with step (g) at G-P1.
 *
 * RULE: raising a budget requires a `source` that links the measurement
 * behind the new number. A budget marked "derived" has no per-job
 * measurement yet — it is the audit's idle requirement (M18 / P-8: mean idle
 * CPU < 1 % of one core, i.e. budget_ms <= 1 % of period_ms) applied to that
 * job, and should be replaced by a measured value when one exists.
 *
 * Aggregate-only (SEC-101): ids, periods and millisecond figures only.
 */

export type JobKind =
  /** Registered through scheduleJob; run time is recorded per run. */
  | "timer"
  /** Recurring work that runs inside another job's tick (no timer of its own). */
  | "sub-pass"
  /** Runs once per boot, after `done`; measured, fix deferred. */
  | "boot-once";

export interface JobBudget {
  lane: string;
  /** Cadence in ms; 0 for boot-once work. */
  period_ms: number;
  budget_ms: number;
  kind: JobKind;
  /** Where the number comes from (measurement or derivation). Required. */
  source: string;
}

const M18 =
  "derived from M18/P-8 idle requirement (<1% of one core) = 1% of period; not measured per job (plan §4 M18)";
const U13 =
  "measured U13 per-boot run (plan §4 'Per-boot cost after U13 S1–S4' row, 2026-09-29), fix deferred";

export const JOB_BUDGETS = {
  "ingest.tail-tick": {
    lane: "tail",
    period_ms: 2_000,
    budget_ms: 20,
    kind: "timer",
    source: `${M18}: 1% x 2,000 ms. Tail tick = hot/cold stat lanes (src/ingest/ingestor.ts, P0-U13 S1).`,
  },
  "ingest.discovery-tick": {
    lane: "discovery",
    period_ms: 30_000,
    budget_ms: 300,
    kind: "timer",
    source: `${M18}: 1% x 30,000 ms. Applies to ticks that do not run a detector pass; a tick that does is covered by ingest.detector-idle-floor.`,
  },
  "lifecycle.calibration-tick": {
    lane: "background",
    period_ms: 7 * 24 * 60 * 60 * 1000,
    budget_ms: 50,
    kind: "timer",
    source: `${M18}; weekly tick, internally gated on opt-in + staleness (lifecycle.ts), so the tick body is a cheap check.`,
  },
  "lifecycle.outcomes-tick": {
    lane: "outcomes",
    period_ms: 10 * 60 * 1000,
    budget_ms: 100,
    kind: "timer",
    source: `${M18}; the tick only launches the async outcomes pass (own 15-min deadline in outcomes-pass.ts).`,
  },
  "lifecycle.reports-tick": {
    lane: "reports",
    period_ms: 7 * 24 * 60 * 60 * 1000,
    budget_ms: 30_000,
    kind: "timer",
    source:
      "measured U4 oracle: weekly_report boot mark ~30.2 s wall, dominated by awaiting the worker recs snapshot; the report itself early-returns when stored (plan §4 'Boot split after P0-U4' row)",
  },
  "lifecycle.wal-idle-checkpoint": {
    lane: "background",
    period_ms: 30_000,
    budget_ms: 300,
    kind: "timer",
    source: `${M18}: 1% x 30,000 ms. Two cheap reads (total_changes, data_version); a TRUNCATE checkpoint runs at most once per idle period (src/db/idle-checkpoint.ts, P0-U5).`,
  },
  "db.wal-checkpoint-kick": {
    lane: "background",
    period_ms: 1_000,
    budget_ms: 10,
    kind: "timer",
    source: `${M18}: 1% x 1,000 ms. Posts one message to the WAL checkpoint worker; the checkpoint itself runs off main and its time is M14 on /api/perf wal.checkpoint (src/daemon/wal-checkpointer.ts, P2-U4b).`,
  },
  "perf.loop-lag-reset": {
    lane: "perf",
    period_ms: 60_000,
    budget_ms: 5,
    kind: "timer",
    source: `${M18}; a histogram.reset() call (perf-monitor.ts), well under 1 ms.`,
  },
  "perf.loop-sample": {
    lane: "perf",
    period_ms: 10,
    budget_ms: 0.1,
    kind: "timer",
    source: `${M18}; records one timestamped loop-delay sample into a typed-array ring (perf-monitor.ts, P3-U1), microseconds. Runs only for 10 min after a /api/perf?since= read; off at idle.`,
  },
  "perf.process-sampler": {
    lane: "perf",
    period_ms: 1_000,
    budget_ms: 10,
    kind: "timer",
    source: `${M18}: 1% x 1,000 ms. memoryUsage() + one statSync of the -wal file.`,
  },
  "ingest.full-walk": {
    lane: "discovery",
    period_ms: 5 * 60_000,
    budget_ms: 3_000,
    kind: "sub-pass",
    source: `${M18}: 1% x 300,000 ms. Full directory walk inside the discovery tick (discoveryFullWalkIntervalMs); 2,881-file scan root in the U13 census.`,
  },
  "ingest.reconcile-idle-floor": {
    lane: "tail",
    period_ms: 60_000,
    budget_ms: 600,
    kind: "sub-pass",
    source: `${M18}: 1% x 60,000 ms. reconcileNow() run from the tail tick at least every reconcileIdleFloorMs.`,
  },
  "ingest.detector-idle-floor": {
    lane: "detector",
    period_ms: 5 * 60_000,
    budget_ms: 21_709,
    kind: "sub-pass",
    source:
      "measured U10 oracle: in-daemon detector pass 17,203–18,091 ms on the primed base copy, budget = ceil(1.2 x 18,091) (plan §4 row 'W0 detector pass after P0-U10'); per-detector budgets in DETECTOR_BUDGETS. The 5-min idle floor is gated by the S4 marker in U14 part B.",
  },
  "boot.diagnostics-7d-30d": {
    lane: "boot",
    period_ms: 0,
    budget_ms: 14_000,
    kind: "boot-once",
    source: `${U13}: diagnostics 7d then 30d prewarm builds ~14 s wall.`,
  },
  "boot.weekly-report": {
    lane: "boot",
    period_ms: 0,
    budget_ms: 84_000,
    kind: "boot-once",
    source: `${U13}: weekly report shares the ~98 CPU-s non-detector boot residual (minus ~14 s diagnostics) with the linker reads; not attributed separately yet — profile before fixing.`,
  },
  "boot.outcomes-linker-reads": {
    lane: "boot",
    period_ms: 0,
    budget_ms: 84_000,
    kind: "boot-once",
    source: `${U13}: outcomes linker synchronous transcript reads for ~600 sessions; shares the ~98 CPU-s residual with the weekly report, not attributed separately yet.`,
  },
  "boot.commit-linker": {
    lane: "boot",
    period_ms: 0,
    budget_ms: 1_000,
    kind: "boot-once",
    source:
      "measured 2026-10-15 on a live-DB copy (120k tool_events, 6 repos): first run 760-790 ms wall, longest loop block 31-62 ms; later boots 3-34 ms (rowid watermark). src/ingest/commit-linker.ts (O-3).",
  },
} as const satisfies Record<string, JobBudget>;

export type JobName = keyof typeof JOB_BUDGETS;

export interface DetectorBudget {
  /** Rows returned by .all/.get/.iterate in one full pass (P0-U10 counter technique). */
  rows_read: number;
  /** In-daemon wall ms for one pass. */
  ms: number;
  source: string;
}

const BENCH =
  "scripts/benchmark/det-bench.mts median of 3 on a primed live DB copy (2026-10-07, rec reset U7; same-day main control on the same copy): rows_read = ceil(1.2 x bench rows); ms = max(5, ceil(1.2 x 2 x bench ms)) — the in-daemon pass is ~2x the isolated bench (plan §4 row 'W0 detector pass after P0-U10'); 5 ms is a noise floor";

/** Budget entry keyed by runtime detector id (DETECTORS[].id); `// bench` comments are the raw det-bench figures. */
export const DETECTOR_BUDGETS: Record<string, DetectorBudget> = {
  A1: { rows_read: 3062, ms: 146, source: BENCH }, // bench 2551 rows / 60 ms
  A2: { rows_read: 0, ms: 17, source: BENCH }, // bench 0 rows / 7 ms
  B1: { rows_read: 73877, ms: 2125, source: BENCH }, // bench 61564 rows / 885 ms
  B2: { rows_read: 73956, ms: 2374, source: BENCH }, // bench 61630 rows / 989 ms
  B3: { rows_read: 73874, ms: 1465, source: BENCH }, // bench 61561 rows / 610 ms
  B4: { rows_read: 73877, ms: 2076, source: BENCH }, // bench 61564 rows / 865 ms
  C1: { rows_read: 29460, ms: 2562, source: BENCH }, // bench 24550 rows / 1067 ms
  C2: { rows_read: 24668, ms: 2518, source: BENCH }, // bench 20556 rows / 1049 ms
  C3: { rows_read: 24692, ms: 2376, source: BENCH }, // bench 20576 rows / 990 ms
  C4: { rows_read: 27408, ms: 2573, source: BENCH }, // bench 22840 rows / 1072 ms
  C5: { rows_read: 207, ms: 56, source: BENCH }, // bench 172 rows / 23 ms
  // C6/D10 re-benched after their U7 changes on a fresh copy with the context probe run and every Edit row given
  // synthetic hashes (old rows have none). ms scaled by the same-run C5 control (6 ms vs 23 ms above): x3.83.
  C6: { rows_read: 2153, ms: 129, source: BENCH }, // bench 1794 rows / 14 ms (x3.83 = 54 ms)
  C7: { rows_read: 14955, ms: 1850, source: BENCH }, // bench 12462 rows / 771 ms
  C9: { rows_read: 15196, ms: 4353, source: BENCH }, // bench 12663 rows / 1814 ms
  C11: { rows_read: 0, ms: 57, source: BENCH }, // bench 0 rows / 23 ms
  D1: { rows_read: 62, ms: 241, source: BENCH }, // bench 51 rows / 100 ms
  D2: { rows_read: 2504, ms: 579, source: BENCH }, // bench 2086 rows / 241 ms
  D4: { rows_read: 23, ms: 557, source: BENCH }, // bench 19 rows / 232 ms
  D5: { rows_read: 28, ms: 5, source: BENCH }, // bench 23 rows / 1 ms
  D6: { rows_read: 50919, ms: 3330, source: BENCH }, // bench 42432 rows / 1387 ms
  D7: { rows_read: 13757, ms: 6240, source: BENCH }, // bench 11464 rows / 2600 ms
  D8: { rows_read: 161615, ms: 5465, source: BENCH }, // bench 134679 rows / 2277 ms
  D9: { rows_read: 6, ms: 226, source: BENCH }, // bench 5 rows / 94 ms
  D10: { rows_read: 11349, ms: 433, source: BENCH }, // bench 9457 rows / 47 ms (x3.83 = 180 ms), 73 catalog items
  D11: { rows_read: 5428, ms: 250, source: BENCH }, // bench 4523 rows / 104 ms
  D12: { rows_read: 214, ms: 133, source: BENCH }, // bench 178 rows / 55 ms
  D14: { rows_read: 14867, ms: 1849, source: BENCH }, // bench 12389 rows / 770 ms
  E1: { rows_read: 14112, ms: 245, source: BENCH }, // bench 11760 rows / 102 ms (U8, 2026-10-09)
  E2: { rows_read: 6958, ms: 176, source: BENCH }, // bench 5798 rows / 73 ms (U10, 2026-10-09)
  G11: { rows_read: 138, ms: 1607, source: BENCH }, // bench 115 rows / 670 ms
  H1: { rows_read: 8, ms: 1749, source: BENCH }, // bench 6 rows / 728 ms
};

/** Job names with no JOB_BUDGETS entry. */
export function findUnbudgetedJobs(names: readonly string[]): string[] {
  return names.filter((n) => !Object.hasOwn(JOB_BUDGETS, n));
}

/** Detector ids with no DETECTOR_BUDGETS entry. */
export function findUnbudgetedDetectors(ids: readonly string[]): string[] {
  return ids.filter((id) => !Object.hasOwn(DETECTOR_BUDGETS, id));
}

/**
 * One aggregate warn line per over-budget detector in a completed pass (ids
 * and numbers only). Detectors with no entry are skipped — the registry test,
 * not the daemon, is what catches a missing entry.
 */
export function detectorBudgetWarnings(
  perDetector: Readonly<Record<string, { ms: number; rows: number; evals?: number }>>,
): string[] {
  const out: string[] = [];
  for (const [id, c] of Object.entries(perDetector)) {
    const b = Object.hasOwn(DETECTOR_BUDGETS, id) ? DETECTOR_BUDGETS[id] : undefined;
    if (b === undefined) continue;
    // Budgets are per evaluation (one window); a history walk sums one per stale week.
    const evals = Math.max(1, c.evals ?? 1);
    const ms = c.ms / evals;
    const rows = c.rows / evals;
    const budgetMs = Math.max(b.ms, DETECTOR_BUDGET_FLOOR.ms);
    const budgetRows = Math.max(b.rows_read, DETECTOR_BUDGET_FLOOR.rows_read);
    if (ms > budgetMs || rows > budgetRows) {
      out.push(
        `Detector budget exceeded: ${id} ${Math.round(ms)} ms / ${Math.round(rows)} rows per evaluation (${evals}) vs budget ${budgetMs} ms / ${budgetRows} rows`,
      );
    }
  }
  return out;
}

/** Floor under benched budgets: a detector benched at ~0 rows/ms should not warn on noise. */
const DETECTOR_BUDGET_FLOOR = { ms: 50, rows_read: 1_000 };
