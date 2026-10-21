/**
 * src/ui/overview/UsageLimitsCard.tsx — Usage-limits hero (overview-v2 §1).
 *
 * Renders the fully-computed LimitsModel from GET /api/query/limits. The backend
 * owns every pace/burn/projection value; this component only formats and renders
 * — it never recomputes pace/burn. Polls every 60s while the tab is visible; the
 * shared useForegroundPoll runs its first fetch even when the tab mounts hidden
 * (guards the prior hidden-mount stuck-skeleton bug).
 *
 * Exclusive states (guide §6.6): connected / signed-out / rate-limited / error /
 * loading — one message only, never two at once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LimitRow,
  LimitsModel,
  LimitsState,
  LocalUsageHistory,
} from "../../query/limits/types";
import { fetchLimits, fetchStatuslineStatus } from "../api/client";
import type { MetricId } from "../lib/metric-copy";
import { useForegroundPoll } from "../lib/use-foreground-poll";
import InfoTip from "../shell/InfoTip";

type UiState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; model: LimitsModel };

const USAGE_SETTINGS_HREF = "#/settings?section=usage";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

/**
 * Dev-only exclusive-state override. `#/overview?fakeLimits=<state>` forces the
 * card into one exclusive state (guide §6.6) so the "one message per state"
 * guarantee is verifiable without waiting on the live usage API. Active ONLY when
 * the param is present — absent, the card renders exactly as in production. The
 * forced model is fully synthesized so each state renders offline and
 * deterministically (`connected` here carries no estimateVsActual — that needs
 * the real OAuth payload).
 */
const FAKE_LIMIT_STATES = new Set<LimitsState>([
  "connected",
  "signed-out",
  "rate-limited",
  "error",
  "loading",
]);

function readFakeLimits(): LimitsState | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("fakeLimits");
  return raw !== null && FAKE_LIMIT_STATES.has(raw as LimitsState) ? (raw as LimitsState) : null;
}

function fakeLimitsModel(state: Exclude<LimitsState, "loading">): LimitsModel {
  const asOf = new Date().toISOString();
  const live = { sessions: 0, runningSpendUsd: 0 };
  const localHistory: LocalUsageHistory = {
    basis: "cap-weighted",
    fiveHourTokens: 420_000,
    sevenDayTokens: 2_500_000,
    tokensPerDay: 510_000,
    weeklyLimitTokens: null,
    weeklyUtilizationPct: null,
    projectedExhaustionAt: null,
    forecastState: "OFF",
  };
  if (state === "signed-out") return { state, asOf, stale: false, rows: [], live, localHistory };
  if (state === "error") return { state, asOf, stale: true, rows: [], live, localHistory };
  const rows: LimitRow[] = [
    {
      id: "session",
      label: "Current session",
      windowHours: 5,
      usedPct: 33,
      resetsAt: asOf,
      hoursUntilReset: 3.5,
      elapsedHours: 1.5,
      pacePct: 30,
      burnRate: 22,
      budgetRate: 20,
      paceState: "ahead",
      projection: { kind: "hits-limit-in", hours: 6 },
    },
    {
      id: "weekly",
      label: "Weekly · all models",
      windowHours: 168,
      usedPct: 52,
      resetsAt: asOf,
      hoursUntilReset: 70,
      elapsedHours: 98,
      pacePct: 58,
      burnRate: 13,
      budgetRate: 14.29,
      paceState: "on",
      projection: { kind: "ends-at", pct: 89 },
    },
  ];
  if (state === "rate-limited") {
    return { state, asOf, stale: true, retryInSec: 240, rows, live, localHistory };
  }
  return { state: "connected", asOf, stale: false, rows, live, localHistory };
}

const SECTION_TIP =
  "Your plan's rolling caps, straight from claude.ai. The tick on each bar is where even spending would put you; the note beside it says whether you're ahead or behind and what happens at this rate.";

const STATUSLINE_SOURCE_TIP =
  "The last percentages Claude Code passed to your statusline. AgentWrangler doesn't use your Claude login to call claude.ai, so weekly per-model rows aren't available.";

