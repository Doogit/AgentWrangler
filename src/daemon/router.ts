/**
 * src/daemon/router.ts — minimal API route dispatcher.
 *
 * Routes /api/* requests to the LocalQueryAPI stubs.
 * WP2 and WP4 replace the stub calls with real implementations.
 *
 * All responses are JSON with no permissive CORS headers.
 */

import type * as http from "node:http";
import type { Db } from "../db/open.js";
import { getPractices } from "../detector/practice-registry.js";
import { getOAuthStatus } from "../oauth/credentials.js";
import { getGithubTokenStatus } from "../outcomes/github/credential.js";
import { manualLink, manualUnlink } from "../outcomes/linker.js";
import { endSession, getAgentsLiveness } from "../query/api/agents-liveness.js";
import { getBurnStatus } from "../query/api/burn-status.js";
import { getCostPerSuccess } from "../query/api/cost-per-success.js";
import { getDeliveryMetrics } from "../query/api/delivery.js";
import { getClosureProxy } from "../query/api/effectiveness.js";
import { getEfficiencyHeadroom } from "../query/api/efficiency-headroom.js";
import { getHeadroomTrend } from "../query/api/headroom-trend.js";
import { getHotSessions } from "../query/api/hot-sessions.js";
import {
  adoptRecommendation,
  calibrateBytesPerToken,
  calibrateLimit,
  confirmApplyJob,
  dismissRecommendation,
  getApplyJob,
  getContextBudget,
  getContextComposition,
  getGlobalOverview,
  getHookConfig,
  getIdleSessions,
  getLinkageRate,
  getLoopGuard,
  getSession,
  getSessionDrivers,
  getSettings,
  getSuccessRate,
  getTurnTimeline,
  getWorkspaceOutcomeDetail,
  installHookRoute,
  listLedger,
  listLiveSessions,
  listRecommendations,
  listSessions,
  listWorkspaceOutcomes,
  listWorkspaces,
  openTerminalForRec,
  resetDatabase,
  rollbackApplyJob,
  startApplyJob,
  uninstallHookRoute,
  updateHookConfig,
  updateSettings,
} from "../query/api/index.js";
import type { WindowFilter } from "../query/api/index.js";
import { getOffloadShare } from "../query/api/offload-share.js";
import { getReport, listReports } from "../query/api/reports.js";
import { getSelfChurn } from "../query/api/self-churn.js";
import {
  getSessionSpendPercentile,
  getWeeklySelfPercentile,
} from "../query/api/self-percentiles.js";
import { getFlavorDecomposition } from "../query/api/spend-flavor.js";
import { type BucketSize, getCacheWriteTrend, getTrends } from "../query/api/trends.js";
import { getSettingsData } from "../query/settings-store.js";
import { isReady } from "./readiness.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// JS Date is representable within ±8.64e15 ms of the epoch. resolveWindow can
// derive a bound up to 7 days beyond an explicit from/to; reject any date so
// close to that limit that the derived window would overflow (a RangeError from
// toISOString). Parsable-but-unbounded dates are dropped, not crashed on.
const MAX_WINDOW_TS = 8.64e15 - 7 * 24 * 60 * 60 * 1000;
function parseDateParam(v: string | null): string | undefined {
  if (v === null) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t) || Math.abs(t) > MAX_WINDOW_TS) return undefined;
  return v;
}

function parseWindowFilter(url: string): WindowFilter {
  const qs = url.split("?")[1] ?? "";
  const params = new URLSearchParams(qs);
  const filter: WindowFilter = {};
  const preset = params.get("preset");
  if (preset === "24h" || preset === "7d" || preset === "30d") filter.preset = preset;
  const from = parseDateParam(params.get("from"));
  if (from !== undefined) filter.from = from;
  const to = parseDateParam(params.get("to"));
  if (to !== undefined) filter.to = to;
  return filter;
}

