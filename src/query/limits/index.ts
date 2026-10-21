/**
 * src/query/limits/index.ts — Usage-limits card model + state machine.
 *
 * Maps the OAuth usage reader result to a single exclusive LimitsModel.state
 * (overview-v2 §1 states table) and computes every derived field so the UI
 * renders values only. Serves last-good rows (stale) during 429/error.
 *
 * Privacy (SEC-101): only percentages, ISO timestamps, counts, and model
 * identifiers are ever stored or returned. The OAuth token and raw API body are
 * never persisted, returned, or written to any log here.
 */

import type { Db } from "../../db/open.js";
import { awaitDbWriteGate } from "../../db/write-gate.js";
import { REF_PRICE_U_PER_TOKEN } from "../../ingest/pricing.js";
import { type OAuthUsageData, type UsageReader, noUsageApi } from "../../oauth/usage.js";
import { listLiveSessions } from "../api/overview.js";
import { getQueryDb } from "../db-context.js";
import { forecastFromDb, readLimitResetsAt } from "../forecast.js";
import {
  CLI_SKIP_STATUSLINE_MS,
  type CliSpawn,
  type CliUsageState,
  cliCallInFlight,
  defaultCliStateDir,
  kickCliRefresh,
  readCliState,
} from "./cli-usage.js";
import { computeRow } from "./compute.js";
import { computeLimitHistory, modelLabel } from "./history.js";
import { loadLastGoodUsage, saveLastGoodUsage } from "./last-good-store.js";
import { recordLimitSnapshot } from "./snapshot-store.js";
import { defaultStatuslinePath, loadStatuslineFile, readStatuslineLimits } from "./statusline.js";
import type {
  LimitRow,
  LimitsModel,
  LocalUsageHistory,
  WeeklyHistoryWeek,
  WeeklyMax,
  WeeklyMaxModel,
  WeeklyMaxState,
} from "./types.js";
import { CLI_STALE_MS, type MergedUsage, cliEnabled, mergeUsage } from "./usage-sources.js";

/** Default retry hint (seconds) when a 429 omits a numeric Retry-After. */
const DEFAULT_RETRY_SEC = 240;
/** Route-level response cache TTL (spec §2D: cache 30s). */
const CACHE_TTL_MS = 30_000;
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JD = 2440587.5;

/** Last successful rows + their timestamp, served (greyed) during 429/error. */
let lastGood: { rows: LimitRow[]; asOf: string } | null = null;
/**
 * Memo of the default-path model (bypassed whenever opts are injected).
 * TTL is normally CACHE_TTL_MS, but a 429 is held for its full retryInSec so we
 * back off upstream instead of re-hitting every cache expiry (which re-arms the
 * rate limit and keeps it stuck).
 */
let responseCache: { expiresAt: number; model: LimitsModel } | null = null;
/** The one background refresh running for an expired memo (P1-U7 single-flight). */
let refreshing: Promise<unknown> | null = null;
/** USAGE-CLI: bumped when a /usage call finishes, so a compute that overlapped it skips the memo write. */
let cliDoneCount = 0;

/** Sessions live now + sum of their list-price running spend (USD). */
function computeLive(): { sessions: number; runningSpendUsd: number } {
  const items = listLiveSessions().data?.items ?? [];
  const runningUsdU = items.reduce((sum, r) => sum + r.running_usd_u, 0);
  return { sessions: items.length, runningSpendUsd: runningUsdU / 1e6 };
}

/**
 * Weekly all-models est-vs-actual: `modelPct` is the existing cap-weighted burn
 * forecast (tokens_used / limit_tokens), matching the current "Weekly burn
 * forecast" tile. Populated only when a weekly limit is configured.
 */
function computeEstimateVsActual(
  db: Db,
  actualPct: number,
): LimitsModel["estimateVsActual"] | undefined {
  const forecast = forecastFromDb(db);
  if (forecast.limit_tokens === null || forecast.limit_tokens <= 0) return undefined;
  const modelPct = (forecast.tokens_used / forecast.limit_tokens) * 100;
  return { modelPct, actualPct, deltaPts: modelPct - actualPct };
}

