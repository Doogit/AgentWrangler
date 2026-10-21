/**
 * src/daemon/route-budgets.ts — per-route latency budgets (P0-U9, plan M2/M18).
 *
 * One entry per GET route in router.ts (parametric segments written `:id`).
 *   p95_ms          idle c=1 p95 budget. Initial value = max(250, ceil(1.2 x audit_p95_ms)),
 *                   where audit_p95_ms is perf-audit-2026-09 section 6's idle c1 p95.
 *                   Routes with no audit row keep the 250 ms floor.
 *   audit_p95_ms    the measurement the budget was derived from (omitted = no audit row).
 *   source          where the response is served from: "rollup" | "snapshot" | "direct" | "stream".
 *                   "stream" routes are excluded from latency checks.
 *   untimed         optional reason a route must not be exercised by timing runs
 *                   (upstream network / credential-store reads).
 *   raised          required when p95_ms exceeds its initial value: the measurement ref that
 *                   justifies it (e.g. an audit or report section).
 *   nomemo          P1-U0: reason a `direct` route must not be served from the data_version
 *                   GET memo (router.ts). Required when the handler reads anything besides the
 *                   DB: processes, the home dir, the network, in-memory daemon state, or a
 *                   second-resolution clock. `untimed` routes are never memoized either.
 *
 * RULES (enforced by test/daemon/route-budgets.test.ts, which imports this module, so entry
 * layout/formatting is free):
 *   - every GET route in router.ts has an entry; no entry for a route that does not exist;
 *   - a p95_ms above the initial value needs a `raised` ref;
 *   - audit_p95_ms values are pinned by a snapshot in the test: changing one is a visible
 *     two-file edit, not a way around the raise rule.
 * scripts/verify-app.mjs step (g) imports this module too.
 */

export type BudgetSource = "rollup" | "snapshot" | "direct" | "stream";

export interface RouteBudget {
  p95_ms: number;
  audit_p95_ms?: number;
  source: BudgetSource;
  untimed?: string;
  raised?: string;
  nomemo?: string;
}

const LIVE_CLOCK = "live view: ages computed from the current second";
const IN_MEMORY = "reads in-memory daemon state, not the DB";

/** max(250 ms, ceil(1.2 x audit idle c1 p95)). */
export function initialBudgetMs(auditP95Ms: number | undefined): number {
  return auditP95Ms === undefined ? 250 : Math.max(250, Math.ceil(1.2 * auditP95Ms));
}

