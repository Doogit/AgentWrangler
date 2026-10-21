/**
 * src/ui/api/client.ts — Typed API client for the Overview surface.
 *
 * Integration flip: set USE_MOCK = false (or remove the constant and the branch)
 * once WP2's real API is live and the daemon serves data.
 *
 * The UI NEVER issues SQL or imports better-sqlite3.
 * All method signatures match the frozen LocalQueryAPI contract.
 */

import type { ActionResponse, ConnectionSnapshot } from "../../daemon/outcomes-control";
import type { OperationSnapshot } from "../../daemon/outcomes-pass";
import type { PracticesResult } from "../../detector/practice-registry";
import type { OAuthStatus } from "../../oauth/credentials";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { BurnStatus } from "../../query/api/burn-status";
import type { ContextComposition } from "../../query/api/context-composition";
import type { CostPerSuccess } from "../../query/api/cost-per-success";
import type { DeliveryMetrics } from "../../query/api/delivery";
import type { SessionDiagnosticAnchor } from "../../query/api/diagnostics";
import type { DiagnosticsPayload } from "../../query/api/diagnostics-triage";
import type { ClosureProxy } from "../../query/api/effectiveness";
import type { EfficiencyHeadroom } from "../../query/api/efficiency-headroom";
import type { HeadroomTrendData } from "../../query/api/headroom-trend";
import type { HookConfig, HookConfigResponse, HookConfigUpdate } from "../../query/api/hook-config";
import type { HotSessionsPage, HotSessionsPageQuery } from "../../query/api/hot-sessions";
import type { JudgeSetupResponse } from "../../query/api/judge-setup";
import type {
  LinkageRateData,
  SuccessRateData,
  WorkspaceOutcomeSummary,
} from "../../query/api/outcomes";
import type {
  GlobalOverview,
  PagedList,
  SessionSummary,
  TurnRow,
  WindowFilter,
  WorkspaceNameRow,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { OverviewSection } from "../../query/api/overview-view";
import type { OverviewSectionName } from "../../shared/schemas/overview-view";
import { queryClient } from "./query-client";
import type { DataScope } from "./query-keys";

import type { RecommendationsView } from "../../query/api/recommendations";
import type { LedgerView } from "../../query/api/recommendations-ledger";
import type { Report } from "../../query/api/reports";
import type { SessionSpendPercentile } from "../../query/api/self-percentiles";
import type { SessionBreakdown } from "../../query/api/session-breakdown";
import type { SessionDrivers } from "../../query/api/session-drivers";
import type { SessionStory } from "../../query/api/session-story";
import type {
  CalibrateBytesPerTokenResult,
  CalibrateResult,
  Settings,
  SettingsUpdate,
} from "../../query/api/settings";
import type { BucketSize, TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import type { StatuslineStatus } from "../../query/limits/statusline";
import type { StatuslinePlan } from "../../query/limits/statusline-install";
import type { LimitsModel, WeightFit } from "../../query/limits/types";
import type { HotSessionRow } from "../../query/spend";
import { daemonFetch } from "./daemon-fetch";
import {
  mockBurnStatus,
  mockCalibrateLimit,
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockDiagnostics,
  mockEfficiencyHeadroom,
  mockGithubTokenStatus,
  mockHeadroomTrend,
  mockHookConfigResponse,
  mockHotSessions,
  mockHotSessionsPage,
  mockJudgeSetup,
  mockLedger,
  mockLimitsCli,
  mockLinkageRate,
  mockOAuthStatus,
  mockPractices,
  mockRecommendations,
  mockReport,
  mockReports,
  mockResetDatabase,
  mockSession,
  mockSessionBreakdown,
  mockSessionDiagnostics,
  mockSessionDrivers,
  mockSessionStory,
  mockSettings,
  mockStatus,
  mockStatuslineChange,
  mockStatuslineStatus,
  mockSuccessRate,
  mockTrends,
  mockTurnTimeline,
  mockUpdateSettings,
  mockWeightFit,
  mockWorkspaceDelivery,
  mockWorkspaceNames,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "./fixtures";
import { SessionTokenUnavailableError, withSessionToken } from "./session-token";

/** Overview's selected-window sidechain spend breakdown. */
export type SubagentSpendResponse = NonNullable<GlobalOverview["subagent_spend"]>;

// ---------------------------------------------------------------------------
// Mocks are active only under Vite test mode (MODE === "test"); the production
// build (and any non-test mode) fetches from the live daemon API.
// ---------------------------------------------------------------------------
const USE_MOCK = import.meta.env.MODE === "test";

/** Keep recently requested read responses available while the UI revalidates them. */
export const RESPONSE_CACHE_TTL_MS = 45_000;

/** Bound retained read responses so distinct query parameters cannot grow unbounded. */
export const RESPONSE_CACHE_MAX_ENTRIES = 128;

export interface ResponseCacheEntry<T> {
  data: T;
  fetchedAt: number;
}

/** Closed-enum aggregate pipeline status (U4). SEC-101: counts + phase labels only. */
export interface PipelineStatus {
  phase: "reading" | "detecting" | "history" | "done";
  weeks_total?: number | null;
  weeks_done?: number | null;
  files_total: number;
  files_completed: number;
  files_with_new_data: number;
  detector_runs: number;
  failed_phase: "reading" | "detecting" | null;
  events: string[];
}

/** Aggregate-only daemon counters used by the first-run Overview welcome. */
export interface DaemonStatus {
  sessions: number;
  files_seen: number;
  files_parsed: number;
  /** Optional when connected to an older daemon; missing does not mean scanning. */
  scan_state?: "scanning" | "complete" | "failed";
  lines_quarantined?: number;
  invalid_scan_root_count?: number;
  /** Post-ready background pipeline status (U4). Absent until first snapshot. */
  pipeline?: PipelineStatus;
  /** Boot-progress fields (BOOT-1): present ONLY while /api/ready is false (P1-U5 chip). */
  boot_files_total?: number;
  boot_sessions_found?: number;
  boot_tokens_counted?: number;
  boot_scan_events?: { seq: number; ts: string; kind: string; text: string }[];
  /** Event-loop-delay percentiles in ms (P0-U2). Optional: an older daemon omits it. */
  loop_lag?: { p50: number; p99: number; max: number };
  /** P2-U2 change counters the status poller compares (P2-U5). Optional: an older daemon omits them. */
  data_version?: number;
  /** Counters, plus `clock`: the `<local day>|<UTC day>` string. */
  data_scopes?: Record<Exclude<DataScope, "clock">, number> & { clock: string };
  /** P2-U4 slice-loop coverage (read by P2-U7). Optional: absent until slices are planned. */
  history_coverage?: HistoryCoverage;
  /** OV-13 cold background builds (no snapshot to serve yet). Absent when none run. */
  jobs?: BackgroundJob[];
}

/** One running cold build, listed in the bottom status card (OV-13). */
export interface BackgroundJob {
  kind: "recommendations" | "diagnostics";
  /** Diagnostics only: the window being built. */
  window_days?: number;
  started_at: string;
  /** The last build's duration; null before the first one. */
  expected_ms: number | null;
}

/** How much history the slice loop has ingested (`/api/status`, P2-U4). Aggregate only. */
export interface HistoryCoverage {
  weeks_done: number;
  weeks_total: number;
  complete_through_ms: number | null;
  /** UTC day (YYYY-MM-DD) of the first whole ingested day; null until W0 is done. */
  oldest_complete_day: string | null;
  partial_week: boolean;
}

/**
 * Shared read-response cache. Keys are built from an endpoint and the request
 * parameter object so a later UI layer can synchronously render a fresh value.
 */
export const responseCache = new Map<string, ResponseCacheEntry<unknown>>();
/** Success timestamps for network-only endpoints, kept outside the payload cache. */
export const networkOnlyFetchTimestamps = new Map<string, number>();
const networkOnlyEndpoints = new Set([
  "/api/live",
  "/api/status",
  "/api/burn-status",
  "/api/query/limits",
  // P1-U4: TanStack is the only cache for the Overview page response.
  "/api/overview-view",
]);
let cacheGeneration = 0;

interface InFlightRequest {
  controller: AbortController;
  subscribers: number;
  promise: Promise<unknown>;
}

/** One document-local transport per cache key while a read is in progress. */
const inFlightRequests = new Map<string, InFlightRequest>();

// Local-only debug/benchmark handle: lets the PERF0 browser harness (and a
// devtools console) read retained cache cardinality without shipping new API.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__awResponseCache = responseCache;
}

export function getResponseCacheKey(endpoint: string, params?: unknown): string {
  return `${endpoint}${JSON.stringify(params)}`;
}

/** Return a cache value only while it is within the read TTL. */
export function getCachedResponse<T>(endpoint: string, params?: unknown): T | undefined {
  const key = getResponseCacheKey(endpoint, params);
  if (networkOnlyEndpoints.has(endpoint)) {
    return undefined;
  }
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

/** Return the timestamp of the most recent successful fetch for a cache key. */
export function getLastFetchTimestamp(endpoint: string, params?: unknown): number | undefined {
  if (networkOnlyEndpoints.has(endpoint)) return networkOnlyFetchTimestamps.get(endpoint);
  return responseCache.get(getResponseCacheKey(endpoint, params))?.fetchedAt;
}

function clearResponseCache(): void {
  responseCache.clear();
  cacheGeneration += 1;
  // P1-U3: TanStack caches see every client write too.
  void queryClient.invalidateQueries();
}

function setCachedResponse<T>(key: string, data: T, fetchedAt: number): void {
  if (!responseCache.has(key) && responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES) {
    for (const [expiredKey, entry] of responseCache) {
      if (fetchedAt - entry.fetchedAt >= RESPONSE_CACHE_TTL_MS) {
        responseCache.delete(expiredKey);
      }
    }

    if (responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestFetchedAt = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of responseCache) {
        if (entry.fetchedAt < oldestFetchedAt) {
          oldestKey = entryKey;
          oldestFetchedAt = entry.fetchedAt;
        }
      }
      if (oldestKey !== undefined) responseCache.delete(oldestKey);
    }
  }

  responseCache.set(key, { data, fetchedAt });
}

export { DaemonUnreachableError, isDaemonUnreachableError } from "./daemon-fetch";

/** A token-gated write; a missing token becomes `Error(message)`, as before P1-U6a. */
async function authorized(
  message: string,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  try {
    return await withSessionToken(send);
  } catch (error) {
    if (error instanceof SessionTokenUnavailableError) throw new Error(message);
    throw error;
  }
}

function subscribeToInFlight<T>(request: InFlightRequest, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  request.subscribers += 1;
  return new Promise<T>((resolve, reject) => {
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      signal?.removeEventListener("abort", onAbort);
      request.subscribers -= 1;
      if (request.subscribers === 0) request.controller.abort();
    };
    const onAbort = () => {
      unsubscribe();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    request.promise.then(
      (data) => {
        if (!subscribed) return;
        unsubscribe();
        resolve(data as T);
      },
      (error: unknown) => {
        if (!subscribed) return;
        unsubscribe();
        reject(error);
      },
    );
  });
}

function createInFlightRequest<T>(
  key: string,
  endpoint: string,
  requestEndpoint: string,
  networkOnly: boolean,
): InFlightRequest {
  const controller = new AbortController();
  const fetchGeneration = cacheGeneration;
  const request: InFlightRequest = {
    controller,
    subscribers: 0,
    promise: Promise.resolve(),
  };

  request.promise = (async () => {
    const res = await daemonFetch(requestEndpoint, {
      signal: controller.signal,
      ...(networkOnly ? { cache: "no-store" as const } : {}),
    });
    if (!res.ok) throw new Error(`${requestEndpoint} returned ${res.status}`);
    const data = (await res.json()) as T;
    controller.signal.throwIfAborted();
    if (cacheGeneration === fetchGeneration) {
      const fetchedAt = Date.now();
      if (networkOnly) {
        networkOnlyFetchTimestamps.set(endpoint, fetchedAt);
      } else {
        setCachedResponse(key, data, fetchedAt);
      }
    }
    return data;
  })().finally(() => {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  });

  return request;
}

/**
 * Read a daemon JSON endpoint with a short-lived response cache.
 *
 * `params` contributes to cache identity but is intentionally separate from
 * `endpoint`: callers that build query strings retain their existing transport
 * encoding while UI callers can use the same endpoint/params pair for reads.
 */
export async function fetchCachedJson<T>(
  endpoint: string,
  params?: unknown,
  requestEndpoint = endpoint,
  signal?: AbortSignal,
  /** P1-U3: `fresh` skips the cache and starts a new request rather than joining one in flight
   *  (a TanStack invalidation refetch must reach the network). Later joiners join this one. */
  options: { fresh?: boolean } = {},
): Promise<T> {
  const networkOnly = networkOnlyEndpoints.has(endpoint);
  const cached = networkOnly || options.fresh ? undefined : getCachedResponse<T>(endpoint, params);
  if (cached !== undefined) return cached;

  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  const key = getResponseCacheKey(endpoint, params);
  let request = options.fresh ? undefined : inFlightRequests.get(key);
  if (!request) {
    request = createInFlightRequest<T>(key, endpoint, requestEndpoint, networkOnly);
    inFlightRequests.set(key, request);
  }
  return subscribeToInFlight<T>(request, signal);
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

/** GET /api/overview-view (P1-U2). Section `data` is unvalidated; read it through `safeSection`. */
export interface OverviewViewResponse {
  data_version: number;
  consistent: boolean;
  window: { from: string; to: string; preset?: string };
  sections: Partial<Record<OverviewSectionName, OverviewSection>>;
}

/**
 * The Overview page in one request. TanStack-owned: always `fresh` (never responseCache).
 * `sections` computes only the named sections (e.g. `["top_recs"]` while it is pending).
 */
export function fetchOverviewView(
  preset: string,
  signal?: AbortSignal,
  sections?: OverviewSectionName[],
): Promise<OverviewViewResponse> {
  const params = new URLSearchParams({ preset });
  if (sections !== undefined) params.set("sections", sections.join(","));
  return fetchCachedJson<OverviewViewResponse>(
    "/api/overview-view",
    { preset, sections },
    `/api/overview-view?${params.toString()}`,
    signal,
    { fresh: true },
  );
}

/**
 * Fetch per-workspace summaries for the comparison table.
 * Endpoint: GET /api/workspaces?preset=7d
 */
export async function fetchWorkspaces(
  filter: WindowFilter,
  options?: { fresh?: boolean; limit?: number },
): Promise<ApiResponse<PagedList<WorkspaceSummary>>> {
  if (USE_MOCK) {
    return Promise.resolve(mockWorkspaces(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.fresh) {
    const res = await daemonFetch(`/api/workspaces?${params.toString()}`);
    if (!res.ok) throw new Error(`/api/workspaces returned ${res.status}`);
    return res.json() as Promise<ApiResponse<PagedList<WorkspaceSummary>>>;
  }
  return fetchCachedJson<ApiResponse<PagedList<WorkspaceSummary>>>(
    "/api/workspaces",
    filter,
    `/api/workspaces?${params.toString()}`,
  );
}

/**
 * Fetch unwindowed naming metadata for ALL registered workspaces (UIR-8) —
 * unlike fetchWorkspaces, this includes workspaces idle beyond the widest
 * canned window, so idle workspaces keep friendly labels.
 * Endpoint: GET /api/workspace-names (bare array, no envelope)
 */
export async function fetchWorkspaceNames(): Promise<WorkspaceNameRow[]> {
  if (USE_MOCK) {
    return Promise.resolve(mockWorkspaceNames());
  }
  const res = await daemonFetch("/api/workspace-names");
  if (!res.ok) throw new Error(`/api/workspace-names returned ${res.status}`);
  return (await res.json()) as WorkspaceNameRow[];
}

export async function fetchWorkspaceSessions(
  workspaceId: string,
  filter: WindowFilter,
  cursor?: { after?: string; limit?: number },
): Promise<ApiResponse<PagedList<SessionSummary>>> {
  if (USE_MOCK) return Promise.resolve(mockWorkspaceSessions(workspaceId, filter));
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  if (cursor?.after !== undefined) params.set("after", cursor.after);
  if (cursor?.limit !== undefined) params.set("limit", String(cursor.limit));
  const res = await daemonFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions?${params}`,
  );
  if (!res.ok) throw new Error(`/api/workspaces/${workspaceId}/sessions returned ${res.status}`);
  return res.json() as Promise<ApiResponse<PagedList<SessionSummary>>>;
}

export async function fetchSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<SessionSummary>> {
  if (USE_MOCK) return Promise.resolve(mockSession(sessionId));
  const res = await daemonFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    signal === undefined ? undefined : { signal },
  );
  if (!res.ok) throw new Error(`/api/sessions/${sessionId} returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SessionSummary>>;
}

export async function fetchSessionDiagnostics(
  sessionId: string,
): Promise<ApiResponse<SessionDiagnosticAnchor[]>> {
  if (USE_MOCK) return Promise.resolve(mockSessionDiagnostics(sessionId));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/diagnostics`);
  if (!res.ok) throw new Error(`Session diagnostics returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SessionDiagnosticAnchor[]>>;
}

export async function fetchSessionBreakdown(
  sessionId: string,
): Promise<ApiResponse<SessionBreakdown | null>> {
  if (USE_MOCK) return Promise.resolve(mockSessionBreakdown(sessionId));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/breakdown`);
  if (!res.ok) throw new Error(`Session breakdown returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SessionBreakdown | null>>;
}

export async function fetchTurnTimeline(
  sessionId: string,
  cursor?: { after?: string; limit?: number; anchor?: string; turn_index?: number },
  signal?: AbortSignal,
): Promise<ApiResponse<PagedList<TurnRow>>> {
  if (USE_MOCK) return Promise.resolve(mockTurnTimeline(sessionId, cursor?.after));
  const params = new URLSearchParams();
  if (cursor?.after !== undefined) params.set("after", cursor.after);
  if (cursor?.limit !== undefined) params.set("limit", String(cursor.limit));
  // P1-U6a: every turn through the page holding the anchor, in one request.
  if (cursor?.anchor !== undefined) params.set("anchor", cursor.anchor);
  if (cursor?.turn_index !== undefined) params.set("turn_index", String(cursor.turn_index));
  const res = await daemonFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns?${params}`,
    signal === undefined ? undefined : { signal },
  );
  if (!res.ok) throw new Error(`/api/sessions/${sessionId}/turns returned ${res.status}`);
  return res.json() as Promise<ApiResponse<PagedList<TurnRow>>>;
}

/**
 * Fetch the BM3 per-session spend percentile within its own workspace.
 * Endpoint: GET /api/sessions/:id/spend-percentile
 * Returns PLAIN observed numbers (NOT enveloped); percentile is null below n>=20.
 */
export async function fetchSpendPercentile(sessionId: string): Promise<SessionSpendPercentile> {
  if (USE_MOCK) return Promise.resolve({ percentile: null, n: 0, window_days: 90 });
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/spend-percentile`);
  if (!res.ok)
    throw new Error(`/api/sessions/${sessionId}/spend-percentile returned ${res.status}`);
  return res.json() as Promise<SessionSpendPercentile>;
}

/** Fetch session cost drivers for the "Cost drivers" panel.
 * Endpoint: GET /api/sessions/:id/drivers
 */
export async function fetchSessionDrivers(
  sessionId: string,
): Promise<ApiResponse<SessionDrivers | null>> {
  if (USE_MOCK) return Promise.resolve(mockSessionDrivers(sessionId));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/drivers`);
  if (!res.ok) throw new Error(`/api/sessions/${sessionId}/drivers returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SessionDrivers | null>>;
}

/** What a session did and where its money went (session page header, spend, timeline, errors).
 * Endpoint: GET /api/sessions/:id/story — plain JSON; 404 (unknown session) reads as null.
 */
export async function fetchSessionStory(sessionId: string): Promise<SessionStory | null> {
  if (USE_MOCK) return Promise.resolve(mockSessionStory(sessionId));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/story`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/sessions/${sessionId}/story returned ${res.status}`);
  return res.json() as Promise<SessionStory | null>;
}

/**
 * Fetch Tier-1 recommendations (DetectorEngine — grouped by lifecycle + live
 * detector status strip). Optionally scoped to one workspace.
 * Endpoint: GET /api/recommendations?workspace_id=<scope>
 */
export async function fetchRecommendations(
  scope?: string,
): Promise<ApiResponse<RecommendationsView>> {
  if (USE_MOCK) {
    return Promise.resolve(mockRecommendations());
  }
  const params = new URLSearchParams();
  if (scope !== undefined) params.set("workspace_id", scope);
  const qs = params.toString();
  const res = await daemonFetch(`/api/recommendations${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`/api/recommendations returned ${res.status}`);
  return res.json() as Promise<ApiResponse<RecommendationsView>>;
}

/** Diagnostics triage view, cold-build progress, or a stale-but-served snapshot. Endpoint: GET /api/diagnostics */
export async function fetchDiagnostics(
  windowDays: 7 | 14 | 30 = 7,
): Promise<ApiResponse<DiagnosticsPayload>> {
  if (USE_MOCK) return Promise.resolve(mockDiagnostics(windowDays));
  const res = await daemonFetch(`/api/diagnostics?window=${windowDays}`);
  if (!res.ok) throw new Error(`/api/diagnostics returned ${res.status}`);
  return res.json() as Promise<ApiResponse<DiagnosticsPayload>>;
}

/** Fetch stored deterministic weekly report artifacts. */
export async function getReports(): Promise<Report[]> {
  if (USE_MOCK) return Promise.resolve(mockReports());
  const res = await daemonFetch("/api/reports");
  if (!res.ok) throw new Error(`/api/reports returned ${res.status}`);
  return res.json() as Promise<Report[]>;
}

/** Fetch one stored report artifact by id. */
export async function getReport(id: string): Promise<Report | null> {
  if (USE_MOCK) return Promise.resolve(mockReport(id));
  const res = await daemonFetch(`/api/reports/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/reports/${id} returned ${res.status}`);
  return res.json() as Promise<Report | null>;
}

/**
 * Fetch daemon settings (scan roots, limit_tokens, workspace mappings, parser health).
 * Endpoint: GET /api/settings
 */
export async function fetchSettings(): Promise<ApiResponse<Settings>> {
  if (USE_MOCK) {
    return Promise.resolve(mockSettings());
  }
  const res = await daemonFetch("/api/settings");
  if (!res.ok) throw new Error(`/api/settings returned ${res.status}`);
  return res.json() as Promise<ApiResponse<Settings>>;
}

/** Fetch aggregate first-run status; foreground polling shares requests across views. */
export async function fetchStatus(signal?: AbortSignal): Promise<DaemonStatus> {
  if (USE_MOCK) return Promise.resolve(mockStatus());
  return fetchCachedJson<DaemonStatus>("/api/status", undefined, undefined, signal);
}

/**
 * Apply a partial settings update.
 * Endpoint: POST /api/settings
 * Write path — CSRF gate enforced by the daemon.
 */
export async function saveSettings(update: SettingsUpdate): Promise<ApiResponse<Settings>> {
  if (USE_MOCK) {
    const result = mockUpdateSettings(update);
    clearResponseCache();
    return result;
  }
  const res = await authorized("Unable to authorize the settings change.", (token) =>
    daemonFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify(update),
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/settings returned ${res.status}`);
  }
  const result = (await res.json()) as ApiResponse<Settings>;
  clearResponseCache();
  return result;
}

/** Read the runtime thresholds for the context-budget hook. */
export async function fetchHookConfig(): Promise<ApiResponse<HookConfigResponse>> {
  if (USE_MOCK) return Promise.resolve(mockHookConfigResponse(false));
  const res = await daemonFetch("/api/hook-config");
  if (!res.ok) throw new Error(`/api/hook-config returned ${res.status}`);
  return res.json() as Promise<ApiResponse<HookConfigResponse>>;
}

/** Persist a partial context-budget hook configuration. */
export async function saveHookConfig(update: HookConfigUpdate): Promise<ApiResponse<HookConfig>> {
  const res = await authorized("Unable to authorize the hook settings change.", (token) =>
    daemonFetch("/api/hook-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify(update),
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/hook-config returned ${res.status}`);
  }
  const result = (await res.json()) as ApiResponse<HookConfig>;
  clearResponseCache();
  return result;
}

export interface HookInstallResult {
  changed: boolean;
  settingsPath: string;
}

async function hookMutation(
  endpoint: "/api/hook/install" | "/api/hook/uninstall",
): Promise<HookInstallResult> {
  const res = await authorized("Unable to authorize hook settings change.", (token) =>
    daemonFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${endpoint} returned ${res.status}`);
  }
  const result = (await res.json()) as HookInstallResult;
  clearResponseCache();
  window.dispatchEvent(new Event("agentwrangler:hooks-changed"));
  return result;
}

/** Install the context-budget Claude Code hook into the user's settings. */
export function installHook(): Promise<HookInstallResult> {
  return hookMutation("/api/hook/install");
}

/** Remove only AgentWrangler's context-budget Claude Code hook. */
export function uninstallHook(): Promise<HookInstallResult> {
  return hookMutation("/api/hook/uninstall");
}

/**
 * Wipe all ingested data and return fresh settings.
 * Endpoint: POST /api/reset
 * Write path — CSRF gate enforced by the daemon.
 */
export async function resetDatabase(): Promise<ApiResponse<Settings>> {
  if (USE_MOCK) {
    const result = mockResetDatabase();
    clearResponseCache();
    return result;
  }
  const res = await authorized("Unable to authorize the reset.", (token) =>
    daemonFetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/reset returned ${res.status}`);
  }
  const result = (await res.json()) as ApiResponse<Settings>;
  clearResponseCache();
  return result;
}

/**
 * Auto-calibrate the weekly token limit from the user's oauth/usage utilization.
 * Endpoint: POST /api/calibrate
 * Write path — CSRF gate enforced by the daemon.
 * Always resolves (never rejects on 429 / low utilization) — check result.data.ok.
 */
export async function calibrateLimitApi(): Promise<ApiResponse<CalibrateResult>> {
  if (USE_MOCK) {
    const result = mockCalibrateLimit();
    clearResponseCache();
    return result;
  }
  const res = await authorized("Unable to authorize calibration.", (token) =>
    daemonFetch("/api/calibrate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/calibrate returned ${res.status}`);
  }
  const result = (await res.json()) as ApiResponse<CalibrateResult>;
  clearResponseCache();
  return result;
}

/**
 * Calibrate the bytes-per-token ratio via Anthropic's count_tokens API (R12).
 * Requires opt-in to be enabled in Settings. Returns ok:false when disabled or
 * when too few successful samples were collected.
 * Endpoint: POST /api/calibrate-bytes-per-token
 */
export async function calibrateBytesPerTokenApi(): Promise<
  ApiResponse<CalibrateBytesPerTokenResult>
> {
  if (USE_MOCK) {
    // Degrade gracefully in test/mock mode — return a disabled result.
    const result: ApiResponse<CalibrateBytesPerTokenResult> = {
      data: { ok: false, reason: "calibration disabled — enable in Settings first" },
      meta: {
        claim_kind: "N_A",
        n: 0,
        window: { from: new Date(0).toISOString(), to: new Date().toISOString() },
        qualification: {
          provisional_excluded: false,
          unpriced_turns: 0,
          claim_kinds_count: 1,
          note: "",
        },
        metric_definition_version: "observe-1",
        drilldown_ids: {},
      },
    };
    clearResponseCache();
    return result;
  }
  const res = await authorized("Unable to authorize calibration.", (token) =>
    daemonFetch("/api/calibrate-bytes-per-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/calibrate-bytes-per-token returned ${res.status}`);
  }
  const result = (await res.json()) as ApiResponse<CalibrateBytesPerTokenResult>;
  clearResponseCache();
  return result;
}

// ---------------------------------------------------------------------------
// OAuth status (O9)
// ---------------------------------------------------------------------------

/** Statusline fallback state + copy-line snippet (OV-7). Endpoint: GET /api/statusline-limits/status */
export async function fetchStatuslineStatus(): Promise<StatuslineStatus> {
  if (USE_MOCK) return Promise.resolve(mockStatuslineStatus());
  const res = await daemonFetch("/api/statusline-limits/status");
  if (!res.ok) throw new Error(`/api/statusline-limits/status returned ${res.status}`);
  return res.json() as Promise<StatuslineStatus>;
}

export type StatuslineChange = { ok: true; plan: StatuslinePlan } | { ok: false; error: string };

async function readStatuslineChange(res: Response): Promise<StatuslineChange> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    plan?: StatuslinePlan;
  } & Partial<StatuslinePlan>;
  if (!res.ok) return { ok: false, error: body.error ?? `Request failed (${res.status})` };
  return { ok: true, plan: (body.plan ?? body) as StatuslinePlan };
}

