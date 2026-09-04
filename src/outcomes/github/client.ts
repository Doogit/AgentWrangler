/**
 * src/outcomes/github/client.ts — GitHub sync client.
 *
 * Uses fetch (REST + GraphQL) — NOT Octokit (plan §6 Q3: no new dep).
 * Injected token + injected fetch for testability.
 *
 * Disabled state: when token is ok:false, ALL methods return {ok:false,reason}
 * and make ZERO network calls.
 *
 * Clean degradation (HARD constraint): never throws; always {ok}|{ok:false,reason}.
 */

import { fingerprintBranchRef } from "../branch-key.js";
import { type CheckRunsBody, aggregateCheckConclusion, normalizePRBody } from "../conclusions.js";
import type { TokenResult } from "./credential.js";

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export type GhResult<T> = { ok: true; data: T } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Payload shapes (minimal — only columns we write to DB)
// ---------------------------------------------------------------------------

export interface GhPR {
  number: number;
  state: "open" | "closed" | "merged";
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  merge_commit_sha: string | null;
  head: { sha: string; refKey: string | null };
}

export interface GhCheckRun {
  conclusion: string | null;
  status: string;
}

export interface GhReviewThread {
  id: string;
  isResolved: boolean;
}

// ---------------------------------------------------------------------------
// GitHub read surface (implemented by both the fetch client and the gh-CLI
// client). Consumers depend on this interface so the transport can be swapped
// without touching sync/link/findings logic.
// ---------------------------------------------------------------------------

