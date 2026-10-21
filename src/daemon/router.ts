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
import { prep } from "../db/stmt-cache.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import {
  getBootProgress,
  getHistoryCoverage,
  getPipelineRetryHook,
  getPipelineStatus,
} from "../ingest/boot-progress.js";
import { createJudgeService, judgeServiceFor } from "../judge/judge-service.js";
import { getOAuthStatus } from "../oauth/credentials.js";
import { getGithubTokenStatus, refreshGithubTokenStatus } from "../outcomes/github/credential.js";
import { manualLink, manualUnlink } from "../outcomes/linker.js";
import { endSession } from "../query/api/agents-liveness.js";
import { getBurnStatus } from "../query/api/burn-status.js";
import { trackDecisionRoute } from "../query/api/decision-track.js";
import {
  EffectRequestError,
  listEffectEvidence,
  mutateEffectCycle,
  trackCompletedChange,
} from "../query/api/effect-service.js";
import {
  FeedbackError,
  deleteFeedbackRoute,
  getGoalRoute,
  listFeedbackRoute,
  resetGoalRoute,
  setFeedbackRoute,
  setGoalRoute,
  undoFeedbackRoute,
} from "../query/api/feedback-store.js";
import { parseHotSessionsPageQuery, parseHotSessionsQuery } from "../query/api/hot-sessions.js";
import {
  adoptRecommendation,
  calibrateBytesPerToken,
  calibrateLimit,
  confirmApplyJob,
  dismissRecommendation,
  getApplyJob,
  getContextBudget,
  getHookConfig,
  getIdleSessions,
  getLinkageRate,
  getLoopGuard,
  getSession,
  getSettings,
  getSuccessRate,
  getWorkspaceOutcomeDetail,
  installHookRoute,
  listLedger,
  listLiveSessions,
  listRecommendationQueue,
  listWorkspaceNames,
  openTerminalForRec,
  reopenRecommendation,
  resetDatabase,
  rollbackApplyJob,
  startApplyJob,
  undoAdoptRecommendation,
  uninstallHookRoute,
  updateHookConfig,
  updateSettings,
} from "../query/api/index.js";
import type {
  DiagnosticsBuilding,
  DiagnosticsReady,
  QueueArtifactKind,
  QueueCompatibility,
  QueueConfidenceTier,
  QueueCursor,
  QueueFilters,
  QueueMeasurementVerdict,
  QueueSafetyClass,
  QueueSort,
  QueueValueBand,
  RecommendationQueueReadRequest,
  WindowFilter,
} from "../query/api/index.js";
import { getJudgeSetup } from "../query/api/judge-setup.js";
import { getOffloadShare } from "../query/api/offload-share.js";
import {
  type OverviewSection,
  composeSections,
  overviewSectionFns,
} from "../query/api/overview-view.js";
import { getReport, listReports } from "../query/api/reports.js";
import { getSessionSpendPercentile } from "../query/api/self-percentiles.js";
import { getSessionBreakdown } from "../query/api/session-breakdown.js";
import type { BucketSize } from "../query/api/trends.js";
import { buildResponse } from "../query/envelope.js";
import { computeWeightFit } from "../query/limits/history.js";
import { getLimitsModel } from "../query/limits/index.js";
import { applyStatusline, planStatusline } from "../query/limits/statusline-install.js";
import { getStatuslineStatus } from "../query/limits/statusline.js";
import { getParserHealth } from "../query/settings-store.js";
import type { RecommendationLifecycle } from "../recommendations/types.js";
import { bumpDataVersion, getDataScopes, getDataVersion } from "./data-version.js";
import {
  type DiagnosticsSnapshotService,
  type HandoffSource,
  joinHandoffs,
} from "./diagnostics-snapshot.js";
import type { HeadroomSnapshotService } from "./headroom-snapshot.js";
import type { OutcomesControlService } from "./outcomes-control.js";
import { finishRequest, getLoopLag, getPerfSnapshot } from "./perf-monitor.js";
import { getScanStatus, isReady } from "./readiness.js";
import type { RecsSnapshotService } from "./recs-snapshot.js";
import { ROUTE_BUDGETS } from "./route-budgets.js";
import type { RouteSnapshotService, RouteSnapshotSpec } from "./route-snapshot.js";
import { runQueryOffThread, runScanOffThread } from "./scan-offload.js";
import { OFFLOADED_OVERVIEW_SECTIONS, type QueryArgs, type QueryName } from "./scan-tasks.js";
// P1-U0: memo for `direct` GET bodies, keyed by (path + query, data_version, minute bucket).
// A route is memoized unless route-budgets.ts marks it `untimed` or `nomemo`. Writes from
// other processes do not bump data_version; the minute bucket caps that staleness at 60 s.
// AW_DISABLE_GET_MEMO=1 turns it off (kept for one release to rule out a staleness bug).
const MEMO_MAX_ENTRIES = 500;
const memoRoutes = Object.entries(ROUTE_BUDGETS)
  .filter(([, b]) => b.source === "direct" && b.untimed === undefined && b.nomemo === undefined)
  .map(([route]) => route);
const memoStatic = new Set(memoRoutes.filter((r) => !r.includes(":id")));
const memoParam = memoRoutes
  .filter((r) => r.includes(":id"))
  .map((r) => new RegExp(`^${r.replace(":id", "[^/]+")}$`));
interface MemoEntry {
  version: number;
  bucket: number;
  bodies: Map<string, string>;
  /** P1-U2: overview-view's DB-backed sections, same (data_version, minute bucket) key. */
  sections: Map<string, OverviewSection>;
}
const getMemo = new WeakMap<Db, MemoEntry>();
// Set on a memo miss; sendJson stores the 200 body under the request's url.
const memoPending = new WeakMap<
  http.ServerResponse,
  { bodies: Map<string, string>; url: string }
>();
// Responses to non-GET API requests; sendJson bumps data_version for these.
const writeResponses = new WeakSet<http.ServerResponse>();

function memoizable(pathname: string): boolean {
  if (memoStatic.has(pathname)) return true;
  if (pathname in ROUTE_BUDGETS) return false;
  return memoParam.some((re) => re.test(pathname));
}

function memoEntry(db: Db): MemoEntry {
  const version = getDataVersion();
  const bucket = Math.floor(Date.now() / 60_000);
  let memo = getMemo.get(db);
  if (
    memo?.version !== version ||
    memo.bucket !== bucket ||
    memo.bodies.size >= MEMO_MAX_ENTRIES ||
    memo.sections.size >= MEMO_MAX_ENTRIES
  ) {
    memo = { version, bucket, bodies: new Map(), sections: new Map() };
    getMemo.set(db, memo);
  }
  return memo;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  sendPayload(res, status, JSON.stringify(body));
}

/** `sendJson` for a body already serialized (a scan worker's `runQueryOffThread` result). */
function sendPayload(res: http.ServerResponse, status: number, payload: string): void {
  const memo = memoPending.get(res);
  if (memo !== undefined && status === 200) memo.bodies.set(memo.url, payload);
  // P1-U0: a non-GET response is a lifecycle write. Bump before the client can see the
  // response, so its follow-up GET never gets a body memoized before the write.
  if (writeResponses.has(res)) bumpDataVersion("lifecycle");
  writeJson(res, status, payload);
}

