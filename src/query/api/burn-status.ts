/** Claude Code burn status for the local dashboard, read from the statusline (OAUTH-1). */

import { awaitDbWriteGate } from "../../db/write-gate.js";
import { cachedFetchOAuthUsage } from "../../oauth/usage-cache.js";
import type { UsageReader } from "../../oauth/usage.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { loadLastGoodUsage, saveLastGoodUsage } from "../limits/last-good-store.js";

export interface BurnStatus {
  available: boolean;
  reason?: string;
  /** True when the data is from the last successful fetch (upstream is failing). */
  stale?: boolean;
  /** ISO timestamp of when this data was fetched (or last-good for stale responses). */
  asOf?: string;
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
  per_model?: Array<{ model: string; utilization: number }>;
}

/** Module-level last-good snapshot for stale-serve on 429 / error. */
let lastGood: BurnStatus | null = null;
let lastGoodAsOf: string | null = null;

/**
 * Reset module-level last-good state.  Call in test beforeEach/afterEach to
 * prevent cross-test state pollution.
 */
export function _resetBurnStatusLastGood(): void {
  lastGood = null;
  lastGoodAsOf = null;
}

/**
 * Persist the latest per-model utilization snapshot to user_config so the D4
 * detector can read it synchronously (async→sync bridge, R12 calibration
 * pattern). The dashboard's recurring GET /api/burn-status poll IS the recurring
 * write. Never throws — a persist failure must not fail the burn-status response,
 * and we only overwrite when live per-model data is present (absence leaves the
 * last-known snapshot in place; D4's 24h staleness bound handles the rest).
 */
function persistPerModelSnapshot(
  five_hour: { utilization: number },
  seven_day: { utilization: number },
  per_model: Array<{ model: string; utilization: number }>,
): void {
  try {
    const snapshot = JSON.stringify({
      captured_at: new Date().toISOString(),
      seven_day_util: seven_day.utilization,
      five_hour_util: five_hour.utilization,
      per_model,
    });
    getQueryDb()
      .prepare(
        `INSERT INTO user_config (key, value, updated_at) VALUES ('per_model_snapshot', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(snapshot, new Date().toISOString());
  } catch {
    // Best-effort: a persist failure never fails the response.
  }
}

/**
 * Get the current burn status.
 *
 * Pass a custom `reader` to inject a test double; production callers pass
 * nothing and receive the shared upstream cache as the default.  Using the
 * shared cache means N rapid calls (from the limit-burn hook firing on every
 * tool call) produce at most 1 upstream fetch per 180 s.
 *
 * On 429 or error: serves the last-good snapshot marked stale with its asOf
 * timestamp rather than a hard failure, matching getLimitsModel's pattern.
 */
export async function getBurnStatus(
  reader: UsageReader = cachedFetchOAuthUsage,
): Promise<ApiResponse<BurnStatus>> {
  // OV-1: after a restart, seed last-good from the persisted fetch.
  if (lastGood === null) {
    try {
      const stored = loadLastGoodUsage(getQueryDb());
      if (stored !== null) {
        const { five_hour, seven_day, per_model } = stored.data;
        lastGood = {
          available: true,
          five_hour,
          seven_day,
          ...(per_model !== undefined ? { per_model } : {}),
        };
        lastGoodAsOf = stored.asOf;
      }
    } catch {
      // No query DB bound: nothing to seed.
    }
  }
  try {
    const result = await reader();
    await awaitDbWriteGate(); // the snapshot writes below follow without another await
    const asOf = new Date().toISOString();

    if (result.ok) {
      const { five_hour, seven_day, per_model } = result.data;
      if (per_model !== undefined && per_model.length > 0) {
        persistPerModelSnapshot(five_hour, seven_day, per_model);
      }
      try {
        saveLastGoodUsage(getQueryDb(), result.data, asOf);
      } catch {
        // No query DB bound: keep the in-memory copy only.
      }

      const status: BurnStatus = {
        available: true,
        stale: false,
        asOf,
        five_hour,
        seven_day,
        ...(per_model !== undefined && per_model.length > 0 ? { per_model } : {}),
      };
      lastGood = status;
      lastGoodAsOf = asOf;

      return buildResponse<BurnStatus>(status, { claim_kind: "OBS_PROXY", n: 1 });
    }

    // Not ok — serve last-good if available, otherwise a hard failure.
    if (lastGood !== null && lastGoodAsOf !== null) {
      return buildResponse<BurnStatus>(
        { ...lastGood, stale: true, asOf: lastGoodAsOf },
        { claim_kind: "OBS_PROXY", n: 0 },
      );
    }

    return buildResponse<BurnStatus>(
      { available: false, reason: result.reason, stale: false },
      { claim_kind: "OBS_PROXY", n: 0 },
    );
  } catch {
    if (lastGood !== null && lastGoodAsOf !== null) {
      return buildResponse<BurnStatus>(
        { ...lastGood, stale: true, asOf: lastGoodAsOf },
        { claim_kind: "OBS_PROXY", n: 0 },
      );
    }
    return buildResponse<BurnStatus>(
      { available: false, reason: "OAuth usage is unavailable.", stale: false },
      { claim_kind: "OBS_PROXY", n: 0 },
    );
  }
}
