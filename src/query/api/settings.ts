/**
 * src/query/api/settings.ts — LocalQueryAPI: settings method stubs.
 *
 * WP4 owns this file. These signatures and return types are FROZEN by WP0.
 * Do NOT change method signatures without a plan decision.
 *
 * All methods return stub responses. WP4 implements the real bodies,
 * wiring to the user_config table and WorkspaceRegistry.
 */

import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import {
  applySettingsUpdate as _applySettingsUpdate,
  calibrateLimit as _calibrateLimit,
  resetDatabase as _resetDatabase,
  getSettingsData,
} from "../settings-store.js";
import type { CalibrateResult as _CalibrateResult } from "../settings-store.js";
export type { CalibrateResult } from "../settings-store.js";
import { calibrateBytesPerToken as _calibrateBytesPerToken } from "../../detector/calibration.js";
import type { CalibrateBytesPerTokenResult as _CalibrateBytesPerTokenResult } from "../../detector/calibration.js";
export type { CalibrateBytesPerTokenResult } from "../../detector/calibration.js";

// Local alias so the function signature below can reference the type.
type CalibrateResult = _CalibrateResult;

// ---------------------------------------------------------------------------
// Settings payload types (frozen — WP4 fills with real data)
// ---------------------------------------------------------------------------

/** Parser health counters (WP1 owns ingestion; WP4 surfaces them in Settings). */
export interface ParserHealth {
  files_seen: number;
  files_parsed: number;
  lines_quarantined: number;
  synthetic_excluded: number;
  duplicate_drops: number;
  parser_version_mix: Record<string, number>;
}

/** A safe pointer to a quarantined parse failure; intentionally excludes raw content. */
export interface QuarantineRow {
  file_path: string;
  line_no: number;
  error_class: string;
  seen_at: string;
}

/** Per-workspace mapping row shown in Settings. */
export interface WorkspaceMapping {
  workspace_id: string;
  project_slug: string;
  repo_path: string | null;
  /** Normalized "owner/repo" string if known. */
  repo_canonical: string | null;
  /** True when the workspace has not yet been mapped to a GitHub repository. */
  is_transient: boolean;
  /**
   * Human-readable reason a still-unmapped (transient) workspace could not be
   * auto-mapped to a GitHub repo — "no cwd recorded", "dir missing", or "no
   * remote". Optional and absent on mapped rows. Derived at read time from the
   * local DB + filesystem only (SEC-101 — never persisted to a committed file).
   */
  mapping_reason?: string;
}

/** Full settings payload. */
export interface Settings {
  /** DB file path currently in use. */
  db_path: string;
  /** Scan roots for transcript discovery. */
  scan_roots: string[];
  /** HTTP port the daemon is listening on. */
  port: number;
  /** Activity window in seconds (sessions older than this are reconciled). */
  activity_window_secs: number;
  /**
   * Weekly token limit for burn forecast.
   * null = not configured (forecast shows OFF state).
   */
  limit_tokens: number | null;
  /**
   * Provenance of the limit_tokens value (ADR-111).
   * "calibrated {YYYY-MM-DD} @ {util}%" when auto-calibrated;
   * "manual" when hand-entered.
   * null when limit_tokens is null (forecast OFF).
   */
  limit_provenance: string | null;
  /**
   * ISO-8601 timestamp when the weekly window next resets (from calibration).
   * Used to surface a re-calibrate hint when a new window has started.
   * null when limit_tokens has never been auto-calibrated.
   */
  limit_resets_at: string | null;
  /** Workspace slug → repo path/canonical mappings. */
  workspace_mappings: WorkspaceMapping[];
  /** Parser health counters from WP1. */
  parser_health: ParserHealth;
  /** Latest parse-failure pointers, newest first (capped at 100). */
  quarantine_rows: QuarantineRow[];
  /** ISO-8601 timestamp of the last database reset, or null. */
  last_reset_at: string | null;
  /**
   * Whether the opt-in bytes→token calibration is enabled (R12).
   * When false (default), no tool-result text leaves the machine.
   */
  bytes_per_token_calibration_enabled: boolean;
  /**
   * Calibrated bytes-per-token ratio (R12).
   * null when calibration has never been run.
   */
  bytes_per_token: number | null;
  /**
   * Provenance of the bytes_per_token value (R12).
   * "calibrated {date} via count_tokens · model {model} · N={n} · median {ratio}"
   * null when never calibrated.
   */
  bytes_per_token_provenance: string | null;
  /**
   * ISO-8601 timestamp of the last bytes-per-token calibration.
   * null when never calibrated.
   */
  bytes_per_token_measured_at: string | null;
}

