/** OAuth-backed Claude Code burn status for the local dashboard. */

import { type UsageReader, fetchOAuthUsage } from "../../oauth/usage.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface BurnStatus {
  available: boolean;
  reason?: string;
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  per_model?: Array<{ model: string; utilization: number }>;
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

export async function getBurnStatus(
  reader: UsageReader = fetchOAuthUsage,
): Promise<ApiResponse<BurnStatus>> {
  try {
    const result = await reader();
    if (!result.ok) {
      return buildResponse<BurnStatus>(
        { available: false, reason: result.reason },
        { claim_kind: "OBS_PROXY", n: 0 },
      );
    }

    const { five_hour, seven_day, per_model } = result.data;
    if (per_model !== undefined && per_model.length > 0) {
      persistPerModelSnapshot(five_hour, seven_day, per_model);
    }

    return buildResponse<BurnStatus>(
      {
        available: true,
        five_hour,
        seven_day,
        ...(per_model !== undefined && per_model.length > 0 ? { per_model } : {}),
      },
      { claim_kind: "OBS_PROXY", n: 1 },
    );
  } catch {
    return buildResponse<BurnStatus>(
      { available: false, reason: "OAuth usage is unavailable." },
      { claim_kind: "OBS_PROXY", n: 0 },
    );
  }
}