export const ROUTE_BUDGETS: Record<string, RouteBudget> = {
  "/api/agents-liveness": {
    p95_ms: 2460,
    audit_p95_ms: 2049.4,
    source: "direct",
    nomemo: "scans running processes",
  },
  "/api/burn-status": {
    p95_ms: 250,
    audit_p95_ms: 2.58,
    source: "direct",
    untimed: "calls the upstream OAuth usage API",
  },
  "/api/context-budget": {
    p95_ms: 250,
    audit_p95_ms: 14.13,
    source: "direct",
    nomemo: LIVE_CLOCK,
  },
  "/api/cost-per-success": { p95_ms: 260, audit_p95_ms: 216.44, source: "direct" },
  "/api/delivery": { p95_ms: 1553, audit_p95_ms: 1293.37, source: "snapshot" },
  "/api/diagnostics": { p95_ms: 250, audit_p95_ms: 187.67, source: "snapshot" },
  "/api/efficiency-headroom": { p95_ms: 250, audit_p95_ms: 97.45, source: "snapshot" },
  "/api/esf/effects": { p95_ms: 250, audit_p95_ms: 5.61, source: "direct" },
  "/api/esf/observations": { p95_ms: 882, audit_p95_ms: 734.61, source: "direct" },
  "/api/esf/session-observations/:id": { p95_ms: 250, audit_p95_ms: 82.69, source: "direct" },
  "/api/history-progress": {
    p95_ms: 250,
    audit_p95_ms: 0.7,
    source: "direct",
    nomemo: IN_MEMORY,
  },
  "/api/hook-config": {
    p95_ms: 250,
    audit_p95_ms: 1.66,
    source: "direct",
    nomemo: "reads the hook install state from the home dir",
  },
  "/api/hot-sessions": { p95_ms: 643, audit_p95_ms: 535.21, source: "direct" },
  "/api/hot-sessions/models": { p95_ms: 250, audit_p95_ms: 31.83, source: "direct" },
  "/api/hot-sessions/page": { p95_ms: 863, audit_p95_ms: 718.9, source: "direct" },
  "/api/idle-sessions": {
    p95_ms: 670,
    audit_p95_ms: 558.17,
    source: "direct",
    nomemo: LIVE_CLOCK,
  },
  "/api/judge-setup": {
    p95_ms: 250,
    source: "direct",
    nomemo: "scans the user's config files on disk and may record a grade snapshot",
  }, // JMS U5; no audit row: 250 ms floor (shared seed: cold 32 ms, warm p95 13 ms; scan ~20 ms)
  "/api/judge-setup/consent": {
    p95_ms: 250,
    source: "direct",
    nomemo: "scans and reads the user's config files on disk and may record a grade snapshot",
  }, // JMS-P2 U9; no audit row: 250 ms floor
  "/api/judge-setup/verdict": { p95_ms: 250, source: "direct" }, // JMS-P2 U9; one-row DB read
  "/api/live": { p95_ms: 250, audit_p95_ms: 7.44, source: "direct", nomemo: LIVE_CLOCK },
  "/api/loop-guard": { p95_ms: 250, audit_p95_ms: 46.79, source: "direct", nomemo: LIVE_CLOCK },
  "/api/oauth/status": {
    p95_ms: 250,
    audit_p95_ms: 2,
    source: "direct",
    untimed: "reads the local credential store",
  },
  "/api/outcomes/detail": { p95_ms: 250, audit_p95_ms: 1.56, source: "direct" },
  "/api/outcomes/linkage": { p95_ms: 250, audit_p95_ms: 7.09, source: "direct" },
  "/api/outcomes/success-rate": { p95_ms: 250, audit_p95_ms: 4.3, source: "direct" },
  "/api/outcomes/sync-status": {
    p95_ms: 250,
    audit_p95_ms: 1.76,
    source: "direct",
    nomemo: IN_MEMORY,
  },
  "/api/outcomes/token-status": {
    p95_ms: 250,
    audit_p95_ms: 1.59,
    source: "direct",
    untimed: "reads the local credential store",
  },
  "/api/outcomes/workspaces": { p95_ms: 250, audit_p95_ms: 192.64, source: "direct" },
  "/api/overview": { p95_ms: 250, audit_p95_ms: 135.78, source: "direct" },
  "/api/overview-view": {
    p95_ms: 2843,
    source: "direct",
    raised:
      "P1-U2: no audit row; ceil(1.2 x 2368.94), the sum of the audit p95s of the composed routes (overview x2, workspaces, trends x2, flavor, cache-write, hot-sessions, live, status, linkage, hook-config)",
    nomemo:
      "live, status, top_recs and hook_config read the clock, in-memory state and the home dir; the DB sections have their own memo",
  },
  "/api/perf": { p95_ms: 250, source: "direct", nomemo: IN_MEMORY }, // no audit row: 250 ms floor
  "/api/practices": { p95_ms: 401, audit_p95_ms: 333.67, source: "snapshot" },
  // USAGE-CLI: no upstream call; the /usage CLI runs in the background, never awaited by the GET.
  "/api/query/limits": { p95_ms: 250, source: "direct" }, // no audit row: 250 ms floor
  "/api/query/limits/weight-fit": { p95_ms: 250, source: "direct" }, // OV-12 U5; no audit row: 250 ms floor
  "/api/ready": { p95_ms: 250, audit_p95_ms: 0.54, source: "direct", nomemo: IN_MEMORY },
  "/api/recommendation-queue": { p95_ms: 250, audit_p95_ms: 3.85, source: "snapshot" },
  "/api/recommendations": { p95_ms: 1217, audit_p95_ms: 1013.51, source: "snapshot" },
  "/api/recommendations/feedback": { p95_ms: 250, audit_p95_ms: 2.09, source: "direct" },
  "/api/recommendations/goal": { p95_ms: 250, audit_p95_ms: 2.16, source: "direct" },
  "/api/recommendations/jobs/:id": {
    p95_ms: 250,
    source: "direct",
    nomemo: "apply-job progress is polled while the job runs",
  }, // no audit row: 250 ms floor
  "/api/recommendations/ledger": { p95_ms: 250, audit_p95_ms: 19.62, source: "direct" },
  "/api/reports": { p95_ms: 250, audit_p95_ms: 1, source: "direct" },
  "/api/reports/:id": { p95_ms: 250, audit_p95_ms: 1.08, source: "direct" },
  "/api/self-percentiles/weekly": { p95_ms: 250, audit_p95_ms: 147.21, source: "direct" },
  "/api/sessions/:id": { p95_ms: 250, audit_p95_ms: 29.44, source: "direct" },
  "/api/sessions/:id/breakdown": { p95_ms: 250, audit_p95_ms: 38.29, source: "direct" },
  "/api/sessions/:id/diagnostics": { p95_ms: 250, audit_p95_ms: 64.83, source: "direct" },
  "/api/sessions/:id/drivers": { p95_ms: 250, audit_p95_ms: 4.66, source: "direct" },
  "/api/sessions/:id/story": {
    p95_ms: 250,
    source: "direct",
    nomemo: "reads the session transcript on disk",
  }, // no audit row: 250 ms floor (81–96 ms measured on the live DB copy, 2026-10-05)
  "/api/sessions/:id/spend-percentile": { p95_ms: 250, audit_p95_ms: 2.26, source: "direct" },
  "/api/sessions/:id/turns": { p95_ms: 250, audit_p95_ms: 6.58, source: "direct" },
  "/api/settings": {
    p95_ms: 250,
    audit_p95_ms: 15.05,
    source: "direct",
    nomemo: "stats the scan roots on disk",
  },
  "/api/status": { p95_ms: 250, audit_p95_ms: 2.04, source: "direct", nomemo: IN_MEMORY },
  "/api/statusline-limits/preview": {
    p95_ms: 250,
    source: "direct",
    nomemo: "reads the home dir",
  }, // no audit row: 250 ms floor
  "/api/statusline-limits/status": {
    p95_ms: 250,
    source: "direct",
    nomemo: "reads the home dir",
  }, // no audit row: 250 ms floor
  "/api/trends": { p95_ms: 690, audit_p95_ms: 574.19, source: "direct" },
  "/api/trends/headroom": { p95_ms: 721, audit_p95_ms: 600.53, source: "direct" },
  "/api/version": { p95_ms: 250, source: "direct", nomemo: IN_MEMORY }, // P2-U2; no audit row: 250 ms floor
  "/api/workspace-names": { p95_ms: 250, audit_p95_ms: 1.7, source: "direct" },
  "/api/workspaces": { p95_ms: 250, audit_p95_ms: 125.75, source: "direct" },
  "/api/workspaces/:id/closure-proxy": { p95_ms: 1481, audit_p95_ms: 1233.83, source: "direct" },
  "/api/workspaces/:id/context": { p95_ms: 250, audit_p95_ms: 23.55, source: "direct" },
  "/api/workspaces/:id/cost-per-success": { p95_ms: 250, audit_p95_ms: 154.23, source: "direct" },
  "/api/workspaces/:id/delivery": { p95_ms: 9976, audit_p95_ms: 8312.58, source: "snapshot" },
  "/api/workspaces/:id/offload-share": { p95_ms: 250, audit_p95_ms: 66.78, source: "direct" },
  "/api/workspaces/:id/self-churn": { p95_ms: 250, audit_p95_ms: 158.03, source: "direct" },
  "/api/workspaces/:id/sessions": { p95_ms: 747, audit_p95_ms: 621.73, source: "direct" },
};