/**
 * Days since the start of the weekly window the limit was calibrated on
 * ([resets_at - 7d, resets_at), rolled by whole weeks to contain `now`); 7 when
 * no reset time is stored. Comparing a trailing 7 days against that limit mixes
 * in the previous window's usage (REL-FIX 3: 134% shown while claude.ai said ~16%).
 */
function limitWindowDays(db: Db, now: Date): number {
  const resetsMs = Date.parse(readLimitResetsAt(db) ?? "");
  if (Number.isNaN(resetsMs)) return 7;
  const weekMs = 7 * MS_PER_DAY;
  const weeksAhead = Math.floor((now.getTime() - resetsMs) / weekMs) + 1;
  const windowStartMs = resetsMs + weeksAhead * weekMs - weekMs;
  return (now.getTime() - windowStartMs) / MS_PER_DAY;
}

function computeLocalHistory(db: Db, now: Date): LocalUsageHistory {
  const fiveHour = forecastFromDb(db, { now, windowDays: 5 / 24 });
  const weekly = forecastFromDb(db, { now, windowDays: 7 });
  const limitWindow = forecastFromDb(db, { now, windowDays: limitWindowDays(db, now) });
  const weeklyLimitTokens = weekly.limit_tokens;
  return {
    basis: "cap-weighted",
    fiveHourTokens: fiveHour.tokens_used,
    sevenDayTokens: weekly.tokens_used,
    tokensPerDay: weekly.tokens_per_day,
    weeklyLimitTokens,
    weeklyUtilizationPct:
      weeklyLimitTokens !== null && weeklyLimitTokens > 0
        ? (limitWindow.tokens_used / weeklyLimitTokens) * 100
        : null,
    projectedExhaustionAt:
      limitWindow.projected_exhaustion_jd === null
        ? null
        : new Date(
            (limitWindow.projected_exhaustion_jd - UNIX_EPOCH_JD) * MS_PER_DAY,
          ).toISOString(),
    forecastState: limitWindow.state,
  };
}

const UNAVAILABLE: WeeklyMax = {
  weekStart: null,
  resetsAt: null,
  usedPct: null,
  spendSoFarU: null,
  impliedMaxSpendU: null,
  impliedMaxPwTokens: null,
  stale: false,
  state: "unavailable",
};

/** Floors: below 2% the ratio is noise; below 10% it is shown with a low-confidence chip. */
function impliedMax(
  spendU: number,
  usedPct: number,
): { state: WeeklyMaxState; impliedMaxSpendU: number | null; impliedMaxPwTokens: number | null } {
  if (usedPct < 2) return { state: "too-early", impliedMaxSpendU: null, impliedMaxPwTokens: null };
  // Usage upstream with no local spend = usage we can't see; a $0 max would be wrong.
  if (spendU <= 0)
    return { state: "unavailable", impliedMaxSpendU: null, impliedMaxPwTokens: null };
  const maxU = spendU / (usedPct / 100);
  return {
    state: usedPct < 10 ? "low-confidence" : "ok",
    impliedMaxSpendU: maxU,
    impliedMaxPwTokens: maxU / REF_PRICE_U_PER_TOKEN,
  };
}

/**
 * OV-12 U1: implied weekly max from local spend in [weekStart, asOf) — asOf, not now, because a
 * stale/last-good usedPct is frozen at its asOf. Provisional turns are included (in-progress spend
 * is real; matches calibrateLimit's window query). One scan, folded by model family.
 */
