/**
 * src/query/settings-store.ts — Data access for getSettings/updateSettings (WP4).
 *
 * Provides:
 *   - Health context: setHealthInstance / clearHealthInstance
 *   - getSettingsData(db) — assembles the full Settings payload
 *   - applySettingsUpdate(db, update) — validates, persists, returns updated Settings or Error
 *   - validateScanRoots(roots) — path guard (used by updateSettings + UI)
 *
 * No SQL in the UI; all reads/writes go through this module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../daemon/config.js";
import type { Db } from "../db/open.js";
import type { Health } from "../ingest/health.js";
import type { HealthCounters } from "../ingest/types.js";
import { newHealthCounters } from "../ingest/types.js";
import { fetchOAuthUsage } from "../oauth/usage.js";
import type { UsageReader } from "../oauth/usage.js";
import type {
  ParserHealth,
  QuarantineRow,
  Settings,
  SettingsUpdate,
  WorkspaceMapping,
} from "./api/settings.js";
import { capWeightExprSql, resolveCapReadCoeff } from "./cap-weighted.js";

// ---------------------------------------------------------------------------
// Calibration result type (ADR-111)
// ---------------------------------------------------------------------------

/** Result of a limit calibration attempt. */
export type CalibrateResult =
  | { ok: true; limit_tokens: number; provenance: string; confidence?: "low" }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Health context — wired by the daemon; zero-filled when not injected
// ---------------------------------------------------------------------------

let _health: Health | null = null;

/** Inject the running Health instance (daemon boot / tests). */
export function setHealthInstance(h: Health): void {
  _health = h;
}

/** Clear the injected Health instance (tests, between cases). */
export function clearHealthInstance(): void {
  _health = null;
}

// Runtime-reset hook — wired by the daemon so resetDatabase can also clear the
// running Ingestor's in-memory caches (offsets/correlation). Zero-op when unset.
let _runtimeReset: (() => void) | null = null;

/** Inject a callback that clears live ingestor runtime state on DB reset (daemon boot / tests). */
export function setRuntimeResetHook(fn: () => void): void {
  _runtimeReset = fn;
}

/** Clear the injected runtime-reset hook (tests, between cases). */
export function clearRuntimeResetHook(): void {
  _runtimeReset = null;
}

function getHealthCounters(): HealthCounters {
  return _health?.snapshot() ?? newHealthCounters();
}

function toParserHealth(c: HealthCounters): ParserHealth {
  return {
    files_seen: c.filesSeen,
    files_parsed: c.filesParsed,
    lines_quarantined: c.linesQuarantined,
    synthetic_excluded: c.syntheticExcluded,
    duplicate_drops: c.duplicateDrops,
    parser_version_mix: c.parserVersionMix,
  };
}

// ---------------------------------------------------------------------------
// user_config key helpers
// ---------------------------------------------------------------------------

function configGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

function configSet(db: Db, key: string, value: string | null): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Explain why a still-unmapped workspace has no GitHub canonical, from DB + a
 * cheap fs check (no subprocess). The auto-mapper (ingestor discovery tick)
 * writes repo_path from the transcript cwd and derives the canonical from the
 * git remote; a row stays unmapped only when one of those inputs is absent.
 */
function deriveMappingReason(repoPath: string | null, discoveredCwd: string | null): string {
  const localPath = repoPath ?? discoveredCwd;
  if (localPath === null) return "No working directory recorded in transcripts yet.";
  if (!fs.existsSync(localPath)) return "Working directory no longer exists locally.";
  return "No GitHub remote detected for this checkout.";
}

function readWorkspaceMappings(db: Db): WorkspaceMapping[] {
  const rows = db
    .prepare(
      "SELECT workspace_id, project_slug, repo_path, repo_owner, repo_name, discovered_cwd FROM workspaces",
    )
    .all() as Array<{
    workspace_id: string;
    project_slug: string;
    repo_path: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    discovered_cwd: string | null;
  }>;

  return rows.map((r) => {
    const isTransient = r.repo_owner === null && r.repo_name === null;
    return {
      workspace_id: r.workspace_id,
      project_slug: r.project_slug,
      repo_path: r.repo_path,
      repo_canonical:
        r.repo_owner !== null && r.repo_name !== null ? `${r.repo_owner}/${r.repo_name}` : null,
      is_transient: isTransient,
      ...(isTransient
        ? { mapping_reason: deriveMappingReason(r.repo_path, r.discovered_cwd) }
        : {}),
    };
  });
}