/** Exact before/after of settings.json's statusLine entry. Endpoint: GET /api/statusline-limits/preview */
export async function fetchStatuslinePreview(
  action: "install" | "uninstall",
): Promise<StatuslineChange> {
  if (USE_MOCK) return Promise.resolve(mockStatuslineChange(action));
  return readStatuslineChange(await daemonFetch(`/api/statusline-limits/preview?action=${action}`));
}

/**
 * Write the previewed change to ~/.claude/settings.json. `expectBefore` is the preview's `before`;
 * the daemon refuses (409) if the entry changed since. Endpoint: POST /api/statusline-limits/{action}
 * (CSRF + session token, like the hook installer).
 */
export async function applyStatusline(
  action: "install" | "uninstall",
  expectBefore: string | null,
): Promise<StatuslineChange> {
  if (USE_MOCK) return Promise.resolve(mockStatuslineChange(action));
  let res: Response;
  try {
    res = await withSessionToken((token) =>
      daemonFetch(`/api/statusline-limits/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
        body: JSON.stringify({ expectBefore }),
      }),
    );
  } catch (error) {
    if (error instanceof SessionTokenUnavailableError) {
      return { ok: false, error: "Unable to authorize the settings change." };
    }
    throw error;
  }
  const out = await readStatuslineChange(res);
  if (out.ok) clearResponseCache();
  return out;
}

/**
 * Fetch the OAuth usage-reader authentication state.
 * Returns authenticated boolean + tier (safe: token never included).
 * Endpoint: GET /api/oauth/status
 */
export async function fetchOAuthStatus(): Promise<OAuthStatus> {
  if (USE_MOCK) {
    return Promise.resolve(mockOAuthStatus());
  }
  const res = await daemonFetch("/api/oauth/status");
  if (!res.ok) throw new Error(`/api/oauth/status returned ${res.status}`);
  return res.json() as Promise<OAuthStatus>;
}

/**
 * Fetch OAuth-backed rate-limit burn status (5h + 7d utilization + reset times).
 * Signed-out or unavailable → available:false + reason.
 * Endpoint: GET /api/burn-status
 */
export async function fetchBurnStatus(signal?: AbortSignal): Promise<ApiResponse<BurnStatus>> {
  if (USE_MOCK) return Promise.resolve(mockBurnStatus());
  return fetchCachedJson<ApiResponse<BurnStatus>>("/api/burn-status", undefined, undefined, signal);
}

/**
 * Fetch the fully-computed Usage-limits card model (overview-v2 §1). The backend
 * computes every pace/burn/projection field; the UI renders values only.
 * Network-only (no response cache) — polled every 60s by the hero card.
 * Endpoint: GET /api/query/limits
 */
export async function fetchLimits(signal?: AbortSignal): Promise<LimitsModel> {
  if (USE_MOCK) return Promise.resolve(mockLimitsCli());
  return fetchCachedJson<LimitsModel>("/api/query/limits", undefined, undefined, signal);
}

/**
 * OV-12 U5 (D6): model weight check for Settings → calibration. Local data only (no upstream call).
 * Endpoint: GET /api/query/limits/weight-fit
 */
export async function fetchWeightFit(signal?: AbortSignal): Promise<WeightFit> {
  if (USE_MOCK) return Promise.resolve(mockWeightFit("not-ready"));
  return fetchCachedJson<WeightFit>("/api/query/limits/weight-fit", undefined, undefined, signal);
}

/**
 * Fetch hot sessions ranked by cost (returns bare array, same shape as
 * /api/hot-sessions daemon route).
 * Endpoint: GET /api/hot-sessions
 */
export async function fetchHotSessions(filter?: WindowFilter): Promise<HotSessionRow[]> {
  if (USE_MOCK) return Promise.resolve(mockHotSessions(filter));
  const params = new URLSearchParams();
  if (filter?.preset !== undefined) params.set("preset", filter.preset);
  if (filter?.from !== undefined) params.set("from", filter.from);
  if (filter?.to !== undefined) params.set("to", filter.to);
  const qs = params.toString();
  const res = await daemonFetch(`/api/hot-sessions${qs === "" ? "" : `?${qs}`}`);
  if (!res.ok) throw new Error(`/api/hot-sessions returned ${res.status}`);
  return res.json() as Promise<HotSessionRow[]>;
}

/** One page of whole-session aggregates for the Sessions list. */
export async function fetchHotSessionsPage(
  query: HotSessionsPageQuery = {},
): Promise<HotSessionsPage> {
  if (USE_MOCK) return Promise.resolve(mockHotSessionsPage(query));
  const params = new URLSearchParams();
  if (query.window?.from !== undefined) params.set("from", query.window.from);
  if (query.window?.to !== undefined) params.set("to", query.window.to);
  if (query.workspace !== undefined) params.set("workspace", query.workspace);
  if (query.model !== undefined) params.set("model", query.model);
  for (const category of query.category ?? []) params.append("category", category);
  if (query.q !== undefined) params.set("q", query.q);
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.direction !== undefined) params.set("direction", query.direction);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  const res = await daemonFetch(`/api/hot-sessions/page${qs === "" ? "" : `?${qs}`}`);
  if (!res.ok) throw new Error(`/api/hot-sessions/page returned ${res.status}`);
  return res.json() as Promise<HotSessionsPage>;
}

/**
 * Fetch the GitHub token status for outcomes sync.
 * Returns configured boolean + source (safe: token value never included).
 * Endpoint: GET /api/outcomes/token-status
 */
export async function fetchGithubTokenStatus(): Promise<GithubTokenStatus> {
  if (USE_MOCK) {
    return Promise.resolve(mockGithubTokenStatus());
  }
  const res = await daemonFetch("/api/outcomes/token-status");
  if (!res.ok) throw new Error(`/api/outcomes/token-status returned ${res.status}`);
  return res.json() as Promise<GithubTokenStatus>;
}

/** All outcomes controls use the daemon's same-origin session-token gate. */
async function postOutcomesControl<T>(endpoint: string): Promise<T> {
  const res = await authorized("Unable to authorize outcomes control.", (token) =>
    daemonFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: "{}",
    }),
  );
  if (!res.ok) throw new Error(`Outcomes control returned ${res.status}`);
  return res.json() as Promise<T>;
}

export function refreshGithubTokenStatus(): Promise<GithubTokenStatus> {
  if (USE_MOCK) return Promise.resolve(mockGithubTokenStatus());
  return postOutcomesControl<GithubTokenStatus>("/api/outcomes/token-refresh");
}

export interface OutcomesStatus {
  sinceDaemonStart: true;
  sync: OperationSnapshot;
  connection: ConnectionSnapshot;
}

export async function fetchOutcomesStatus(): Promise<OutcomesStatus> {
  if (USE_MOCK) {
    const empty: OperationSnapshot = {
      state: "never-run",
      attemptId: null,
      startedAt: null,
      completedAt: null,
      lastSuccess: null,
      eligibleRepositories: 0,
      attemptedReads: 0,
      failedReads: 0,
      categories: {},
      failedStages: [],
      draining: false,
    };
    return {
      sinceDaemonStart: true,
      sync: empty,
      connection: { ...empty, repositoryAccess: "untested", credentialEpoch: 0 },
    };
  }
  const res = await daemonFetch("/api/outcomes/sync-status");
  if (!res.ok) throw new Error("Could not read outcomes status.");
  return res.json() as Promise<OutcomesStatus>;
}

async function startOutcomesAction(endpoint: string): Promise<ActionResponse> {
  const res = await authorized("Unable to authorize outcomes control.", (token) =>
    daemonFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: "{}",
    }),
  );
  if (res.status !== 202 && res.status !== 409 && res.status !== 429)
    throw new Error("Outcomes control failed.");
  return res.json() as Promise<ActionResponse>;
}
export const startOutcomesConnectionTest = (): Promise<ActionResponse> =>
  startOutcomesAction("/api/outcomes/connection-test");
export const startOutcomesSyncRetry = (): Promise<ActionResponse> =>
  startOutcomesAction("/api/outcomes/sync-retry");

// ---------------------------------------------------------------------------
// Outcomes (WP5)
// ---------------------------------------------------------------------------

/**
 * Fetch global success rate (EXPERIMENTAL).
 * Endpoint: GET /api/outcomes/success-rate
 */
export async function fetchSuccessRate(): Promise<ApiResponse<SuccessRateData>> {
  if (USE_MOCK) {
    return Promise.resolve(mockSuccessRate());
  }
  const res = await daemonFetch("/api/outcomes/success-rate");
  if (!res.ok) throw new Error(`/api/outcomes/success-rate returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SuccessRateData>>;
}

/**
 * Fetch per-workspace outcome summaries (EXPERIMENTAL).
 * Endpoint: GET /api/outcomes/workspaces
 */
export async function fetchWorkspaceOutcomes(): Promise<ApiResponse<WorkspaceOutcomeSummary[]>> {
  if (USE_MOCK) {
    return Promise.resolve(mockWorkspaceOutcomes());
  }
  const res = await daemonFetch("/api/outcomes/workspaces");
  if (!res.ok) throw new Error(`/api/outcomes/workspaces returned ${res.status}`);
  return res.json() as Promise<ApiResponse<WorkspaceOutcomeSummary[]>>;
}

/** Fetch the v1 context-composition adjunct for a selected workspace. */
export async function fetchContextComposition(
  workspaceId: string,
): Promise<ApiResponse<ContextComposition>> {
  if (USE_MOCK) return Promise.resolve(mockContextComposition(workspaceId));
  const res = await daemonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/context`);
  if (!res.ok) throw new Error(`/api/workspaces/${workspaceId}/context returned ${res.status}`);
  return res.json() as Promise<ApiResponse<ContextComposition>>;
}

/**
 * Fetch live linkage rate (EXPERIMENTAL).
 * Endpoint: GET /api/outcomes/linkage
 */
export async function fetchLinkageRate(
  workspaceId?: string,
): Promise<ApiResponse<LinkageRateData>> {
  if (USE_MOCK) {
    return Promise.resolve(mockLinkageRate());
  }
  const params = new URLSearchParams();
  if (workspaceId !== undefined) params.set("workspace_id", workspaceId);
  const qs = params.toString();
  const res = await daemonFetch(`/api/outcomes/linkage${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`/api/outcomes/linkage returned ${res.status}`);
  return res.json() as Promise<ApiResponse<LinkageRateData>>;
}

/**
 * Fetch spend-over-time data grouped by the requested bucket size.
 * Endpoint: GET /api/trends?preset=&bucket=day|week|month&workspace_id=
 */
export async function fetchTrends(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): Promise<ApiResponse<TrendData>> {
  if (USE_MOCK) {
    return Promise.resolve(mockTrends(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  params.set("bucket", bucket);
  if (workspaceId !== undefined) params.set("workspace_id", workspaceId);
  const res = await daemonFetch(`/api/trends?${params.toString()}`);
  if (!res.ok) throw new Error(`/api/trends returned ${res.status}`);
  return res.json() as Promise<ApiResponse<TrendData>>;
}

/**
 * Fetch percent-native headroom versus the calibrated cap over time.
 * Endpoint: GET /api/trends/headroom?preset=&bucket=day|week|month&workspace_id=
 */
export async function fetchHeadroomTrend(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): Promise<ApiResponse<HeadroomTrendData>> {
  if (USE_MOCK) {
    return Promise.resolve(mockHeadroomTrend(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  params.set("bucket", bucket);
  if (workspaceId !== undefined) params.set("workspace_id", workspaceId);
  const res = await daemonFetch(`/api/trends/headroom?${params.toString()}`);
  if (!res.ok) throw new Error(`/api/trends/headroom returned ${res.status}`);
  return res.json() as Promise<ApiResponse<HeadroomTrendData>>;
}

/**
 * Fetch the W4 Impact Ledger (realized vs modeled per adopted rec).
 * Endpoint: GET /api/recommendations/ledger
 */
export async function fetchLedger(): Promise<ApiResponse<LedgerView>> {
  if (USE_MOCK) {
    return Promise.resolve(mockLedger());
  }
  const res = await daemonFetch("/api/recommendations/ledger");
  if (!res.ok) throw new Error(`/api/recommendations/ledger returned ${res.status}`);
  return res.json() as Promise<ApiResponse<LedgerView>>;
}

/**
 * Manually link a session to a work item.
 * Endpoint: POST /api/outcomes/link
 * Write path — CSRF gate enforced by the daemon.
 */
export async function linkSession(sessionId: string, workItemId: string): Promise<void> {
  if (USE_MOCK) {
    clearResponseCache();
    return;
  }
  const res = await authorized("Unable to authorize the link.", (token) =>
    daemonFetch("/api/outcomes/link", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify({ session_id: sessionId, work_item_id: workItemId }),
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/outcomes/link returned ${res.status}`);
  }
  clearResponseCache();
}

/**
 * Manually unlink a session from a work item.
 * Endpoint: POST /api/outcomes/unlink
 * Write path — CSRF gate enforced by the daemon.
 */
export async function unlinkSession(sessionId: string, workItemId: string): Promise<void> {
  if (USE_MOCK) {
    clearResponseCache();
    return;
  }
  const res = await authorized("Unable to authorize the unlink.", (token) =>
    daemonFetch("/api/outcomes/unlink", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify({ session_id: sessionId, work_item_id: workItemId }),
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/outcomes/unlink returned ${res.status}`);
  }
  clearResponseCache();
}

/**
 * Trigger a background pipeline retry.
 * Endpoint: POST /api/pipeline/retry
 * Same-origin write path — CSRF + session token, like every write.
 */
export async function retryPipeline(signal?: AbortSignal): Promise<void> {
  if (USE_MOCK) return;
  const res = await authorized("Unable to authorize the retry.", (token) =>
    daemonFetch("/api/pipeline/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      signal: signal ?? null,
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/pipeline/retry returned ${res.status}`);
  }
}

/**
 * Fetch the BM1 practice scorecard.
 * Endpoint: GET /api/practices
 * Returns a PLAIN object (NOT enveloped): { practices, window }.
 */
export async function fetchPractices(): Promise<PracticesResult> {
  if (USE_MOCK) return Promise.resolve(mockPractices());
  const res = await daemonFetch("/api/practices");
  if (!res.ok) throw new Error(`/api/practices returned ${res.status}`);
  return res.json() as Promise<PracticesResult>;
}

/**
 * Fetch the "Judge my setup" grade, rubric metadata and per-check dollars.
 * Endpoint: GET /api/judge-setup
 * Returns a PLAIN object (NOT enveloped): JudgeSetupResponse.
 */
export async function fetchJudgeSetup(): Promise<JudgeSetupResponse> {
  if (USE_MOCK) return Promise.resolve(mockJudgeSetup());
  const res = await daemonFetch("/api/judge-setup");
  if (!res.ok) throw new Error(`/api/judge-setup returned ${res.status}`);
  return res.json() as Promise<JudgeSetupResponse>;
}

/**
 * Fetch individual modeled opportunities; no combined efficiency ratio.
 * Endpoint: GET /api/efficiency-headroom
 * Returns an enveloped ApiResponse<EfficiencyHeadroom>.
 */
export async function fetchEfficiencyHeadroom(): Promise<ApiResponse<EfficiencyHeadroom>> {
  if (USE_MOCK) return Promise.resolve(mockEfficiencyHeadroom());
  const res = await daemonFetch("/api/efficiency-headroom");
  if (!res.ok) throw new Error(`/api/efficiency-headroom returned ${res.status}`);
  return res.json() as Promise<ApiResponse<EfficiencyHeadroom>>;
}

/**
 * Fetch workspace-history follow-up observations as of now, independent of the spend filter.
 * Endpoint: GET /api/workspaces/:id/closure-proxy
 * Returns an enveloped ApiResponse<ClosureProxy>.
 */
export async function fetchClosureProxy(workspaceId: string): Promise<ApiResponse<ClosureProxy>> {
  if (USE_MOCK) return Promise.resolve(mockClosureProxy(workspaceId));
  const res = await daemonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/closure-proxy`);
  if (!res.ok)
    throw new Error(`/api/workspaces/${workspaceId}/closure-proxy returned ${res.status}`);
  return res.json() as Promise<ApiResponse<ClosureProxy>>;
}

/**
 * Fetch the R4a lifecycle cost-per-success proxy.
 * Endpoint: GET /api/workspaces/:id/cost-per-success (per-ws) or /api/cost-per-success (global).
 * Windowed via ?preset=/?from=/?to=. Returns an enveloped ApiResponse<CostPerSuccess>;
 * cost_per_* fields are null when their denominator count is 0.
 */
export async function fetchCostPerSuccess(
  filter: WindowFilter,
  workspaceId?: string,
): Promise<ApiResponse<CostPerSuccess>> {
  if (USE_MOCK) return Promise.resolve(mockCostPerSuccess(filter, workspaceId));
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  const qs = params.toString();
  const path =
    workspaceId === undefined
      ? "/api/cost-per-success"
      : `/api/workspaces/${encodeURIComponent(workspaceId)}/cost-per-success`;
  const res = await daemonFetch(`${path}${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<ApiResponse<CostPerSuccess>>;
}

/**
 * Fetch observed per-workspace delivery metrics for the selected window.
 * Endpoint: GET /api/workspaces/:id/delivery?from=/to=
 */
export async function fetchWorkspaceDelivery(
  workspaceId: string,
  filter: WindowFilter,
): Promise<ApiResponse<DeliveryMetrics>> {
  if (USE_MOCK) return Promise.resolve(mockWorkspaceDelivery(workspaceId, filter));
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/delivery`;
  const res = await daemonFetch(`${path}?${params.toString()}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<ApiResponse<DeliveryMetrics>>;
}