/** Partial settings update payload. Only provided fields are changed. */
export interface SettingsUpdate {
  scan_roots?: string[];
  activity_window_secs?: number;
  limit_tokens?: number | null;
  workspace_mappings?: Array<{
    workspace_id: string;
    repo_path?: string | null;
    repo_canonical?: string | null;
  }>;
  /** Toggle the opt-in bytes→token calibration (R12). */
  bytes_per_token_calibration_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Method stubs — WP4 fills these
// ---------------------------------------------------------------------------

/**
 * Return the current daemon settings.
 * Reads user_config + WorkspaceRegistry; parser_health from the injected Health instance.
 */
export function getSettings(): ApiResponse<Settings> {
  const db = getQueryDb();
  const data = getSettingsData(db);
  return buildResponse<Settings>(data, {
    claim_kind: "N_A",
    n: 1,
  });
}

/**
 * Apply a partial settings update and persist to user_config.
 * Validates scan_roots paths before writing. Throws on invalid input.
 *
 * This is the write path; it requires the CSRF same-origin gate (enforced in http.ts).
 */
export function updateSettings(update: SettingsUpdate): ApiResponse<Settings> {
  const db = getQueryDb();
  const data = _applySettingsUpdate(db, update);
  return buildResponse<Settings>(data, {
    claim_kind: "N_A",
    n: 1,
  });
}

/**
 * Wipe all ingested data tables and return fresh settings.
 * Preserves user_config and schema_migrations.
 */
export function resetDatabase(): ApiResponse<Settings> {
  const db = getQueryDb();
  const data = _resetDatabase(db);
  return buildResponse<Settings>(data, {
    claim_kind: "N_A",
    n: 1,
  });
}

/**
 * Auto-calibrate `:limit_tokens` from the user's local oauth/usage utilization.
 * Implements ADR-111: limit_tokens ≈ tokens_in_window / seven_day.utilization.
 *
 * Always returns 200; ok:false means calibration failed gracefully (429, low
 * utilization) — the client shows the reason and falls back to manual entry.
 * This is a write path; it requires the CSRF same-origin gate (enforced in http.ts).
 */
export async function calibrateLimit(): Promise<ApiResponse<CalibrateResult>> {
  const db = getQueryDb();
  const result = await _calibrateLimit(db);
  return buildResponse<CalibrateResult>(result, {
    claim_kind: "N_A",
    n: 1,
  });
}

// Local alias for the calibration result type used below.
type CalibrateBytesPerTokenResult = _CalibrateBytesPerTokenResult;

/**
 * Calibrate the bytes-per-token ratio via Anthropic's count_tokens API (R12).
 *
 * Requires opt-in to be enabled (user_config.bytes_per_token_calibration_enabled="true").
 * Returns ok:false when disabled or when <30 successful samples could be collected.
 * This is a write path; it requires the CSRF same-origin gate (enforced in http.ts).
 */
export async function calibrateBytesPerToken(): Promise<ApiResponse<CalibrateBytesPerTokenResult>> {
  const db = getQueryDb();
  const result = await _calibrateBytesPerToken(db);
  return buildResponse<CalibrateBytesPerTokenResult>(result, {
    claim_kind: "N_A",
    n: 1,
  });
}
