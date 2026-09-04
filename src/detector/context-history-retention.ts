import { performance } from "node:perf_hooks";
import type { Db } from "../db/open.js";
import { GLOBAL_WORKSPACE_ID } from "./context-probe.js";
import { isD1SourceBackedRecommendation, parseD1SourceIdentity } from "./d1-source-identity.js";
import { AFTER_WINDOW_DAYS } from "./measurement.js";

export const CONTEXT_HISTORY_RETENTION_VERSION = "context-history-retention-v1";
export const DEFAULT_CONTEXT_HISTORY_RETENTION_POLICY = Object.freeze({
  maxAgeDays: 90,
  maxUnprotectedRowsPerSource: 64,
});

export interface ContextHistoryRetentionPolicy {
  maxAgeDays: number;
  maxUnprotectedRowsPerSource: number;
}

export interface ContextHistoryRetentionSummary {
  policy_version: typeof CONTEXT_HISTORY_RETENTION_VERSION;
  mode: "inspect" | "compact";
  started_at: string;
  source_n: number;
  rows_before: number;
  latest_protected_n: number;
  open_window_protected_n: number;
  recent_retained_n: number;
  count_retained_n: number;
  delete_candidate_n: number;
  rows_deleted: number;
  rows_after: number;
  malformed_open_effect_n: number;
  duration_ms: number;
  failure_class: string | null;
}

export interface ContextHistoryRetentionInspection {
  ok: boolean;
  summary: ContextHistoryRetentionSummary;
  /** Ephemeral deterministic row IDs for fixture validation; never log or persist. */
  candidate_ids: number[];
}

export interface ContextHistoryRetentionCompaction {
  ok: boolean;
  summary: ContextHistoryRetentionSummary;
}

type Component = "CLAUDE_MD" | "RULES" | "MCP_SCHEMAS" | "SETTINGS_SYSTEM" | "MEMORY" | "OTHER";

interface HistoryRow {
  id: number;
  workspace_id: string;
  component: string;
  file_ref: string;
  observed_at: string;
}

interface ValidHistoryRow extends HistoryRow {
  component: Component;
  observedMs: number;
  sourceKey: string;
}

interface OpenEffect {
  sourceKey: string;
  beforeToMs: number;
  afterFromMs: number;
  afterToMs: number;
}

interface Plan {
  candidateIds: number[];
  latestIds: number[];
  summary: ContextHistoryRetentionSummary;
}