function writeJson(res: http.ServerResponse, status: number, payload: string): void {
  // P0-U2: Server-Timing + per-route duration, from the mark http.ts set at
  // request start. finishRequest returns null for a response it never saw
  // marked (not expected on this path, but a safe no-op).
  const timing = finishRequest(res);
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  };
  // A route may set its own Server-Timing entries first (overview-view's sections).
  const routeTiming = res.getHeader("Server-Timing");
  if (timing) {
    headers["Server-Timing"] =
      `${routeTiming === undefined ? "" : `${String(routeTiming)}, `}app;dur=${timing.durationMs}`;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/** OV-13: background builds with nothing to serve meanwhile (cold builds only). */
function coldJobs(
  recs: Pick<RecsSnapshotService, "coldBuild">,
  diagnostics: Pick<DiagnosticsSnapshotService, "coldBuilds">,
): Record<string, unknown>[] {
  const jobs: Record<string, unknown>[] = [];
  const rec = recs.coldBuild();
  if (rec) {
    jobs.push({
      kind: "recommendations",
      started_at: new Date(rec.sinceMs).toISOString(),
      expected_ms: rec.expectedMs,
    });
  }
  for (const build of diagnostics.coldBuilds()) {
    jobs.push({
      kind: "diagnostics",
      window_days: build.windowDays,
      started_at: new Date(build.sinceMs).toISOString(),
      expected_ms: build.expectedMs,
    });
  }
  return jobs;
}

/** The `/api/status` body (also overview-view's `status` section). */
function daemonStatus(db: Db, jobs: Record<string, unknown>[]): Record<string, unknown> {
  const sessions = (prep(db, "SELECT COUNT(*) AS count FROM sessions").get() as { count: number })
    .count;
  // Only the in-memory counters: the full Settings read stats every unmapped workspace's dir on disk.
  const parser_health = getParserHealth();
  return {
    sessions,
    files_seen: parser_health.files_seen,
    files_parsed: parser_health.files_parsed,
    lines_quarantined: parser_health.lines_quarantined,
    ...getScanStatus(),
    // BOOT-1: boot-progress fields exist ONLY pre-ready; the steady-state
    // /api/status shape is unchanged (UI fixtures must not require them).
    // U4: pipeline field included post-ready only when a snapshot exists.
    ...(isReady()
      ? (() => {
          const ps = getPipelineStatus();
          return ps ? { pipeline: ps } : {};
        })()
      : getBootProgress()),
    // P2-U4: optional; present once the slice loop has planned its slices.
    ...(() => {
      const coverage = getHistoryCoverage();
      return coverage ? { history_coverage: coverage } : {};
    })(),
    // P0-U2: optional — an older UI/fixture that doesn't know this field
    // ignores it (memory note "Envelope fields break UI fixtures").
    loop_lag: getLoopLag(),
    // P2-U2 (poll-first, D6): what a polling client compares to decide what to refetch.
    data_version: getDataVersion(),
    data_scopes: getDataScopes(),
    // OV-13: optional, present only while a cold build runs.
    ...(jobs.length > 0 ? { jobs } : {}),
  };
}

// P0-U6 demo hook only: corrupts a named response section so the UI's error
// isolation (WidgetBoundary) can be demonstrated on the real bundle. Inert
// unless both env vars are set; never touches sendJson itself.
function testFaultOn(section: string): boolean {
  return process.env.AW_TEST_HOOKS === "1" && process.env.AW_TEST_FAULT_SECTION === section;
}

function applyTestFault<T>(section: string, body: T): T {
  if (!testFaultOn(section)) return body;
  if (body === null || typeof body !== "object" || !("data" in body)) return body;
  const data = (body as { data: unknown }).data;
  if (data === null || typeof data !== "object") return body;
  return { ...body, data: { ...data, by_workspace: "corrupted-not-an-array" } };
}

/** A handler's uncaught error, inline or from an offloaded query (re-thrown by its inline re-run). */
function sendRouteError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof EffectRequestError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  // Do not leak internal exception text into a cross-origin-readable 500 body
  // (GET routes are not CSRF-gated). Validation errors on POST routes still
  // return their message via the 400 paths above.
  sendJson(res, 500, { error: "Internal error" });
}

function sendFeedbackError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof FeedbackError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  // Oversized body (readBody) rejects with EffectRequestError(400, …).
  if (error instanceof EffectRequestError) {
    sendJson(res, error.status, { error: error.message, code: "INVALID_REQUEST" });
    return;
  }
  sendJson(res, 500, { error: "Internal error" });
}

/** Read + JSON-parse a write body, then run `run` and send its enveloped result. */
function withJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  run: (body: unknown) => unknown,
): void {
  readBody(req, 4096)
    .then((raw) => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body", code: "INVALID_REQUEST" });
        return;
      }
      try {
        sendJson(res, 200, run(body));
      } catch (error) {
        sendFeedbackError(res, error);
      }
    })
    .catch((error) => sendFeedbackError(res, error));
}

/**
 * Every write route reads its body first, then writes synchronously in the continuation. The body
 * resolves only once the DB write gate is open (src/db/write-gate.ts), so that write never lands
 * inside an in-flight WAL checkpoint. A handler that awaits again before writing gates again.
 */
function readBody(req: http.IncomingMessage, maxBytes?: number): Promise<string> {
  return readRawBody(req, maxBytes).then(async (raw) => {
    await awaitDbWriteGate();
    return raw;
  });
}