export interface GithubClient {
  readonly enabled: boolean;
  listPRs(owner: string, repo: string, since?: string): Promise<GhResult<GhPR[]>>;
  getPRHeadKey(owner: string, repo: string, prNumber: number): Promise<GhResult<string | null>>;
  getCheckConclusion(owner: string, repo: string, ref: string): Promise<GhResult<string>>;
  listPRCommits(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<{ sha: string; message: string }[]>>;
  listPullsForCommit(owner: string, repo: string, sha: string): Promise<GhResult<number[]>>;
  getPRBody(owner: string, repo: string, prNumber: number): Promise<GhResult<string>>;
  getPRDiff(owner: string, repo: string, prNumber: number): Promise<GhResult<string>>;
  getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<GhReviewThread[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/**
 * Validate and privacy-project a REST pull-request payload.
 * The raw head ref is fingerprinted while local to this function and is never
 * included in either the returned value or an error reason.
 */
function projectPR(value: unknown): GhPR | null {
  if (!isRecord(value) || !isRecord(value.head) || typeof value.head.ref !== "string") return null;
  if (
    !Number.isInteger(value.number) ||
    (value.state !== "open" && value.state !== "closed" && value.state !== "merged") ||
    !isNullableString(value.merged_at) ||
    !isNullableString(value.closed_at) ||
    typeof value.created_at !== "string" ||
    !isNullableString(value.merge_commit_sha) ||
    typeof value.head.sha !== "string"
  ) {
    return null;
  }

  return {
    number: value.number as number,
    state: value.state,
    merged_at: value.merged_at,
    closed_at: value.closed_at,
    created_at: value.created_at,
    merge_commit_sha: value.merge_commit_sha,
    head: { sha: value.head.sha, refKey: fingerprintBranchRef(value.head.ref) },
  };
}

/** Validate a complete page before exposing any projected PRs. */
export function projectPRPage(value: unknown): GhResult<GhPR[]> {
  if (!Array.isArray(value)) return { ok: false, reason: "github-pr-payload-invalid" };
  const projected: GhPR[] = [];
  for (const item of value) {
    const pr = projectPR(item);
    if (pr === null) return { ok: false, reason: "github-pr-payload-invalid" };
    projected.push(pr);
  }
  return { ok: true, data: projected };
}

/** Validate and project only the privacy-safe branch key from one PR payload. */
export function projectPRHeadKey(value: unknown): GhResult<string | null> {
  if (!isRecord(value) || !isRecord(value.head) || typeof value.head.ref !== "string") {
    return { ok: false, reason: "github-pr-payload-invalid" };
  }
  return { ok: true, data: fingerprintBranchRef(value.head.ref) };
}

// ---------------------------------------------------------------------------
// Injected fetch type
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch;

/**
 * Retry/timeout tuning for the outbound GitHub fetches.
 * A busy Node event loop (tail-watcher + linkSessions transcript streaming) can
 * delay undici's socket callbacks past a single AbortSignal.timeout even when the
 * server responds promptly, aborting the fetch. A bounded per-attempt timeout plus
 * retry-with-backoff lets the call fail fast and re-fire once the loop drains,
 * instead of one long 30 s hang stalling the whole outcomes pass.
 */
export interface GithubClientOptions {
  /** Per-attempt fetch timeout (ms). Default 15 000. */
  requestTimeoutMs?: number;
  /** Max fetch attempts before giving up (bounded — never hangs). Default 3. */
  maxAttempts?: number;
  /** Base backoff between attempts (ms); grows linearly per attempt. Default 500. */
  retryBackoffMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const GH_REST = "https://api.github.com";
const GH_GRAPHQL = "https://api.github.com/graphql";

export class GithubSyncClient implements GithubClient {
  private readonly token: string | null;
  private readonly fetchFn: FetchFn;
  private readonly etags = new Map<string, string>();
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(
    tokenResult: TokenResult,
    fetchFn: FetchFn = globalThis.fetch,
    options: GithubClientOptions = {},
  ) {
    this.token = tokenResult.ok ? tokenResult.data : null;
    this.fetchFn = fetchFn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  private disabledResult<T>(): GhResult<T> {
    return { ok: false, reason: "github-token-unset" };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token ?? ""}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  /**
   * fetch with a bounded per-attempt timeout and retry-with-backoff.
   * Each attempt arms a fresh AbortSignal.timeout so a request that was aborted
   * because the loop was momentarily starved gets a clean retry once the loop
   * drains. Re-throws the last error after maxAttempts so the caller's try/catch
   * still maps it to {ok:false,reason} (clean degradation — never hangs the pass).
   * Only thrown errors (abort/network) are retried; an HTTP error response is
   * returned to the caller unchanged (no retry on 4xx/5xx).
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.fetchFn(url, {
          ...init,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (e: unknown) {
        lastErr = e;
        if (attempt < this.maxAttempts) {
          await new Promise((r) => setTimeout(r, this.retryBackoffMs * attempt));
        }
      }
    }
    throw lastErr;
  }

  /**
   * List PRs for a repo updated since the watermark ISO-8601 date.
   * Returns up to 100 PRs per call (no pagination for now — watermark minimises volume).
   */
  async listPRs(owner: string, repo: string, since?: string): Promise<GhResult<GhPR[]>> {
    if (!this.enabled) return this.disabledResult();
    const qs = new URLSearchParams({
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
    if (since !== undefined) qs.set("since", since);
    const url = `${GH_REST}/repos/${owner}/${repo}/pulls?${qs}`;
    const hdrs = this.headers();
    const etag = this.etags.get(url);
    if (etag !== undefined) hdrs["If-None-Match"] = etag;

    try {
      const res = await this.fetchWithRetry(url, { headers: hdrs });
      if (res.status === 304) return { ok: true, data: [] }; // not modified
      if (!res.ok) return { ok: false, reason: `github-api-error:${res.status}` };
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return { ok: false, reason: "github-pr-payload-invalid" };
      }
      const projected = projectPRPage(payload);
      if (!projected.ok) return projected;
      const newEtag = res.headers.get("ETag");
      if (newEtag !== null) this.etags.set(url, newEtag);
      return projected;
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async getPRHeadKey(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<string | null>> {
    if (!this.enabled) return this.disabledResult();
    const url = `${GH_REST}/repos/${owner}/${repo}/pulls/${prNumber}`;
    try {
      const res = await this.fetchWithRetry(url, { headers: this.headers() });
      if (!res.ok) return { ok: false, reason: `github-pr-error:${res.status}` };
      try {
        return projectPRHeadKey(await res.json());
      } catch {
        return { ok: false, reason: "github-pr-payload-invalid" };
      }
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-pr-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Get check-run conclusions for the HEAD sha of a PR.
   * Returns aggregated conclusion: SUCCESS|FAILURE|PENDING|NONE.
   */
  async getCheckConclusion(owner: string, repo: string, ref: string): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const url = `${GH_REST}/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`;
    try {
      const res = await this.fetchWithRetry(url, { headers: this.headers() });
      if (!res.ok) return { ok: false, reason: `github-checks-error:${res.status}` };
      const body = (await res.json()) as CheckRunsBody;
      return aggregateCheckConclusion(body);
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-checks-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * List commit SHAs for a PR (for SHA_OVERLAP linkage).
   */
  async listPRCommits(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<{ sha: string; message: string }[]>> {
    if (!this.enabled) return this.disabledResult();
    // GitHub caps commits per page at 100; PRs with >100 commits truncate the SHA set
    // (pre-existing limitation, same on both transports).
    const url = `${GH_REST}/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`;
    try {
      const res = await this.fetchWithRetry(url, { headers: this.headers() });
      if (!res.ok) return { ok: false, reason: `github-commits-error:${res.status}` };
      const data = (await res.json()) as Array<{ sha: string; commit?: { message?: string } }>;
      return {
        ok: true,
        data: data.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" })),
      };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-commits-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async listPullsForCommit(owner: string, repo: string, sha: string): Promise<GhResult<number[]>> {
    if (!this.enabled) return this.disabledResult();
    const url = `${GH_REST}/repos/${owner}/${repo}/commits/${sha}/pulls`;
    try {
      const res = await this.fetchWithRetry(url, {
        headers: { ...this.headers(), Accept: "application/vnd.github+json" },
      });
      if (res.status === 404) return { ok: true, data: [] };
      if (!res.ok) return { ok: false, reason: `github-commit-pulls-error:${res.status}` };
      const data = (await res.json()) as Array<{ number: number }>;
      return { ok: true, data: data.map((p) => p.number) };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-commit-pulls-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Fetch PR body for E2 extraction (in-memory only; body never stored).
   */
  async getPRBody(owner: string, repo: string, prNumber: number): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const url = `${GH_REST}/repos/${owner}/${repo}/pulls/${prNumber}`;
    try {
      const res = await this.fetchWithRetry(url, { headers: this.headers() });
      if (!res.ok) return { ok: false, reason: `github-pr-error:${res.status}` };
      const data = (await res.json()) as { body: string | null };
      return { ok: true, data: normalizePRBody(data) };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-pr-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Fetch diff for E3 extraction (in-memory only; diff never stored).
   */
  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<GhResult<string>> {
    if (!this.enabled) return this.disabledResult();
    const url = `${GH_REST}/repos/${owner}/${repo}/pulls/${prNumber}`;
    const hdrs = { ...this.headers(), Accept: "application/vnd.github.diff" };
    try {
      const res = await this.fetchWithRetry(url, { headers: hdrs });
      if (!res.ok) return { ok: false, reason: `github-diff-error:${res.status}` };
      const diff = await res.text();
      return { ok: true, data: diff };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-diff-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Fetch review thread resolution status via GraphQL (E1 extraction).
   * Returns list of {id, isResolved} for the PR.
   * Paginates automatically so PRs with >100 review threads are not truncated.
   */
  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GhResult<GhReviewThread[]>> {
    if (!this.enabled) return this.disabledResult();
    const query = `
      query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$pr) {
            reviewThreads(first:100, after:$cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved }
            }
          }
        }
      }
    `;
    type GqlBody = {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
              nodes?: GhReviewThread[];
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    try {
      const allThreads: GhReviewThread[] = [];
      let cursor: string | null = null;

      do {
        const res = await this.fetchWithRetry(GH_GRAPHQL, {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables: { owner, repo, pr: prNumber, cursor } }),
        });
        if (!res.ok) return { ok: false, reason: `github-graphql-error:${res.status}` };
        const body = (await res.json()) as GqlBody;
        if (body.errors !== undefined && body.errors.length > 0) {
          return {
            ok: false,
            reason: `github-graphql-errors: ${body.errors.map((e) => e.message).join("; ")}`,
          };
        }
        const reviewThreads = body.data?.repository?.pullRequest?.reviewThreads;
        allThreads.push(...(reviewThreads?.nodes ?? []));
        const pageInfo = reviewThreads?.pageInfo;
        if (pageInfo?.hasNextPage !== true) break;
        cursor = pageInfo.endCursor ?? null;
      } while (cursor !== null);

      return { ok: true, data: allThreads };
    } catch (e: unknown) {
      return {
        ok: false,
        reason: `github-graphql-fetch-error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
