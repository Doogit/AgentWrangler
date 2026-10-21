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

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { HookConfig, HookConfigResponse } from "../../query/api/hook-config";
import type { Report } from "../../query/api/reports";
import type { Settings, WorkspaceMapping } from "../../query/api/settings";
import type { ApiResponse } from "../../query/envelope";
import type { StatuslineStatus } from "../../query/limits/statusline";
import type { StatuslinePlan } from "../../query/limits/statusline-install";
import type { WeightFit } from "../../query/limits/types";
import type { OutcomesStatus } from "../api/client";
import {
  applyStatusline,
  calibrateBytesPerTokenApi,
  calibrateLimitApi,
  fetchGithubTokenStatus,
  fetchHookConfig,
  fetchOutcomesStatus,
  fetchSettings,
  fetchStatuslinePreview,
  fetchStatuslineStatus,
  fetchWeightFit,
  getReports,
  installHook,
  refreshGithubTokenStatus,
  resetDatabase,
  saveHookConfig,
  saveSettings,
  startOutcomesConnectionTest,
  startOutcomesSyncRetry,
  uninstallHook,
} from "../api/client";
import { setExperimentalActions, useExperimentalActions } from "../hooks/useExperimentalActions";
import { formatAbsolute, relativeTime } from "../lib/relative-time";
import { useWorkspaceNames } from "../lib/workspace-names";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import Modal from "../shell/Modal";
import { SkeletonBlock } from "../shell/Skeleton";
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