function readRawBody(req: http.IncomingMessage, maxBytes?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (maxBytes !== undefined && size > maxBytes) {
        reject(new EffectRequestError(400, "Request body is too large."));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
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

const ALL_TIME_FROM = "1970-01-01T00:00:00.000Z";

function parseWindowFilter(url: string): WindowFilter {
  const qs = url.split("?")[1] ?? "";
  const params = new URLSearchParams(qs);
  const filter: WindowFilter = {};
  const preset = params.get("preset");
  if (preset === "24h" || preset === "7d" || preset === "30d") filter.preset = preset;
  // "all" is an unbounded window: every query already handles a from-only filter (to = now).
  const from = preset === "all" ? ALL_TIME_FROM : parseDateParam(params.get("from"));
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

const OPAQUE_QUEUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUEUE_LIFECYCLES = [
  "ACTIONABLE",
  "INVESTIGATE",
  "PARTIALLY_ACTIONED",
  "ACTIONED",
  "MEASURING",
  "MEASURED_IMPROVED",
  "MEASURED_NO_EFFECT",
  "MEASURED_INCONCLUSIVE",
  "MEASURED_WORSE",
  "MEASUREMENT_UNSUPPORTED",
  "DISMISSED",
  "SNOOZED",
  "STALE",
] as const;
const QUEUE_ARTIFACT_KINDS = [
  "installable_hook",
  "config_diff",
  "claude_md_rule",
  "skill",
  "subagent_def",
  "cc_prompt",
  "advice",
] as const;
const QUEUE_VALUE_BANDS = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"] as const;
const QUEUE_CONFIDENCE_TIERS = ["UNKNOWN", "LOW", "MEDIUM", "HIGH"] as const;
const QUEUE_MEASUREMENT_VERDICTS = [
  "AUTOMATIC",
  "VALIDATED_PROXY",
  "MANUAL",
  "UNMEASURABLE",
] as const;
const QUEUE_SAFETY_CLASSES = [
  "HIGH_INTEGRITY",
  "SECRET",
  "PROTECTED_PATH",
  "DESTRUCTIVE_ACTION",
] as const;
const QUEUE_COMPATIBILITIES = ["NATIVE", "LEGACY"] as const;
const QUEUE_SORTS = [
  "RECOMMENDED",
  "ESTIMATED_VALUE",
  "CONFIDENCE",
  "NEWEST_EVIDENCE",
  "MEASURED_RESULT",
] as const;

function queueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): readonly T[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  return value.every((item) => typeof item === "string" && allowed.includes(item as T))
    ? (value as readonly T[])
    : null;
}

function queueNullableEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): readonly (T | null)[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  return value.every(
    (item) => item === null || (typeof item === "string" && allowed.includes(item as T)),
  )
    ? (value as readonly (T | null)[])
    : null;
}

function queueOpaqueArray(value: unknown, allowNull = false): readonly (string | null)[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  return value.every(
    (item) =>
      (allowNull && item === null) || (typeof item === "string" && OPAQUE_QUEUE_ID.test(item)),
  )
    ? (value as readonly (string | null)[])
    : null;
}

/** Parses only bounded structural queue filters; raw payloads are never accepted here. */
function parseQueueFilters(raw: string | null): QueueFilters | null | undefined {
  if (raw === null) return undefined;
  if (raw.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "lifecycle",
    "artifactKind",
    "handlerFamily",
    "workspaceId",
    "scopeId",
    "valueBand",
    "confidenceTier",
    "measurementVerdict",
    "safetyClass",
    "compatibility",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const lifecycle =
    record.lifecycle === undefined ? undefined : queueEnumArray(record.lifecycle, QUEUE_LIFECYCLES);
  const artifactKind =
    record.artifactKind === undefined
      ? undefined
      : queueEnumArray(record.artifactKind, QUEUE_ARTIFACT_KINDS);
  const handlerFamily =
    record.handlerFamily === undefined ? undefined : queueOpaqueArray(record.handlerFamily);
  const workspaceId =
    record.workspaceId === undefined ? undefined : queueOpaqueArray(record.workspaceId, true);
  const scopeId = record.scopeId === undefined ? undefined : queueOpaqueArray(record.scopeId, true);
  const valueBand =
    record.valueBand === undefined
      ? undefined
      : queueEnumArray(record.valueBand, QUEUE_VALUE_BANDS);
  const confidenceTier =
    record.confidenceTier === undefined
      ? undefined
      : queueEnumArray(record.confidenceTier, QUEUE_CONFIDENCE_TIERS);
  const measurementVerdict =
    record.measurementVerdict === undefined
      ? undefined
      : queueNullableEnumArray(record.measurementVerdict, QUEUE_MEASUREMENT_VERDICTS);
  const safetyClass =
    record.safetyClass === undefined
      ? undefined
      : queueNullableEnumArray(record.safetyClass, QUEUE_SAFETY_CLASSES);
  const compatibility =
    record.compatibility === undefined
      ? undefined
      : queueEnumArray(record.compatibility, QUEUE_COMPATIBILITIES);
  if (
    lifecycle === null ||
    artifactKind === null ||
    handlerFamily === null ||
    workspaceId === null ||
    scopeId === null ||
    valueBand === null ||
    confidenceTier === null ||
    measurementVerdict === null ||
    safetyClass === null ||
    compatibility === null
  )
    return null;
  return {
    ...(lifecycle === undefined
      ? {}
      : { lifecycle: lifecycle as readonly RecommendationLifecycle[] }),
    ...(artifactKind === undefined
      ? {}
      : { artifactKind: artifactKind as readonly QueueArtifactKind[] }),
    ...(handlerFamily === undefined ? {} : { handlerFamily: handlerFamily as readonly string[] }),
    ...(workspaceId === undefined
      ? {}
      : { workspaceId: workspaceId as readonly (string | null)[] }),
    ...(scopeId === undefined ? {} : { scopeId: scopeId as readonly (string | null)[] }),
    ...(valueBand === undefined ? {} : { valueBand: valueBand as readonly QueueValueBand[] }),
    ...(confidenceTier === undefined
      ? {}
      : { confidenceTier: confidenceTier as readonly QueueConfidenceTier[] }),
    ...(measurementVerdict === undefined
      ? {}
      : {
          measurementVerdict: measurementVerdict as readonly (QueueMeasurementVerdict | null)[],
        }),
    ...(safetyClass === undefined
      ? {}
      : { safetyClass: safetyClass as readonly QueueSafetyClass[] }),
    ...(compatibility === undefined
      ? {}
      : { compatibility: compatibility as readonly QueueCompatibility[] }),
  };
}

function isQueueCursor(value: unknown): value is QueueCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const snapshot = cursor.snapshot as Record<string, unknown> | null;
  const after = cursor.after as Record<string, unknown> | null;
  const expected = after?.expectedSavingsUsdPerWeek;
  const finiteUnit = (item: unknown): boolean =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1;
  const validExpected =
    expected === null ||
    (typeof expected === "number" && Number.isFinite(expected) && expected >= 0);
  const validEvidence =
    after?.evidenceNewestAt === "" ||
    (typeof after?.evidenceNewestAt === "string" &&
      Number.isFinite(Date.parse(after.evidenceNewestAt)) &&
      new Date(after.evidenceNewestAt).toISOString() === after.evidenceNewestAt);
  return (
    cursor.version === 1 &&
    typeof cursor.queryFingerprint === "string" &&
    cursor.queryFingerprint.length <= 4096 &&
    snapshot !== null &&
    typeof snapshot === "object" &&
    OPAQUE_QUEUE_ID.test(String(snapshot.compositionSnapshotId)) &&
    Number.isSafeInteger(snapshot.compositionVersion) &&
    (snapshot.compositionVersion as number) > 0 &&
    OPAQUE_QUEUE_ID.test(String(snapshot.rankingPolicyVersion)) &&
    after !== null &&
    typeof after === "object" &&
    (after.safetyPinOrdinal === null ||
      (Number.isSafeInteger(after.safetyPinOrdinal) && (after.safetyPinOrdinal as number) >= 0)) &&
    validExpected &&
    finiteUnit(after.confidence) &&
    finiteUnit(after.applicability) &&
    validEvidence &&
    typeof after.stableId === "string" &&
    OPAQUE_QUEUE_ID.test(after.stableId)
  );
}

function parseRecommendationQueueRequest(url: string): RecommendationQueueReadRequest | null {
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  const rawPageSize = params.get("page_size");
  const pageSize = rawPageSize === null ? 25 : Number(rawPageSize);
  if (!Number.isSafeInteger(pageSize)) return null;
  const rawSort = params.get("sort");
  if (rawSort !== null && !QUEUE_SORTS.includes(rawSort as QueueSort)) return null;
  const filters = parseQueueFilters(params.get("filters"));
  if (filters === null) return null;
  const rawCursor = params.get("cursor");
  let cursor: QueueCursor | undefined;
  if (rawCursor !== null) {
    if (rawCursor.length > 4096) return null;
    try {
      const decoded: unknown = JSON.parse(rawCursor);
      if (!isQueueCursor(decoded)) return null;
      cursor = decoded;
    } catch {
      return null;
    }
  }
  return {
    pageSize,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters === undefined ? {} : { filters }),
    ...(rawSort === null ? {} : { sort: rawSort as QueueSort }),
  };
}

/**
 * D8: one-click (headless) apply is off for 0.2.0. Starting or confirming a job is refused
 * with a 403; the engine, GET and rollback stay so an existing job can still be undone.
 */
const ONE_CLICK_APPLY_ENABLED = false;
const APPLY_DISABLED_BODY = {
  code: "APPLY_DISABLED",
  error:
    "One-click apply is off in 0.2.0: Claude Code permission rules can't confine the edit yet. Use Open in Claude Code or Copy prompt instead.",
};

