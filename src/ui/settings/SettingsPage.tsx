/**
 * src/ui/settings/SettingsPage.tsx — Settings surface (WP4).
 *
 * Sections:
 *   1. Config form — limit_tokens, scan_roots, activity_window_secs
 *   2. Workspace mappings — editable repo_path + repo_canonical per workspace
 *   3. Parser health — read-only counter panel
 *   4. DB-reset — type-to-confirm in-DOM modal (no native confirm/alert)
 *
 * Inline validation errors for all write paths (never silent no-op).
 * Loading skeleton and error banner consistent with OverviewPage.
 *
 * NOTE: The frozen Settings DTO has no `origin` field, so the planned
 * "auto-suggest dropdown from checkout origin" is degraded to a plain
 * editable repo_path field. Inline validation errors still work.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthStatus } from "../../oauth/credentials";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { AgentsLivenessResult, LiveAgent } from "../../query/api/agents-liveness";
import type { HookConfig, HookConfigResponse } from "../../query/api/hook-config";
import type { IdleSession } from "../../query/api/idle-sessions";
import type { Report } from "../../query/api/reports";
import type { Settings, WorkspaceMapping } from "../../query/api/settings";
import type { ApiResponse } from "../../query/envelope";
import {
  calibrateBytesPerTokenApi,
  calibrateLimitApi,
  endSessionPid,
  fetchAgentsLiveness,
  fetchGithubTokenStatus,
  fetchHookConfig,
  fetchIdleSessions,
  fetchOAuthStatus,
  fetchSettings,
  getReports,
  installHook,
  resetDatabase,
  saveHookConfig,
  saveSettings,
  uninstallHook,
} from "../api/client";
import { setExperimentalActions, useExperimentalActions } from "../hooks/useExperimentalActions";
import { formatAbsolute, relativeTime } from "../lib/relative-time";
import Chip, { type ChipProps } from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import AnchorsPanel from "./AnchorsPanel";
import { buildHookInstallPrompt, buildHookUninstallPrompt } from "./install-prompt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T };

/** Extract the file basename from any path (browser-safe, no node:path). */
function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
}

// ---------------------------------------------------------------------------
// Config form section
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  settings: Settings;
  onSaved: (updated: Settings) => void;
}

