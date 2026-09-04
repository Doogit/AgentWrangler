/**
 * src/ui/api/client.ts — Typed API client for the Overview surface.
 *
 * Integration flip: set USE_MOCK = false (or remove the constant and the branch)
 * once WP2's real API is live and the daemon serves data.
 *
 * The UI NEVER issues SQL or imports better-sqlite3.
 * All method signatures match the frozen LocalQueryAPI contract.
 */

import type { PracticesResult } from "../../detector/practice-registry";
import type { OAuthStatus } from "../../oauth/credentials";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { AgentsLivenessResult, EndSessionResult } from "../../query/api/agents-liveness";
import type { BurnStatus } from "../../query/api/burn-status";
import type { ContextComposition } from "../../query/api/context-composition";
import type { CostPerSuccess } from "../../query/api/cost-per-success";
import type { ClosureProxy } from "../../query/api/effectiveness";
import type { EfficiencyHeadroom } from "../../query/api/efficiency-headroom";
import type { HeadroomTrendData } from "../../query/api/headroom-trend";
import type { HookConfig, HookConfigResponse, HookConfigUpdate } from "../../query/api/hook-config";
import type { IdleSession } from "../../query/api/idle-sessions";
import type {
  LinkageRateData,
  SuccessRateData,
  WorkspaceOutcomeSummary,
} from "../../query/api/outcomes";
import type {
  GlobalOverview,
  LiveSessionRow,
  PagedList,
  SessionSummary,
  TurnRow,
  WindowFilter,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { RecommendationsView } from "../../query/api/recommendations";
import type { LedgerView } from "../../query/api/recommendations-ledger";
import type { Report } from "../../query/api/reports";
import type { SessionSpendPercentile } from "../../query/api/self-percentiles";
import type { SessionDrivers } from "../../query/api/session-drivers";
import type {
  CalibrateBytesPerTokenResult,
  CalibrateResult,
  Settings,
  SettingsUpdate,
} from "../../query/api/settings";
import type { FlavorDecomposition } from "../../query/api/spend-flavor";
import type { BucketSize, CacheWriteTrend, TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import type { HotSessionRow } from "../../query/spend";
import {
  mockBurnStatus,
  mockCacheWriteTrend,
  mockCalibrateLimit,
  mockClosureProxy,
  mockContextComposition,
  mockCostPerSuccess,
  mockEfficiencyHeadroom,
  mockFlavorDecomposition,
  mockGithubTokenStatus,
  mockGlobalOverview,
  mockHeadroomTrend,
  mockHotSessions,
  mockLedger,
  mockLinkageRate,
  mockLiveSessions,
  mockOAuthStatus,
  mockPractices,
  mockRecommendations,
  mockReport,
  mockReports,
  mockResetDatabase,
  mockSession,
  mockSessionDrivers,
  mockSettings,
  mockStatus,
  mockSuccessRate,
  mockTrends,
  mockTurnTimeline,
  mockUpdateSettings,
  mockWorkspaceOutcomes,
  mockWorkspaceSessions,
  mockWorkspaces,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Mocks are active only under Vite test mode (MODE === "test"); the production
// build (and any non-test mode) fetches from the live daemon API.
// ---------------------------------------------------------------------------
const USE_MOCK = import.meta.env.MODE === "test";
const DAEMON_REQUEST_TIMEOUT_MS = 8_000;

/** Keep recently requested read responses available while the UI revalidates them. */
export const RESPONSE_CACHE_TTL_MS = 45_000;

export interface ResponseCacheEntry<T> {
  data: T;
  fetchedAt: number;
}

/** Aggregate-only daemon counters used by the first-run Overview welcome. */
export interface DaemonStatus {
  sessions: number;
  files_seen: number;
  files_parsed: number;
}

/**
 * Shared read-response cache. Keys are built from an endpoint and the request
 * parameter object so a later UI layer can synchronously render a fresh value.
 */
export const responseCache = new Map<string, ResponseCacheEntry<unknown>>();

export function getResponseCacheKey(endpoint: string, params?: unknown): string {
  return `${endpoint}${JSON.stringify(params)}`;
}

/** Return a cache value only while it is within the read TTL. */
export function getCachedResponse<T>(endpoint: string, params?: unknown): T | undefined {
  const entry = responseCache.get(getResponseCacheKey(endpoint, params));
  if (!entry || Date.now() - entry.fetchedAt >= RESPONSE_CACHE_TTL_MS) return undefined;
  return entry.data as T;
}

/** Return the timestamp of the most recent successful fetch for a cache key. */
export function getLastFetchTimestamp(endpoint: string, params?: unknown): number | undefined {
  return responseCache.get(getResponseCacheKey(endpoint, params))?.fetchedAt;
}

/** A transport failure distinct from daemon HTTP or data errors. */
export class DaemonUnreachableError extends Error {
  readonly code = "DAEMON_UNREACHABLE";

  constructor() {
    super("The local daemon could not be reached.");
    this.name = "DaemonUnreachableError";
  }
}

export function isDaemonUnreachableError(error: unknown): error is DaemonUnreachableError {
  return error instanceof DaemonUnreachableError;
}

async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), DAEMON_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch {
    throw new DaemonUnreachableError();
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
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
): Promise<T> {
  const cached = getCachedResponse<T>(endpoint, params);
  if (cached !== undefined) return cached;

  const res = await daemonFetch(requestEndpoint);
  if (!res.ok) throw new Error(`${requestEndpoint} returned ${res.status}`);
  const data = (await res.json()) as T;
  responseCache.set(getResponseCacheKey(endpoint, params), { data, fetchedAt: Date.now() });
  return data;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

/**
 * Fetch the global overview (spend cards, forecast, ctx/turn, model mix).
 * Endpoint: GET /api/overview?preset=7d
 */
export async function fetchGlobalOverview(
  filter: WindowFilter,
): Promise<ApiResponse<GlobalOverview>> {
  if (USE_MOCK) {
    return Promise.resolve(mockGlobalOverview(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  return fetchCachedJson<ApiResponse<GlobalOverview>>(
    "/api/overview",
    filter,
    `/api/overview?${params.toString()}`,
  );
}

/**
 * Fetch per-workspace summaries for the comparison table.
 * Endpoint: GET /api/workspaces?preset=7d
 */
export async function fetchWorkspaces(
  filter: WindowFilter,
): Promise<ApiResponse<PagedList<WorkspaceSummary>>> {
  if (USE_MOCK) {
    return Promise.resolve(mockWorkspaces(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  return fetchCachedJson<ApiResponse<PagedList<WorkspaceSummary>>>(
    "/api/workspaces",
    filter,
    `/api/workspaces?${params.toString()}`,
  );
}

/**
 * Fetch live sessions for the live strip (poll every 30 s).
 * Endpoint: GET /api/live
 */
export async function fetchLiveSessions(): Promise<ApiResponse<PagedList<LiveSessionRow>>> {
  if (USE_MOCK) {
    return Promise.resolve(mockLiveSessions());
  }
  return fetchCachedJson<ApiResponse<PagedList<LiveSessionRow>>>("/api/live");
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

export async function fetchSession(sessionId: string): Promise<ApiResponse<SessionSummary>> {
  if (USE_MOCK) return Promise.resolve(mockSession(sessionId));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`/api/sessions/${sessionId} returned ${res.status}`);
  return res.json() as Promise<ApiResponse<SessionSummary>>;
}

export async function fetchTurnTimeline(
  sessionId: string,
  cursor?: { after?: string; limit?: number },
): Promise<ApiResponse<PagedList<TurnRow>>> {
  if (USE_MOCK) return Promise.resolve(mockTurnTimeline(sessionId, cursor?.after));
  const params = new URLSearchParams();
  if (cursor?.after !== undefined) params.set("after", cursor.after);
  if (cursor?.limit !== undefined) params.set("limit", String(cursor.limit));
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns?${params}`);
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

/** Fetch aggregate first-run onboarding status. Endpoint: GET /api/status. */
export async function fetchStatus(): Promise<DaemonStatus> {
  if (USE_MOCK) return Promise.resolve(mockStatus());
  return fetchCachedJson<DaemonStatus>("/api/status");
}

/**
 * Apply a partial settings update.
 * Endpoint: POST /api/settings
 * Write path — CSRF gate enforced by the daemon.
 */
export async function saveSettings(update: SettingsUpdate): Promise<ApiResponse<Settings>> {
  if (USE_MOCK) {
    return Promise.resolve(mockUpdateSettings(update));
  }
  const res = await daemonFetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/settings returned ${res.status}`);
  }
  return res.json() as Promise<ApiResponse<Settings>>;
}

/** Read the runtime thresholds for the context-budget hook. */
export async function fetchHookConfig(): Promise<ApiResponse<HookConfigResponse>> {
  const res = await daemonFetch("/api/hook-config");
  if (!res.ok) throw new Error(`/api/hook-config returned ${res.status}`);
  return res.json() as Promise<ApiResponse<HookConfigResponse>>;
}

/** Read idle, sidechain-dominant sessions for warn-only dashboard surfacing. */
export async function fetchIdleSessions(): Promise<ApiResponse<IdleSession[]>> {
  const res = await daemonFetch("/api/idle-sessions");
  if (!res.ok) throw new Error(`/api/idle-sessions returned ${res.status}`);
  return res.json() as Promise<ApiResponse<IdleSession[]>>;
}

/** Fetch live Claude Code agent measurements from the running CLI. */
export async function fetchAgentsLiveness(): Promise<ApiResponse<AgentsLivenessResult>> {
  const res = await daemonFetch("/api/agents-liveness");
  if (!res.ok) throw new Error(`/api/agents-liveness returned ${res.status}`);
  return res.json() as Promise<ApiResponse<AgentsLivenessResult>>;
}

/**
 * Send a confirm-gated end request for the given PID.
 * TOKEN-GATED — mirrors the hook install pattern.
 * Endpoint: POST /api/idle-sessions/end
 */
export async function endSessionPid(pid: number): Promise<EndSessionResult> {
  const tokenResponse = await daemonFetch("/api/token");
  if (!tokenResponse.ok) throw new Error("Unable to authorize session end.");
  const token = ((await tokenResponse.json()) as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Unable to authorize session end.");
  }
  const res = await daemonFetch("/api/idle-sessions/end", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
    body: JSON.stringify({ pid, confirm: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/idle-sessions/end returned ${res.status}`);
  }
  return res.json() as Promise<EndSessionResult>;
}

/** Persist a partial context-budget hook configuration. */
export async function saveHookConfig(update: HookConfigUpdate): Promise<ApiResponse<HookConfig>> {
  const res = await daemonFetch("/api/hook-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/hook-config returned ${res.status}`);
  }
  return res.json() as Promise<ApiResponse<HookConfig>>;
}

export interface HookInstallResult {
  changed: boolean;
  settingsPath: string;
}

async function hookMutation(
  endpoint: "/api/hook/install" | "/api/hook/uninstall",
): Promise<HookInstallResult> {
  const tokenResponse = await daemonFetch("/api/token");
  if (!tokenResponse.ok) throw new Error("Unable to authorize hook settings change.");
  const token = ((await tokenResponse.json()) as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Unable to authorize hook settings change.");
  }
  const res = await daemonFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${endpoint} returned ${res.status}`);
  }
  return res.json() as Promise<HookInstallResult>;
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
    return Promise.resolve(mockResetDatabase());
  }
  const res = await daemonFetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/reset returned ${res.status}`);
  }
  return res.json() as Promise<ApiResponse<Settings>>;
}

/**
 * Auto-calibrate the weekly token limit from the user's oauth/usage utilization.
 * Endpoint: POST /api/calibrate
 * Write path — CSRF gate enforced by the daemon.
 * Always resolves (never rejects on 429 / low utilization) — check result.data.ok.
 */
export async function calibrateLimitApi(): Promise<ApiResponse<CalibrateResult>> {
  if (USE_MOCK) {
    return Promise.resolve(mockCalibrateLimit());
  }
  const res = await daemonFetch("/api/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/calibrate returned ${res.status}`);
  }
  return res.json() as Promise<ApiResponse<CalibrateResult>>;
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
    return Promise.resolve({
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
    });
  }
  const res = await daemonFetch("/api/calibrate-bytes-per-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/calibrate-bytes-per-token returned ${res.status}`);
  }
  return res.json() as Promise<ApiResponse<CalibrateBytesPerTokenResult>>;
}

// ---------------------------------------------------------------------------
// OAuth status (O9)
// ---------------------------------------------------------------------------

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
export async function fetchBurnStatus(): Promise<ApiResponse<BurnStatus>> {
  if (USE_MOCK) return Promise.resolve(mockBurnStatus());
  const res = await daemonFetch("/api/burn-status");
  if (!res.ok) throw new Error(`/api/burn-status returned ${res.status}`);
  return res.json() as Promise<ApiResponse<BurnStatus>>;
}

/**
 * Fetch hot sessions ranked by cost (returns bare array, same shape as
 * /api/hot-sessions daemon route).
 * Endpoint: GET /api/hot-sessions
 */
export async function fetchHotSessions(filter?: WindowFilter): Promise<HotSessionRow[]> {
  if (USE_MOCK) return Promise.resolve(mockHotSessions());
  const params = new URLSearchParams();
  if (filter?.preset !== undefined) params.set("preset", filter.preset);
  if (filter?.from !== undefined) params.set("from", filter.from);
  if (filter?.to !== undefined) params.set("to", filter.to);
  const qs = params.toString();
  const res = await daemonFetch(`/api/hot-sessions${qs === "" ? "" : `?${qs}`}`);
  if (!res.ok) throw new Error(`/api/hot-sessions returned ${res.status}`);
  return res.json() as Promise<HotSessionRow[]>;
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
 * Fetch four-flavor token decomposition for the selected window.
 * Endpoint: GET /api/overview/flavor?preset=7d
 */
export async function fetchFlavorDecomposition(
  filter: WindowFilter,
): Promise<ApiResponse<FlavorDecomposition>> {
  if (USE_MOCK) {
    return Promise.resolve(mockFlavorDecomposition(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  const res = await daemonFetch(`/api/overview/flavor?${params.toString()}`);
  if (!res.ok) throw new Error(`/api/overview/flavor returned ${res.status}`);
  return res.json() as Promise<ApiResponse<FlavorDecomposition>>;
}

/**
 * Fetch cache-write spike timeline for the selected window.
 * Endpoint: GET /api/trends/cache-write?preset=7d&bucket=day
 */
export async function fetchCacheWriteTrend(
  filter: WindowFilter,
  bucket: BucketSize = "day",
  workspaceId?: string,
): Promise<ApiResponse<CacheWriteTrend>> {
  if (USE_MOCK) {
    return Promise.resolve(mockCacheWriteTrend(filter));
  }
  const params = new URLSearchParams();
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  params.set("bucket", bucket);
  if (workspaceId !== undefined) params.set("workspace_id", workspaceId);
  const res = await daemonFetch(`/api/trends/cache-write?${params.toString()}`);
  if (!res.ok) throw new Error(`/api/trends/cache-write returned ${res.status}`);
  return res.json() as Promise<ApiResponse<CacheWriteTrend>>;
}

/**
 * Manually link a session to a work item.
 * Endpoint: POST /api/outcomes/link
 * Write path — CSRF gate enforced by the daemon.
 */
export async function linkSession(sessionId: string, workItemId: string): Promise<void> {
  if (USE_MOCK) return;
  const res = await daemonFetch("/api/outcomes/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, work_item_id: workItemId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/outcomes/link returned ${res.status}`);
  }
}

/**
 * Manually unlink a session from a work item.
 * Endpoint: POST /api/outcomes/unlink
 * Write path — CSRF gate enforced by the daemon.
 */
export async function unlinkSession(sessionId: string, workItemId: string): Promise<void> {
  if (USE_MOCK) return;
  const res = await daemonFetch("/api/outcomes/unlink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, work_item_id: workItemId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `/api/outcomes/unlink returned ${res.status}`);
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
 * Fetch the BM2 efficiency headroom ratio (modeled ceiling over open recs).
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
 * Fetch the EF2 closure proxy for a workspace.
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
