/**
 * src/query/limits/last-good-store.ts — persist the last good usage-limits fetch (OV-1).
 *
 * The in-memory last-good copies in limits/index.ts and api/burn-status.ts are lost on a
 * daemon restart, so the usage card went blank until the next successful fetch. This keeps
 * the last good five_hour/seven_day (+ per-model) periods under their own user_config key;
 * `per_model_snapshot` (read by D4) is left unchanged. Only percentages, ISO timestamps and
 * model ids are stored (SEC-101). Best-effort: never throws.
 */

import type { Db } from "../../db/open.js";
import type { OAuthUsageData, OAuthUsagePeriod } from "../../oauth/usage.js";

const KEY = "usage_last_good";

export interface StoredUsage {
  asOf: string;
  data: OAuthUsageData;
}

export function saveLastGoodUsage(db: Db, data: OAuthUsageData, asOf: string): void {
  try {
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(KEY, JSON.stringify({ asOf, data }), asOf);
  } catch {
    // Best-effort: a persist failure never fails the usage response.
  }
}

function isPeriod(p: unknown): p is OAuthUsagePeriod {
  const v = p as { utilization?: unknown; resets_at?: unknown } | null;
  return (
    typeof v?.utilization === "number" && (v.resets_at === null || typeof v.resets_at === "string")
  );
}

/** The stored last good fetch, or null when absent or malformed. */
export function loadLastGoodUsage(db: Db): StoredUsage | null {
  try {
    const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(KEY) as
      | { value: string | null }
      | undefined;
    if (row?.value == null) return null;
    const parsed = JSON.parse(row.value) as Partial<StoredUsage>;
    const data = parsed.data;
    if (
      typeof parsed.asOf !== "string" ||
      Number.isNaN(Date.parse(parsed.asOf)) ||
      !isPeriod(data?.five_hour) ||
      !isPeriod(data?.seven_day)
    ) {
      return null;
    }
    const perModel = Array.isArray(data.per_model)
      ? data.per_model.filter(
          (m) => typeof m?.model === "string" && typeof m.utilization === "number",
        )
      : [];
    return {
      asOf: parsed.asOf,
      data: {
        five_hour: data.five_hour,
        seven_day: data.seven_day,
        ...(perModel.length > 0 ? { per_model: perModel } : {}),
      },
    };
  } catch {
    return null;
  }
}