function ConfigForm({ settings, onSaved }: ConfigFormProps) {
  const [limitRaw, setLimitRaw] = useState(
    settings.limit_tokens !== null ? String(settings.limit_tokens) : "",
  );
  const [scanRoots, setScanRoots] = useState(settings.scan_roots.join("\n"));
  const [windowSecs, setWindowSecs] = useState(String(settings.activity_window_secs));
  const [saving, setSaving] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [provenance, setProvenance] = useState<string | null>(settings.limit_provenance);
  const [limitConfidence, setLimitConfidence] = useState<"low" | null>(
    settings.limit_provenance?.includes("LOW CONFIDENCE") ? "low" : null,
  );
  // Track whether the user manually edited the limit field this session.
  // Only set to true on direct user input — not when calibrate updates limitRaw
  // programmatically. When false, we omit limit_tokens from the Save payload so a
  // calibrated limit + its provenance/resets_at are preserved (Bug-1 fix).
  const [limitDirty, setLimitDirty] = useState(false);

  // Re-calibrate hint: show when a stored resets_at has passed
  const resetsAt = settings.limit_resets_at;
  const showRecalibrateHint =
    provenance?.startsWith("calibrated") === true &&
    resetsAt !== null &&
    Date.now() > new Date(resetsAt).getTime();

  async function handleCalibrate() {
    setError(null);
    setCalibrating(true);
    try {
      const res = await calibrateLimitApi();
      if (res.data === null) {
        setError("Calibration returned no data — try again.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.reason);
        return;
      }
      // Success: update the limit field and provenance
      setLimitRaw(String(res.data.limit_tokens));
      setProvenance(res.data.provenance);
      setLimitConfidence(res.data.confidence ?? null);
      // Refresh parent settings so limit_resets_at and provenance reflect the
      // persisted calibration (Bug-2 fix — calibrate was leaving parent stale).
      const fresh = await fetchSettings();
      if (fresh.data !== null) {
        onSaved(fresh.data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCalibrating(false);
    }
  }

  async function handleSave() {
    setSaved(false);
    const roots = scanRoots
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Coerce + validate numbers loudly rather than letting NaN/Infinity slip
    // through (NaN serializes to JSON null and would silently clear the limit).
    const limitTrimmed = limitRaw.trim();
    let limit: number | null;
    if (limitTrimmed === "") {
      limit = null;
    } else {
      const parsed = Number(limitTrimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Weekly token limit must be a non-negative number.");
        return;
      }
      limit = parsed;
    }

    const windowNum = Number(windowSecs.trim());
    if (!Number.isFinite(windowNum) || windowNum < 1) {
      setError("Activity window must be a whole number of seconds (>= 1).");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      // Only include limit_tokens when the user actually edited the manual-override
      // field this session. If untouched (e.g. limit was set by Calibrate), omit
      // the key so the backend leaves calibrated provenance + resets_at intact.
      const res = await saveSettings({
        ...(limitDirty ? { limit_tokens: limit } : {}),
        scan_roots: roots,
        activity_window_secs: windowNum,
      });
      if (res.data !== null) {
        onSaved(res.data);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 15 }}>Configuration</h2>
      <p className="settings-hint">
        Estimates your weekly usage cap from recent activity so burn forecasts have a real ceiling
        to project against.
      </p>
      <div className="settings-field">
        {/* Primary: calibrate from live oauth/usage — the common path */}
        <button
          type="button"
          className="settings-calibrate-primary-btn"
          onClick={handleCalibrate}
          disabled={calibrating}
          title="Derive the weekly token limit from your current oauth/usage utilization"
        >
          {calibrating
            ? "Calibrating…"
            : provenance?.startsWith("calibrated")
              ? "Re-calibrate from usage"
              : "Calibrate from usage"}
        </button>
        <p className="settings-calibrate-desc">
          Derives your weekly limit from Claude Code utilization — auto-saves on success. No manual
          entry needed in the common case.
        </p>

        {/* Calibration result: shown after a successful calibrate */}
        {provenance?.startsWith("calibrated") && limitRaw !== "" && (
          <div className="settings-calibrate-result" aria-label="Calibration result">
            {Number(limitRaw).toLocaleString()} tokens/wk &middot; {provenance}
            {(limitConfidence === "low" || provenance.includes("LOW CONFIDENCE")) && (
              <>
                <span
                  className="chip bfc-chip-low-confidence"
                  // biome-ignore lint/a11y/useSemanticElements: chip badge uses role="status"; <output> semantics differ
                  role="status"
                  aria-label="LOW CONFIDENCE"
                >
                  LOW CONFIDENCE
                </span>
                <InfoTip
                  label="What LOW CONFIDENCE means"
                  content="This limit was calibrated from under 10% usage, so the projected cap is a rough guess. Re-calibrate after you've used ~10% of a window for a stable number."
                />
              </>
            )}
          </div>
        )}

        {showRecalibrateHint && (
          <output
            className="settings-hint"
            style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--amber, #f59e0b)" }}
          >
            A new weekly window has started — consider re-calibrating.
          </output>
        )}

        {/* Advanced: manual override — de-emphasised below the primary action */}
        <div className="settings-advanced-override">
          <label className="settings-label" htmlFor="limit-tokens">
            Weekly token limit
            <span className="settings-hint"> (blank = forecast OFF)</span>
          </label>
          <span className="settings-hint" style={{ marginBottom: 4, fontSize: 11 }}>
            Advanced: manual override — use if Calibrate is unavailable or you need a specific
            value.
          </span>
          <input
            id="limit-tokens"
            className="settings-input"
            type="number"
            min={0}
            value={limitRaw}
            onChange={(e) => {
              setLimitRaw(e.target.value);
              setLimitDirty(true);
              // Manual edit clears calibrated provenance label
              if (provenance?.startsWith("calibrated")) {
                setProvenance("manual");
              }
            }}
            placeholder="e.g. 10000000000"
          />
          {provenance === "manual" && (
            <div
              className="settings-hint"
              style={{ marginTop: 4, fontSize: 11 }}
              aria-label="Limit provenance"
            >
              manual override
            </div>
          )}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="scan-roots">
          Scan roots
          <span className="settings-hint"> (one absolute path per line)</span>
        </label>
        <textarea
          id="scan-roots"
          className="settings-textarea"
          rows={3}
          value={scanRoots}
          onChange={(e) => setScanRoots(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="activity-window">
          Activity window (seconds)
        </label>
        <input
          id="activity-window"
          className="settings-input"
          type="number"
          min={1}
          value={windowSecs}
          onChange={(e) => setWindowSecs(e.target.value)}
        />
      </div>
      {error !== null && (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      )}
      <button type="button" className="settings-save-btn" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : saved ? "Saved" : "Save config"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bytes-per-token calibration section (R12)
// ---------------------------------------------------------------------------

interface BytesCalibrationSectionProps {
  settings: Settings;
  onSaved: (updated: Settings) => void;
}

function BytesCalibrationSection({ settings, onSaved }: BytesCalibrationSectionProps) {
  const [toggling, setToggling] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<string | null>(settings.bytes_per_token_provenance);
  const [ratio, setRatio] = useState<number | null>(settings.bytes_per_token);
  const enabled = settings.bytes_per_token_calibration_enabled;

  async function handleToggle(checked: boolean) {
    setError(null);
    setToggling(true);
    try {
      const res = await saveSettings({ bytes_per_token_calibration_enabled: checked });
      if (res.data !== null) onSaved(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }

  async function handleRecalibrate() {
    setError(null);
    setCalibrating(true);
    try {
      const res = await calibrateBytesPerTokenApi();
      if (res.data === null) {
        setError("Calibration returned no data — try again.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.reason);
        return;
      }
      setRatio(res.data.ratio);
      setProvenance(res.data.provenance);
      const fresh = await fetchSettings();
      if (fresh.data !== null) onSaved(fresh.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCalibrating(false);
    }
  }

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Bytes→token calibration</h2>
      <p className="settings-hint" style={{ marginBottom: 10 }}>
        Sends ~150 sampled tool-output snippets to Anthropic&rsquo;s free token-counter to calibrate
        cost estimates. The same text your Claude Code session already sent when it ran. Nothing is
        stored — only the resulting ratio. Off by default.
      </p>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={toggling}
          onChange={(e) => {
            void handleToggle(e.target.checked);
          }}
        />
        <span>Enable opt-in calibration</span>
      </label>
      {enabled && (
        <>
          <button
            type="button"
            className="settings-calibrate-primary-btn"
            onClick={() => {
              void handleRecalibrate();
            }}
            disabled={calibrating}
            title="Sample tool-result output and count tokens via Anthropic count_tokens API"
          >
            {calibrating ? "Calibrating…" : provenance !== null ? "Recalibrate" : "Calibrate now"}
          </button>
          {ratio !== null && provenance !== null && (
            <div
              className="settings-calibrate-result"
              aria-label="Bytes-per-token calibration result"
              style={{ marginTop: 8 }}
            >
              {ratio.toFixed(4)} bytes/token &middot; {provenance}
            </div>
          )}
        </>
      )}
      {error !== null && (
        <div className="settings-inline-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace mappings section
// ---------------------------------------------------------------------------

interface WorkspaceMappingsProps {
  mappings: WorkspaceMapping[];
  onSaved: (updated: Settings) => void;
}

function WorkspaceMappings({ mappings, onSaved }: WorkspaceMappingsProps) {
  const [rows, setRows] = useState<WorkspaceMapping[]>(mappings);
  const [showTransient, setShowTransient] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync local rows only when the SET of workspaces changes (e.g. a DB reset
  // empties them, or a workspace is added/removed). Keying on the workspace_ids
  // rather than the array reference means a value-equal refresh after saving a
  // different section does not clobber unsaved edits in this table.
  const prevIdsKey = useRef<string | null>(null);
  const workspaceIdsKey = mappings
    .map((m) => m.workspace_id)
    .sort()
    .join(" ");
  useEffect(() => {
    if (workspaceIdsKey !== prevIdsKey.current) {
      prevIdsKey.current = workspaceIdsKey;
      setRows(mappings);
    }
  }, [workspaceIdsKey, mappings]);

  function update(idx: number, field: "repo_path" | "repo_canonical", value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value || null } : r)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveSettings({
        workspace_mappings: rows.map((r) => ({
          workspace_id: r.workspace_id,
          repo_path: r.repo_path,
          repo_canonical: r.repo_canonical,
        })),
      });
      if (res.data !== null) {
        onSaved(res.data);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 15 }}>Workspace Mappings</h2>
      <p className="settings-hint">
        Maps each session's working directory to a named workspace so spend rolls up per project.
      </p>
      <label>
        <input
          type="checkbox"
          checked={showTransient}
          onChange={(e) => setShowTransient(e.target.checked)}
        />{" "}
        Show transient workspaces
      </label>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Repo path</th>
              <th>Canonical (owner/repo)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) =>
              row.is_transient && !showTransient ? null : (
                <tr key={row.workspace_id}>
                  <td style={{ color: "var(--soft)" }}>
                    {row.project_slug}
                    {row.is_transient && " (transient)"}
                  </td>
                  <td>
                    <input
                      aria-label={`Repo path for ${row.project_slug}`}
                      className="settings-table-input"
                      value={row.repo_path ?? ""}
                      onChange={(e) => update(i, "repo_path", e.target.value)}
                      placeholder="/absolute/path/to/repo"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Canonical for ${row.project_slug}`}
                      className="settings-table-input"
                      value={row.repo_canonical ?? ""}
                      onChange={(e) => update(i, "repo_canonical", e.target.value)}
                      placeholder="owner/repo"
                    />
                    {row.repo_canonical === null && row.mapping_reason !== undefined && (
                      <div
                        className="settings-hint"
                        style={{ marginTop: 4, fontSize: 12 }}
                        role="note"
                      >
                        {row.mapping_reason}
                      </div>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {error !== null && (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="settings-save-btn"
        style={{ marginTop: 12 }}
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save mappings"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parser health section
// ---------------------------------------------------------------------------

function ParserHealthPanel({ health }: { health: Settings["parser_health"] }) {
  const quarantineRate = health.files_seen === 0 ? 0 : health.lines_quarantined / health.files_seen;
  const parserHealthStatus: Pick<ChipProps, "kind" | "label"> =
    quarantineRate < 0.01
      ? { kind: "EXACT", label: "Healthy" }
      : quarantineRate <= 0.05
        ? { kind: "LIST_EQUIV_STALE", label: "Warning" }
        : { kind: "PROXY", label: "Errors" };
  const entries: [string, string, number | Record<string, number>][] = [
    ["Files seen", "Files the daemon found while scanning.", health.files_seen],
    ["Files parsed", "Files successfully read into aggregate metrics.", health.files_parsed],
    [
      "Lines quarantined",
      "Lines skipped after a parse problem; raw content is not retained here.",
      health.lines_quarantined,
    ],
    [
      "Synthetic excluded",
      "Generated fixture data excluded from the health count.",
      health.synthetic_excluded,
    ],
    [
      "Duplicate drops",
      "Repeated observations ignored to keep aggregates accurate.",
      health.duplicate_drops,
    ],
  ];

  const versionMix = health.parser_version_mix;
  const versionEntries = Object.entries(versionMix);

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 15 }}>
        Parser Health <Chip {...parserHealthStatus} />
      </h2>
      <div className="settings-health-grid">
        {entries.map(([label, caption, value]) => (
          <div key={label} className="settings-health-row">
            <span className="settings-health-label" title={caption}>
              {label}
            </span>
            <span className="settings-health-value">{String(value)}</span>
            <span className="section-meta">{caption}</span>
          </div>
        ))}
        {versionEntries.length > 0 && (
          <div className="settings-health-row">
            <span className="settings-health-label">Parser coverage</span>
            <span
              className="settings-health-value"
              title={`Parser versions: ${versionEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}`}
            >
              {versionEntries.reduce((total, [, count]) => total + count, 0).toLocaleString()}{" "}
              parsed files
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ParseFailuresPanel({ rows }: { rows: Settings["quarantine_rows"] }) {
  if (rows.length === 0) return null;

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Parse Failures</h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 12px" }}>
        Latest 100 first-quarantined pointers
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "monospace", fontSize: 12 }}>
        {rows.map((row) => (
          <li key={`${row.file_path}:${row.line_no}:${row.seen_at}`}>
            {row.file_path}:{row.line_no} · {row.error_class} · {row.seen_at}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WeeklyReportsPanel({ reports }: { reports: Report[] }) {
  if (reports.length === 0) return null;

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 15 }}>Weekly Reports</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Period start</th>
              <th>Period end</th>
              <th>Generated at</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.report_id}>
                <td title={formatAbsolute(report.period_start)}>
                  {relativeTime(report.period_start)}
                </td>
                <td title={formatAbsolute(report.period_end)}>{relativeTime(report.period_end)}</td>
                <td title={formatAbsolute(report.generated_at)}>
                  {relativeTime(report.generated_at)}
                </td>
                <td>
                  <a
                    download={`${report.report_id}.json`}
                    href={`data:application/json;charset=utf-8,${encodeURIComponent(report.content_json)}`}
                  >
                    Download JSON
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth status panel
// ---------------------------------------------------------------------------

function OAuthStatusPanel() {
  const [status, setStatus] = useState<OAuthStatus | null>(null);

  useEffect(() => {
    void Promise.resolve(fetchOAuthStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => setStatus(null));
  }, []);

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Usage reader</h2>
      {status === null && <p style={{ color: "var(--muted)", margin: 0 }}>Loading…</p>}
      {status?.authenticated && (
        <p style={{ margin: 0 }} aria-label="oauth reader status">
          usage reader: authenticated as <strong>{status.tier ?? "unknown tier"}</strong>
        </p>
      )}
      {status !== null && !status.authenticated && (
        <p style={{ margin: 0, color: "var(--amber, #f59e0b)" }} aria-label="oauth reader status">
          not signed in — {status.reason ?? "re-login to Claude Code"}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub token status panel (outcomes sync) — mirrors the usage-reader pattern
// ---------------------------------------------------------------------------

function GithubTokenStatusPanel() {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null);

  useEffect(() => {
    void Promise.resolve(fetchGithubTokenStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => setStatus(null));
  }, []);

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Outcomes sync</h2>
      <p className="settings-hint">
        Cross-checks sessions against your git history to tell finished work from abandoned, feeding
        the Success metric.
      </p>
      {status === null && <p style={{ color: "var(--muted)", margin: 0 }}>Loading…</p>}
      {status?.configured && (
        <p style={{ margin: 0 }} aria-label="github token status">
          GitHub token: configured <strong>({status.source})</strong>
        </p>
      )}
      {status !== null && !status.configured && (
        <p style={{ margin: 0, color: "var(--amber, #f59e0b)" }} aria-label="github token status">
          {status.reason ?? "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN"}
        </p>
      )}
    </section>
  );
}

function ContextBudgetHookPanel() {
  const [config, setConfig] = useState<HookConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"install" | "uninstall" | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  useEffect(() => {
    void Promise.resolve(fetchHookConfig())
      .then((response) => {
        if (response?.data != null) setConfig(response.data);
      })
      .catch(() => {});
  }, []);

  const installed = config?.installed ?? false;

  async function handleCopy(text: string, kind: "install" | "uninstall") {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(kind);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setError("Copy failed — your browser may not support clipboard access.");
    }
  }

  async function changeInstall(nextInstalled: boolean) {
    setBusy(true);
    setError(null);
    setInstallMsg(null);
    try {
      const result = await (nextInstalled ? installHook() : uninstallHook());
      if (config !== null) setConfig({ ...config, installed: nextInstalled });
      const verb = nextInstalled ? "Installed" : "Uninstalled";
      setInstallMsg(
        result.changed
          ? `${verb} — wrote ${result.settingsPath}`
          : nextInstalled
            ? `Already installed — no change to ${result.settingsPath}`
            : `Not installed — no change to ${result.settingsPath}`,
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveThreshold(name: keyof HookConfig, value: string) {
    if (config === null) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    try {
      const response = await saveHookConfig({ [name]: parsed });
      if (response.data !== null) setConfig({ ...response.data, installed: config.installed });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // soft_pct / hard_pct are stored as fractions but shown/edited as whole percents.
  async function savePercent(name: "soft_pct" | "hard_pct", percentValue: string) {
    const percent = Number(percentValue);
    if (!Number.isFinite(percent)) return;
    await saveThreshold(name, String(percent / 100));
  }

  const fmtTokens = (n: number) => Math.round(n).toLocaleString("en-US");
  const asPercent = (fraction: number) => Math.round(fraction * 100);

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <div className="fb5-panel-header">
        <h2 style={{ margin: 0, fontSize: 15 }}>In-session guards</h2>
        {config !== null && (
          <span
            className={`fb5-status-pill ${installed ? "fb5-status-installed" : "fb5-status-not-installed"}`}
            aria-label={installed ? "Installed" : "Not installed"}
          >
            {installed ? "● Installed" : "Not installed"}
          </span>
        )}
      </div>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 14px" }}>
        Three small hooks inside Claude Code that warn you before waste happens — they only warn and
        never block a tool call.
      </p>
      {config !== null && (
        <>
          <div className="fb5-guard-cards">
            <div className="fb5-guard-card">
              <div className="fb5-guard-card-title">Context budget</div>
              <div className="fb5-guard-inputs">
                <label className="fb5-guard-label">
                  Context window
                  <input
                    aria-label="Context window (tokens)"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1000"
                    step="1000"
                    value={config.context_window}
                    onChange={(e) => void saveThreshold("context_window", e.target.value)}
                  />
                  tokens
                </label>
                <label className="fb5-guard-label">
                  Warn at
                  <input
                    aria-label="Soft threshold percent"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1"
                    max="99"
                    value={asPercent(config.soft_pct)}
                    onChange={(e) => void savePercent("soft_pct", e.target.value)}
                  />
                  % of the window (≈ {fmtTokens(config.soft_pct * config.context_window)} tokens)
                </label>
                <label className="fb5-guard-label">
                  Urgent at
                  <input
                    aria-label="Hard threshold percent"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1"
                    max="100"
                    value={asPercent(config.hard_pct)}
                    onChange={(e) => void savePercent("hard_pct", e.target.value)}
                  />
                  % of the window (≈ {fmtTokens(config.hard_pct * config.context_window)} tokens)
                </label>
              </div>
              <p className="fb5-field-hint" style={{ marginTop: 8 }}>
                Set the window to 1,000,000 if you run 1M-context models. Both thresholds only warn
                — a session already past the window is measured against its real size.
              </p>
            </div>
            <div className="fb5-guard-card">
              <div className="fb5-guard-card-title">Loop guard</div>
              <div className="fb5-guard-inputs">
                <label className="fb5-guard-label">
                  After
                  <input
                    aria-label="Identical-failure count"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1"
                    step="1"
                    value={config.d7_fail_count}
                    onChange={(e) => void saveThreshold("d7_fail_count", e.target.value)}
                  />
                  identical failures within
                  <input
                    aria-label="Loop window (turns)"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1"
                    step="1"
                    value={config.d7_window_turns}
                    onChange={(e) => void saveThreshold("d7_window_turns", e.target.value)}
                  />
                  turns
                </label>
              </div>
            </div>
            <div className="fb5-guard-card">
              <div className="fb5-guard-card-title">Burn alert</div>
              <div className="fb5-guard-inputs">
                <label className="fb5-guard-label">
                  Send 5h/weekly pace and 15%/50% checkpoint alerts after the session has been idle
                  for this many seconds
                  <input
                    aria-label="Idle cutoff (seconds)"
                    className="settings-input fb5-guard-input"
                    type="number"
                    min="1"
                    step="1"
                    value={config.d9_idle_seconds}
                    onChange={(e) => void saveThreshold("d9_idle_seconds", e.target.value)}
                  />
                  s
                </label>
              </div>
            </div>
          </div>
          <p className="fb5-field-hint">
            fields: context_window, soft_pct, hard_pct, d7_fail_count, d7_window_turns,
            d9_idle_seconds
          </p>
        </>
      )}
      {error !== null && (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      )}
      {installMsg !== null && (
        <output className="fb5-field-hint" aria-label="install status" style={{ display: "block" }}>
          {installMsg}
        </output>
      )}
      <div className="fb5-actions">
        <div className="fb5-action-group">
          <button
            type="button"
            className="settings-save-btn"
            onClick={() =>
              config !== null && void handleCopy(buildHookInstallPrompt(config), "install")
            }
            disabled={config === null}
          >
            {copyFeedback === "install" ? "Copied!" : "Copy install prompt"}
          </button>
          <button
            type="button"
            className="fb5-secondary-btn"
            onClick={() => void changeInstall(true)}
            disabled={busy || config === null}
          >
            {busy ? "Installing…" : "Install directly — writes ~/.claude/settings.json for you"}
          </button>
        </div>
        <div className="fb5-action-group">
          <button
            type="button"
            className="settings-cancel-btn"
            onClick={() => void handleCopy(buildHookUninstallPrompt(), "uninstall")}
          >
            {copyFeedback === "uninstall" ? "Copied!" : "Copy uninstall prompt"}
          </button>
          <button
            type="button"
            className="fb5-secondary-btn"
            onClick={() => void changeInstall(false)}
            disabled={busy}
          >
            {busy ? "Uninstalling…" : "Uninstall directly"}
          </button>
        </div>
      </div>
      <p className="fb5-takes-effect">Takes effect immediately, no restart.</p>
    </section>
  );
}

function IdleSessionsPanel() {
  const [transcriptIdle, setTranscriptIdle] = useState<IdleSession[]>([]);
  const [liveness, setLiveness] = useState<AgentsLivenessResult | null>(null);
  const [confirmSingle, setConfirmSingle] = useState<LiveAgent | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<LiveAgent[] | null>(null);
  const [endingPids, setEndingPids] = useState<Set<number>>(new Set());
  const [endedSessions, setEndedSessions] = useState<Set<string>>(new Set());
  const [endError, setEndError] = useState<string | null>(null);
  const [copiedAgents, setCopiedAgents] = useState(false);

  useEffect(() => {
    void Promise.resolve(fetchIdleSessions())
      .then((response) => setTranscriptIdle(response?.data ?? []))
      .catch(() => setTranscriptIdle([]));
    void Promise.resolve(fetchAgentsLiveness())
      .then((response) => setLiveness(response?.data ?? null))
      .catch(() => setLiveness(null));
  }, []);

  const transcriptIdleIds = new Set(transcriptIdle.map((s) => s.session_id));
  const liveAgentIds = new Set((liveness?.agents ?? []).map((a) => a.session_id));

  // Intersection: live agents that are also transcript-idle, minus already-ended
  const intersectionRows: LiveAgent[] =
    liveness?.available === true
      ? (liveness.agents ?? []).filter(
          (a) => transcriptIdleIds.has(a.session_id) && !endedSessions.has(a.session_id),
        )
      : [];

  // Non-live count: transcript-idle sessions not present in live list + locally ended
  const nonLiveCount =
    liveness?.available === true
      ? transcriptIdle.filter((s) => !liveAgentIds.has(s.session_id)).length + endedSessions.size
      : 0;

  const interactivePidRows = intersectionRows.filter((a) => a.pid !== null);

  async function handleEnd(agent: LiveAgent) {
    if (agent.pid === null) return;
    const pid = agent.pid;
    setEndingPids((prev) => new Set(prev).add(pid));
    setEndError(null);
    try {
      await endSessionPid(pid);
      setEndedSessions((prev) => new Set(prev).add(agent.session_id));
    } catch (e: unknown) {
      setEndError(e instanceof Error ? e.message : String(e));
    } finally {
      setEndingPids((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  }

  async function handleBulkEnd(agents: LiveAgent[]) {
    setEndError(null);
    for (const agent of agents) {
      await handleEnd(agent);
    }
  }

  async function handleCopyAgents() {
    try {
      await navigator.clipboard.writeText("claude agents");
      setCopiedAgents(true);
      setTimeout(() => setCopiedAgents(false), 2000);
    } catch {
      /* ignore clipboard failure for CTA copy */
    }
  }

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Idle background sessions</h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 12px" }}>
        Idle sessions cost nothing while idle; resuming after the prompt cache expires re-writes the
        whole context at full price, and live background sessions can wake and spend.
      </p>

      {/* CLI unavailable: banner + transcript-only fallback (no End actions) */}
      {liveness !== null && !liveness.available && (
        <output className="banner banner-warning" style={{ marginBottom: 12 }}>
          {liveness.reason ?? "liveness unknown"}
        </output>
      )}
      {(liveness === null || !liveness.available) && transcriptIdle.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "monospace", fontSize: 12 }}>
          {transcriptIdle.map((session) => (
            <li key={session.session_id}>
              <a href={`#/sessions/${session.session_id}`}>{session.session_id}</a> ·{" "}
              {Math.floor(session.idle_seconds / 60)} idle min ·{" "}
              {session.cap_weighted_tokens.toLocaleString()} cap-weighted tokens
            </li>
          ))}
        </ul>
      )}
      {(liveness === null || !liveness.available) && transcriptIdle.length === 0 && (
        <p style={{ color: "var(--muted)", margin: 0 }}>No idle background sessions found.</p>
      )}

      {/* Liveness available: intersection view */}
      {liveness?.available === true && (
        <>
          {intersectionRows.length > 0 ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Workspace</th>
                      <th>Kind</th>
                      <th>Status</th>
                      <th>Idle min</th>
                      <th>Cap-ctx held</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {intersectionRows.map((agent) => (
                      <tr key={agent.session_id}>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                          <a href={`#/sessions/${agent.session_id}`}>{agent.session_id}</a>
                        </td>
                        <td style={{ color: "var(--soft)", fontSize: 12 }}>
                          {agent.workspace_id ?? basename(agent.cwd) ?? "—"}
                        </td>
                        <td style={{ fontSize: 12 }}>{agent.kind}</td>
                        <td style={{ fontSize: 12 }}>{agent.status}</td>
                        <td style={{ fontSize: 12 }}>{Math.floor(agent.idle_seconds / 60)}</td>
                        <td style={{ fontSize: 12 }}>
                          {agent.cap_weighted_context_held.toLocaleString()}
                        </td>
                        <td>
                          {agent.pid !== null ? (
                            <button
                              type="button"
                              className="fb6-end-btn"
                              disabled={endingPids.has(agent.pid)}
                              onClick={() => setConfirmSingle(agent)}
                            >
                              {endingPids.has(agent.pid) ? "Ending…" : "End session"}
                            </button>
                          ) : (
                            <span className="fb6-bg-cta">
                              Manage in terminal: <code className="fb6-code">claude agents</code>
                              <button
                                type="button"
                                className="fb6-copy-btn"
                                onClick={() => void handleCopyAgents()}
                              >
                                {copiedAgents ? "Copied" : "Copy"}
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {interactivePidRows.length > 0 && (
                <button
                  type="button"
                  className="fb6-bulk-end-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => setConfirmBulk(interactivePidRows)}
                >
                  End all idle interactive sessions
                </button>
              )}
            </>
          ) : (
            <p style={{ color: "var(--muted)", margin: 0 }}>No live idle sessions found.</p>
          )}
          {nonLiveCount > 0 && (
            <p className="fb6-ended-line">
              {nonLiveCount} past {nonLiveCount === 1 ? "session" : "sessions"} ended — closed
              sessions cost nothing.
            </p>
          )}
        </>
      )}

      {endError !== null && (
        <div className="settings-inline-error" role="alert" style={{ marginTop: 8 }}>
          {endError}
        </div>
      )}

      {/* Single end confirm dialog */}
      {confirmSingle !== null && (
        <div className="settings-modal-backdrop">
          <dialog open aria-labelledby="end-session-title" className="settings-modal">
            <h3 id="end-session-title" style={{ margin: "0 0 10px" }}>
              End session?
            </h3>
            <p style={{ color: "var(--soft)", fontSize: 13, margin: "0 0 8px" }}>
              <strong>Session:</strong> {confirmSingle.name || confirmSingle.session_id}
            </p>
            <p style={{ color: "var(--soft)", fontSize: 13, margin: "0 0 8px" }}>
              <strong>PID:</strong> {confirmSingle.pid}
            </p>
            <p style={{ color: "var(--soft)", fontSize: 13, margin: "0 0 14px" }}>
              <strong>Working dir:</strong>{" "}
              <code style={{ fontFamily: "monospace" }}>{confirmSingle.cwd}</code>
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="settings-cancel-btn"
                onClick={() => setConfirmSingle(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-reset-confirm-btn"
                onClick={() => {
                  if (confirmSingle === null) return;
                  const agent = confirmSingle;
                  setConfirmSingle(null);
                  void handleEnd(agent);
                }}
              >
                Confirm End
              </button>
            </div>
          </dialog>
        </div>
      )}

      {/* Bulk end confirm dialog */}
      {confirmBulk !== null && (
        <div className="settings-modal-backdrop">
          <dialog open aria-labelledby="bulk-end-title" className="settings-modal">
            <h3 id="bulk-end-title" style={{ margin: "0 0 10px" }}>
              End all idle interactive sessions?
            </h3>
            <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13 }}>
              {confirmBulk.map((a) => (
                <li key={a.session_id} style={{ color: "var(--soft)", marginBottom: 4 }}>
                  PID {a.pid} — <code style={{ fontFamily: "monospace" }}>{a.cwd}</code>
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="settings-cancel-btn"
                onClick={() => setConfirmBulk(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-reset-confirm-btn"
                onClick={() => {
                  if (confirmBulk === null) return;
                  const agents = confirmBulk;
                  setConfirmBulk(null);
                  void handleBulkEnd(agents);
                }}
              >
                Confirm End All
              </button>
            </div>
          </dialog>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// DB-reset section
// ---------------------------------------------------------------------------

interface DbResetProps {
  dbPath: string;
  onReset: (updated: Settings) => void;
}

function DbReset({ dbPath, onReset }: DbResetProps) {
  const [showModal, setShowModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const dbName = basename(dbPath);
  const confirmed = confirmText === dbName;

  function openModal() {
    setConfirmText("");
    setError(null);
    setShowModal(true);
    // Focus the input after render
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function closeModal() {
    setShowModal(false);
    setConfirmText("");
    setError(null);
  }

  async function handleReset() {
    if (!confirmed) return;
    setResetting(true);
    setError(null);
    try {
      const res = await resetDatabase();
      if (res.data !== null) {
        onReset(res.data);
        setShowModal(false);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--red)" }}>Reset Database</h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 12px" }}>
        Permanently deletes all ingested session, turn, and workspace data. Config and schema are
        preserved. This cannot be undone.
      </p>
      <button type="button" className="settings-reset-btn" onClick={openModal}>
        Reset database…
      </button>

      {showModal && (
        <div className="settings-modal-backdrop">
          <dialog open aria-labelledby="reset-modal-title" className="settings-modal">
            <h3 id="reset-modal-title" style={{ margin: "0 0 10px", color: "var(--red)" }}>
              Confirm reset
            </h3>
            <p style={{ color: "var(--soft)", fontSize: 13, margin: "0 0 14px" }}>
              Type <strong style={{ color: "var(--text)" }}>{dbName}</strong> to confirm. All
              ingested data will be permanently deleted.
            </p>
            <input
              ref={inputRef}
              aria-label="Type the database name to confirm reset"
              className="settings-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={dbName}
              autoComplete="off"
            />
            {error !== null && (
              <div className="settings-inline-error" role="alert" style={{ marginTop: 8 }}>
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="settings-cancel-btn"
                onClick={closeModal}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-reset-confirm-btn"
                onClick={handleReset}
                disabled={!confirmed || resetting}
                aria-disabled={!confirmed}
              >
                {resetting ? "Resetting…" : "Reset database"}
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}

function GettingStartedCard() {
  return (
    <section className="settings-onboarding-card" aria-labelledby="getting-started-title">
      <h2 id="getting-started-title">Getting started</h2>
      <p>Follow your first-run progress and next steps on Overview.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const experimental = useExperimentalActions();
  const [state, setState] = useState<LoadState<ApiResponse<Settings>>>({ status: "loading" });
  const [reports, setReports] = useState<Report[]>([]);

  const doLoad = useCallback(() => {
    setState({ status: "loading" });
    fetchSettings()
      .then((v) => setState({ status: "ok", value: v }))
      .catch((e: unknown) => setState({ status: "error", message: String(e) }));
    void Promise.resolve(getReports())
      .then((v) => setReports(v ?? []))
      .catch(() => setReports([]));
  }, []);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  function handleUpdated(updated: Settings) {
    setState((prev) =>
      prev.status === "ok" ? { status: "ok", value: { ...prev.value, data: updated } } : prev,
    );
  }

  const settings = state.status === "ok" ? state.value.data : null;

  return (
    <div>
      <div className="page-top">
        <div className="page-title">
          <h1>Settings</h1>
          <p className="page-sub">Daemon config · workspace mappings · parser health</p>
        </div>
      </div>

      {state.status === "loading" && (
        <div aria-busy="true" aria-label="Loading settings">
          <div className="settings-skeleton" />
          <div className="settings-skeleton" />
          <div className="settings-skeleton" />
        </div>
      )}

      {state.status === "error" && (
        <div className="banner banner-error" role="alert" aria-live="assertive">
          <span>⚠ Failed to load settings — {state.message}</span>
          <button type="button" className="banner-retry" onClick={doLoad}>
            Retry
          </button>
        </div>
      )}

      {settings !== null && (
        <>
          <div
            style={{
              color: "var(--muted)",
              fontSize: 11,
              marginBottom: 14,
              fontFamily: "monospace",
            }}
          >
            DB: {settings.db_path} · port {settings.port}
          </div>
          {(settings.scan_roots.length === 0 || settings.parser_health.files_seen === 0) && (
            <GettingStartedCard />
          )}
          <ConfigForm settings={settings} onSaved={handleUpdated} />
          <BytesCalibrationSection settings={settings} onSaved={handleUpdated} />
          <OAuthStatusPanel />
          <GithubTokenStatusPanel />
          <ContextBudgetHookPanel />
          <IdleSessionsPanel />
          <WorkspaceMappings mappings={settings.workspace_mappings} onSaved={handleUpdated} />
          <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
            <h2 style={{ margin: "0 0 14px", fontSize: 15 }}>Experimental actions</h2>
            <p className="settings-hint">
              Turns on methods still under validation; their numbers show an EXP chip and should be
              read as directional.
            </p>
            <label>
              <input
                type="checkbox"
                checked={experimental}
                onChange={(e) => setExperimentalActions(e.target.checked)}
              />{" "}
              Experimental actions
            </label>
            <p>
              Off by default. When on, shows the experimental Apply/dry-run controls on
              recommendation cards. Adopt/Dismiss are always available.
            </p>
          </section>
          <ParserHealthPanel health={settings.parser_health} />
          <ParseFailuresPanel rows={settings.quarantine_rows} />
          <AnchorsPanel />
          <WeeklyReportsPanel reports={reports} />
          <DbReset dbPath={settings.db_path} onReset={handleUpdated} />
        </>
      )}
    </div>
  );
}