function readQuarantineRows(db: Db): QuarantineRow[] {
  return db
    .prepare(
      `SELECT file_path, line_no, error_class, seen_at
       FROM ingest_quarantine
       ORDER BY seen_at DESC, q_id DESC
       LIMIT 100`,
    )
    .all() as QuarantineRow[];
}

/**
 * Assemble the full Settings payload from the DB and daemon config.
 * Parser health counters come from the injected Health instance (zero-filled when absent).
 */
export function getSettingsData(db: Db): Settings {
  const cfg = loadConfig();

  // Overlay DB-persisted values over daemon defaults
  const scanRootsRaw = configGet(db, "scan_roots");
  let scanRoots: string[];
  if (scanRootsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(scanRootsRaw);
      // Degrade a corrupt/wrong-typed value (e.g. hand-edited DB) to daemon
      // defaults rather than throwing — a getSettings/reset return-read must
      // never hard-fail — and never surface a non-array as scan_roots.
      scanRoots = Array.isArray(parsed) ? (parsed as string[]) : cfg.scanRoots;
    } catch {
      scanRoots = cfg.scanRoots;
    }
  } else {
    scanRoots = cfg.scanRoots;
  }

  const windowRaw = configGet(db, "activity_window_secs");
  const activityWindowSecs: number =
    windowRaw !== null ? Number(windowRaw) : cfg.activityWindowSecs;

  const limitRaw = configGet(db, "limit_tokens");
  const limitTokens: number | null = limitRaw !== null ? Number(limitRaw) : null;

  // Provenance (ADR-111): "calibrated {date} @ {util}%" or "manual".
  // Only meaningful when limit_tokens is set; null when limit is unset.
  const limitProvenanceRaw = configGet(db, "limit_provenance");
  const limitProvenance: string | null =
    limitTokens !== null ? (limitProvenanceRaw ?? "manual") : null;

  // When the weekly window resets (stored at calibration time; null if never calibrated).
  const limitResetsAt = configGet(db, "limit_resets_at");

  const lastResetAt = configGet(db, "last_reset_at");

  // R12 — bytes→token calibration fields
  const bptEnabled = configGet(db, "bytes_per_token_calibration_enabled") === "true";
  const bptRaw = configGet(db, "bytes_per_token");
  const bptMeasuredAt = configGet(db, "bytes_per_token_measured_at");
  const bptProvenance = configGet(db, "bytes_per_token_provenance");
  const bpt: number | null =
    bptRaw !== null && Number.isFinite(Number(bptRaw)) ? Number(bptRaw) : null;

  return {
    db_path: cfg.dbPath,
    scan_roots: scanRoots,
    port: cfg.port,
    activity_window_secs: activityWindowSecs,
    limit_tokens: limitTokens,
    limit_provenance: limitProvenance,
    limit_resets_at: limitResetsAt,
    workspace_mappings: readWorkspaceMappings(db),
    parser_health: toParserHealth(getHealthCounters()),
    quarantine_rows: readQuarantineRows(db),
    last_reset_at: lastResetAt,
    bytes_per_token_calibration_enabled: bptEnabled,
    bytes_per_token: bpt,
    bytes_per_token_provenance: bptProvenance,
    bytes_per_token_measured_at: bptMeasuredAt,
  };
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Parse an "owner/repo" canonical into its parts, or null when malformed.
 * Valid = exactly one "/" with a non-empty owner and non-empty repo.
 */
function parseRepoCanonical(canonical: string): { owner: string; name: string } | null {
  const slash = canonical.indexOf("/");
  if (slash <= 0) return null; // no slash, or leading slash (empty owner)
  const owner = canonical.slice(0, slash);
  const name = canonical.slice(slash + 1);
  if (name.length === 0 || name.includes("/")) return null; // empty or extra slash
  return { owner, name };
}

/**
 * Check that every root is an absolute path that exists and is a directory.
 * Returns an error string on the first failure, null on success.
 */