function computeWeeklyMax(
  db: Db,
  rows: LimitRow[],
  asOf: string,
  stale: boolean,
  now: Date,
): WeeklyMax {
  const weekly = rows.find((r) => r.id === "weekly");
  if (weekly === undefined || weekly.idle || Date.parse(weekly.resetsAt) <= now.getTime()) {
    return UNAVAILABLE;
  }
  const weekStart = new Date(Date.parse(weekly.resetsAt) - 168 * 36e5).toISOString();
  const byModel = db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE ts >= ? AND ts < ? GROUP BY model",
    )
    .all(weekStart, asOf) as { model: string; u: number }[];
  const spendSoFarU = byModel.reduce((sum, r) => sum + r.u, 0);
  const perModel: WeeklyMaxModel[] = rows
    .filter((r): r is LimitRow & { id: `weekly:${string}` } => r.id.startsWith("weekly:"))
    .map((r) => {
      const family = modelLabel(r.id.slice("weekly:".length));
      const spendU = byModel
        .filter((t) => modelLabel(t.model) === family)
        .reduce((sum, t) => sum + t.u, 0);
      return { id: r.id, label: family, usedPct: r.usedPct, ...impliedMax(spendU, r.usedPct) };
    });
  const max = impliedMax(spendSoFarU, weekly.usedPct);
  // OV-12 U5: past weeks, and this week vs the latest of them (a "clear" change beats the noise band).
  // History is extra: an error there must not take down this week's max.
  let history: WeeklyHistoryWeek[] = [];
  let noisePct = 0;
  try {
    ({ history, noisePct } = computeLimitHistory(db, weekly.resetsAt));
  } catch (err) {
    console.warn("limits: past-week history failed:", err);
  }
  const ref = history[0];
  let vsLastWeek: WeeklyMax["vsLastWeek"];
  if (max.state === "ok" && max.impliedMaxSpendU !== null && ref !== undefined) {
    const pct = ((max.impliedMaxSpendU - ref.impliedMaxSpendU) / ref.impliedMaxSpendU) * 100;
    vsLastWeek = {
      pct,
      clear: Math.abs(pct) > noisePct,
      resetsAt: ref.resetsAt,
      impliedMaxSpendU: ref.impliedMaxSpendU,
    };
  }
  return {
    weekStart,
    resetsAt: weekly.resetsAt,
    usedPct: weekly.usedPct,
    spendSoFarU,
    ...max,
    stale,
    ...(perModel.length > 0 ? { perModel } : {}),
    ...(history.length > 0 ? { history, noisePct } : {}),
    ...(vsLastWeek !== undefined ? { vsLastWeek } : {}),
  };
}

/**
 * Resolve a nullable resets_at to a concrete ISO timestamp for computeRow.
 * When resets_at is null (inactive window) we use the end of the window from
 * now so the math stays finite; such rows are marked `idle` and the UI shows
 * "no active window" instead of this placeholder reset/pace.
 */
function resolveResetsAt(resetsAt: string | null, windowHours: number, now: Date): string {
  if (resetsAt !== null) return resetsAt;
  return new Date(now.getTime() + windowHours * 36e5).toISOString();
}

function markIdle(row: LimitRow, resetsAt: string | null): LimitRow {
  return resetsAt === null ? { ...row, idle: true } : row;
}

/** Build the connected-state rows. Per-model rows reuse the weekly reset (the
 * API omits per-model resets_at — audit §2 open-question 2). */
function buildRows(data: OAuthUsageData, now: Date): LimitRow[] {
  const fiveHourResetsAt = resolveResetsAt(data.five_hour.resets_at, 5, now);
  const sevenDayResetsAt = resolveResetsAt(data.seven_day.resets_at, 168, now);
  const rows: LimitRow[] = [
    markIdle(
      computeRow(
        {
          id: "session",
          label: "Current session",
          windowHours: 5,
          usedPct: data.five_hour.utilization * 100,
          resetsAt: fiveHourResetsAt,
        },
        now,
      ),
      data.five_hour.resets_at,
    ),
    markIdle(
      computeRow(
        {
          id: "weekly",
          label: "Weekly · all models",
          windowHours: 168,
          usedPct: data.seven_day.utilization * 100,
          resetsAt: sevenDayResetsAt,
        },
        now,
      ),
      data.seven_day.resets_at,
    ),
  ];
  for (const m of data.per_model ?? []) {
    rows.push(
      markIdle(
        computeRow(
          {
            id: `weekly:${m.model}`,
            label: `Weekly · ${modelLabel(m.model)}`,
            windowHours: 168,
            usedPct: m.utilization * 100,
            resetsAt: sevenDayResetsAt,
          },
          now,
        ),
        data.seven_day.resets_at,
      ),
    );
  }
  return rows;
}