function refuseApply(req: http.IncomingMessage, res: http.ServerResponse): void {
  readBody(req)
    .catch(() => "")
    .then(() => sendJson(res, 403, APPLY_DISABLED_BODY));
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
  outcomesControl: OutcomesControlService | null | undefined,
  recsSnapshot: RecsSnapshotService,
  diagnosticsSnapshot: DiagnosticsSnapshotService,
  diagnosticsHandoffs: HandoffSource,
  routeSnapshot: RouteSnapshotService,
  headroomSnapshot: HeadroomSnapshotService,
): void {
  const afterRecWrite = <T>(result: T): T => {
    recsSnapshot.invalidate();
    return result;
  };
  // P0-U7: rec writes take the displayed card from the snapshot (no main-thread git probe).
  const cardFor = (recId: string) => recsSnapshot.peekCard(recId);
  // PERF P3-F3: a heavy pure read, run fresh on a scan worker; the body is the same call's JSON.
  const sendQuery = <N extends QueryName>(name: N, ...args: QueryArgs<N>): void => {
    runQueryOffThread(_db, name, ...args).then(
      (payload) => sendPayload(res, 200, payload),
      (error: unknown) => sendRouteError(res, error),
    );
  };
  // P1-U8: keyed by route + window filter; the window resolves when the build starts.
  const sendRouteSnapshot = (
    key: unknown[],
    filter: WindowFilter,
    spec: (window: { from: string; to: string }) => RouteSnapshotSpec,
  ): void => {
    routeSnapshot
      .get(JSON.stringify([...key, filter]), (now) => spec(resolveWindow(filter, now)))
      .then(
        (body) => sendJson(res, 200, body),
        () => sendJson(res, 500, { error: "Internal error" }),
      );
  };
  // Strip query string for routing.
  const pathname = url.split("?")[0] ?? url;
  if (method !== "GET") {
    writeResponses.add(res);
  } else if (process.env.AW_DISABLE_GET_MEMO !== "1" && memoizable(pathname)) {
    const { bodies } = memoEntry(_db);
    const hit = bodies.get(url);
    if (hit !== undefined) {
      writeJson(res, 200, hit);
      return;
    }
    memoPending.set(res, { bodies, url });
  }
  try {
    // GET /api/esf/observations — complete selected-turn accounting cohort.
    if (method === "GET" && pathname === "/api/esf/observations") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const window = resolveWindow(parseWindowFilter(url));
      if (Date.parse(window.from) >= Date.parse(window.to)) {
        sendJson(res, 400, { error: "from must precede to" });
        return;
      }
      sendQuery("getEsfObservations", {
        workspaceId: params.get("workspace_id") || null,
        ...window,
      });
      return;
    }

    // Full-session aggregate: never derive this from a paginated timeline.
    const sessionObservationId = pathname.match(/^\/api\/esf\/session-observations\/([^/]+)$/)?.[1];
    if (method === "GET" && sessionObservationId !== undefined) {
      runQueryOffThread(
        _db,
        "getSessionEsfObservations",
        decodeURIComponent(sessionObservationId),
      ).then(
        // buildResponse puts `data` first, so an unknown session's body starts with a null data.
        (payload) => sendPayload(res, payload.startsWith('{"data":null') ? 404 : 200, payload),
        (error: unknown) => sendRouteError(res, error),
      );
      return;
    }

    // GET /api/esf/effects — independently keyset-paged versioned and legacy evidence.
    if (method === "GET" && pathname === "/api/esf/effects") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const workspaceId = params.get("workspace_id");
      sendJson(
        res,
        200,
        listEffectEvidence(
          _db,
          workspaceId,
          params.get("rec_id") ?? undefined,
          params.get("limit") ?? undefined,
          params.get("cycle_cursor") ?? undefined,
          params.get("legacy_cursor") ?? undefined,
        ),
      );
      return;
    }

    const effectAction = pathname.match(
      /^\/api\/esf\/effects\/(track|stop|close|rollback|attest-rollback)$/,
    )?.[1];
    if (method === "POST" && effectAction !== undefined) {
      readBody(req, 4096)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body." });
            return;
          }
          try {
            const result =
              effectAction === "track"
                ? trackCompletedChange(_db, body)
                : mutateEffectCycle(_db, effectAction, body);
            recsSnapshot.invalidate();
            sendJson(res, 200, result);
          } catch (error) {
            const status = error instanceof EffectRequestError ? error.status : 409;
            sendJson(res, status, {
              error:
                error instanceof EffectRequestError
                  ? error.message
                  : "Effect request conflicts with the current cycle.",
            });
          }
        })
        .catch((error) =>
          sendJson(res, error instanceof EffectRequestError ? error.status : 500, {
            error:
              error instanceof EffectRequestError
                ? error.message
                : "Internal error reading request body",
          }),
        );
      return;
    }

    // POST /api/recommendations/decision/track — RIQ5: open/track a cycle (or
    // record a manual completed-change attestation) from a served decision.
    if (method === "POST" && pathname === "/api/recommendations/decision/track") {
      readBody(req, 4096)
        .then((raw) => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body." });
            return;
          }
          try {
            sendJson(res, 200, afterRecWrite(trackDecisionRoute(_db, body)));
          } catch (error) {
            const status = error instanceof EffectRequestError ? error.status : 409;
            sendJson(res, status, {
              error:
                error instanceof EffectRequestError
                  ? error.message
                  : "Effect request conflicts with the current cycle.",
            });
          }
        })
        .catch((error) =>
          sendJson(res, error instanceof EffectRequestError ? error.status : 500, {
            error:
              error instanceof EffectRequestError
                ? error.message
                : "Internal error reading request body",
          }),
        );
      return;
    }

    // GET /api/overview
    if (method === "GET" && pathname === "/api/overview") {
      sendQuery("getGlobalOverview", parseWindowFilter(url));
      return;
    }

    // GET /api/overview-view?preset=&sections=a,b  (P1-U2: the Overview page, one status per section)
    if (method === "GET" && pathname === "/api/overview-view") {
      const filter = parseWindowFilter(url);
      const window = resolveWindow(filter);
      const week = resolveWindow({ preset: "7d" });
      const fns = overviewSectionFns({
        filter,
        window,
        week,
        status: () => daemonStatus(_db, coldJobs(recsSnapshot, diagnosticsSnapshot)),
        recs: recsSnapshot,
      });
      // PERF P3-F3: the DB-only sections run on a scan worker (same section function, fresh per
      // call); status, top_recs and hook_config read daemon state or the home dir and stay here.
      for (const name of OFFLOADED_OVERVIEW_SECTIONS) {
        fns[name] = () =>
          runQueryOffThread(_db, "overviewSection", name, filter, window, week).then(
            // JSON.stringify(undefined) is undefined: such a section's data stays undefined.
            (payload) =>
              typeof payload === "string" ? (JSON.parse(payload) as unknown) : undefined,
          );
      }
      const requested = new URLSearchParams(url.split("?")[1] ?? "").get("sections");
      const names = requested === null ? Object.keys(fns) : requested.split(",");
      if (!names.every((name) => Object.hasOwn(fns, name))) {
        sendJson(res, 400, { error: "Unknown overview section.", code: "INVALID_QUERY" });
        return;
      }
      const selected = Object.fromEntries(
        names.map((name) => [name, fns[name as keyof typeof fns]]),
      );
      void composeSections(selected, {
        ...(process.env.AW_DISABLE_GET_MEMO === "1" ? {} : { memo: memoEntry(_db).sections }),
        memoPrefix: `${filter.preset ?? ""}|${filter.from ?? ""}|${filter.to ?? ""}|`,
      }).then(
        (view) => {
          res.setHeader(
            "Server-Timing",
            Object.entries(view.sections)
              .map(([name, section]) => `${name};dur=${section.ms}`)
              .join(", "),
          );
          sendJson(res, 200, {
            ...view,
            window: {
              ...window,
              ...(filter.preset === undefined ? {} : { preset: filter.preset }),
            },
          });
        },
        () => sendJson(res, 500, { error: "Internal error" }),
      );
      return;
    }

    // GET /api/context-budget?session_id=... (strictly fail-open budget hook)
    if (method === "GET" && pathname === "/api/context-budget") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const sessionId = params.get("session_id") ?? "";
      sendJson(res, 200, getContextBudget(sessionId, params.get("agent_id")));
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
      runScanOffThread(_db, { kind: "idle-sessions" })
        .then((r) => sendJson(res, 200, r))
        .catch(() => sendJson(res, 200, getIdleSessions()));
      return;
    }

    if (method === "GET" && pathname === "/api/agents-liveness") {
      runScanOffThread(_db, { kind: "agents-liveness" })
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
          return endSession(body.pid, body.confirm).then((result) =>
            sendJson(res, result.status, result),
          );
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
      const rawLimit = new URLSearchParams(url.split("?")[1] ?? "").get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
        sendJson(res, 400, { error: "Invalid workspace limit.", code: "INVALID_QUERY" });
        return;
      }
      const cursor = parseCursor(url);
      if (cursor.after !== undefined) {
        const decoded = Buffer.from(cursor.after, "base64").toString("utf-8");
        if (
          !/^(0|[1-9]\d*)$/.test(decoded) ||
          !Number.isSafeInteger(Number(decoded)) ||
          Buffer.from(decoded, "utf-8").toString("base64") !== cursor.after
        ) {
          sendJson(res, 400, { error: "Invalid workspace cursor.", code: "INVALID_QUERY" });
          return;
        }
      }
      sendQuery(
        "listWorkspaces",
        parseWindowFilter(url),
        cursor.after !== undefined || cursor.limit !== undefined ? cursor : undefined,
      );
      return;
    }

    // GET /api/workspace-names  (unwindowed naming metadata for all workspaces — UIR-8)
    if (method === "GET" && pathname === "/api/workspace-names") {
      sendJson(res, 200, listWorkspaceNames());
      return;
    }

    // GET /api/delivery (delivery proxy metrics across all workspaces)
    if (method === "GET" && pathname === "/api/delivery") {
      sendRouteSnapshot(["delivery", null], parseWindowFilter(url), (window) => ({
        route: "delivery",
        workspaceId: null,
        ...window,
      }));
      return;
    }

    const workspaceDeliveryMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/delivery$/);
    if (method === "GET" && workspaceDeliveryMatch?.[1]) {
      const workspaceId = decodeURIComponent(workspaceDeliveryMatch[1]);
      sendRouteSnapshot(["delivery", workspaceId], parseWindowFilter(url), (window) => ({
        route: "delivery",
        workspaceId,
        ...window,
      }));
      return;
    }

    // GET /api/cost-per-success (lifecycle cost-per-success across all workspaces)
    if (method === "GET" && pathname === "/api/cost-per-success") {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendQuery("getCostPerSuccess", null, from, to);
      return;
    }

    const workspaceCostPerSuccessMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/cost-per-success$/,
    );
    if (method === "GET" && workspaceCostPerSuccessMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendQuery("getCostPerSuccess", decodeURIComponent(workspaceCostPerSuccessMatch[1]), from, to);
      return;
    }

    // GET /api/practices (BM1 published-best-practice scorecard, from a P1-U8 snapshot)
    if (method === "GET" && pathname === "/api/practices") {
      const filter = parseWindowFilter(url);
      const persistedStrip = filter.to === undefined || !!filter.preset;
      sendRouteSnapshot(["practices"], filter, (window) => ({
        route: "practices",
        persistedStrip,
        ...window,
      }));
      return;
    }

    // GET /api/judge-setup (JMS U5: env scan + setup grade + rubric metadata + per-check dollars)
    if (method === "GET" && pathname === "/api/judge-setup") {
      // The cards only price the grade. A cold recs build can take minutes after a restart, so grade
      // now with whatever snapshot exists and let the build finish in the background.
      const peek = recsSnapshot.peek();
      const cards = peek.state === "ready" ? (peek.result.data?.active ?? []) : null;
      if (cards === null) void recsSnapshot.get().catch(() => {});
      // Test seam: point the scan at a fixture dir instead of the real ~/.claude.
      const scan: { claudeDir?: string; claudeJsonPath?: string } = {};
      if (process.env.AW_CLAUDE_DIR) scan.claudeDir = process.env.AW_CLAUDE_DIR;
      if (process.env.AW_CLAUDE_JSON) scan.claudeJsonPath = process.env.AW_CLAUDE_JSON;
      const now = new Date();
      runScanOffThread(_db, { kind: "env-scan", scan, nowIso: now.toISOString() })
        // getJudgeSetup records a grade snapshot (a write): wait out an in-flight checkpoint.
        .then(async (built) => {
          await awaitDbWriteGate();
          return built;
        })
        .then(({ scan: envScan, grade, where }) =>
          sendJson(res, 200, {
            ...getJudgeSetup(_db, { cards: cards ?? [], scan, envScan, grade, where, now }),
            ...(cards === null ? { dollars_pending: true } : {}),
          }),
        )
        .catch(() => sendJson(res, 500, { error: "judge setup failed" }));
      return;
    }

    // JMS-P2 U9 "Judge me": consent preview, approval, the isolated `claude -p` run, stored verdict.
    // POSTs sit behind the http.ts write gate. The browser only ever sends hashes and the nonce.
    if (pathname.startsWith("/api/judge-setup/")) {
      const judge = judgeServiceFor(_db, () => {
        const scan: { claudeDir?: string; claudeJsonPath?: string } = {};
        if (process.env.AW_CLAUDE_DIR) scan.claudeDir = process.env.AW_CLAUDE_DIR;
        if (process.env.AW_CLAUDE_JSON) scan.claudeJsonPath = process.env.AW_CLAUDE_JSON;
        return createJudgeService({ db: _db, scan });
      });
      if (method === "GET" && pathname === "/api/judge-setup/consent") {
        const prep = judge.prep();
        runScanOffThread(_db, {
          kind: "judge-inputs",
          scan: judge.scanOptions(),
          ...(prep ? { prep } : {}),
        })
          // judge.consent records a grade snapshot (a write): wait out an in-flight checkpoint.
          .then(async (inputs) => {
            await awaitDbWriteGate();
            sendJson(res, 200, judge.consent(inputs));
          })
          .catch(() => sendJson(res, 500, { error: "consent failed" }));
        return;
      }
      if (method === "GET" && pathname === "/api/judge-setup/verdict") {
        sendJson(res, 200, { verdict: judge.latest(), remembered: judge.remembered() });
        return;
      }
      const post = (
        handle: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
        limit = 1024,
      ) => {
        readBody(req, limit)
          .then(async (raw) => {
            let body: unknown;
            try {
              body = JSON.parse(raw);
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body." });
              return;
            }
            const rec =
              body !== null && typeof body === "object" && !Array.isArray(body)
                ? (body as Record<string, unknown>)
                : {};
            const out = await handle(rec);
            sendJson(res, out.status, out.body);
          })
          .catch(() => sendJson(res, 500, { error: "Internal error" }));
      };
      const str = (v: unknown): string | null =>
        typeof v === "string" && v.length > 0 && v.length <= 128 ? v : null;
      if (method === "POST" && pathname === "/api/judge-setup/consent/approve") {
        post(async (b) => {
          const hash = str(b.shapeHash);
          return hash === null
            ? { status: 400, body: { error: "shapeHash required" } }
            : judge.approve(hash, b.remember === true);
        });
        return;
      }
      if (method === "POST" && pathname === "/api/judge-setup/consent/sources") {
        // U10: the consent screen's names-to-scrub and included-repos edits.
        const list = (v: unknown, max: number, maxLen: number): string[] | null =>
          Array.isArray(v) &&
          v.length <= max &&
          v.every((s) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= maxLen)
            ? [...new Set((v as string[]).map((s) => s.trim()))]
            : null;
        post(async (b) => {
          const names = list(b.extraNames, 50, 64);
          const repos = b.includedRepos === null ? null : list(b.includedRepos, 500, 1024);
          if (names === null || (b.includedRepos !== null && repos === null))
            return {
              status: 400,
              body: { error: "extraNames and includedRepos must be string lists" },
            };
          judge.setSources(names, repos);
          return { status: 200, body: { ok: true } };
        }, 64 * 1024);
        return;
      }
      if (method === "POST" && pathname === "/api/judge-setup/consent/revoke") {
        post(async () => {
          judge.revoke();
          return { status: 200, body: { ok: true } };
        });
        return;
      }
      if (method === "POST" && pathname === "/api/judge-setup/judge") {
        // Only these two fields are read; anything else in the body (e.g. a payload) is ignored.
        post(async (b) => {
          const hash = str(b.shapeHash);
          return hash === null
            ? { status: 400, body: { error: "shapeHash required" } }
            : judge.run(hash, str(b.consentNonce));
        });
        return;
      }
      if (method === "POST" && pathname === "/api/judge-setup/judge/cancel") {
        post(async () => ({ status: 200, body: { cancelled: judge.cancel() } }));
        return;
      }
    }

    // GET /api/efficiency-headroom (individual weekly estimates; separate selected-window spend)
    if (method === "GET" && pathname === "/api/efficiency-headroom") {
      const filter = parseWindowFilter(url);
      const failed = () => sendJson(res, 500, { error: "Efficiency headroom failed" });
      if (filter.to !== undefined && !filter.preset) {
        const { from, to } = resolveWindow(filter);
        void headroomSnapshot.compute(from, to).then((body) => sendJson(res, 200, body), failed);
        return;
      }
      // P3-U5: a worker-built snapshot; a stale one is served while one rebuild runs (A-17).
      void headroomSnapshot
        .get(`${filter.preset ?? ""}|${filter.from ?? ""}`, () => resolveWindow(filter))
        .then(({ response, freshness }) => {
          sendJson(
            res,
            200,
            freshness ? { ...response, meta: { ...response.meta, freshness } } : response,
          );
        }, failed);
      return;
    }

    const workspaceSelfChurnMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/self-churn$/);
    if (method === "GET" && workspaceSelfChurnMatch?.[1]) {
      const { from, to } = resolveWindow(parseWindowFilter(url));
      sendQuery("getSelfChurn", {
        workspaceId: decodeURIComponent(workspaceSelfChurnMatch[1]),
        from,
        to,
      });
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
      sendQuery("getClosureProxy", {
        workspaceId: decodeURIComponent(workspaceClosureProxyMatch[1]),
        now: new Date().toISOString(),
      });
      return;
    }

    const workspaceSessionsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/sessions$/);
    if (method === "GET" && workspaceSessionsMatch?.[1]) {
      sendQuery(
        "listSessions",
        decodeURIComponent(workspaceSessionsMatch[1]),
        parseWindowFilter(url),
        parseCursor(url),
      );
      return;
    }

    const contextMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
    if (method === "GET" && contextMatch?.[1]) {
      sendQuery("getContextComposition", decodeURIComponent(contextMatch[1]));
      return;
    }

    // GET /api/live  (live strip — LIVE sessions, <=30s freshness)
    if (method === "GET" && pathname === "/api/live") {
      sendJson(res, 200, listLiveSessions());
      return;
    }

    if (method === "GET" && pathname === "/api/hot-sessions/page") {
      const badQuery = (error: unknown): boolean => {
        if (!(error instanceof RangeError)) return false;
        sendJson(res, 400, { error: error.message, code: "INVALID_QUERY" });
        return true;
      };
      let query: ReturnType<typeof parseHotSessionsPageQuery>;
      try {
        query = parseHotSessionsPageQuery(new URLSearchParams(url.split("?")[1] ?? ""));
      } catch (error) {
        if (!badQuery(error)) throw error;
        return;
      }
      runQueryOffThread(_db, "getHotSessionsPage", query).then(
        (payload) => sendPayload(res, 200, payload),
        (error: unknown) => {
          if (!badQuery(error)) sendRouteError(res, error);
        },
      );
      return;
    }

    // GET /api/hot-sessions/models  (complete model catalog for filtering)
    if (method === "GET" && pathname === "/api/hot-sessions/models") {
      sendQuery("getHotSessionModels");
      return;
    }

    // GET /api/hot-sessions  (sessions ranked by list-equivalent cost)
    // Optional preset/from/to windows the ranking (prior-week deltas);
    // with no window param it stays all-time (unchanged default).
    if (method === "GET" && pathname === "/api/hot-sessions") {
      const wf = parseWindowFilter(url);
      const hasWindow = wf.preset !== undefined || wf.from !== undefined || wf.to !== undefined;
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      sendQuery(
        "getHotSessions",
        hasWindow ? resolveWindow(wf) : undefined,
        20,
        parseHotSessionsQuery(params),
      );
      return;
    }

    // GET /api/self-percentiles/weekly  (BM3 — this ISO week vs the trailing 8
    // full weeks for spend + cache-write share; plain observed numbers, no envelope)
    if (method === "GET" && pathname === "/api/self-percentiles/weekly") {
      sendQuery("getWeeklySelfPercentile", new Date());
      return;
    }

    const sessionPanelMatch = pathname.match(/^\/api\/sessions\/([^/]*)\/(diagnostics|breakdown)$/);
    if (method === "GET" && sessionPanelMatch && sessionPanelMatch[2]) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(sessionPanelMatch[1] ?? "");
      } catch {
        sendJson(res, 400, { error: "Invalid session id.", code: "INVALID_QUERY" });
        return;
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        sendJson(res, 400, { error: "Invalid session id.", code: "INVALID_QUERY" });
        return;
      }
      if (sessionPanelMatch[2] === "diagnostics") sendQuery("getSessionDiagnostics", sessionId);
      else sendJson(res, 200, getSessionBreakdown(sessionId, _db));
      return;
    }

    const sessionTurnsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (method === "GET" && sessionTurnsMatch?.[1]) {
      const sessionId = decodeURIComponent(sessionTurnsMatch[1]);
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const anchor = params.get("anchor");
      const turnIndex = params.get("turn_index");
      if (anchor === null && turnIndex === null) {
        sendQuery("getTurnTimeline", sessionId, parseCursor(url));
        return;
      }
      // P1-U6a: one request through the anchor's page, in place of the client's cursor walk.
      if ((anchor !== null && turnIndex !== null) || params.has("after")) {
        sendJson(res, 400, {
          error: "anchor and turn_index are exclusive and do not take after.",
          code: "INVALID_QUERY",
        });
        return;
      }
      if (turnIndex !== null && !/^\d+$/.test(turnIndex)) {
        sendJson(res, 400, { error: "Invalid turn_index.", code: "INVALID_QUERY" });
        return;
      }
      runQueryOffThread(
        _db,
        "getTurnTimelineThrough",
        sessionId,
        anchor !== null ? { anchor } : { turn_index: Number(turnIndex) },
        parseCursor(url),
      ).then(
        (payload) =>
          payload === "null"
            ? sendJson(res, 404, { error: "Anchor is not a turn of this session." })
            : sendPayload(res, 200, payload),
        (error: unknown) => sendRouteError(res, error),
      );
      return;
    }

    const sessionDriversMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/drivers$/);
    if (method === "GET" && sessionDriversMatch?.[1]) {
      sendQuery("getSessionDrivers", decodeURIComponent(sessionDriversMatch[1]));
      return;
    }

    const sessionStoryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/story$/);
    if (method === "GET" && sessionStoryMatch?.[1]) {
      runScanOffThread(_db, {
        kind: "session-story",
        sessionId: decodeURIComponent(sessionStoryMatch[1]),
      }).then(
        (story) =>
          story === null
            ? sendJson(res, 404, { error: "Session not found" })
            : sendJson(res, 200, story),
        (err: unknown) => sendJson(res, 500, { error: String(err) }),
      );
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

    // GET /api/diagnostics?window=7|14|30  (P4 triage view, served from its snapshot)
    if (method === "GET" && pathname === "/api/diagnostics") {
      const window = new URLSearchParams(url.split("?")[1] ?? "").get("window");
      if (window !== null && window !== "7" && window !== "14" && window !== "30") {
        sendJson(res, 400, { error: "Invalid diagnostics window query.", code: "INVALID_QUERY" });
        return;
      }
      const windowDays = window === null ? 7 : (Number(window) as 7 | 14 | 30);
      // Never waits on the build (KTD-6, R27): a cold window answers with its progress.
      const state = diagnosticsSnapshot.get(windowDays);
      if (state.status === "failed") {
        // The build logged the cause; don't leak exception text on a GET 500.
        sendJson(res, 500, { error: "Diagnostics build failed" });
        return;
      }
      if (state.status === "building") {
        const building: DiagnosticsBuilding = {
          status: "building",
          window_days: windowDays,
          progress: state.progress,
        };
        sendJson(res, 200, buildResponse(building, { claim_kind: "OBS_PROXY" }));
        return;
      }
      // Hand-offs join at GET time (KTD-7), so an adopt or dismiss shows without a rebuild.
      void diagnosticsHandoffs
        .get()
        .then((candidates) => {
          const view = joinHandoffs(state.view, candidates);
          const ready: DiagnosticsReady = {
            ...view,
            status: "ready",
            snapshot_at: new Date(state.snapshotAtMs).toISOString(),
            refreshing: state.refreshing,
          };
          sendJson(
            res,
            200,
            buildResponse(ready, {
              claim_kind: "OBS_PROXY",
              n: view.tiles.session_count,
              freshness: state.freshness,
            }),
          );
        })
        .catch(() => sendJson(res, 500, { error: "Diagnostics failed" }));
      return;
    }

    if (method === "GET" && pathname === "/api/recommendations") {
      const wid = new URLSearchParams(url.split("?")[1] ?? "").get("workspace_id") ?? undefined;
      void recsSnapshot.get(wid).then(
        (result) => {
          const peeked = recsSnapshot.peek(wid);
          // A-17: only when the served result is still the current snapshot.
          sendJson(
            res,
            200,
            peeked.state === "ready" && peeked.result === result
              ? { ...result, meta: { ...result.meta, freshness: peeked.freshness } }
              : result,
          );
        },
        (error) =>
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Recommendations build failed",
          }),
      );
      return;
    }

    // GET /api/recommendation-queue (RQU-1a, additive HRE snapshot reader).
    if (method === "GET" && pathname === "/api/recommendation-queue") {
      const request = parseRecommendationQueueRequest(url);
      if (request === null) {
        sendJson(res, 400, { error: "Invalid recommendation queue query.", code: "INVALID_QUERY" });
        return;
      }
      sendJson(res, 200, listRecommendationQueue(request));
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
      if (!ONE_CLICK_APPLY_ENABLED) {
        refuseApply(req, res);
        return;
      }
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
            sendJson(
              res,
              202,
              afterRecWrite(startApplyJob(applyRecId, workspace_cwd, undefined, cardFor)),
            );
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
          return openTerminalForRec(openTerminalRecId, prompt, {}, cardFor).then(
            (result) => sendJson(res, result.launched ? 200 : 409, result),
            (e: unknown) =>
              sendJson(res, 500, {
                error: e instanceof Error ? e.message : "Open terminal failed",
              }),
          );
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
        if (!ONE_CLICK_APPLY_ENABLED) {
          refuseApply(req, res);
          return;
        }
        readBody(req)
          .then(() => {
            try {
              sendJson(res, 202, afterRecWrite(confirmApplyJob(job.jobId, undefined, cardFor)));
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
              sendJson(res, 200, afterRecWrite(rollbackApplyJob(job.jobId)));
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : "Rollback failed" });
            }
          })
          .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
        return;
      }
    }

    // POST /api/pipeline/retry — re-invoke the background pipeline (write path — CSRF gate enforced)
    if (method === "POST" && pathname === "/api/pipeline/retry") {
      const retryHook = getPipelineRetryHook();
      if (!retryHook) {
        // No pipeline registered (e.g. daemon booted with no scan root) — a 202
        // here would falsely claim a retry was accepted when nothing can run.
        sendJson(res, 503, { error: "No pipeline to retry" });
        return;
      }
      retryHook();
      sendJson(res, 202, { retrying: true });
      return;
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
            sendJson(
              res,
              200,
              afterRecWrite(dismissRecommendation(rec_id, Date.now(), dismissedUntilOverride)),
            );
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
          const { rec_id, completed_change, option_id } = body as Record<string, unknown>;
          if (typeof rec_id !== "string" || rec_id.length === 0) {
            sendJson(res, 400, { error: "rec_id is required" });
            return;
          }
          if (
            option_id !== undefined &&
            (typeof option_id !== "string" || option_id.length === 0)
          ) {
            sendJson(res, 400, { error: "option_id must be a non-empty string" });
            return;
          }
          try {
            sendJson(
              res,
              200,
              afterRecWrite(
                adoptRecommendation(rec_id, Date.now(), {
                  completedChange: completed_change === true,
                  optionId: option_id,
                  cardFor,
                }),
              ),
            );
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : "Adopt failed" });
          }
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    if (
      method === "POST" &&
      (pathname === "/api/recommendations/undo-adopt" || pathname === "/api/recommendations/reopen")
    ) {
      withJsonBody(req, res, (body) => {
        const recId = (body as Record<string, unknown>).rec_id;
        const key = (body as Record<string, unknown>).idempotency_key;
        if (typeof recId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(recId))
          throw new EffectRequestError(400, "rec_id must be an opaque identifier.");
        if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(key))
          throw new EffectRequestError(400, "idempotency_key must be an opaque identifier.");
        return afterRecWrite(
          pathname.endsWith("undo-adopt")
            ? undoAdoptRecommendation(recId, key)
            : reopenRecommendation(recId, key),
        );
      });
      return;
    }

    // ── RIQ3 relevance feedback + goal preference (migration 021) ──────────
    // Local, enum-only, SEC-101. Writes are CSRF + session-token gated in http.ts.
    if (method === "GET" && pathname === "/api/recommendations/feedback") {
      const scopeKey = new URLSearchParams(url.split("?")[1] ?? "").get("scope_key");
      if (!scopeKey) {
        sendJson(res, 400, { error: "scope_key is required", code: "INVALID_REQUEST" });
        return;
      }
      sendJson(res, 200, listFeedbackRoute(_db, scopeKey));
      return;
    }
    if (method === "POST" && pathname === "/api/recommendations/feedback") {
      withJsonBody(req, res, (body) => afterRecWrite(setFeedbackRoute(_db, body)));
      return;
    }
    if (method === "POST" && pathname === "/api/recommendations/feedback/undo") {
      withJsonBody(req, res, (body) => afterRecWrite(undoFeedbackRoute(_db, body)));
      return;
    }
    if (method === "DELETE" && pathname === "/api/recommendations/feedback") {
      withJsonBody(req, res, (body) => afterRecWrite(deleteFeedbackRoute(_db, body)));
      return;
    }
    if (method === "GET" && pathname === "/api/recommendations/goal") {
      const scopeKey = new URLSearchParams(url.split("?")[1] ?? "").get("scope_key");
      if (!scopeKey) {
        sendJson(res, 400, { error: "scope_key is required", code: "INVALID_REQUEST" });
        return;
      }
      sendJson(res, 200, getGoalRoute(_db, scopeKey));
      return;
    }
    if (method === "POST" && pathname === "/api/recommendations/goal") {
      withJsonBody(req, res, (body) => afterRecWrite(setGoalRoute(_db, body)));
      return;
    }
    if (method === "POST" && pathname === "/api/recommendations/goal/reset") {
      withJsonBody(req, res, (body) => afterRecWrite(resetGoalRoute(_db, body)));
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

    // GET /api/trends
    if (method === "GET" && pathname === "/api/trends") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const rawBucket = params.get("bucket") ?? "day";
      const bucket: BucketSize = rawBucket === "week" || rawBucket === "month" ? rawBucket : "day";
      const wid = params.get("workspace_id") ?? undefined;
      runQueryOffThread(_db, "getTrends", parseWindowFilter(url), bucket, wid).then(
        (payload) =>
          testFaultOn("trends")
            ? sendJson(res, 200, applyTestFault("trends", JSON.parse(payload) as unknown))
            : sendPayload(res, 200, payload),
        (error: unknown) => sendRouteError(res, error),
      );
      return;
    }

    // GET /api/trends/headroom
    if (method === "GET" && pathname === "/api/trends/headroom") {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const rawBucket = params.get("bucket") ?? "day";
      const bucket: BucketSize = rawBucket === "week" || rawBucket === "month" ? rawBucket : "day";
      const wid = params.get("workspace_id") ?? undefined;
      sendQuery("getHeadroomTrend", parseWindowFilter(url), bucket, wid);
      return;
    }

    // GET /api/outcomes/success-rate
    if (method === "GET" && pathname === "/api/outcomes/success-rate") {
      sendJson(res, 200, getSuccessRate());
      return;
    }

    // GET /api/outcomes/workspaces
    if (method === "GET" && pathname === "/api/outcomes/workspaces") {
      sendQuery("listWorkspaceOutcomes");
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

    // GET /api/query/limits — fully computed Usage-limits card model (spec §1).
    // Response caches 30s inside getLimitsModel (a 429 is held for its full
    // retryInSec to back off upstream); last-good served during 429/error.
    if (method === "GET" && pathname === "/api/query/limits") {
      getLimitsModel()
        .then((model) => sendJson(res, 200, model))
        .catch(() => sendJson(res, 500, { error: "Internal error" }));
      return;
    }

    // GET /api/query/limits/weight-fit — OV-12 U5 (D6) model weight check, from limit_snapshots +
    // turns only (no upstream call). Diagnostic for Settings → calibration.
    if (method === "GET" && pathname === "/api/query/limits/weight-fit") {
      sendJson(res, 200, computeWeightFit(_db));
      return;
    }

    // GET /api/statusline-limits/status — OV-7 statusline fallback file state + copy-line snippet
    if (method === "GET" && pathname === "/api/statusline-limits/status") {
      sendJson(res, 200, getStatuslineStatus());
      return;
    }

    // GET /api/statusline-limits/preview?action=install|uninstall — OV-7b: the exact before/after of the
    // statusLine entry in ~/.claude/settings.json. Read-only.
    if (method === "GET" && pathname === "/api/statusline-limits/preview") {
      const action = new URLSearchParams(url.split("?")[1] ?? "").get("action");
      if (action !== "install" && action !== "uninstall") {
        sendJson(res, 400, { error: "action must be install or uninstall" });
        return;
      }
      const plan = planStatusline(action);
      if (plan.ok) sendJson(res, 200, plan.plan);
      else sendJson(res, plan.code === "conflict" ? 409 : 422, { error: plan.error });
      return;
    }

    // POST /api/statusline-limits/install and /uninstall — OV-7b: writes ~/.claude/settings.json
    // (backup first, atomic). CSRF + session-token gated in http.ts, like /api/hook/install.
    const statuslineApply = pathname.match(/^\/api\/statusline-limits\/(install|uninstall)$/);
    if (method === "POST" && statuslineApply?.[1]) {
      const action = statuslineApply[1] as "install" | "uninstall";
      readBody(req, 64 * 1024)
        .then((raw) => {
          let body: { expectBefore?: unknown } = {};
          try {
            body = raw.trim() === "" ? {} : (JSON.parse(raw) as typeof body);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const eb = body?.expectBefore;
          if (eb !== undefined && eb !== null && typeof eb !== "string") {
            sendJson(res, 400, { error: "expectBefore must be a string or null" });
            return;
          }
          const r = applyStatusline(action, { expectBefore: eb });
          if (r.ok) sendJson(res, 200, { plan: r.plan, backupPath: r.backupPath });
          else sendJson(res, r.code === "conflict" ? 409 : 422, { error: r.error });
        })
        .catch(() => sendJson(res, 500, { error: "Internal error reading request body" }));
      return;
    }

    // GET /api/oauth/status — OAuth usage-reader auth state (no token; read-only)
    if (method === "GET" && pathname === "/api/oauth/status") {
      getOAuthStatus()
        .then((status) => sendJson(res, 200, status))
        .catch(() => sendJson(res, 500, { error: "Internal error reading OAuth status" }));
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

    // Explicitly re-read the local secret source; never contacts GitHub.
    if (method === "POST" && pathname === "/api/outcomes/token-refresh") {
      // Fence old-token tests immediately, including while the store read is pending.
      outcomesControl?.invalidateConnection();
      refreshGithubTokenStatus()
        .then((status) => {
          outcomesControl?.invalidateConnection();
          sendJson(res, 200, status);
        })
        .catch(() => {
          // Also fence tests started during a refresh that failed.
          outcomesControl?.invalidateConnection();
          sendJson(res, 200, {
            configured: false,
            source: null,
            state: "store-error",
            code: "credential-read-failed",
            reason: "Credential store could not be read.",
          });
        });
      return;
    }

    if (method === "GET" && pathname === "/api/outcomes/sync-status") {
      if (!outcomesControl) {
        sendJson(res, 503, { error: "outcomes-unavailable" });
        return;
      }
      sendJson(res, 200, outcomesControl.snapshot());
      return;
    }
    if (method === "POST" && pathname === "/api/outcomes/connection-test") {
      if (!outcomesControl) {
        sendJson(res, 503, { error: "outcomes-unavailable" });
        return;
      }
      const result = outcomesControl.startConnection();
      sendJson(res, result.status, result);
      return;
    }
    if (method === "POST" && pathname === "/api/outcomes/sync-retry") {
      if (!outcomesControl) {
        sendJson(res, 503, { error: "outcomes-unavailable" });
        return;
      }
      const result = outcomesControl.startSync();
      sendJson(res, result.status, result);
      return;
    }

    // GET /api/ready — readiness probe (GET; exempt from CSRF/write gate)
    if (method === "GET" && pathname === "/api/ready") {
      sendJson(res, 200, { ready: isReady() });
      return;
    }

    // Small, aggregate-only revision for list pages during historical backfill.
    if (method === "GET" && pathname === "/api/history-progress") {
      const pipeline = getPipelineStatus();
      sendJson(res, 200, {
        complete: pipeline?.phase === "done" && pipeline.failed_phase === null,
        processing:
          pipeline !== null && pipeline.phase !== "done" && pipeline.failed_phase === null,
        failed: pipeline?.failed_phase != null,
        revision: pipeline
          ? `${pipeline.phase}:${pipeline.files_with_new_data}:${pipeline.weeks_done}:${pipeline.detector_runs}`
          : "pending",
      });
      return;
    }

    // GET /api/status — first-run onboarding counters (GET; no CSRF gate)
    if (method === "GET" && pathname === "/api/status") {
      sendJson(res, 200, daemonStatus(_db, coldJobs(recsSnapshot, diagnosticsSnapshot)));
      return;
    }

    // GET /api/version — P2-U2 (D16): only the counter; the body is the version, so no ETag.
    if (method === "GET" && pathname === "/api/version") {
      sendJson(res, 200, { data_version: getDataVersion() });
      return;
    }

    // GET /api/perf — P0-U2 aggregate-only instrumentation snapshot.
    if (method === "GET" && pathname === "/api/perf") {
      // P3-U1: optional ?since=<epoch ms> scopes loop_lag to that span; omitted = the 60 s window.
      const rawSince = new URLSearchParams(url.split("?")[1] ?? "").get("since");
      const since = rawSince === null || rawSince === "" ? Number.NaN : Number(rawSince);
      sendJson(res, 200, getPerfSnapshot(Number.isFinite(since) ? since : undefined));
      return;
    }

    // 404 for everything else.
    sendJson(res, 404, { error: "Not found", path: pathname });
  } catch (error) {
    sendRouteError(res, error);
  }
}