const PRESET_DAYS: Record<NonNullable<WindowFilter["preset"]>, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveWindow(
  filters: WindowFilter,
  now: Date = new Date(),
): { from: string; to: string } {
  const nowIso = now.toISOString();
  if (filters.preset !== undefined) {
    return {
      from: new Date(now.getTime() - PRESET_DAYS[filters.preset] * MS_PER_DAY).toISOString(),
      to: nowIso,
    };
  }
  if (filters.from !== undefined && filters.to !== undefined)
    return { from: filters.from, to: filters.to };
  if (filters.from !== undefined) return { from: filters.from, to: nowIso };
  if (filters.to !== undefined) {
    return {
      from: new Date(new Date(filters.to).getTime() - 7 * MS_PER_DAY).toISOString(),
      to: filters.to,
    };
  }
  return { from: new Date(now.getTime() - 7 * MS_PER_DAY).toISOString(), to: nowIso };
}

function parseCursor(url: string): { after?: string; limit?: number } {
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  const after = params.get("after") ?? undefined;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const cursor: { after?: string; limit?: number } = {};
  if (after !== undefined) cursor.after = after;
  if (limit !== undefined && Number.isInteger(limit) && limit > 0) cursor.limit = limit;
  return cursor;
}

function recApplyId(pathname: string): string | null {
  const m = pathname.match(/^\/api\/recommendations\/([^/]+)\/apply$/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function recOpenTerminalId(pathname: string): string | null {
  const m = pathname.match(/^\/api\/recommendations\/([^/]+)\/open-terminal$/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function jobRoute(
  pathname: string,
): { jobId: string; action: "get" | "confirm" | "rollback" } | null {
  const m = pathname.match(/^\/api\/recommendations\/jobs\/([^/]+)(?:\/(confirm|rollback))?$/);
  if (!m?.[1]) return null;
  const action = m[2] === "confirm" || m[2] === "rollback" ? m[2] : "get";
  return { jobId: decodeURIComponent(m[1]), action };
}

export function handleApiRequest(
  _db: Db,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): void {
  // Strip query string for routing.
  const pathname = url.split("?")[0] ?? url;
  try {
    // GET /api/overview
    if (method === "GET" && pathname === "/api/overview") {
      sendJson(res, 200, getGlobalOverview(parseWindowFilter(url)));
      return;
    }

    // GET /api/context-budget?session_id=... (strictly fail-open budget hook)
    if (method === "GET" && pathname === "/api/context-budget") {
      const sessionId = new URLSearchParams(url.split("?")[1] ?? "").get("session_id") ?? "";
      sendJson(res, 200, getContextBudget(sessionId));
      return;
    }

    // GET /api/loop-guard?session_id=... (strictly fail-open D7 hook)
    if (method === "GET" && pathname === "/api/loop-guard") {
      const sessionId = new URLSearchParams(url.split("?")[1] ?? "").get("session_id") ?? "";
      sendJson(res, 200, getLoopGuard(sessionId));
      return;
    }

    // GET /api/idle-sessions (strictly read-only D9 idle-session measurements)
    if (method === "GET" && pathname === "/api/idle-sessions") {
      sendJson(res, 200, getIdleSessions());
      return;
    }

    if (method === "GET" && pathname === "/api/agents-liveness") {
      getAgentsLiveness()
        .then((r) => sendJson(res, 200, r))
        .catch(() => sendJson(res, 500, { error: "liveness failed" }));
      return;
    }

    if (method === "POST" && pathname === "/api/idle-sessions/end") {
      readBody(req)
        .then((raw) => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const result = endSession(body.pid, body.confirm);
          sendJson(res, result.status, result);
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // GET/POST /api/hook-config (dedicated user_config keys; CSRF gated in http.ts)
    if (method === "GET" && pathname === "/api/hook-config") {
      sendJson(res, 200, getHookConfig());
      return;
    }
    if (method === "POST" && pathname === "/api/hook-config") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          try {
            sendJson(res, 200, updateHookConfig(body as Parameters<typeof updateHookConfig>[0]));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Invalid hook config" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // POST /api/hook/install and /api/hook/uninstall (local settings write; token gated in http.ts)
    if (method === "POST" && pathname === "/api/hook/install") {
      sendJson(res, 200, installHookRoute());
      return;
    }
    if (method === "POST" && pathname === "/api/hook/uninstall") {
      sendJson(res, 200, uninstallHookRoute());
      return;
    }

    // GET /api/reports (stored deterministic weekly report artifacts)
    if (method === "GET" && pathname === "/api/reports") {
      sendJson(res, 200, listReports(_db));
      return;
    }

    const reportMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
    if (method === "GET" && reportMatch?.[1]) {
      const report = getReport(_db, decodeURIComponent(reportMatch[1]));
      sendJson(res, report === undefined ? 404 : 200, report === undefined ? null : report);
      return;
    }

    // GET /api/workspaces  (per-workspace comparison table)
    if (method === "GET" && pathname === "/api/workspaces") {
      sendJson(res, 200, listWorkspaces(parseWindowFilter(url)));
      return;
    }

    // GET /api/delivery (delivery proxy metrics across all workspaces)
    if (method === "GET" && pathname === "/api/delivery") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getDeliveryMetrics(_db, { workspaceId: null, from, to }));
      return;
    }

    const workspaceDeliveryMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/delivery$/);
    if (method === "GET" && workspaceDeliveryMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(
        res,
        200,
        getDeliveryMetrics(_db, {
          workspaceId: decodeURIComponent(workspaceDeliveryMatch[1]),
          from,
          to,
        }),
      );
      return;
    }

    // GET /api/cost-per-success (lifecycle cost-per-success across all workspaces)
    if (method === "GET" && pathname === "/api/cost-per-success") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getCostPerSuccess(_db, null, from, to));
      return;
    }

    const workspaceCostPerSuccessMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/cost-per-success$/,
    );
    if (method === "GET" && workspaceCostPerSuccessMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(
        res,
        200,
        getCostPerSuccess(_db, decodeURIComponent(workspaceCostPerSuccessMatch[1]), from, to),
      );
      return;
    }

    // GET /api/self-churn (14-day self-churn structural proxy across all workspaces)
    if (method === "GET" && pathname === "/api/self-churn") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getSelfChurn(_db, { workspaceId: null, from, to }));
      return;
    }

    // GET /api/practices (BM1 published-best-practice scorecard, computed on request)
    if (method === "GET" && pathname === "/api/practices") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getPractices(_db, { from, to }));
      return;
    }

    // GET /api/efficiency-headroom (BM2 modeled savings vs trailing-window spend)
    if (method === "GET" && pathname === "/api/efficiency-headroom") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getEfficiencyHeadroom(_db, { from, to }));
      return;
    }

    const workspaceSelfChurnMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/self-churn$/);
    if (method === "GET" && workspaceSelfChurnMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(
        res,
        200,
        getSelfChurn(_db, {
          workspaceId: decodeURIComponent(workspaceSelfChurnMatch[1]),
          from,
          to,
        }),
      );
      return;
    }

    // GET /api/offload-share (within-session subagent offload share across all workspaces)
    if (method === "GET" && pathname === "/api/offload-share") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(res, 200, getOffloadShare(_db, { workspaceId: null, from, to }));
      return;
    }

    const workspaceOffloadShareMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/offload-share$/,
    );
    if (method === "GET" && workspaceOffloadShareMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendJson(
        res,
        200,
        getOffloadShare(_db, {
          workspaceId: decodeURIComponent(workspaceOffloadShareMatch[1]),
          from,
          to,
        }),
      );
      return;
    }

    const workspaceClosureProxyMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/closure-proxy$/,
    );
    if (method === "GET" && workspaceClosureProxyMatch?.[1]) {
      sendJson(
        res,
        200,
        getClosureProxy(_db, {
          workspaceId: decodeURIComponent(workspaceClosureProxyMatch[1]),
          now: new Date().toISOString(),
        }),
      );
      return;
    }

    const workspaceSessionsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/sessions$/);
    if (method === "GET" && workspaceSessionsMatch?.[1]) {
      sendJson(
        res,
        200,
        listSessions(
          decodeURIComponent(workspaceSessionsMatch[1]),
          parseWindowFilter(url),
          parseCursor(url),
        ),
      );
      return;
    }

    const contextMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
    if (method === "GET" && contextMatch?.[1]) {
      sendJson(res, 200, getContextComposition(decodeURIComponent(contextMatch[1])));
      return;
    }

    // GET /api/live  (live strip — LIVE sessions, <=30s freshness)
    if (method === "GET" && pathname === "/api/live") {
      sendJson(res, 200, listLiveSessions());
      return;
    }

    // GET /api/hot-sessions  (sessions ranked by list-equivalent cost)
    // Optional preset/from/to windows the ranking (used by Briefs prior-week deltas);
    // with no window param it stays all-time (unchanged default).
    if (method === "GET" && pathname === "/api/hot-sessions") {
      const wf = parseWindowFilter(url);
      const hasWindow = wf.preset !== undefined || wf.from !== undefined || wf.to !== undefined;
      sendJson(res, 200, getHotSessions(hasWindow ? resolveWindow(wf) : undefined));
      return;
    }

    // GET /api/self-percentiles/weekly  (BM3 — this ISO week vs the trailing 8
    // full weeks for spend + cache-write share; plain observed numbers, no envelope)
    if (method === "GET" && pathname === "/api/self-percentiles/weekly") {
      sendJson(res, 200, getWeeklySelfPercentile(_db, new Date()));
      return;
    }

    const sessionTurnsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (method === "GET" && sessionTurnsMatch?.[1]) {
      sendJson(
        res,
        200,
        getTurnTimeline(decodeURIComponent(sessionTurnsMatch[1]), parseCursor(url)),
      );
      return;
    }

    const sessionDriversMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/drivers$/);
    if (method === "GET" && sessionDriversMatch?.[1]) {
      sendJson(res, 200, getSessionDrivers(_db, decodeURIComponent(sessionDriversMatch[1])));
      return;
    }

    const sessionSpendPercentileMatch = pathname.match(
      /^\/api\/sessions\/([^/]+)\/spend-percentile$/,
    );
    if (method === "GET" && sessionSpendPercentileMatch?.[1]) {
      sendJson(
        res,
        200,
        getSessionSpendPercentile(_db, decodeURIComponent(sessionSpendPercentileMatch[1])),
      );
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === "GET" && sessionMatch?.[1]) {
      sendJson(res, 200, getSession(decodeURIComponent(sessionMatch[1])));
      return;
    }

    // GET /api/recommendations  (DetectorEngine — Tier-1 recs, read path)
    if (method === "GET" && pathname === "/api/recommendations") {
      const wid = new URLSearchParams(url.split("?")[1] ?? "").get("workspace_id") ?? undefined;
      sendJson(res, 200, listRecommendations(wid));
      return;
    }

    // GET /api/recommendations/ledger  (W4 Impact Ledger — realized vs modeled)
    if (method === "GET" && pathname === "/api/recommendations/ledger") {
      const wid = new URLSearchParams(url.split("?")[1] ?? "").get("workspace_id") ?? undefined;
      sendJson(res, 200, listLedger(wid));
      return;
    }

    const applyRecId = recApplyId(pathname);
    if (method === "POST" && applyRecId !== null) {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { workspace_cwd } = body as Record<string, unknown>;
          if (typeof workspace_cwd !== "string" || workspace_cwd.length === 0) {
            sendJson(res, 400, { error: "workspace_cwd is required" });
            return;
          }
          try {
            sendJson(res, 202, startApplyJob(applyRecId, workspace_cwd));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Apply failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // POST /api/recommendations/:id/open-terminal (O11 Option B — write path,
    // CSRF/token gate enforced in http.ts). Launches the user's real terminal
    // in the rec's workspace; the daemon never runs the edit.
    const openTerminalRecId = recOpenTerminalId(pathname);
    if (method === "POST" && openTerminalRecId !== null) {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { prompt } = body as Record<string, unknown>;
          if (typeof prompt !== "string" || prompt.length === 0) {
            sendJson(res, 400, { error: "prompt is required" });
            return;
          }
          try {
            const result = openTerminalForRec(openTerminalRecId, prompt);
            sendJson(res, result.launched ? 200 : 409, result);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : "Open terminal failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    const job = jobRoute(pathname);
    if (job !== null) {
      if (method === "GET" && job.action === "get") {
        try {
          sendJson(res, 200, getApplyJob(job.jobId));
        } catch (e) {
          sendJson(res, 404, { error: e instanceof Error ? e.message : "Job not found" });
        }
        return;
      }
      if (method === "POST" && job.action === "confirm") {
        readBody(req)
          .then(() => {
            try {
              sendJson(res, 202, confirmApplyJob(job.jobId));
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : "Confirm failed" });
            }
          })
          .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
        return;
      }
      if (method === "POST" && job.action === "rollback") {
        readBody(req)
          .then(() => {
            try {
              sendJson(res, 200, rollbackApplyJob(job.jobId));
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : "Rollback failed" });
            }
          })
          .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
        return;
      }
    }

    // POST /api/recommendations/dismiss  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/recommendations/dismiss") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { rec_id, dismissed_until } = body as Record<string, unknown>;
          if (typeof rec_id !== "string" || rec_id.length === 0) {
            sendJson(res, 400, { error: "rec_id is required" });
            return;
          }
          // Optional dismissed_until override (ISO string) for explicit snooze duration.
          // When absent, dismissRecommendation applies the default 30-day cool-down.
          const dismissedUntilOverride =
            typeof dismissed_until === "string" && dismissed_until.length > 0
              ? dismissed_until
              : undefined;
          try {
            sendJson(res, 200, dismissRecommendation(rec_id, Date.now(), dismissedUntilOverride));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Dismiss failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // POST /api/recommendations/adopt  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/recommendations/adopt") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { rec_id } = body as Record<string, unknown>;
          if (typeof rec_id !== "string" || rec_id.length === 0) {
            sendJson(res, 400, { error: "rec_id is required" });
            return;
          }
          try {
            sendJson(res, 200, adoptRecommendation(rec_id));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Adopt failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // GET /api/settings
    if (method === "GET" && pathname === "/api/settings") {
      sendJson(res, 200, getSettings());
      return;
    }

    // POST /api/reset  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/reset") {
      try {
        sendJson(res, 200, resetDatabase());
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : "Reset failed" });
      }
      return;
    }

    // POST /api/settings  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/settings") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          try {
            sendJson(res, 200, updateSettings(body as Parameters<typeof updateSettings>[0]));
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Invalid settings" });
          }
        })
        .catch(() => {
          sendJson(res, 500, { error: "Internal error reading request body" });
        });
      return;
    }

    // POST /api/calibrate  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/calibrate") {
      calibrateLimit()
        .then((result) => {
          sendJson(res, 200, result);
        })
        .catch(() => {
          sendJson(res, 500, { error: "Internal error" });
        });
      return;
    }

    // POST /api/calibrate-bytes-per-token  (R12 — write path, CSRF gate enforced)
    if (method === "POST" && pathname === "/api/calibrate-bytes-per-token") {
      calibrateBytesPerToken()
        .then((result) => {
          sendJson(res, 200, result);
        })
        .catch(() => {
          sendJson(res, 500, { error: "Internal error" });
        });
      return;
    }

    // GET /api/overview/flavor  (four-flavor decomposition + cache efficiency)
    if (method === "GET" && pathname === "/api/overview/flavor") {
      sendJson(res, 200, getFlavorDecomposition(parseWindowFilter(url)));
      return;
    }

    // GET /api/trends/cache-write  (cache-write spike timeline)
    if (method === "GET" && pathname === "/api/trends/cache-write") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const rawBucket = params.get("bucket") ?? "day";
      const bucket: BucketSize = rawBucket === "week" || rawBucket === "month" ? rawBucket : "day";
      const wid = params.get("workspace_id") ?? undefined;
      sendJson(res, 200, getCacheWriteTrend(parseWindowFilter(url), bucket, wid));
      return;
    }

    // GET /api/trends
    if (method === "GET" && pathname === "/api/trends") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const rawBucket = params.get("bucket") ?? "day";
      const bucket: BucketSize = rawBucket === "week" || rawBucket === "month" ? rawBucket : "day";
      const wid = params.get("workspace_id") ?? undefined;
      sendJson(res, 200, getTrends(parseWindowFilter(url), bucket, wid));
      return;
    }

    // GET /api/trends/headroom
    if (method === "GET" && pathname === "/api/trends/headroom") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const rawBucket = params.get("bucket") ?? "day";
      const bucket: BucketSize = rawBucket === "week" || rawBucket === "month" ? rawBucket : "day";
      const wid = params.get("workspace_id") ?? undefined;
      sendJson(res, 200, getHeadroomTrend(parseWindowFilter(url), bucket, wid));
      return;
    }

    // GET /api/outcomes/success-rate
    if (method === "GET" && pathname === "/api/outcomes/success-rate") {
      sendJson(res, 200, getSuccessRate());
      return;
    }

    // GET /api/outcomes/workspaces
    if (method === "GET" && pathname === "/api/outcomes/workspaces") {
      sendJson(res, 200, listWorkspaceOutcomes());
      return;
    }

    // GET /api/outcomes/linkage
    if (method === "GET" && pathname === "/api/outcomes/linkage") {
      const wid = new URLSearchParams(url.split("?")[1] ?? "").get("workspace_id") ?? undefined;
      sendJson(res, 200, getLinkageRate(wid));
      return;
    }

    // GET /api/outcomes/detail
    if (method === "GET" && pathname === "/api/outcomes/detail") {
      const workItemId = new URLSearchParams(url.split("?")[1] ?? "").get("work_item_id") ?? "";
      if (workItemId.length === 0) {
        sendJson(res, 400, { error: "work_item_id is required" });
        return;
      }
      sendJson(res, 200, getWorkspaceOutcomeDetail(workItemId));
      return;
    }

    // POST /api/outcomes/link  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/outcomes/link") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { session_id, work_item_id } = body as Record<string, unknown>;
          if (typeof session_id !== "string" || typeof work_item_id !== "string") {
            sendJson(res, 400, { error: "session_id and work_item_id are required strings" });
            return;
          }
          try {
            manualLink(_db, session_id, work_item_id);
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Link failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // POST /api/outcomes/unlink  (write path — CSRF gate in http.ts already enforced)
    if (method === "POST" && pathname === "/api/outcomes/unlink") {
      readBody(req)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { session_id, work_item_id } = body as Record<string, unknown>;
          if (typeof session_id !== "string" || typeof work_item_id !== "string") {
            sendJson(res, 400, { error: "session_id and work_item_id are required strings" });
            return;
          }
          try {
            const changes = manualUnlink(_db, session_id, work_item_id);
            if (changes === 0) {
              sendJson(res, 404, { error: "No MANUAL link found for this session and work item" });
            } else {
              sendJson(res, 200, { ok: true });
            }
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Unlink failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // GET /api/burn-status — OAuth-backed rate-limit burn status (no params)
    if (method === "GET" && pathname === "/api/burn-status") {
      getBurnStatus()
        .then((result) => {
          sendJson(res, 200, result);
        })
        .catch(() => {
          sendJson(res, 500, { error: "Internal error" });
        });
      return;
    }

    // GET /api/oauth/status — OAuth usage-reader auth state (no token; read-only)
    if (method === "GET" && pathname === "/api/oauth/status") {
      sendJson(res, 200, getOAuthStatus());
      return;
    }

    // GET /api/outcomes/token-status — GitHub token availability (no token value)
    if (method === "GET" && pathname === "/api/outcomes/token-status") {
      getGithubTokenStatus()
        .then((status) => sendJson(res, 200, status))
        .catch(() =>
          sendJson(res, 200, {
            configured: false,
            source: null,
            reason: "outcomes sync: token status unavailable",
          }),
        );
      return;
    }

    // GET /api/ready — readiness probe (GET; exempt from CSRF/write gate)
    if (method === "GET" && pathname === "/api/ready") {
      sendJson(res, 200, { ready: isReady() });
      return;
    }

    // GET /api/status — first-run onboarding counters (GET; no CSRF gate)
    if (method === "GET" && pathname === "/api/status") {
      const sessions = (
        _db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }
      ).count;
      const { parser_health } = getSettingsData(_db);
      sendJson(res, 200, {
        sessions,
        files_seen: parser_health.files_seen,
        files_parsed: parser_health.files_parsed,
      });
      return;
    }

    // 404 for everything else.
    sendJson(res, 404, { error: "Not found", path: pathname });
  } catch {
    // Do not leak internal exception text into a cross-origin-readable 500 body
    // (GET routes are not CSRF-gated). Validation errors on POST routes still
    // return their message via the 400 paths above.
    sendJson(res, 500, { error: "Internal error" });
  }
}