/**
 * Pick the usage reader. `AW_FAKE_USAGE_STATUS=<code>` forces a failure with that
 * HTTP status (verification harness for the exclusive states); an injected
 * reader (tests) always wins over the env flag.
 *
 * The default is `noUsageApi` (OAUTH-1: no oauth/usage call), so the card always
 * serves the statusline values below.
 */
function resolveReader(injected?: UsageReader): UsageReader {
  if (injected !== undefined) return injected;
  const fake = process.env.AW_FAKE_USAGE_STATUS;
  if (fake !== undefined && fake.trim() !== "") {
    const status = Number(fake);
    return async () => ({ ok: false, reason: `AW_FAKE_USAGE_STATUS=${fake}`, status });
  }
  return noUsageApi;
}

export interface GetLimitsModelOptions {
  reader?: UsageReader;
  now?: Date;
  db?: Db;
  /** Statusline fallback file (OV-7). Tests inject this; the default is under the real home. */
  statuslinePath?: string;
  /**
   * USAGE-CLI shared state dir and test doubles. The default is ~/.agentwrangler outside vitest; under vitest
   * with nothing injected the CLI reader is absent (no file read, no spawn).
   */
  cli?: {
    stateDir: string;
    enabled?: boolean;
    spawn?: CliSpawn;
    baseEnv?: Record<string, string | undefined>;
  };
}

function statuslinePathFor(opts: GetLimitsModelOptions): string | null {
  return opts.statuslinePath ?? (process.env.VITEST === undefined ? defaultStatuslinePath() : null);
}

/**
 * OV-7: statusline values to serve in place of the failed API, or null. Newest wins against the
 * API last-good (compared by `at` vs `asOf`; a tie keeps last-good). Under vitest with no injected
 * path the real ~/.agentwrangler file is never read, so a developer's own statusline can't leak into
 * unrelated tests.
 */
function statuslineFallback(
  opts: GetLimitsModelOptions,
  now: Date,
): { data: OAuthUsageData; asOf: string } | null {
  const filePath = statuslinePathFor(opts);
  if (filePath === null) return null;
  const s = readStatuslineLimits({ path: filePath, now });
  if (s === null) return null;
  if (lastGood !== null && Date.parse(lastGood.asOf) >= s.atMs) return null;
  return {
    data: {
      five_hour: { utilization: s.five_hour.usedPct / 100, resets_at: s.five_hour.resetsAt },
      seven_day: { utilization: s.seven_day.usedPct / 100, resets_at: s.seven_day.resetsAt },
    },
    asOf: new Date(s.atMs).toISOString(),
  };
}

/** Age of the statusline file whatever its freshness, or null when absent (CLI-skip rule). */
function statuslineAgeMs(opts: GetLimitsModelOptions, nowMs: number): number | null {
  const filePath = statuslinePathFor(opts);
  const s = filePath === null ? null : loadStatuslineFile(filePath);
  return s === null ? null : nowMs - s.atMs;
}

function lastTurnAt(db: Db): string | null {
  try {
    return (db.prepare("SELECT MAX(ts) AS ts FROM turns").get() as { ts: string | null }).ts;
  } catch {
    return null;
  }
}

function cliStateDir(opts: GetLimitsModelOptions): string | null {
  return opts.cli?.stateDir ?? (process.env.VITEST === undefined ? defaultCliStateDir() : null);
}

/** USAGE-CLI: kick the background refresher (never awaited) and return the shared state it reads. */
function cliReading(
  opts: GetLimitsModelOptions,
  db: Db,
): { on: boolean; state: CliUsageState } | null {
  const stateDir = cliStateDir(opts);
  if (stateDir === null) return null;
  const on = opts.cli?.enabled ?? cliEnabled(db);
  if (on) kickCli(opts, db, stateDir);
  return { on, state: readCliState(stateDir) };
}