export function validateScanRoots(roots: string[]): string | null {
  for (const root of roots) {
    if (!path.isAbsolute(root)) {
      return `Scan root "${root}" is not an absolute path.`;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return `Scan root "${root}" does not exist.`;
    }
    if (!stat.isDirectory()) {
      return `Scan root "${root}" is not a directory.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Apply a partial settings update and persist to the DB.
 *
 * Returns the updated Settings on success, or throws an Error on validation failure.
 * Persistence is in a single transaction — either all fields update or none do.
 *
 * @throws {Error} When scan_roots contains an invalid path.
 */
export function applySettingsUpdate(db: Db, update: SettingsUpdate): Settings {
  // Validate scan roots before writing anything
  if (update.scan_roots !== undefined) {
    const err = validateScanRoots(update.scan_roots);
    if (err !== null) {
      throw new Error(err);
    }
  }

  // Validate any non-empty repo_canonical shape before writing anything
  if (update.workspace_mappings !== undefined) {
    for (const m of update.workspace_mappings) {
      if (
        m.repo_canonical !== null &&
        m.repo_canonical !== undefined &&
        m.repo_canonical !== "" &&
        parseRepoCanonical(m.repo_canonical) === null
      ) {
        throw new Error(`Canonical "${m.repo_canonical}" must be in "owner/repo" form.`);
      }
    }
  }

  db.transaction(() => {
    if (update.limit_tokens !== undefined) {
      configSet(
        db,
        "limit_tokens",
        update.limit_tokens !== null ? String(update.limit_tokens) : null,
      );
      // Track provenance: manual entry clears any prior calibration label (ADR-111).
      if (update.limit_tokens !== null) {
        configSet(db, "limit_provenance", "manual");
      } else {
        configSet(db, "limit_provenance", null);
        configSet(db, "limit_resets_at", null);
      }
    }
    if (update.scan_roots !== undefined) {
      configSet(db, "scan_roots", JSON.stringify(update.scan_roots));
    }
    if (update.activity_window_secs !== undefined) {
      configSet(db, "activity_window_secs", String(update.activity_window_secs));
    }
    // R12 — opt-in calibration toggle
    if (update.bytes_per_token_calibration_enabled !== undefined) {
      configSet(
        db,
        "bytes_per_token_calibration_enabled",
        update.bytes_per_token_calibration_enabled ? "true" : null,
      );
    }
    if (update.workspace_mappings !== undefined) {
      const stmt = db.prepare(
        `UPDATE workspaces
         SET repo_path = ?, repo_owner = ?, repo_name = ?
         WHERE workspace_id = ?`,
      );
      for (const m of update.workspace_mappings) {
        let owner: string | null = null;
        let name: string | null = null;
        if (
          m.repo_canonical !== null &&
          m.repo_canonical !== undefined &&
          m.repo_canonical !== ""
        ) {
          const parsed = parseRepoCanonical(m.repo_canonical);
          // Shape already validated above; parsed is non-null here.
          if (parsed !== null) {
            owner = parsed.owner;
            name = parsed.name;
          }
        }
        const info = stmt.run(
          m.repo_path !== undefined ? m.repo_path : null,
          owner,
          name,
          m.workspace_id,
        );
        if (info.changes === 0) {
          throw new Error(`Unknown workspace "${m.workspace_id}" — nothing was saved.`);
        }
      }
    }
  })();

  return getSettingsData(db);
}

// ---------------------------------------------------------------------------
// Calibration (ADR-111)
// ---------------------------------------------------------------------------

/** Seven-day nominal window duration (ms) for deriving window_start from resets_at. */
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Auto-calibrate `:limit_tokens` from the oauth/usage endpoint (ADR-111).
 *
 * Formula: limit_tokens ≈ tokens_in_window / seven_day.utilization
 * where tokens_in_window is the CAP-WEIGHTED token metric (Data Model §2A cap
 * meter, reusing `capWeightExprSql`) over the current weekly window — cache
 * reads × COEFF (default 0.1, UNVERIFIED), everything else full weight. All
 * turns including provisional are counted (burn = all compute engaged). The
 * derived limit is therefore on the same cap-weighted scale as the forecast's
 * tokens_used, keeping the two comparable.
 *
 * Guards (mandatory per ADR-111):
 *  - utilization < 0.02 → refuse; < 0.10 proceeds with low confidence.
 *  - any non-200 from oauth/usage → return ok:false, never throw or block.
 *
 * The `reader` parameter is injectable for tests; defaults to fetchOAuthUsage().
 */
export async function calibrateLimit(
  db: Db,
  reader: UsageReader = fetchOAuthUsage,
): Promise<CalibrateResult> {
  // 1. Fetch utilization
  let usage: Awaited<ReturnType<UsageReader>>;
  try {
    usage = await reader();
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `oauth/usage reader failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!usage.ok) {
    return { ok: false, reason: usage.reason };
  }

  const sevenDay = usage.data?.seven_day;
  if (sevenDay === undefined || sevenDay === null) {
    return { ok: false, reason: "oauth/usage did not return a seven_day period." };
  }
  const { utilization, resets_at: resetsAt } = sevenDay;

  if (!Number.isFinite(utilization) || utilization < 0 || utilization > 1) {
    return { ok: false, reason: "oauth/usage returned an invalid seven_day utilization." };
  }

  // 2. Guard: refuse only when utilization makes the denominator too noisy.
  if (utilization < 0.02) {
    const pct = (utilization * 100).toFixed(1);
    return {
      ok: false,
      reason: `Utilization is only ${pct}% — use Claude Code for a while to build up a reliable reading, then re-calibrate.`,
    };
  }

  const lowConfidence = utilization < 0.1;

  // 3. Window: resets_at minus 7 days (nominal; actual reset cadence may vary).
  if (typeof resetsAt !== "string" || resetsAt.length === 0) {
    return { ok: false, reason: "oauth/usage returned an invalid resets_at timestamp." };
  }
  const resetsAtMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) {
    return { ok: false, reason: "oauth/usage returned an invalid resets_at timestamp." };
  }
  const windowStartIso = new Date(resetsAtMs - SEVEN_DAY_MS).toISOString();

  // 4. Sum CAP-WEIGHTED tokens (Data Model §2A meter: cache reads × COEFF,
  // unverified; input/output/cache-writes full weight) in the window.
  // Half-open interval [window_start, resets_at): the upper bound excludes any
  // turns that landed after the current window reset (e.g. if resets_at is
  // slightly in the past due to clock skew or a just-rolled window).
  const coeff = resolveCapReadCoeff(db);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${capWeightExprSql("turns", coeff)}), 0) AS tok
         FROM turns
        WHERE ts >= ? AND ts < ?`,
    )
    .get(windowStartIso, resetsAt) as { tok: number };

  const tokensInWindow = row.tok;
  if (!Number.isFinite(tokensInWindow) || tokensInWindow <= 0) {
    return {
      ok: false,
      reason:
        "No local token usage exists in the calibration window; record local usage before calibrating.",
    };
  }
  const limitTokens = Math.round(tokensInWindow / utilization);

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const provenance = `calibrated ${date} @ ${(utilization * 100).toFixed(1)}%; cap-weighted (cache reads ×${coeff} COEFF, unverified)`;

  const calibratedProvenance = `${provenance}${lowConfidence ? " — LOW CONFIDENCE (<10% utilization; re-calibrate after ~10% for a stable number)" : ""}`;

  // 5. Persist atomically.
  db.transaction(() => {
    configSet(db, "limit_tokens", String(limitTokens));
    configSet(db, "limit_provenance", calibratedProvenance);
    configSet(db, "limit_resets_at", resetsAt);
  })();

  return {
    ok: true,
    limit_tokens: limitTokens,
    provenance: calibratedProvenance,
    ...(lowConfidence ? { confidence: "low" as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/**
 * Ingested data tables wiped by resetDatabase, in FK-safe order
 * (dependents before parents). Kept as an exported literal so a drift-guard
 * test can assert it stays in sync with the schema as migrations add tables.
 */
export const RESET_DATA_TABLES = [
  "reports",
  "apply_jobs",
  "recommendation_effects",
  "recommendations",
  "analysis_runs",
  "session_work_links",
  "observed_outcomes",
  "review_findings",
  "work_item_branch_keys",
  "work_items",
  "tool_event_metadata",
  "tool_events",
  "turns",
  "session_churn",
  "sessions",
  "context_inventory",
  "context_inventory_history",
  "workspaces",
  "ingest_quarantine",
  "ingest_offsets",
] as const;

/**
 * Tables intentionally NOT wiped by resetDatabase:
 *   - user_config / schema_migrations: config + schema, preserved by contract.
 *   - pricing_snapshots: seeded reference data (Ingestor re-seeds it once at boot
 *     and caches snapshot_ids for the process lifetime). Wiping it while the
 *     daemon runs would orphan those cached ids and make the next re-ingested
 *     turn violate the turns.pricing_snapshot_id FK; it is not ingested session data.
 */
export const RESET_PRESERVED_TABLES = [
  "user_config",
  "schema_migrations",
  "pricing_snapshots",
] as const;

/**
 * Full data-table wipe (preserves RESET_PRESERVED_TABLES).
 * Executes in a single transaction; sets last_reset_at in user_config.
 * Returns fresh settings after the reset.
 */
export function resetDatabase(db: Db): Settings {
  db.transaction(() => {
    for (const table of RESET_DATA_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    configSet(db, "last_reset_at", new Date().toISOString());
  })();

  // Coordinate with a live ingestor (if wired): clear its in-memory caches so a
  // reset on a running daemon re-ingests faithfully rather than lossily.
  _runtimeReset?.();

  return getSettingsData(db);
}
