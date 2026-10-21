/**
 * src/oauth/usage-cache.ts — Shared module-level cache for the oauth/usage
 * upstream call.
 *
 * Prevents 429 storms when both /api/burn-status and /api/query/limits are
 * polled rapidly (e.g. the limit-burn PreToolUse hook fires on every tool
 * call).  A single cache + in-flight coalescing mean N concurrent callers
 * share one upstream fetch.
 *
 *   - Min TTL: 180 s (matches UsageLimitsCard's 3-min poll comment).
 *   - In-flight coalescing: N simultaneous callers → 1 upstream fetch.
 *   - 429: TTL extended to max(MIN_TTL_MS, retryAfterSec * 1000).
 *   - Default backoff (no Retry-After): 240 s.
 *
 * The cache returns the actual upstream result (ok or error).  Callers own
 * their stale-serve logic (getLimitsModel already does; getBurnStatus is
 * extended in this same PR).
 *
 * Privacy (SEC-101): only the result object — percentages, ISO timestamps,
 * model ids — is cached here.  The OAuth access token from credentials.json
 * is never stored in module-level state.
 */

import { getQueryDb } from "../query/db-context.js";
import { readMergedUsage } from "../query/limits/usage-sources.js";
import type { OAuthUsageResult, UsageReader } from "./usage.js";

/** USAGE-CLI: the statusline merged with the stored `claude -p /usage` reading, as the limits card shows. */
const defaultUpstream: UsageReader = () => {
  let db: ReturnType<typeof getQueryDb> | null = null;
  try {
    db = getQueryDb();
  } catch {
    // No query DB bound: the Settings toggle reads as on.
  }
  return readMergedUsage(db);
};

/** Min TTL for any result (3 min). */
const MIN_TTL_MS = 180_000;
/** Default backoff when a 429 omits a numeric Retry-After. */
const DEFAULT_RETRY_MS = 240_000;

interface CacheSlot {
  expiresAt: number;
  result: OAuthUsageResult;
}

/** The cached result with its expiry timestamp. */
let slot: CacheSlot | null = null;
/** An in-flight upstream fetch, coalesced across simultaneous callers. */
let inFlight: Promise<OAuthUsageResult> | null = null;

/**
 * Reset all module-level state.  Call in test beforeEach/afterEach to prevent
 * cross-test cache pollution.
 */
export function _resetSharedUsageCache(): void {
  slot = null;
  inFlight = null;
}

/**
 * Fetch the oauth/usage endpoint with module-level caching and in-flight
 * coalescing.
 *
 * Pass `upstream` to inject a test double; production callers pass nothing
 * and receive the merged statusline + CLI reading (OAUTH-1: no oauth/usage call; USAGE-CLI).
 *
 * Returns the raw `OAuthUsageResult` so callers retain full control of stale
 * handling and error surfacing.
 */
export async function cachedFetchOAuthUsage(
  upstream: UsageReader = defaultUpstream,
): Promise<OAuthUsageResult> {
  const now = Date.now();

  // 1. Serve from cache if still valid.
  if (slot !== null && now < slot.expiresAt) {
    return slot.result;
  }

  // 2. Coalesce: if a fetch is already in flight, wait for it.
  if (inFlight !== null) {
    return inFlight;
  }

  // 3. Start a new fetch and coalesce future callers onto the same promise.
  inFlight = (async (): Promise<OAuthUsageResult> => {
    try {
      const result = await upstream();
      const t = Date.now();

      let ttlMs: number;
      if (result.ok) {
        ttlMs = MIN_TTL_MS;
      } else if (result.status === 429) {
        const retryMs = (result.retryAfterSec ?? DEFAULT_RETRY_MS / 1000) * 1000;
        ttlMs = Math.max(MIN_TTL_MS, retryMs);
      } else {
        ttlMs = MIN_TTL_MS;
      }

      slot = { expiresAt: t + ttlMs, result };
      return result;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