/** True when this kick started a /usage call. */
function kickCli(opts: GetLimitsModelOptions, db: Db, stateDir: string): boolean {
  return (
    kickCliRefresh({
      stateDir,
      now: () => (opts.now ?? new Date()).getTime(),
      enabled: true,
      statuslineAgeMs: () => statuslineAgeMs(opts, (opts.now ?? new Date()).getTime()),
      lastTurnAt: () => lastTurnAt(db),
      ...(opts.cli?.spawn !== undefined ? { spawn: opts.cli.spawn } : {}),
      ...(opts.cli?.baseEnv !== undefined ? { baseEnv: opts.cli.baseEnv } : {}),
      onDone: () => {
        cliDoneCount++;
        responseCache = null;
      },
    }) !== null
  );
}

/** Rows from the merged reading; per-row source/asOf only when the sources mix. */
function mergedRows(m: MergedUsage, now: Date): LimitRow[] {
  const rows = buildRows(m.data, now);
  const perModelAsOf = m.perModelAsOf;
  if (perModelAsOf === undefined) return rows;
  return rows.map((r) =>
    r.id.startsWith("weekly:")
      ? { ...r, source: "cli" as const, asOf: perModelAsOf }
      : { ...r, source: "statusline" as const, asOf: m.asOf },
  );
}

/**
 * Compute the full LimitsModel. Exclusive state per audit §6 / spec §1:
 *   401/403 → signed-out (rows: [])
 *   429     → rate-limited (retryInSec, last-good rows, stale)
 *   other failure / network / 5xx → error (last-good rows when present, stale)
 *   ok      → connected
 * The 30s response cache applies only to the default (no-opts) path so tests
 * with an injected reader/now/db are never served a stale memo. P1-U7 (A-13): once
 * the memo exists, a GET never waits on upstream — an expired memo is served as is
 * and one background refresh replaces it. Only the first GET after boot waits.
 */
export async function getLimitsModel(opts: GetLimitsModelOptions = {}): Promise<LimitsModel> {
  const useCache = opts.reader === undefined && opts.now === undefined && opts.db === undefined;
  if (!useCache) return computeModel(opts, false);
  // USAGE-CLI: a memo hit still kicks the refresher, so a call starts on the first GET allowed to start
  // it rather than at the next memo expiry; a call that starts drops the memo so this GET shows pending.
  if (responseCache !== null) {
    const stateDir = cliStateDir(opts);
    const db = getQueryDb();
    if (stateDir !== null && (opts.cli?.enabled ?? cliEnabled(db)) && kickCli(opts, db, stateDir)) {
      responseCache = null;
    }
  }
  if (responseCache === null) return computeModel(opts, true);
  if (Date.now() >= responseCache.expiresAt && refreshing === null) {
    refreshing = computeModel(opts, true)
      .catch(() => {})
      .finally(() => {
        refreshing = null;
      });
  }
  return responseCache.model;
}