const CLI_SOURCE_TIP =
  "AgentWrangler runs your `claude` CLI's `/usage` command in the background, at most every 5 minutes while this page is open. It never reads your Claude login.";

const CLI_NOTICE_DISMISSED_KEY = "aw.usageCliNoticeDismissed";
const POLL_MS = 180_000;
const POLL_PENDING_MS = 10_000;

const CLI_REASON_TEXT: Record<NonNullable<LimitsModel["cliReason"]>, string> = {
  not_found: "The `claude` command was not found, so usage could not be read from Claude Code.",
  outdated: "Your Claude Code version is too old to report usage with /usage. Update Claude Code.",
  timeout: "Claude Code took too long to answer /usage. It will try again later.",
  parse: "Claude Code's /usage output was not in a format AgentWrangler understands.",
  guard:
    "Reading usage was stopped because /usage did not behave as a free command. It stays off until Claude Code is updated.",
  error: "Claude Code could not report usage. It will try again later.",
  off: "Reading usage via Claude Code /usage is turned off in Settings.",
};

function readNoticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(CLI_NOTICE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeNoticeDismissed(): void {
  try {
    window.localStorage.setItem(CLI_NOTICE_DISMISSED_KEY, "1");
  } catch {
    // storage unavailable: the notice is hidden for this view only
  }
}

/** Default-on notice while the CLI reader is the source (operator 2026-10-20). */
function CliNotice() {
  const [dismissed, setDismissed] = useState(readNoticeDismissed);
  if (dismissed) return null;
  return (
    <div className="notice" data-testid="cli-source-notice">
      <span>
        Usage is read in the background through Claude Code&apos;s /usage command.{" "}
        <a href="#/settings?section=statusline">Switch to the statusline</a> (updates on every turn,
        no background calls), or <a href="#/settings?section=usage">turn it off in Settings</a>.
      </span>{" "}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          storeNoticeDismissed();
          setDismissed(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Source line under the meters (spec "UI"). Null when there is nothing to name. */
function SourceLine({ model }: { model: LimitsModel }) {
  if (model.rows.length === 0) return null;
  const cliRow = model.rows.find((r) => r.source === "cli" && r.asOf !== undefined);
  if (model.source === "statusline" && cliRow?.asOf !== undefined) {
    return (
      <div className="foot" data-testid="limits-source">
        Source: statusline · {fmtAgeMin(model.asOf)}; model rows: Claude Code /usage ·{" "}
        {fmtAgeMin(cliRow.asOf)}{" "}
        <InfoTip label="About the /usage source" content={CLI_SOURCE_TIP} />
      </div>
    );
  }
  if (model.source === "statusline") {
    return (
      <div className="foot" data-testid="limits-source">
        Source: your Claude Code statusline · {fmtAgeMin(model.asOf)}{" "}
        <InfoTip label="About the statusline source" content={STATUSLINE_SOURCE_TIP} />
      </div>
    );
  }
  if (model.source === "cli") {
    return (
      <div className="foot" data-testid="limits-source">
        Source: Claude Code /usage · {fmtAgeMin(model.asOf)}{" "}
        <InfoTip label="About the /usage source" content={CLI_SOURCE_TIP} />
      </div>
    );
  }
  return null;
}

/** "N min ago" for the statusline source line. */
function fmtAgeMin(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 1 ? "just now" : `${min} min ago`;
}

/** Round to at most one decimal, dropping a trailing .0 (e.g. 14.3, 20). */
function fmtRate(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** "2h 29m" from a fractional hour count. */
function fmtHm(hours: number): string {
  const totalMin = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

/** "45 min" / "2 h" / "3 d" for the statusline file's age. */
function fmtAgo(sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

/** "2d 22h" for weekly windows. */
function fmtDh(hours: number): string {
  const clamped = Math.max(0, hours);
  const d = Math.floor(clamped / 24);
  const h = Math.round(clamped % 24);
  return `${d}d ${h}h`;
}

/** "as of 14:02" for stale / rate-limited rows. */
export function asOfTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return Math.round(n).toLocaleString();
}

/**
 * The real cap blocks you at 100%, so a local estimate over twice the configured limit
 * means the stored limit is wrong (e.g. calibrated before history finished loading).
 */
const IMPLAUSIBLE_LIMIT_PCT = 200;

function LocalHistoryFallback({ history }: { history?: LocalUsageHistory }) {
  if (history === undefined) {
    return (
      <div className="local-usage-fallback" data-testid="local-usage-fallback">
        <div className="local-usage-title">
          <span className="chip chip-modeled">Local history unavailable</span>
          <span>Restart AgentWrangler to load the current modeled-usage data.</span>
        </div>
      </div>
    );
  }
  const projected =
    history.projectedExhaustionAt === null
      ? null
      : new Date(history.projectedExhaustionAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
  return (
    <div className="local-usage-fallback" data-testid="local-usage-fallback">
      <div className="local-usage-title">
        <span className="chip chip-modeled">Modeled local history</span>
        <span>Cap-weighted transcript aggregates; not exact claude.ai plan usage.</span>
      </div>
      <div className="local-usage-grid">
        <div>
          <small>Last 5 hours</small>
          <b className="num">{fmtTokens(history.fiveHourTokens)}</b>
        </div>
        <div>
          <small>Rolling 7 days</small>
          <b className="num">{fmtTokens(history.sevenDayTokens)}</b>
        </div>
        <div>
          <small>Burn rate</small>
          <b className="num">
            {history.tokensPerDay === null
              ? "Building baseline"
              : `${fmtTokens(history.tokensPerDay)}/day`}
          </b>
        </div>
      </div>
      {history.weeklyUtilizationPct === null ? (
        <div className="foot">
          <a href="#/settings?section=calibration">Calibrate a weekly limit</a> to enable local
          utilization and projection.
        </div>
      ) : history.weeklyUtilizationPct > IMPLAUSIBLE_LIMIT_PCT &&
        history.weeklyLimitTokens !== null ? (
        <div className="local-usage-forecast" data-testid="local-limit-implausible">
          <b className="warn-t">
            Configured weekly limit ({fmtTokens(history.weeklyLimitTokens)}) is far below this
            week's usage ({fmtTokens(history.sevenDayTokens)}), so it looks wrong
          </b>
          <span>
            <a href="#/settings?section=calibration">Re-calibrate</a> to fix utilization and
            projection.
          </span>
        </div>
      ) : (
        <div className="local-usage-forecast">
          <b>{Math.round(history.weeklyUtilizationPct)}% of configured weekly limit</b>
          {projected !== null && <span>Projected limit · {projected}</span>}
        </div>
      )}
    </div>
  );
}

function metricIdForRow(row: LimitRow): MetricId {
  if (row.id === "session") return "limit.session";
  if (row.id === "weekly") return "limit.weekly";
  return "limit.weekly.model";
}

function rateUnit(windowHours: number): string {
  return windowHours === 5 ? "%/hr" : "%/day";
}

function resetSmall(row: LimitRow): string {
  if (row.idle) {
    return row.windowHours === 5
      ? "5-hour window · no active window"
      : "7-day window · no active window";
  }
  if (row.windowHours === 5) return `5-hour window · resets in ${fmtHm(row.hoursUntilReset)}`;
  return `7-day window · resets in ${fmtDh(row.hoursUntilReset)}`;
}

function familyFromLabel(label: string): string {
  const idx = label.lastIndexOf("· ");
  return idx === -1 ? "" : ` ${label.slice(idx + 2).trim()}`;
}

type Severity = "ok" | "warn" | "bad";

/**
 * Row color: utilization thresholds (amber ≥80% used, rose ≥95%) whatever the
 * pace; pace state may escalate the color but never mute it.
 */
function rowSeverity(row: LimitRow): Severity {
  const util = row.usedPct >= 95 ? 2 : row.usedPct >= 80 ? 1 : 0;
  const pace = row.idle ? 0 : row.paceState === "over" ? 2 : row.paceState === "ahead" ? 1 : 0;
  const level = Math.max(util, pace);
  return level === 2 ? "bad" : level === 1 ? "warn" : "ok";
}

const SEVERITY_TEXT: Record<Severity, string | undefined> = {
  ok: undefined,
  warn: "warn-t",
  bad: "bad",
};
const SEVERITY_FILL: Record<Severity, string> = {
  ok: "fill",
  warn: "fill amber",
  bad: "fill rose",
};

/** Pace phrase, colored by the row severity. */
function PacePhrase({ row, severity }: { row: LimitRow; severity: Severity }) {
  const delta = Math.round(row.usedPct - row.pacePct);
  const burnTip = `Burning ${fmtRate(row.burnRate)}${rateUnit(row.windowHours)} on average since this window started, against ${fmtRate(
    row.budgetRate,
  )}${rateUnit(row.windowHours)} even-spend budget. Pace ${Math.round(row.pacePct)}% = where even spending would put you now.`;

  let text: string;
  if (delta < -20) text = "Well under pace";
  else if (row.paceState === "on") text = "On pace";
  else text = `▲ ${delta} pts ahead of pace`;

  return (
    <span className={SEVERITY_TEXT[severity]}>
      <b>{text}</b> <InfoTip label={`Burn rate for ${row.label}`} content={burnTip} />
    </span>
  );
}

function projectionLine(row: LimitRow): string {
  if (row.projection.kind === "hits-limit-in") {
    return `Limit in ${fmtHm(row.projection.hours)} at this rate`;
  }
  const window = row.windowHours === 5 ? "window" : "week";
  return `Ends ${window} at ~${Math.round(row.projection.pct)}% at this ${window}'s average rate`;
}

function MeterRow({ row, model, stale }: { row: LimitRow; model: LimitsModel; stale: boolean }) {
  const isSession = row.id === "session";
  const isWeeklyAll = row.id === "weekly";
  const isPerModel = row.id.startsWith("weekly:");
  const severity = rowSeverity(row);
  const eva = model.estimateVsActual;

  return (
    <div
      className="meter-row"
      data-testid={`limit-row-${row.id}`}
      data-severity={severity}
      style={stale ? { opacity: 0.6 } : undefined}
    >
      <div className="meter-head">
        <span className="meter-name" style={{ overflowWrap: "anywhere" }}>
          {row.label} <InfoTip label={`About ${row.label}`} metricId={metricIdForRow(row)} />
        </span>
        <b className={`meter-pct num ${SEVERITY_TEXT[severity] ?? ""}`}>
          {Math.round(row.usedPct)}%
        </b>
      </div>
      <div className="meter">
        <div
          className={stale ? "fill stale" : SEVERITY_FILL[severity]}
          data-testid={`limit-fill-${row.id}`}
          style={{ width: `${Math.min(100, Math.max(0, row.usedPct))}%` }}
        />
        {!row.idle && (
          <div className="pace" style={{ left: `${Math.min(100, Math.max(0, row.pacePct))}%` }} />
        )}
      </div>
      <div className="rate num">
        <span>
          {resetSmall(row)}
          {stale && ` · as of ${asOfTime(model.asOf)}`}
        </span>
        {row.idle ? (
          <span>Idle · starts with your next message</span>
        ) : (
          <span>
            <PacePhrase row={row} severity={severity} /> · {projectionLine(row)}
          </span>
        )}
        {isSession && (
          <span>
            <a href="#/sessions?live=1">{model.live.sessions} live</a> · $
            {model.live.runningSpendUsd.toFixed(2)}
          </span>
        )}
        {isWeeklyAll && eva !== undefined && (
          <span>
            Our estimate {Math.round(eva.modelPct)}%{" "}
            <span className={Math.abs(eva.deltaPts) >= 10 ? "bad" : undefined}>
              ({eva.deltaPts >= 0 ? "+" : ""}
              {Math.round(eva.deltaPts)})
            </span>{" "}
            · <a href="#/settings?section=calibration">Calibrate</a>
          </span>
        )}
        {isPerModel && row.headroomMultiple !== undefined && (
          <span>
            Room for <b>~{Math.round(row.headroomMultiple)}× more</b>
            {familyFromLabel(row.label)} this week
          </span>
        )}
      </div>
    </div>
  );
}

function Header({ model, fake }: { model: LimitsModel | null; fake: LimitsState | null }) {
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  let ago = "";
  if (model !== null) {
    const secs = Math.max(0, Math.round((nowTs - new Date(model.asOf).getTime()) / 1000));
    ago = secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  }

  // Name the source the rows actually come from, and its age (REL-FIX bug 4).
  const descParts: string[] = [];
  if (model?.plan) descParts.push(model.plan);
  const liveApi =
    model !== null &&
    model.state === "connected" &&
    model.source !== "statusline" &&
    model.source !== "cli";
  const staleApi = model !== null && model.state === "rate-limited" && model.rows.length > 0;
  if (model === null) descParts.push("exact usage currently unavailable");
  else if (model.source === "statusline")
    descParts.push(`from your Claude Code statusline · updated ${ago}`);
  else if (model.source === "cli" && model.state === "connected")
    descParts.push(`from Claude Code /usage · refreshed ${ago}`);
  else if (liveApi) descParts.push(`from claude.ai usage API · refreshed ${ago}`);
  else if (staleApi)
    descParts.push(`last claude.ai reading ${ago} · usage API rate-limited, not refreshing`);
  else descParts.push("exact usage currently unavailable · modeled from local history");

  return (
    <div className="sec-h" style={{ marginBottom: 6 }}>
      <div>
        <h2 id="usage-limits-title">
          Usage limits <InfoTip label="About usage limits" content={SECTION_TIP} />{" "}
          {liveApi && <span className="chip exact">Exact · claude.ai</span>}
          {staleApi && <span className="chip unv">Stale · claude.ai</span>}
          {fake !== null && (
            <span className="chip unv" data-testid="fake-limits-chip" style={{ marginLeft: 6 }}>
              DEV fake · {fake}
            </span>
          )}
        </h2>
        <div className="desc">
          {descParts.join(" · ")} · <a href={USAGE_SETTINGS_HREF}>Usage tracking settings</a>
        </div>
      </div>
      <div>
        <a className="btn-ghost" href={CLAUDE_USAGE_URL} rel="noreferrer noopener" target="_blank">
          Open claude.ai usage ↗
        </a>
      </div>
    </div>
  );
}

export default function UsageLimitsCard() {
  const [state, setState] = useState<UiState>({ status: "loading" });

  // While the first /usage reading is landing (`pending`), re-poll every 10 s, else every 3 min.
  const pending = state.status === "ok" && state.model?.pending === true;
  useForegroundPoll(
    fetchLimits,
    // 3 min, matching claude.ai's own usage page. The upstream usage endpoint
    // rate-limits aggressively; a faster cadence gets 429'd and stays stuck.
    pending ? POLL_PENDING_MS : POLL_MS,
    (model) => setState({ status: "ok", model }),
    (error) =>
      setState((prev) =>
        prev.status === "ok" ? prev : { status: "error", message: String(error) },
      ),
  );

  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchLimits()
      .then((model) => setState({ status: "ok", model }))
      .catch((error: unknown) => setState({ status: "error", message: String(error) }));
  }, []);

  // Guard against a malformed/empty payload (e.g. a mocked transport that resolves
  // undefined) so the hero degrades to its loading state instead of throwing.
  const liveModel = state.status === "ok" && state.model ? state.model : null;

  // Dev-only `?fakeLimits=` override (above). When active it replaces the model and
  // suppresses the real UiState branches, so exactly one exclusive state renders.
  const fake = readFakeLimits();
  const model = fake === null ? liveModel : fake === "loading" ? null : fakeLimitsModel(fake);
  const showLoading = fake === "loading" || (fake === null && state.status === "loading");
  const showFetchError = fake === null && state.status === "error";
  const showLocalFallback =
    model !== null &&
    (model.state === "signed-out" ||
      model.state === "error" ||
      (model.state === "rate-limited" && model.rows.length === 0));

  // OV-7b: when the usage API has failed and no statusline is feeding the card, point at the setup.
  const apiFailed =
    model !== null &&
    model.source !== "statusline" &&
    (model.state === "error" || model.state === "rate-limited");
  const [fallbackState, setFallbackState] = useState<string | null>(null);
  const [fallbackAgeSec, setFallbackAgeSec] = useState<number | null>(null);
  useEffect(() => {
    if (!apiFailed) return;
    let live = true;
    void Promise.resolve(fetchStatuslineStatus())
      .then((s) => {
        if (!live) return;
        setFallbackState(s?.state ?? null);
        setFallbackAgeSec(s?.ageSec ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiFailed]);
  const pendingNoRows = model !== null && model.pending === true && model.rows.length === 0;
  const showFallbackLink =
    apiFailed && !pendingNoRows && (fallbackState === "not-set-up" || fallbackState === "stale");
  const cliReason = model?.cliReason;
  // The error notice carries its own details; elsewhere show the CLI reason in a footer.
  const showCliDetails =
    model !== null &&
    model.state !== "error" &&
    cliReason !== undefined &&
    (cliReason !== "off" || model.rows.length === 0);
  const showCliNotice =
    model !== null && model.source === "cli" && model.rows.length > 0 && cliReason !== "off";

  return (
    <section
      className="card card-padded"
      aria-labelledby="usage-limits-title"
      data-testid="usage-limits-card"
    >
      <Header model={model} fake={fake} />
      {showLoading && (
        <div aria-busy="true" aria-label="Loading usage limits" style={{ minHeight: 220 }}>
          <div className="skeleton" style={{ height: 220, borderRadius: "var(--r-control)" }} />
        </div>
      )}

      {showFetchError && state.status === "error" && (
        <div className="notice" role="alert">
          <span>Usage limits could not be loaded — {state.message}</span>{" "}
          <button type="button" className="btn-secondary" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {model !== null && model.state === "signed-out" && (
        <div className="notice">
          Usage limits unavailable — <a href={USAGE_SETTINGS_HREF}>connect usage tracking</a>
        </div>
      )}

      {pendingNoRows && (
        <div className="notice" data-testid="limits-pending" aria-live="polite">
          Reading usage from Claude Code…
        </div>
      )}

      {model !== null && model.state === "error" && !pendingNoRows && (
        <div className="notice" role="alert">
          <span>No recent usage reading from your Claude Code statusline.</span>{" "}
          {(model.reason || cliReason !== undefined) && (
            <details>
              <summary>Show details</summary>
              {model.reason && <span style={{ color: "var(--muted)" }}>{model.reason}</span>}
              {cliReason !== undefined && (
                <span style={{ color: "var(--muted)" }} data-testid="cli-reason">
                  {" "}
                  {CLI_REASON_TEXT[cliReason]}
                </span>
              )}
            </details>
          )}
          <button type="button" className="btn-secondary" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {model !== null && model.state === "rate-limited" && (
        <div className="notice warn">
          claude.ai rate-limited the usage API; retrying in{" "}
          {Math.max(1, Math.round((model.retryInSec ?? 240) / 60))}m…
        </div>
      )}

      {showLocalFallback && model !== null && <LocalHistoryFallback history={model.localHistory} />}

      {model !== null &&
        (model.state === "connected" || model.state === "rate-limited") &&
        model.rows.length > 0 && (
          <div className="meter-grid">
            {model.rows.map((row) => (
              <MeterRow key={row.id} row={row} model={model} stale={model.stale} />
            ))}
          </div>
        )}

      {showFallbackLink && (
        <div className="foot" data-testid="statusline-fallback-link">
          <a href="#/settings?section=statusline">
            {fallbackState === "stale" && fallbackAgeSec !== null
              ? `Statusline last updated ${fmtAgo(fallbackAgeSec)} ago`
              : "Set up the statusline to see usage limits"}
          </a>
        </div>
      )}

      {model !== null && <SourceLine model={model} />}

      {showCliDetails && cliReason !== undefined && (
        <details className="foot">
          <summary>Show details</summary>
          <span style={{ color: "var(--muted)" }} data-testid="cli-reason">
            {CLI_REASON_TEXT[cliReason]}
          </span>
        </details>
      )}

      {showCliNotice && <CliNotice />}
    </section>
  );
}