const COMPONENTS = new Set<Component>([
  "CLAUDE_MD",
  "RULES",
  "MCP_SCHEMAS",
  "SETTINGS_SYSTEM",
  "MEMORY",
  "OTHER",
]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETE_CHUNK_SIZE = 500;

class RetentionPlanError extends Error {
  constructor(
    readonly failureClass: string,
    readonly malformedOpenEffectN = 0,
  ) {
    super(failureClass);
  }
}

function sourceKey(workspaceId: string, component: Component, fileRef: string): string {
  return JSON.stringify([workspaceId, component, fileRef]);
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null;
  return ms;
}

function validateInputs(
  now: Date,
  policy: ContextHistoryRetentionPolicy,
): { nowMs: number; startedAt: string } {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RetentionPlanError("invalid_clock");
  if (
    !Number.isSafeInteger(policy.maxAgeDays) ||
    policy.maxAgeDays <= 0 ||
    !Number.isSafeInteger(policy.maxAgeDays * MS_PER_DAY) ||
    !Number.isSafeInteger(policy.maxUnprotectedRowsPerSource) ||
    policy.maxUnprotectedRowsPerSource < 0
  ) {
    throw new RetentionPlanError("invalid_policy");
  }
  return { nowMs, startedAt: now.toISOString() };
}

function validateHistoryRows(db: Db): ValidHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, component, file_ref, observed_at
         FROM context_inventory_history
        ORDER BY id ASC`,
    )
    .all() as HistoryRow[];

  return rows.map((row) => {
    const observedMs = canonicalTimestamp(row.observed_at);
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      typeof row.workspace_id !== "string" ||
      row.workspace_id.length === 0 ||
      !COMPONENTS.has(row.component as Component) ||
      typeof row.file_ref !== "string" ||
      row.file_ref.length === 0 ||
      observedMs === null
    ) {
      throw new RetentionPlanError("invalid_history_row");
    }
    const component = row.component as Component;
    return {
      ...row,
      component,
      observedMs,
      sourceKey: sourceKey(row.workspace_id, component, row.file_ref),
    };
  });
}

function readOpenEffects(db: Db): OpenEffect[] {
  const recs = db
    .prepare(
      `SELECT rec_id, detector_id, scope_workspace_id, evidence_json, target_metric, adopted_at
         FROM recommendations
        WHERE state IN ('ADOPTED', 'MEASURING')
        ORDER BY rec_id ASC`,
    )
    .all() as Array<{
    rec_id: string;
    detector_id: string | null;
    scope_workspace_id: string | null;
    evidence_json: string;
    target_metric: string;
    adopted_at: string | null;
  }>;

  const sourceBacked = recs.filter(isD1SourceBackedRecommendation);
  const effects: OpenEffect[] = [];
  let malformedN = 0;

  for (const rec of sourceBacked) {
    const adoptedMs = canonicalTimestamp(rec.adopted_at);
    const identity = parseD1SourceIdentity(rec.evidence_json);
    const component = identity?.component as Component | undefined;
    const workspaceId = rec.scope_workspace_id ?? GLOBAL_WORKSPACE_ID;
    const openRows = db
      .prepare(
        `SELECT measured_at, before_from, before_to, after_from, after_to
           FROM recommendation_effects
          WHERE rec_id = ? AND verdict IS NULL
          ORDER BY measured_at ASC`,
      )
      .all(rec.rec_id) as Array<{
      measured_at: string;
      before_from: string;
      before_to: string;
      after_from: string;
      after_to: string;
    }>;

    if (
      adoptedMs === null ||
      identity === null ||
      identity.fileRef.length === 0 ||
      !COMPONENTS.has(component as Component) ||
      workspaceId.length === 0 ||
      openRows.length !== 1
    ) {
      malformedN++;
      continue;
    }

    const effect = openRows[0];
    if (effect === undefined) {
      malformedN++;
      continue;
    }
    const measuredMs = canonicalTimestamp(effect.measured_at);
    const beforeFromMs = canonicalTimestamp(effect.before_from);
    const beforeToMs = canonicalTimestamp(effect.before_to);
    const afterFromMs = canonicalTimestamp(effect.after_from);
    const afterToMs = canonicalTimestamp(effect.after_to);
    if (
      measuredMs === null ||
      beforeFromMs === null ||
      beforeToMs === null ||
      afterFromMs === null ||
      afterToMs === null ||
      effect.measured_at !== rec.adopted_at ||
      measuredMs !== adoptedMs ||
      beforeFromMs > beforeToMs ||
      beforeToMs !== adoptedMs ||
      afterFromMs !== adoptedMs ||
      afterToMs !== adoptedMs + AFTER_WINDOW_DAYS * MS_PER_DAY
    ) {
      malformedN++;
      continue;
    }

    effects.push({
      sourceKey: sourceKey(workspaceId, component as Component, identity.fileRef),
      beforeToMs,
      afterFromMs,
      afterToMs,
    });
  }

  if (malformedN > 0) throw new RetentionPlanError("invalid_open_effect", malformedN);
  return effects;
}

function emptySummary(
  mode: "inspect" | "compact",
  startedAt: string,
  failureClass: string | null,
  malformedOpenEffectN = 0,
): ContextHistoryRetentionSummary {
  return {
    policy_version: CONTEXT_HISTORY_RETENTION_VERSION,
    mode,
    started_at: startedAt,
    source_n: 0,
    rows_before: 0,
    latest_protected_n: 0,
    open_window_protected_n: 0,
    recent_retained_n: 0,
    count_retained_n: 0,
    delete_candidate_n: 0,
    rows_deleted: 0,
    rows_after: 0,
    malformed_open_effect_n: malformedOpenEffectN,
    duration_ms: 0,
    failure_class: failureClass,
  };
}

function planRetention(
  db: Db,
  now: Date,
  policy: ContextHistoryRetentionPolicy,
  mode: "inspect" | "compact",
): Plan {
  const { nowMs, startedAt } = validateInputs(now, policy);
  const rows = validateHistoryRows(db);
  const effects = readOpenEffects(db);
  const bySource = new Map<string, ValidHistoryRow[]>();
  for (const row of rows) {
    const group = bySource.get(row.sourceKey);
    if (group === undefined) bySource.set(row.sourceKey, [row]);
    else group.push(row);
  }
  for (const group of bySource.values()) {
    group.sort((a, b) => b.observedMs - a.observedMs || b.id - a.id);
  }

  const latestIds = new Set<number>();
  for (const group of bySource.values()) {
    const latest = group[0];
    if (latest === undefined) throw new RetentionPlanError("latest_invariant");
    latestIds.add(latest.id);
  }

  const openWindowIds = new Set<number>();
  for (const effect of effects) {
    const group = bySource.get(effect.sourceKey) ?? [];
    const baseline = group.find((row) => row.observedMs <= effect.beforeToMs);
    if (baseline !== undefined) openWindowIds.add(baseline.id);
    for (const row of group) {
      if (row.observedMs > effect.afterFromMs && row.observedMs <= effect.afterToMs) {
        openWindowIds.add(row.id);
      }
    }
  }

  const cutoffMs = nowMs - policy.maxAgeDays * MS_PER_DAY;
  const recentIds = new Set<number>();
  const ordinaryRetainedIds = new Set<number>();
  const candidateIds: number[] = [];
  for (const group of bySource.values()) {
    const unprotected = group.filter((row) => !latestIds.has(row.id) && !openWindowIds.has(row.id));
    for (const row of unprotected) {
      if (row.observedMs >= cutoffMs) recentIds.add(row.id);
    }
    for (const row of unprotected.slice(0, policy.maxUnprotectedRowsPerSource)) {
      if (row.observedMs >= cutoffMs) ordinaryRetainedIds.add(row.id);
    }
    for (const row of unprotected) {
      if (!ordinaryRetainedIds.has(row.id)) candidateIds.push(row.id);
    }
  }
  candidateIds.sort((a, b) => a - b);
  const summary: ContextHistoryRetentionSummary = {
    ...emptySummary(mode, startedAt, null),
    source_n: bySource.size,
    rows_before: rows.length,
    latest_protected_n: latestIds.size,
    open_window_protected_n: openWindowIds.size,
    recent_retained_n: recentIds.size,
    count_retained_n: ordinaryRetainedIds.size,
    delete_candidate_n: candidateIds.length,
    rows_after: rows.length,
  };
  return { candidateIds, latestIds: [...latestIds].sort((a, b) => a - b), summary };
}

function failureSummary(
  mode: "inspect" | "compact",
  now: Date,
  error: unknown,
  attempted?: ContextHistoryRetentionSummary,
): ContextHistoryRetentionSummary {
  const retentionError = error instanceof RetentionPlanError ? error : null;
  const startedAt = Number.isFinite(now.getTime()) ? now.toISOString() : "";
  return {
    ...(attempted ??
      emptySummary(
        mode,
        startedAt,
        retentionError?.failureClass ?? "database_error",
        retentionError?.malformedOpenEffectN ?? 0,
      )),
    mode,
    rows_deleted: 0,
    rows_after: attempted?.rows_before ?? 0,
    malformed_open_effect_n:
      retentionError?.malformedOpenEffectN ?? attempted?.malformed_open_effect_n ?? 0,
    failure_class: retentionError?.failureClass ?? "database_error",
  };
}

function withDuration(
  summary: ContextHistoryRetentionSummary,
  startedAtMs: number,
): ContextHistoryRetentionSummary {
  return {
    ...summary,
    duration_ms: Math.max(0, Math.round(performance.now() - startedAtMs)),
  };
}

export function inspectContextHistoryRetention(
  db: Db,
  now: Date,
  policy: ContextHistoryRetentionPolicy = DEFAULT_CONTEXT_HISTORY_RETENTION_POLICY,
): ContextHistoryRetentionInspection {
  const startedAtMs = performance.now();
  try {
    const plan = planRetention(db, now, policy, "inspect");
    return {
      ok: true,
      summary: withDuration(plan.summary, startedAtMs),
      candidate_ids: plan.candidateIds,
    };
  } catch (error) {
    return {
      ok: false,
      summary: withDuration(failureSummary("inspect", now, error), startedAtMs),
      candidate_ids: [],
    };
  }
}

export function compactContextHistory(
  db: Db,
  now: Date,
  policy: ContextHistoryRetentionPolicy = DEFAULT_CONTEXT_HISTORY_RETENTION_POLICY,
): ContextHistoryRetentionCompaction {
  const startedAtMs = performance.now();
  let attempted: ContextHistoryRetentionSummary | undefined;
  try {
    const run = db.transaction(() => {
      const plan = planRetention(db, now, policy, "compact");
      attempted = plan.summary;
      let rowsDeleted = 0;
      for (let offset = 0; offset < plan.candidateIds.length; offset += DELETE_CHUNK_SIZE) {
        const chunk = plan.candidateIds.slice(offset, offset + DELETE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const result = db
          .prepare(`DELETE FROM context_inventory_history WHERE id IN (${placeholders})`)
          .run(...chunk);
        rowsDeleted += result.changes;
      }
      if (rowsDeleted !== plan.candidateIds.length) {
        throw new RetentionPlanError("delete_count_invariant");
      }
      const rowsAfter = (
        db.prepare("SELECT COUNT(*) AS n FROM context_inventory_history").get() as { n: number }
      ).n;
      if (rowsAfter !== plan.summary.rows_before - rowsDeleted) {
        throw new RetentionPlanError("row_count_invariant");
      }
      for (const latestId of plan.latestIds) {
        const retained = db
          .prepare("SELECT 1 AS present FROM context_inventory_history WHERE id = ?")
          .get(latestId) as { present: number } | undefined;
        if (retained === undefined) throw new RetentionPlanError("latest_invariant");
      }
      return {
        ...plan.summary,
        rows_deleted: rowsDeleted,
        rows_after: rowsAfter,
      } satisfies ContextHistoryRetentionSummary;
    });
    return { ok: true, summary: withDuration(run.immediate(), startedAtMs) };
  } catch (error) {
    return {
      ok: false,
      summary: withDuration(failureSummary("compact", now, error, attempted), startedAtMs),
    };
  }
}