async function computeModel(opts: GetLimitsModelOptions, useCache: boolean): Promise<LimitsModel> {
  const cliDoneAtStart = cliDoneCount;
  const now = opts.now ?? new Date();
  const db = opts.db ?? getQueryDb();
  const reader = resolveReader(opts.reader);
  // OV-1: after a restart, seed last-good from the persisted fetch. Rows are computed at
  // that fetch's time so they read exactly as the card showed them then.
  if (lastGood === null) {
    const stored = loadLastGoodUsage(db);
    if (stored !== null) {
      lastGood = { rows: buildRows(stored.data, new Date(stored.asOf)), asOf: stored.asOf };
    }
  }
  const cli = cliReading(opts, db);
  const live = computeLive();
  const localHistory = computeLocalHistory(db, now);

  const result = await reader().catch(
    () => ({ ok: false, reason: "usage reader threw" }) as Awaited<ReturnType<UsageReader>>,
  );
  await awaitDbWriteGate(); // last-good and snapshot writes below follow without another await

  // USAGE-CLI: the stored CLI reading carries its own call time, so it is compared with the statusline
  // only, not with last-good (which burn status re-stamps on every poll).
  const fallback = result.ok
    ? null
    : mergeUsage(
        statuslineFallback(opts, now),
        cli?.on ? (cli.state.reading ?? null) : null,
        now.getTime(),
      );

  let model: LimitsModel;
  if (result.ok) {
    const rows = buildRows(result.data, now);
    const asOf = now.toISOString();
    lastGood = { rows, asOf };
    saveLastGoodUsage(db, result.data, asOf);
    const actualPct = result.data.seven_day.utilization * 100;
    const estimateVsActual = computeEstimateVsActual(db, actualPct);
    model = {
      state: "connected",
      asOf,
      stale: false,
      source: "api",
      rows,
      live,
      localHistory,
      ...(estimateVsActual !== undefined ? { estimateVsActual } : {}),
    };
  } else if (fallback !== null) {
    model = {
      state: "connected",
      asOf: fallback.asOf,
      stale: fallback.source === "cli" && now.getTime() - Date.parse(fallback.asOf) > CLI_STALE_MS,
      source: fallback.source,
      rows: mergedRows(fallback, now),
      live,
      localHistory,
    };
  } else if (result.status === 401 || result.status === 403) {
    model = {
      state: "signed-out",
      asOf: now.toISOString(),
      stale: false,
      rows: [],
      live,
      localHistory,
    };
  } else if (result.status === 429) {
    model = {
      state: "rate-limited",
      asOf: lastGood?.asOf ?? now.toISOString(),
      stale: true,
      retryInSec: result.retryAfterSec ?? DEFAULT_RETRY_SEC,
      rows: lastGood?.rows ?? [],
      live,
      localHistory,
    };
  } else {
    model = {
      state: "error",
      asOf: lastGood?.asOf ?? now.toISOString(),
      stale: lastGood !== null,
      rows: lastGood?.rows ?? [],
      live,
      localHistory,
      ...(!result.ok && result.reason ? { reason: result.reason } : {}),
    };
  }

  if (cli !== null) {
    const s = cli.state;
    const reason = !cli.on
      ? "off"
      : s.guardTrippedVersion !== undefined
        ? "guard"
        : s.outcome !== undefined && s.outcome !== "ok"
          ? s.outcome
          : undefined;
    if (reason !== undefined) model.cliReason = reason;
    // First reading not landed yet (and the statusline isn't covering it), or a call running now.
    // Not when a fresh statusline blocks the call, nor after an attempt cut off mid-call (backoff advanced).
    const slAge = statuslineAgeMs(opts, now.getTime());
    const awaitingFirst =
      s.reading === undefined &&
      s.outcome === undefined &&
      (s.backoffStep ?? 0) === 0 &&
      model.source !== "statusline" &&
      (slAge === null || slAge > CLI_SKIP_STATUSLINE_MS);
    if (cli.on && (cliCallInFlight() || awaitingFirst)) model.pending = true;
  }

  model.weeklyMax = computeWeeklyMax(db, model.rows, model.asOf, model.stale, now);

  const weekly = model.rows.find((r) => r.id === "weekly");
  if (model.state === "connected" && !model.stale && model.source && weekly && !weekly.idle) {
    recordLimitSnapshot(db, {
      ts: model.asOf,
      resetsAt: weekly.resetsAt,
      usedPct: weekly.usedPct,
      source: model.source,
    });
  }

  // A /usage call that finished while this ran makes the model pre-call; don't memo it.
  if (useCache && cliDoneCount === cliDoneAtStart) {
    const ttlMs =
      model.state === "rate-limited"
        ? Math.max(CACHE_TTL_MS, (model.retryInSec ?? DEFAULT_RETRY_SEC) * 1000)
        : CACHE_TTL_MS;
    responseCache = { expiresAt: Date.now() + ttlMs, model };
  }
  return model;
}