/** ST-9: reword "cache reads ×N COEFF, unverified" → "cache reads counted at N× (unverified)". */
function sanitizeProvenance(p: string | null): string | null {
  if (p === null) return null;
  return p.replace(
    /cache reads ×(\S+) COEFF, unverified/g,
    "cache reads counted at $1× (unverified)",
  );
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
  // The Advanced override can change the persisted limit independently.
  useEffect(() => {
    setLimitRaw(settings.limit_tokens !== null ? String(settings.limit_tokens) : "");
    setProvenance(settings.limit_provenance);
    setLimitConfidence(settings.limit_provenance?.includes("LOW CONFIDENCE") ? "low" : null);
  }, [settings.limit_tokens, settings.limit_provenance]);
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
    const windowNum = Number(windowSecs.trim());
    if (!Number.isFinite(windowNum) || windowNum < 1) {
      setError("Activity window must be a whole number of seconds (>= 1).");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const res = await saveSettings({
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
      <h2 style={{ margin: "0 0 14px" }}>Configuration</h2>
      <p className="settings-hint">
        Estimates your weekly token allowance from recent usage, so the dashboard can forecast when
        you may reach it.
      </p>
      <div className="settings-field">
        {/* Primary: calibrate from live oauth/usage — the common path */}
        <button
          type="button"
          className="btn-primary settings-calibrate-btn"
          id="calibrate-limit"
          onClick={handleCalibrate}
          disabled={calibrating}
          title="Estimate the weekly token limit from Claude Code's reported usage percentage"
        >
          {calibrating
            ? "Calibrating…"
            : provenance?.startsWith("calibrated")
              ? "Re-calibrate from usage"
              : "Calibrate from usage"}
        </button>
        <p className="settings-calibrate-desc">
          Uses Claude Code's reported usage percentage to estimate your weekly limit. Saves the
          estimate automatically when successful.
        </p>

        {/* Calibration result: shown after a successful calibrate */}
        {provenance?.startsWith("calibrated") && limitRaw !== "" && (
          <div className="settings-calibrate-result" aria-label="Calibration result">
            {Number(limitRaw).toLocaleString()} tokens/wk &middot; {sanitizeProvenance(provenance)}
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
          <output className="settings-recalibrate-warning">
            ⚠ A new weekly window has started — consider re-calibrating.
          </output>
        )}
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="scan-roots">
          Scan roots
          <span className="settings-hint">
            {" "}
            (one absolute path per line; restart the daemon after saving)
          </span>
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
        <p className="settings-hint" style={{ margin: "0 0 4px" }}>
          How long a session can go quiet before it stops counting as active in the metrics.
        </p>
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
      <button
        type="button"
        className="btn-primary"
        style={{ marginTop: 14 }}
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save config"}
      </button>
    </div>
  );
}

function ManualLimitOverride({ settings, onSaved }: ConfigFormProps) {
  const [limitRaw, setLimitRaw] = useState(
    settings.limit_tokens !== null ? String(settings.limit_tokens) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh after calibration, without resetting drafts on unrelated saves.
  useEffect(() => {
    setLimitRaw(settings.limit_tokens !== null ? String(settings.limit_tokens) : "");
  }, [settings.limit_tokens]);

  async function handleSave() {
    const value = limitRaw.trim();
    const limit = value === "" ? null : Number(value);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
      setError("Weekly token limit must be a non-negative number.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const response = await saveSettings({ limit_tokens: limit });
      if (response.data !== null) onSaved(response.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Weekly token limit override</h3>
      <p className="settings-hint">
        Use a specific weekly limit when usage calibration is unavailable.
      </p>
      <label className="settings-label" htmlFor="limit-tokens">
        Weekly token limit (blank turns forecasting off)
      </label>
      <input
        id="limit-tokens"
        className="settings-input"
        type="number"
        min={0}
        value={limitRaw}
        onChange={(event) => setLimitRaw(event.target.value)}
        placeholder="e.g. 10000000000"
      />
      {error !== null && (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="btn-primary"
        style={{ marginTop: 14 }}
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save weekly limit"}
      </button>
    </section>
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
      <h2 style={{ margin: "0 0 10px" }}>Bytes→token calibration</h2>
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
            className="btn-primary settings-calibrate-btn"
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
  onSaved: (settings: Settings) => void;
}

function WorkspaceMappings({ mappings, onSaved }: WorkspaceMappingsProps) {
  const { labelFor } = useWorkspaceNames();
  const [rows, setRows] = useState(mappings);
  const [showTransient, setShowTransient] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const previousIds = useRef<string | null>(null);
  const workspaceIds = mappings
    .map((mapping) => mapping.workspace_id)
    .sort()
    .join(" ");
  useEffect(() => {
    if (workspaceIds !== previousIds.current) {
      previousIds.current = workspaceIds;
      setRows(mappings);
    }
  }, [mappings, workspaceIds]);

  function update(index: number, field: "repo_path" | "repo_canonical", value: string) {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value.trim() === "" ? null : value } : row,
      ),
    );
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await saveSettings({
        workspace_mappings: rows.map(({ workspace_id, repo_path, repo_canonical }) => ({
          workspace_id,
          repo_path,
          repo_canonical,
        })),
      });
      if (response.data !== null) onSaved(response.data);
      setMessage("Workspace mappings saved.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px" }}>Workspace names and paths</h2>
      <p className="settings-hint">
        Workspace names are derived from the editable local path and GitHub owner/repo mapping.
        Correct either value here when automatic detection is incomplete.
      </p>
      <label className="settings-hint">
        <input
          type="checkbox"
          checked={showTransient}
          onChange={(event) => setShowTransient(event.target.checked)}
        />{" "}
        Show transient workspaces
      </label>
      <div className="table-wrap">
        <table aria-label="Auto-derived workspace names">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Local path</th>
              <th>GitHub owner/repo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) =>
              row.is_transient && !showTransient ? null : (
                <tr key={row.workspace_id}>
                  <td>
                    {labelFor(row.workspace_id)}
                    {row.is_transient ? " (transient)" : ""}
                  </td>
                  <td>
                    <input
                      className="settings-table-input"
                      aria-label={`Repo path for ${row.project_slug}`}
                      value={row.repo_path ?? ""}
                      onChange={(event) => update(index, "repo_path", event.target.value)}
                      placeholder="C:\\path\\to\\repo"
                    />
                  </td>
                  <td>
                    <input
                      className="settings-table-input"
                      aria-label={`Canonical for ${row.project_slug}`}
                      value={row.repo_canonical ?? ""}
                      onChange={(event) => update(index, "repo_canonical", event.target.value)}
                      placeholder="owner/repo"
                    />
                    {row.repo_canonical === null && row.mapping_reason && (
                      <div className="settings-hint" role="note">
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
      {rows.length === 0 && (
        <p className="settings-hint">
          Workspaces appear after AgentWrangler observes a working directory.
        </p>
      )}
      {message && <output className="settings-hint">{message}</output>}
      <button
        type="button"
        className="btn-primary"
        onClick={handleSave}
        disabled={saving || rows.length === 0}
      >
        {saving ? "Saving…" : "Save workspace mappings"}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Parser health section
// ---------------------------------------------------------------------------

function ParserHealthPanel({ health }: { health: Settings["parser_health"] }) {
  const parserHealthStatus =
    health.lines_quarantined > 0
      ? "Quarantined lines detected"
      : health.files_seen === 0
        ? "No parser data"
        : "No quarantined lines";
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
      <h2 style={{ margin: "0 0 14px" }}>
        Parser Health
        {/* biome-ignore lint/a11y/useSemanticElements: status badge is not a form output */}
        <span role="status" className="chip" aria-label={parserHealthStatus}>
          {parserHealthStatus}
        </span>
      </h2>
      <p className="section-meta">
        Quarantine rate is unavailable: files seen and lines quarantined use different units.
      </p>
      <div className="settings-health-grid">
        {entries.map(([label, caption, value]) => (
          <div key={label} className="settings-health-row">
            <span className="settings-health-label">{label}</span>
            <span className="settings-health-value">{String(value)}</span>
            <span className="section-meta">{caption}</span>
          </div>
        ))}
        {versionEntries.length > 0 && (
          <div className="settings-health-row">
            <span className="settings-health-label">
              Parser coverage{" "}
              <InfoTip
                label="Parser version breakdown"
                content={`How many files each parser version has processed. Versions: ${versionEntries
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}.`}
              />
            </span>
            <span className="settings-health-value">
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
      <h2 style={{ margin: "0 0 6px" }}>Parse Failures</h2>
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
      <h2 style={{ margin: "0 0 14px" }}>Weekly Reports</h2>
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
// Model weight check (OV-12 U5, D6) — diagnostic; changes no other number
// ---------------------------------------------------------------------------

const fmtWeight = ([lo, hi]: [number, number]) => (lo === hi ? `${lo}×` : `${lo}–${hi}×`);
const round1 = (n: number) => Math.round(n * 10) / 10;

function WeightCheckCard() {
  const [fit, setFit] = useState<WeightFit | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void Promise.resolve(fetchWeightFit())
      .then((f) => setFit(f ?? null))
      .catch(() => setFailed(true));
  }, []);

  return (
    <section
      className="card"
      style={{ padding: "18px 20px", marginBottom: 16 }}
      data-testid="weight-check"
    >
      <h2 style={{ margin: "0 0 6px", display: "flex", alignItems: "center", gap: 8 }}>
        Model weight check <span className="chip">Diagnostic</span>
        <InfoTip label="About the model weight check" metricId="limits.weight_fit" />
      </h2>
      <p className="settings-hint">
        Tests whether your weekly limit counts each model the way API list prices do. It doesn't
        change any number on the Overview.
      </p>
      {fit === null && !failed && <SkeletonBlock height={20} />}
      {failed && <p className="settings-hint">Couldn't load the weight check.</p>}
      {fit !== null && (
        <>
          <div className="weight-status">
            <strong>
              {fit.ready
                ? `Fitted from ${fit.readings} readings across ${fit.weeks} weeks`
                : "Not enough data yet"}
            </strong>
            {!fit.ready && (
              <span className="settings-hint">
                Needs 6 readings at 10% or more, across 3 limit weeks, with a varied model mix.
              </span>
            )}
            <span className="weight-reqs">
              <span className={`weight-req${fit.readings >= 6 ? " met" : ""}`}>
                Readings <b>{fit.readings}</b> / 6
              </span>
              <span className={`weight-req${fit.weeks >= 3 ? " met" : ""}`}>
                Weeks <b>{fit.weeks}</b> / 3
              </span>
              <span className={`weight-req${fit.variedMix ? " met" : ""}`}>
                Varied mix {fit.variedMix ? "✓" : "✗"}
              </span>
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="num weight-table">
              <thead>
                <tr>
                  <th>Model family</th>
                  <th>List-price weight</th>
                  <th>Fitted</th>
                  <th>Reads as</th>
                </tr>
              </thead>
              <tbody>
                {fit.families.map((f) => {
                  const fitted =
                    f.status === "fitted" && f.multiplier !== null
                      ? fmtWeight([
                          round1(f.listWeight[0] * f.multiplier),
                          round1(f.listWeight[1] * f.multiplier),
                        ])
                      : f.status === "reference"
                        ? fmtWeight(f.listWeight)
                        : "—";
                  let reads: ReactNode = "—";
                  if (f.status === "reference") reads = "Reference";
                  else if (f.status === "too-little-use") reads = "Too little use to fit";
                  else if (f.multiplier !== null) {
                    reads =
                      Math.abs(f.multiplier - 1) <= 0.1 ? (
                        <span className="chip exact">Matches price</span>
                      ) : (
                        <span className="chip unv">
                          Counts {f.multiplier < 1 ? "less" : "more"} than price
                        </span>
                      );
                  }
                  return (
                    <tr key={f.family}>
                      <td>{f.family}</td>
                      <td>{fmtWeight(f.listWeight)}</td>
                      <td>{fitted}</td>
                      <td>{reads}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {fit.ready && fit.spreadListPct !== null && fit.spreadFittedPct !== null && (
            <p className="settings-hint" style={{ marginTop: 10 }}>
              Weekly max spread: <b>±{round1(fit.spreadListPct)}%</b> at list prices →{" "}
              <b>±{round1(fit.spreadFittedPct)}%</b> with fitted weights.
            </p>
          )}
          <p className="settings-hint" style={{ marginTop: 6, fontSize: 11 }}>
            Weights vs Sonnet 5 input ($2/MTok). Sonnet is the reference, so it isn't fitted.
            "Matches" = within 10% of list price.
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Statusline fallback panel (OV-7)
// ---------------------------------------------------------------------------

function statuslineAge(ageSec: number | null): string {
  if (ageSec === null) return "";
  if (ageSec < 90) return `${ageSec}s ago`;
  if (ageSec < 5400) return `${Math.round(ageSec / 60)} min ago`;
  return `${Math.round(ageSec / 3600)} h ago`;
}

const USAGE_CLI_DISCLOSURE =
  "AgentWrangler runs your `claude` CLI's `/usage` command in the background, at most every 5 minutes while this page is open. It never reads your Claude login.";

function UsageCliPanel({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (updated: Settings) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.usage_cli_enabled !== false;

  async function toggle(checked: boolean) {
    setError(null);
    setSaving(true);
    try {
      const res = await saveSettings({ usage_cli_enabled: checked });
      if (res.data !== null) onSaved(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      id="usage-cli"
      className="card"
      aria-labelledby="usage-cli-title"
      style={{ padding: "18px 20px", marginBottom: 16 }}
    >
      <h2 id="usage-cli-title" style={{ margin: "0 0 6px" }}>
        Usage limits from Claude Code{" "}
        <InfoTip label="About the /usage reader" content={USAGE_CLI_DISCLOSURE} />
      </h2>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
        />
        Read usage via Claude Code /usage
      </label>
      <p className="settings-hint">{USAGE_CLI_DISCLOSURE}</p>
      {error !== null && (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function StatuslineFallbackPanel() {
  const [status, setStatus] = useState<StatuslineStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<{
    action: "install" | "uninstall";
    plan: StatuslinePlan;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    void Promise.resolve(fetchStatuslineStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function startPreview(action: "install" | "uninstall") {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fetchStatuslinePreview(action);
      if (r.ok) setPreview({ action, plan: r.plan });
      else setError(r.error);
    } catch {
      setError("Could not reach the daemon.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await applyStatusline(preview.action, preview.plan.before);
      if (r.ok) {
        setDone(
          preview.action === "install"
            ? "Installed. Claude Code picks it up on its next statusline refresh."
            : "Uninstalled. Your previous statusline is restored.",
        );
        setPreview(null);
        loadStatus();
      } else setError(r.error);
    } catch {
      setError("Could not reach the daemon.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      id="statusline-fallback"
      tabIndex={-1}
      aria-labelledby="statusline-fallback-title"
      className="card"
      style={{ padding: "18px 20px", marginBottom: 16 }}
    >
      <h2 id="statusline-fallback-title" style={{ margin: "0 0 6px" }}>
        Usage limits from your statusline{" "}
        <InfoTip
          label="About the statusline source"
          content="The Usage limits card shows the percentages Claude Code last passed to your statusline. AgentWrangler doesn't use your Claude login to call claude.ai. Only the two percentages and their reset times are saved, to ~/.agentwrangler/statusline-limits.json."
        />
      </h2>
      <p className="settings-hint">
        Optional: updates on every turn, no background calls. Point Claude Code's statusline at{" "}
        <code>agentwrangler statusline</code>. If you already have a statusline, it keeps running
        and showing as before.
      </p>
      {status === null && <SkeletonBlock height={20} />}
      {status !== null && (
        <>
          <p
            style={{
              margin: "0 0 10px",
              color: status.state === "found" ? undefined : "var(--amber)",
            }}
            aria-label="statusline fallback status"
          >
            {status.state === "found" && `Found — last written ${statuslineAge(status.ageSec)}.`}
            {status.state === "stale" &&
              `Stale — last written ${statuslineAge(status.ageSec)}; the statusline may have stopped writing.`}
            {status.state === "not-set-up" && "Not set up."}
          </p>
          {status.installed === true && (
            <p style={{ margin: "0 0 10px" }}>
              Installed — Claude Code's statusLine runs <code>agentwrangler statusline</code>.
            </p>
          )}
          {done !== null && (
            <output style={{ display: "block", margin: "0 0 10px" }}>{done}</output>
          )}
          {error !== null && (
            <div className="settings-inline-error" role="alert" style={{ marginBottom: 10 }}>
              {error}
            </div>
          )}
          {preview !== null && (
            <div style={{ margin: "0 0 12px" }}>
              <p className="settings-hint">
                {preview.plan.changed
                  ? `This changes only the statusLine entry in ${preview.plan.settingsPath}. A timestamped backup is saved next to it first.`
                  : "Nothing to change."}
              </p>
              <p style={{ margin: "0 0 4px" }}>Before</p>
              <pre
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 10px" }}
                aria-label="statusline entry before"
              >
                <code>{preview.plan.before ?? "(none — no statusLine entry)"}</code>
              </pre>
              <p style={{ margin: "0 0 4px" }}>After</p>
              <pre
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 10px" }}
                aria-label="statusline entry after"
              >
                <code>{preview.plan.after ?? "(removed — no statusLine entry)"}</code>
              </pre>
              <div style={{ display: "flex", gap: 8 }}>
                {preview.plan.changed && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => void confirm()}
                  >
                    {preview.action === "install" ? "Confirm install" : "Confirm uninstall"}
                  </button>
                )}
                <button type="button" className="btn-secondary" onClick={() => setPreview(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {preview === null && (
            <div style={{ margin: "0 0 12px" }}>
              <button
                type="button"
                className={status.installed === true ? "btn-secondary" : "btn-primary"}
                disabled={busy}
                onClick={() =>
                  void startPreview(status.installed === true ? "uninstall" : "install")
                }
              >
                {status.installed === true ? "Uninstall statusline" : "Install statusline"}
              </button>
            </div>
          )}
          <p className="settings-hint">
            Or set it up by hand: use this as your statusLine command in{" "}
            <code>~/.claude/settings.json</code> (needs <code>agentwrangler</code> on your PATH). To
            keep an existing statusline, add <code>--wrap "your command"</code>.
          </p>
          <pre
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 10px" }}
            aria-label="statusline snippet"
          >
            <code>{status.snippet}</code>
          </pre>
          <button type="button" className="btn-secondary" onClick={() => void copy(status.snippet)}>
            {copied ? "Copied" : "Copy the line"}
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub token status panel (outcomes sync) — mirrors the usage-reader pattern
// ---------------------------------------------------------------------------

function GithubTokenStatusPanel() {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null);
  const [requestState, setRequestState] = useState<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  const load = useCallback((refresh: boolean) => {
    const id = ++requestId.current;
    setRequestState("loading");
    setRefreshing(refresh);
    void Promise.resolve(
      refresh
        ? typeof refreshGithubTokenStatus === "function"
          ? refreshGithubTokenStatus()
          : null
        : typeof fetchGithubTokenStatus === "function"
          ? fetchGithubTokenStatus()
          : null,
    )
      .then((next) => {
        if (id !== requestId.current) return;
        if (!next) return;
        setStatus(next);
        setRequestState("ready");
        if (refresh) window.dispatchEvent(new Event("agentwrangler:outcomes-credential-refreshed"));
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setRequestState("error");
      })
      .finally(() => {
        if (id === requestId.current) setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load(false);
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h2 style={{ margin: "0 0 6px" }}>Outcomes sync</h2>
      <p className="settings-hint">
        Compares sessions with your git history to distinguish finished work from abandoned work. It
        is optional and needs the GitHub command-line tool (<code>gh</code>) available to the daemon
        plus a read-only GitHub token. This optional panel is shown to every user, including a new
        installation; nothing is synced until the prerequisites are configured.
      </p>
      <p className="settings-hint">
        Create a GitHub token with access to the repositories you want to sync. On Windows, open
        Credential Manager → Windows Credentials → Add a generic credential. Use
        <code> AgentWrangler-GithubToken</code> as the address and put the token in the password
        field. To replace it, edit that credential; to remove it, delete that credential. Closing
        the OS dialog without saving leaves it unchanged. On any platform, you can instead set
        <code> AW_GITHUB_TOKEN</code> in the daemon process environment and restart the daemon. The
        environment token takes precedence; deleting the Windows credential may leave outcomes
        configured while that environment value remains. Removing a credential does not delete
        historical outcomes.
      </p>
      {requestState === "loading" && status === null && <SkeletonBlock height={20} />}
      {requestState === "error" && <p role="alert">Could not read token status. Retry below.</p>}
      {requestState !== "error" && status?.configured && (
        <p style={{ margin: 0 }} aria-label="github token status">
          GitHub token: configured <strong>({status.source})</strong>. This has not checked GitHub
          access.
        </p>
      )}
      {requestState !== "error" && status !== null && !status.configured && (
        <p style={{ margin: 0, color: "var(--amber)" }} aria-label="github token status">
          {status.state === "store-error"
            ? `Credential store error (${status.code ?? "credential-read-failed"}). `
            : ""}
          {status.reason ?? "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN"}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" onClick={() => load(false)} disabled={refreshing}>
          Retry status
        </button>
        <button type="button" onClick={() => load(true)} disabled={refreshing}>
          I've changed the credential — recheck locally
        </button>
      </div>
      <p className="settings-hint">
        Recheck clears the daemon's cached Windows credential. It does not contact GitHub. Restart
        the daemon after changing AW_GITHUB_TOKEN.
      </p>
    </section>
  );
}

function OutcomesOperationsPanel() {
  const [status, setStatus] = useState<OutcomesStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const mounted = useRef(true);
  const actionPending = useRef(false);
  const requestId = useRef(0);
  const load = useCallback(() => {
    if (actionPending.current || typeof fetchOutcomesStatus !== "function") return;
    const id = ++requestId.current;
    void Promise.resolve(fetchOutcomesStatus())
      .then((next) => {
        if (mounted.current && id === requestId.current && next) {
          setStatus(next);
          setMessage((prior) => (prior === "Could not read outcomes status." ? null : prior));
        }
      })
      .catch(() => {
        if (mounted.current && id === requestId.current)
          setMessage("Could not read outcomes status.");
      });
  }, []);
  useEffect(() => {
    mounted.current = true;
    load();
    const onCredentialRefresh = () => {
      requestId.current++;
      setStatus((current) =>
        current
          ? {
              ...current,
              connection: {
                ...current.connection,
                state: "never-run",
                attemptId: null,
                startedAt: null,
                completedAt: null,
                lastSuccess: null,
                eligibleRepositories: 0,
                attemptedReads: 0,
                failedReads: 0,
                failedStages: [],
                categories: {},
                draining: false,
                repositoryAccess: "untested",
                credentialEpoch: current.connection.credentialEpoch + 1,
              },
            }
          : null,
      );
      load();
    };
    window.addEventListener("agentwrangler:outcomes-credential-refreshed", onCredentialRefresh);
    return () => {
      mounted.current = false;
      requestId.current++;
      window.removeEventListener(
        "agentwrangler:outcomes-credential-refreshed",
        onCredentialRefresh,
      );
    };
  }, [load]);
  useEffect(() => {
    if (
      status?.sync.state !== "running" &&
      status?.connection.state !== "running" &&
      !status?.sync.draining &&
      !status?.connection.draining
    )
      return;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [
    status?.sync.state,
    status?.connection.state,
    status?.sync.draining,
    status?.connection.draining,
    load,
  ]);
  const act = (action: () => Promise<{ status: number; retryAfterMs?: number }>) => {
    requestId.current++;
    actionPending.current = true;
    setRequesting(true);
    setMessage("Starting operation…");
    void Promise.resolve(action())
      .then((result) => {
        if (!mounted.current) return;
        setMessage(
          result.status === 429
            ? `Action cooling down. Try again in ${Math.ceil((result.retryAfterMs ?? 0) / 1000)} seconds.`
            : result.status === 409
              ? "An operation is already running or draining."
              : "Operation started.",
        );
        actionPending.current = false;
        load();
      })
      .catch(() => {
        if (mounted.current) setMessage("Could not start operation.");
      })
      .finally(() => {
        actionPending.current = false;
        if (mounted.current) setRequesting(false);
      });
  };
  const render = (label: string, item: OutcomesStatus["sync"] | OutcomesStatus["connection"]) => (
    <div>
      <strong>
        {label}: {item.state}
      </strong>
      <span>
        {" "}
        · {item.eligibleRepositories} eligible repositories · {item.attemptedReads} reads ·{" "}
        {item.failedReads} failed
      </span>
      {item.startedAt && (
        <p>
          Last attempt: {item.startedAt}
          {item.completedAt ? ` · completed ${item.completedAt}` : ""}.
        </p>
      )}
      {item.lastSuccess && <p>Last full success: {item.lastSuccess} (historical evidence).</p>}
      {item.failedStages.length > 0 && (
        <p>
          Failed stages: {item.failedStages.join(", ")}. Categories:{" "}
          {Object.entries(item.categories)
            .map(([code, count]) => `${code} ${count}`)
            .join(", ")}
          .
        </p>
      )}
      {item.draining && (
        <p>The timed-out operation is still draining. Restart the daemon if it never settles.</p>
      )}
    </div>
  );
  return (
    <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
      <h3>GitHub connection and sync</h3>
      <p className="settings-hint">
        Status is kept in memory since daemon start. A connection test checks one locally mapped
        repository through the daemon's configured token and GitHub CLI; it does not prove access to
        every repository or API. A sync success records when the complete pass finished, not whether
        the current credential still works.
      </p>
      {status && (
        <>
          {render("Sync", status.sync)}
          {render("Connection test", status.connection)}
          {status.connection.repositoryAccess === "untested" && (
            <p>Repository access has not been tested.</p>
          )}
        </>
      )}
      {message && <output style={{ display: "block" }}>{message}</output>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => act(startOutcomesConnectionTest)}
          disabled={requesting}
        >
          Test connection
        </button>
        <button type="button" onClick={() => act(startOutcomesSyncRetry)} disabled={requesting}>
          Retry sync
        </button>
        <button type="button" onClick={load}>
          Refresh status
        </button>
      </div>
    </section>
  );
}

function ContextBudgetHookPanel() {
  const [config, setConfig] = useState<HookConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"install" | "uninstall" | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [contextWindowRaw, setContextWindowRaw] = useState("");

  useEffect(() => {
    void Promise.resolve(fetchHookConfig())
      .then((response) => {
        if (response?.data != null) {
          setConfig(response.data);
          setContextWindowRaw(response.data.context_window.toLocaleString("en-US"));
        }
      })
      .catch(() => {});
  }, []);

  const installed = config?.installed ?? false;
  const installPrompt = config === null ? null : buildHookInstallPrompt(config);
  const uninstallPrompt = buildHookUninstallPrompt();

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

  async function saveContextWindow() {
    const normalized = contextWindowRaw.replace(/,/g, "").trim();
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
      setError("Context window must be at least 1,000 tokens.");
      return;
    }
    await saveThreshold("context_window", normalized);
    setContextWindowRaw(Math.round(parsed).toLocaleString("en-US"));
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
        <h2 style={{ margin: 0 }}>Context budget hook</h2>
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
        Hooks give Claude Code local reminders about context size, repeated failures, and spend. The
        direct install also adds a dangerous-command check and a checkpoint before compaction.
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
                    type="text"
                    inputMode="numeric"
                    value={contextWindowRaw}
                    onChange={(e) => setContextWindowRaw(e.target.value)}
                    onBlur={() => void saveContextWindow()}
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
          <details>
            <summary className="fb5-field-hint" style={{ cursor: "pointer" }}>
              Show config field names
            </summary>
            <p className="fb5-field-hint">
              fields: context_window, soft_pct, hard_pct, d7_fail_count, d7_window_turns,
              d9_idle_seconds
            </p>
          </details>
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
            className="btn-primary"
            onClick={() => installPrompt !== null && void handleCopy(installPrompt, "install")}
            disabled={config === null}
          >
            {copyFeedback === "install" ? "Copied!" : "Copy install prompt"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void changeInstall(true)}
            disabled={busy || config === null}
          >
            {busy ? "Installing…" : "Install directly — writes ~/.claude/settings.json for you"}
          </button>
          <details>
            <summary className="settings-hint" style={{ margin: "10px 0 6px", cursor: "pointer" }}>
              Show install prompt text — copy this exact text into Claude Code if you prefer to
              review the change there.
            </summary>
            <textarea
              aria-label="Install prompt text"
              className="settings-textarea"
              readOnly
              rows={8}
              value={installPrompt ?? "Loading the current hook settings…"}
              style={{
                minHeight: 150,
                resize: "vertical",
                border: "1px solid var(--line)",
                background: "var(--bg)",
                fontFamily: "monospace",
                fontSize: 12,
              }}
            />
          </details>
        </div>
        <div className="fb5-action-group">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleCopy(uninstallPrompt, "uninstall")}
          >
            {copyFeedback === "uninstall" ? "Copied!" : "Copy uninstall prompt"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void changeInstall(false)}
            disabled={busy}
          >
            {busy ? "Uninstalling…" : "Uninstall directly"}
          </button>
          <details>
            <summary className="settings-hint" style={{ margin: "10px 0 6px", cursor: "pointer" }}>
              Show uninstall prompt text — copy this exact text to remove only AgentWrangler&apos;s
              copied hooks.
            </summary>
            <textarea
              aria-label="Uninstall prompt text"
              className="settings-textarea"
              readOnly
              rows={6}
              value={uninstallPrompt}
              style={{
                minHeight: 120,
                resize: "vertical",
                border: "1px solid var(--line)",
                background: "var(--bg)",
                fontFamily: "monospace",
                fontSize: 12,
              }}
            />
          </details>
        </div>
      </div>
      <p className="fb5-takes-effect">Takes effect immediately, no restart.</p>
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
      <h2 style={{ margin: "0 0 6px", color: "var(--red)" }}>Reset Database</h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 12px" }}>
        Permanently deletes all ingested session, turn, and workspace data. Config and schema are
        preserved. This cannot be undone.
      </p>
      <button type="button" className="btn-destructive" onClick={openModal}>
        Reset database…
      </button>

      {showModal && (
        <div className="settings-modal-backdrop">
          <Modal
            labelledBy="reset-modal-title"
            onCancel={() => {
              if (!resetting) closeModal();
            }}
          >
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
                className="btn-secondary"
                onClick={closeModal}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-destructive"
                onClick={handleReset}
                disabled={!confirmed || resetting}
                aria-disabled={!confirmed}
              >
                {resetting ? "Resetting…" : "Reset database"}
              </button>
            </div>
          </Modal>
        </div>
      )}
    </div>
  );
}

function CalibrationNote({ settings, onSaved }: ConfigFormProps) {
  const [raw, setRaw] = useState(String(settings.cap_read_coeff ?? 0.1));
  const [message, setMessage] = useState<string | null>(null);

  async function saveCoefficient() {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      setMessage("Enter a coefficient greater than 0 and at most 1.");
      return;
    }
    try {
      const response = await saveSettings({ cap_read_coeff: value });
      if (response.data !== null) onSaved(response.data);
      setMessage("Cap coefficient saved.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section
      id="settings-calibration"
      tabIndex={-1}
      className="card"
      style={{ padding: "18px 20px", marginBottom: 16 }}
    >
      <h2 style={{ margin: "0 0 6px" }}>Calibration &amp; the cap coefficient</h2>
      <p className="settings-hint">
        When estimating how much of your subscription limit each token consumes, the dashboard
        weights cache-read tokens at <strong>{settings.cap_read_coeff ?? 0.1}×</strong> a fresh
        input token. Anthropic has not published this coefficient, so it is marked{" "}
        <em>unverified</em>. Compare the Usage limits card&rsquo;s estimate against the actual
        claude.ai figure — when they drift far apart, this coefficient is the most likely cause.
        Calibrate the weekly token limit above from live usage to keep the forecast honest.
      </p>
      <label className="settings-field">
        Cache-read cap coefficient
        <input
          className="settings-input"
          aria-label="Cache-read cap coefficient"
          type="number"
          min="0.01"
          max="1"
          step="0.01"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
        />
      </label>
      <button type="button" className="btn-primary" onClick={() => void saveCoefficient()}>
        Save cap coefficient
      </button>
      {message && <output className="settings-hint">{message}</output>}
    </section>
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

const settingsNavigation = [
  ["Essentials", "essentials"],
  ["In-session guards", "in-session-guards"],
  ["Integrations", "integrations"],
  ["Advanced", "advanced"],
] as const;

type SettingsNavigationSection = (typeof settingsNavigation)[number][1];

const settingsSectionByAnchor: Record<string, SettingsNavigationSection> = {
  essentials: "essentials",
  configuration: "essentials",
  "scan-roots": "essentials",
  calibration: "essentials",
  usage: "essentials",
  statusline: "essentials",
  workspaces: "integrations",
  "outcomes-sync": "integrations",
  "in-session-guards": "in-session-guards",
  integrations: "integrations",
  advanced: "advanced",
  "parser-health": "advanced",
};

function getActiveSettingsSection(): SettingsNavigationSection {
  const section = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section");
  return section === null ? "essentials" : (settingsSectionByAnchor[section] ?? "essentials");
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const experimental = useExperimentalActions();
  const [state, setState] = useState<LoadState<ApiResponse<Settings>>>({ status: "loading" });
  const [reports, setReports] = useState<Report[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeSection, setActiveSection] =
    useState<SettingsNavigationSection>(getActiveSettingsSection);
  const advancedDetailsRef = useRef<HTMLDetailsElement>(null);

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

  useEffect(() => {
    if (state.status !== "ok") return;
    const navigateToSection = () => {
      const section = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section");
      setActiveSection(getActiveSettingsSection());
      // Keys here must stay in sync with settingsSectionByAnchor above:
      // every scrollable anchor needs a nav-section owner, or its highlight falls back to Essentials.
      const targets: Record<string, string> = {
        essentials: "settings-essentials",
        configuration: "settings-essentials",
        "scan-roots": "scan-roots",
        calibration: "calibrate-limit",
        usage: "usage-cli",
        statusline: "statusline-fallback",
        workspaces: "settings-integrations",
        "outcomes-sync": "settings-integrations",
        "in-session-guards": "settings-in-session-guards",
        integrations: "settings-integrations",
        advanced: "settings-advanced",
        "parser-health": "settings-parser-health",
      };
      const id = section === null ? undefined : targets[section];
      if (id === undefined) return;
      if (section === "advanced" || section === "parser-health") {
        advancedDetailsRef.current?.setAttribute("open", "");
        setAdvancedOpen(true);
      }
      const target = document.getElementById(id);
      target?.scrollIntoView?.({ block: "start" });
      target?.focus({ preventScroll: true });
    };
    navigateToSection();
    window.addEventListener("hashchange", navigateToSection);
    return () => window.removeEventListener("hashchange", navigateToSection);
  }, [state.status]);

  return (
    <div className="settings-page">
      <div className="page-top">
        <div className="page-title">
          <h1>Settings</h1>
          <p className="page-sub">
            Usage limits, monitored folders, session warnings, and diagnostics
          </p>
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
          <nav className="settings-nav" aria-label="Settings sections">
            {settingsNavigation.map(([label, section]) => (
              <a
                key={section}
                className={
                  activeSection === section
                    ? "settings-nav-link settings-nav-link--active"
                    : "settings-nav-link"
                }
                href={`#/settings?section=${section}`}
                aria-current={activeSection === section ? "page" : undefined}
              >
                {/* biome-ignore lint/a11y/useSemanticElements: the nav item is intentionally exposed as the section heading (G-F3 dropped the in-panel SectionHeader); a native <h2> nested in this nav anchor would carry unwanted heading styling. */}
                <span role="heading" aria-level={2}>
                  {label}
                </span>
              </a>
            ))}
          </nav>
          {(settings.scan_roots.length === 0 || settings.parser_health.files_seen === 0) && (
            <GettingStartedCard />
          )}
          <div id="settings-essentials" tabIndex={-1}>
            <ConfigForm settings={settings} onSaved={handleUpdated} />
            <WeightCheckCard />
            <UsageCliPanel settings={settings} onSaved={handleUpdated} />
            <StatuslineFallbackPanel />
            <CalibrationNote settings={settings} onSaved={handleUpdated} />
          </div>
          <div id="settings-in-session-guards" tabIndex={-1}>
            <ContextBudgetHookPanel />
          </div>
          <div id="settings-integrations" tabIndex={-1}>
            <GithubTokenStatusPanel />
            <OutcomesOperationsPanel />
            <WorkspaceMappings mappings={settings.workspace_mappings} onSaved={handleUpdated} />
          </div>
          <div id="settings-advanced" tabIndex={-1}>
            <details
              ref={advancedDetailsRef}
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>Advanced and diagnostics</summary>
              <p className="settings-hint" style={{ marginTop: 10 }}>
                Use these details to troubleshoot local ingestion or enable features still being
                evaluated.
              </p>
              <p
                className="settings-hint"
                data-testid="settings-local-database"
                style={{ fontFamily: "monospace" }}
              >
                Local database: {settings.db_path} · port {settings.port}
              </p>
              <ManualLimitOverride settings={settings} onSaved={handleUpdated} />
              <BytesCalibrationSection settings={settings} onSaved={handleUpdated} />
              <section className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                <h2 style={{ margin: "0 0 14px" }}>Experimental actions</h2>
                <p className="settings-hint">
                  Turns on methods still under validation; their numbers show an EXP chip and should
                  be read as directional.
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
                  Off by default. When on, shows Open in Claude Code on recommendation cards.
                  Tracking requires a completed action; Dismiss remains available.
                </p>
                <p className="settings-hint">
                  One-click apply is off in 0.2.0: Claude Code permission rules can't confine the
                  edit yet. Use Open in Claude Code or Copy prompt instead.
                </p>
              </section>
              <div id="settings-parser-health" tabIndex={-1}>
                <ParserHealthPanel health={settings.parser_health} />
                <ParseFailuresPanel rows={settings.quarantine_rows} />
              </div>
              <AnchorsPanel />
              <WeeklyReportsPanel reports={reports} />
              <DbReset dbPath={settings.db_path} onReset={handleUpdated} />
            </details>
          </div>
        </>
      )}
    </div>
  );
}
