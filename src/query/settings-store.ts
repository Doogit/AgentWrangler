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
import { resolveScanRoots } from "../daemon/scan-roots.js";
import type { Db } from "../db/open.js";
import { getHistoryCoverage, getPipelineStatus } from "../ingest/boot-progress.js";
import { bumpEnrichmentEpoch } from "../ingest/enrichment-epoch.js";
import type { Health } from "../ingest/health.js";
import type { HealthCounters } from "../ingest/types.js";
import { newHealthCounters } from "../ingest/types.js";
import type { UsageReader } from "../oauth/usage.js";
import type {
  ParserHealth,
  QuarantineRow,
  Settings,
  SettingsUpdate,
  WorkspaceMapping,
} from "./api/settings.js";
import { capWeightExprSql, resolveCapReadCoeff } from "./cap-weighted.js";
import { readStatuslineUsage } from "./limits/statusline.js";
import { USAGE_CLI_ENABLED_KEY } from "./limits/usage-sources.js";

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

/** The parser-health part of Settings alone: in-memory counters, no DB or disk reads. */
export function getParserHealth(): ParserHealth {
  return toParserHealth(getHealthCounters());
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

export function configGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function configSet(db: Db, key: string, value: string | null): void {
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
  const scanRoots = resolveScanRoots(configGet(db, "scan_roots"), cfg.scanRoots);

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
    cap_read_coeff: resolveCapReadCoeff(db),
    workspace_mappings: readWorkspaceMappings(db),
    parser_health: toParserHealth(getHealthCounters()),
    quarantine_rows: readQuarantineRows(db),
    last_reset_at: lastResetAt,
    bytes_per_token_calibration_enabled: bptEnabled,
    bytes_per_token: bpt,
    bytes_per_token_provenance: bptProvenance,
    bytes_per_token_measured_at: bptMeasuredAt,
    usage_cli_enabled: configGet(db, USAGE_CLI_ENABLED_KEY) !== "false",
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
  if (
    update.cap_read_coeff !== undefined &&
    (!Number.isFinite(update.cap_read_coeff) ||
      update.cap_read_coeff <= 0 ||
      update.cap_read_coeff > 1)
  ) {
    throw new Error("Cache-read cap coefficient must be greater than 0 and at most 1.");
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
    if (update.cap_read_coeff !== undefined) {
      configSet(db, "cap_read_coeff", String(update.cap_read_coeff));
    }
    // R12 — opt-in calibration toggle
    if (update.bytes_per_token_calibration_enabled !== undefined) {
      configSet(
        db,
        "bytes_per_token_calibration_enabled",
        update.bytes_per_token_calibration_enabled ? "true" : null,
      );
    }
    if (update.usage_cli_enabled !== undefined) {
      configSet(db, USAGE_CLI_ENABLED_KEY, update.usage_cli_enabled ? "true" : "false");
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

/** How much local history is ingested: `loading` while the boot backfill runs. */
export interface HistoryState {
  loading: boolean;
  /** Every turn from here on is ingested (ms); null until the newest week is done. */
  completeThroughMs: number | null;
}

function currentHistoryState(): HistoryState {
  const pipeline = getPipelineStatus();
  return {
    loading: pipeline !== null && pipeline.phase !== "done" && pipeline.failed_phase === null,
    completeThroughMs: getHistoryCoverage()?.complete_through_ms ?? null,
  };
}

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
 *  - history still loading and the window not yet fully ingested → refuse
 *    (REL-FIX: a mid-backfill calibration stored 120,281 against ~119M).
 *
 * `reader` and `history` are injectable for tests; `reader` defaults to the statusline reader (OAUTH-1).
 */
export async function calibrateLimit(
  db: Db,
  reader: UsageReader = () => readStatuslineUsage(),
  history: () => HistoryState = currentHistoryState,
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
  const windowStartMs = resetsAtMs - SEVEN_DAY_MS;
  const windowStartIso = new Date(windowStartMs).toISOString();

  // The local sum is only meaningful once every turn in the window is ingested.
  const hist = history();
  if (hist.loading && (hist.completeThroughMs === null || hist.completeThroughMs > windowStartMs)) {
    return {
      ok: false,
      reason:
        "Local history is still loading, so this week's usage is incomplete. Calibrate again once loading finishes.",
    };
  }

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
  "hre_intervention_locks",
  "hre_effect_cycle_links",
  "hre_measurement_methods",
  "hre_artifact_applications",
  "hre_artifact_revisions",
  "hre_recommendation_lifecycle_events",
  "hre_recommendation_findings",
  "hre_recommendation_revisions",
  "hre_recommendations",
  "hre_findings",
  "hre_ceu_pools",
  "hre_composition_snapshots",
  "hre_capability_observations",
  "hre_capability_profiles",
  "hre_handler_retirements",
  "hre_handler_history",
  "effect_mutation_keys",
  "effect_rollback_operations",
  "effect_guardrail_results",
  "effect_cycles",
  "work_session_allocations",
  "work_allocation_record_snapshots",
  "work_allocation_revisions",
  "work_record_context_refs",
  "work_record_session_links",
  "work_record_revisions",
  "work_record_mutations",
  "work_record_tombstones",
  "work_records",
  "recommendation_effects",
  "recommendation_lifecycle_actions",
  "recommendation_goal_preference",
  "recommendations",
  "detector_status_live",
  "detector_week_results",
  "detector_week_marks",
  "detector_eval_marks",
  "detector_quarantine",
  "setup_grade_snapshots",
  "judge_verdicts",
  "ledger_daily",
  "ledger_daily_top",
  "ledger_daily_sessions",
  "ledger_daily_marks",
  "analysis_runs",
  "session_work_links",
  "observed_outcomes",
  "review_findings",
  "work_item_branch_keys",
  "work_items",
  "subagent_meta",
  "tool_event_content",
  "tool_event_metadata",
  "tool_event_skills",
  "tool_events",
  "turns",
  "session_churn",
  "sessions",
  "context_inventory",
  "context_inventory_history",
  "catalog_items",
  "workspaces",
  "ingest_quarantine",
  "ingest_metric_events",
  "ingest_metric_baselines",
  "ingest_classifier_baselines",
  "ingest_offsets",
] as const;

/**
 * Tables intentionally NOT wiped by resetDatabase:
 *   - user_config / schema_migrations: config + schema, preserved by contract.
 *   - pricing_snapshots: seeded reference data (Ingestor re-seeds it once at boot
 *     and caches snapshot_ids for the process lifetime). Wiping it while the
 *     daemon runs would orphan those cached ids and make the next re-ingested
 *     turn violate the turns.pricing_snapshot_id FK; it is not ingested session data.
 *   - limit_snapshots: past Anthropic limit readings; re-ingesting transcripts can't recover them.
 *   - recommendation_feedback: the user's own relevance verdicts (keyed by opaque identity,
 *     not rec_id); re-ingesting transcripts can't recover them.
 *
 * Rule: a reset never destroys what transcripts can't rebuild. Acted-on recs (any state but
 * PROPOSED/RETIRED) and the rows hanging off them are kept by RESET_KEEP_ROWS below; the
 * detector upsert leaves their state/adopted_at alone when re-ingest re-emits them.
 */
export const RESET_PRESERVED_TABLES = [
  "user_config",
  "schema_migrations",
  "pricing_snapshots",
  "limit_snapshots",
  "recommendation_feedback",
] as const;

const KEPT_RECS = "SELECT rec_id FROM recommendations WHERE state NOT IN ('PROPOSED','RETIRED')";
const KEPT_CYCLES = `SELECT cycle_id FROM effect_cycles WHERE rec_id IN (${KEPT_RECS})`;

/**
 * Rows of RESET_DATA_TABLES that survive a reset: acted-on recs, their effect cycles
 * (+ children), apply jobs, legacy effects, lifecycle actions, and the analysis runs
 * they cite. Parents are deleted after children, so these subqueries still see them.
 * hre_effect_cycle_links is wiped with the rest of hre_*; a kept cycle loses only that bridge.
 */
const RESET_KEEP_ROWS: Partial<Record<(typeof RESET_DATA_TABLES)[number], string>> = {
  apply_jobs: `rec_id IN (${KEPT_RECS})`,
  effect_mutation_keys: `cycle_id IN (${KEPT_CYCLES})`,
  effect_rollback_operations: `cycle_id IN (${KEPT_CYCLES})`,
  effect_guardrail_results: `cycle_id IN (${KEPT_CYCLES})`,
  effect_cycles: `rec_id IN (${KEPT_RECS})`,
  recommendation_effects: `rec_id IN (${KEPT_RECS})`,
  recommendation_lifecycle_actions: `rec_id IN (${KEPT_RECS})`,
  recommendations: "state NOT IN ('PROPOSED','RETIRED')",
  analysis_runs:
    // IS NOT NULL: a NULL in the IN-set would make NOT(...) NULL and keep every row.
    "run_id IN (SELECT analysis_run_id FROM recommendations WHERE analysis_run_id IS NOT NULL" +
    " UNION SELECT run_id FROM apply_jobs WHERE run_id IS NOT NULL)",
};

/**
 * Data-table wipe (preserves RESET_PRESERVED_TABLES and RESET_KEEP_ROWS).
 * Executes in a single transaction; sets last_reset_at in user_config.
 * Returns fresh settings after the reset.
 */
export function resetDatabase(db: Db): Settings {
  db.transaction(() => {
    for (const table of RESET_DATA_TABLES) {
      const keep = RESET_KEEP_ROWS[table];
      db.prepare(`DELETE FROM ${table}${keep ? ` WHERE NOT (${keep})` : ""}`).run();
    }
    bumpEnrichmentEpoch(db); // the wipe is re-ingested into the same windows
    configSet(db, "last_reset_at", new Date().toISOString());
  })();

  // Coordinate with a live ingestor (if wired): clear its in-memory caches so a
  // reset on a running daemon re-ingests faithfully rather than lossily.
  _runtimeReset?.();

  return getSettingsData(db);
}
