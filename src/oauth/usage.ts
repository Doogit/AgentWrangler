/**
 * src/oauth/usage.ts — reader for the Anthropic oauth/usage endpoint.
 *
 * Reads the current user's weekly utilization from their local OAuth session.
 * No data leaves the machine — this queries the same session Claude Code uses.
 *
 * Requires a valid credential (read from ~/.claude/.credentials.json by default).
 * Returns ok:false without calling fetch if credentials are missing or expired.
 *
 * Degrades gracefully on ANY non-200. Never throws uncaught; always returns a
 * typed result.
 */

import type { CredentialSource } from "./credentials.js";
import { fileCredentialSource } from "./credentials.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface OAuthUsagePeriod {
  /**
   * Fraction 0–1; fraction of the period's compute allowance used.
   *
   * NOTE: the live oauth/usage endpoint reports this as a PERCENT (0–100,
   * confirmed against the real endpoint 2026-09-01: five_hour/seven_day
   * `utilization` mirrors the parallel `limits[].percent`). We normalize
   * percent→fraction at this boundary so every downstream consumer keeps the
   * documented 0–1 contract (see calibrateLimit in query/settings-store.ts).
   */
  utilization: number;
  /** ISO-8601 timestamp when this counter resets. */
  resets_at: string;
}

/** Per-model utilization, normalized to the fraction 0–1 contract. */
export interface OAuthUsagePerModel {
  /** Model identifier reported by the oauth/usage endpoint. */
  model: string;
  /** Fraction 0–1; fraction of this model's allowance used. */
  utilization: number;
}

export interface OAuthUsageData {
  five_hour: OAuthUsagePeriod;
  seven_day: OAuthUsagePeriod;
  per_model?: OAuthUsagePerModel[];
}

export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageData }
  | { ok: false; reason: string; status?: number };

/**
 * Validate one raw period from the API (utilization as PERCENT 0–100) and
 * return it normalized to the fraction-0–1 contract, or null if malformed.
 */
function parseUsagePeriod(value: unknown): OAuthUsagePeriod | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { utilization?: unknown; resets_at?: unknown };
  const pct = candidate.utilization;
  if (
    typeof pct !== "number" ||
    !Number.isFinite(pct) ||
    pct < 0 ||
    pct > 100 ||
    typeof candidate.resets_at !== "string" ||
    candidate.resets_at.length === 0 ||
    !Number.isFinite(new Date(candidate.resets_at).getTime())
  ) {
    return null;
  }
  return { utilization: pct / 100, resets_at: candidate.resets_at };
}

/**
 * Parse the unverified per-model utilization response shape. Invalid entries
 * are ignored so optional model detail can never invalidate the core periods.
 */
function parsePerModel(value: unknown): OAuthUsagePerModel[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  try {
    const parseEntry = (modelValue: unknown, entryValue: unknown): OAuthUsagePerModel | null => {
      if (typeof modelValue !== "string" || modelValue.trim().length === 0) return null;
      if (typeof entryValue !== "object" || entryValue === null) return null;

      const pct = (entryValue as { utilization?: unknown }).utilization;
      if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        return null;
      }
      return { model: modelValue.trim(), utilization: pct / 100 };
    };

    const entries: OAuthUsagePerModel[] = [];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;
        const candidate = entry as { model?: unknown; model_key?: unknown; tier?: unknown };
        const model = [candidate.model, candidate.model_key, candidate.tier].find(
          (candidateModel): candidateModel is string =>
            typeof candidateModel === "string" && candidateModel.trim().length > 0,
        );
        const parsed = parseEntry(model, entry);
        if (parsed !== null) entries.push(parsed);
      }
    } else {
      for (const [model, entry] of Object.entries(value)) {
        const parsed = parseEntry(model, entry);
        if (parsed !== null) entries.push(parsed);
      }
    }

    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate value contains valid five_hour and seven_day periods and return the
 * normalized (fraction 0–1) usage data, or null if malformed.
 * Extra unknown keys (per-model breakdowns, extra_usage, limits, spend, …) are
 * tolerated — we only require the two bounded fields.
 */
function parseUsageData(value: unknown): OAuthUsageData | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    five_hour?: unknown;
    seven_day?: unknown;
    per_model?: unknown;
    per_model_utilization?: unknown;
  };
  const fiveHour = parseUsagePeriod(candidate.five_hour);
  const sevenDay = parseUsagePeriod(candidate.seven_day);
  if (fiveHour === null || sevenDay === null) return null;
  let perModel: OAuthUsagePerModel[] | undefined;
  try {
    perModel = parsePerModel(
      candidate.per_model === undefined ? candidate.per_model_utilization : candidate.per_model,
    );
  } catch {
    perModel = undefined;
  }
  if (perModel !== undefined) {
    return { five_hour: fiveHour, seven_day: sevenDay, per_model: perModel };
  }
  return { five_hour: fiveHour, seven_day: sevenDay };
}

/**
 * Fetch the oauth/usage endpoint, authenticated with the local OAuth credential.
 *
 * @param credSource - Credential source to read the token from (default: file source).
 *   Injectable for tests via a stub that returns a known credential or ok:false.
 *
 * Returns ok:false (no fetch) when credentials are missing or expired.
 * Distinguishes 401 (auth failure — re-login) from 429 (rate limited).
 */
export async function fetchOAuthUsage(
  credSource: CredentialSource = fileCredentialSource,
): Promise<OAuthUsageResult> {
  // 1. Read credential; fail closed if unavailable.
  const credResult = credSource.read();
  if (!credResult.ok) {
    return { ok: false, reason: credResult.reason };
  }

  const { accessToken } = credResult.credential;

  // 2. Fetch with auth headers.
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        // Honest, self-identifying UA. Verified 2026-09-01 against the real
        // endpoint: this UA returns 200 — the endpoint does not require Claude
        // Code's own UA, so we do not impersonate it.
        "User-Agent": "claude-code/AgentWrangler-oauth-usage-reader",
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          reason: "OAuth token rejected (401) — re-login to Claude Code.",
          status: 401,
        };
      }
      if (res.status === 429) {
        return {
          ok: false,
          reason: "Rate limited (429) — try again later.",
          status: 429,
        };
      }
      return {
        ok: false,
        reason: `HTTP ${res.status} from oauth/usage`,
        status: res.status,
      };
    }

    const raw: unknown = await res.json();
    const data = parseUsageData(raw);
    if (data === null) {
      return { ok: false, reason: "oauth/usage returned an invalid response shape." };
    }
    return { ok: true, data };
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `Could not reach ${USAGE_URL}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Type for injecting a custom usage reader (tests, stubs). */
export type UsageReader = () => Promise<OAuthUsageResult>;
