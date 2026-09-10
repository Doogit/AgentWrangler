import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { analyzeD7LoopEvents } from "../detector/d7-loop-analysis.js";
import { PREMIUM_MODEL_SQL } from "../ingest/pricing.js";
import { findHandler } from "./registry.js";
import { effectEventSourceIdentity, effectToolIdentity } from "./scope-identity.js";
import type {
  AggregateEvidence,
  EffectCycle,
  GuardrailObservation,
  MixSummary,
  ObservationBundle,
  ObservationProvider,
  ObservationWindow,
} from "./types.js";
import { EFFECT_QUERY_VERSION } from "./types.js";

export interface ResolvedSourceIdentity {
  workspaceId: string;
  component: string;
  fileRef: string;
}

export interface SqlObserverOptions {
  /** Resolve an opaque D1 identity at query time. Returned path data is never persisted. */
  resolveSourceIdentity?: (opaqueIdentity: string) => ResolvedSourceIdentity | null;
}

interface SessionFloorRow {
  session_id: string;
  floor_value: number;
}

interface ScopedEventRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  session_last_turn_at: string | null;
  ts: string;
  tool_name: string;
  result_bytes: number | null;
  input_hash: string | null;
  exit_class: string | null;
  file_path_hash: string | null;
  owner_message_id: string | null;
  block_index: number | null;
  is_test_command: number | null;
  metadata_rows: number;
  owner_rows: number;
  owner_session_id: string | null;
  owner_workspace_id: string | null;
  owner_ts: string | null;
  owner_provisional: number | null;
  owner_model: string | null;
  owner_parser_version: string | null;
  eligible: boolean;
  sourceMatchingWrite: boolean;
}

interface ScopedWindowData {
  rows: ScopedEventRow[];
  eligibleRows: ScopedEventRow[];
  eligibleSessionIds: Set<string>;
  eligibleOwnerIds: Set<string>;
  excluded: Record<string, number>;
}

const emptyEvidence = (reason: string): AggregateEvidence => ({
  value: null,
  denominator: null,
  exposureN: 0,
  sessionN: 0,
  excluded: { [reason]: 1 },
});

function paramsForScope(window: ObservationWindow, workspaceId: string | null): unknown[] {
  return workspaceId === null ? [window.from, window.to] : [window.from, window.to, workspaceId];
}

function scopeClause(alias: string, workspaceId: string | null): string {
  return workspaceId === null ? "" : ` AND ${alias}.workspace_id = ?`;
}

function quantile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) return undefined;
  return low + (high - low) * (index - lower);
}

function increment(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function inWindow(value: string | null, window: ObservationWindow): boolean {
  if (value === null) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && time >= Date.parse(window.from) && time < Date.parse(window.to);
}

function scopedWindow(db: Db, cycle: EffectCycle, window: ObservationWindow): ScopedWindowData {
  const ws = cycle.scope.workspaceId;
  const raw = db
    .prepare(
      `WITH metadata AS (
         SELECT event_id, COUNT(*) AS metadata_rows,
                MAX(file_path_hash) AS file_path_hash,
                MAX(owner_message_id) AS owner_message_id,
                MAX(block_index) AS block_index,
                MAX(is_test_command) AS is_test_command
           FROM tool_event_metadata GROUP BY event_id
       ), owners AS (
         SELECT message_id, COUNT(*) AS owner_rows,
                MAX(session_id) AS owner_session_id,
                MAX(workspace_id) AS owner_workspace_id,
                MAX(ts) AS owner_ts, MAX(provisional) AS owner_provisional,
                MAX(model) AS owner_model, MAX(parser_version) AS owner_parser_version
           FROM turns GROUP BY message_id
       )
       SELECT e.event_id,e.session_id,s.workspace_id,s.last_turn_at AS session_last_turn_at,
              e.ts,e.tool_name,e.result_bytes,e.input_hash,e.exit_class,
              m.file_path_hash,m.owner_message_id,m.block_index,m.is_test_command,
              COALESCE(m.metadata_rows,0) AS metadata_rows,
              COALESCE(o.owner_rows,0) AS owner_rows,
              o.owner_session_id,o.owner_workspace_id,o.owner_ts,o.owner_provisional,
              o.owner_model,o.owner_parser_version
         FROM sessions s JOIN tool_events e ON e.session_id=s.session_id
         LEFT JOIN metadata m ON m.event_id=e.event_id
         LEFT JOIN owners o ON o.message_id=m.owner_message_id
        WHERE s.state='RECONCILED'
          ${scopeClause("s", ws)}
          AND (strftime('%s',s.last_turn_at) IS NULL OR
               (julianday(s.last_turn_at)>=julianday(?) AND julianday(s.last_turn_at)<julianday(?)))
          AND (strftime('%s',e.ts) IS NULL OR
               (julianday(e.ts)>=julianday(?) AND julianday(e.ts)<julianday(?)))
        ORDER BY e.session_id,e.ts,m.block_index,e.event_id`,
    )
    .all(...(ws === null ? [] : [ws]), window.from, window.to, window.from, window.to) as Array<
    Omit<ScopedEventRow, "eligible" | "sourceMatchingWrite">
  >;

  const excluded: Record<string, number> = {};
  const eligibleSessionIds = new Set<string>();
  const eligibleOwnerIds = new Set<string>();
  const rows = raw.map((row): ScopedEventRow => {
    let reason: string | null = null;
    if (!inWindow(row.session_last_turn_at, window))
      reason = "SESSION_END_INVALID_OR_OUTSIDE_WINDOW";
    else if (!inWindow(row.ts, window)) reason = "EVENT_TIMESTAMP_INVALID_OR_OUTSIDE_WINDOW";
    else if (row.metadata_rows !== 1) reason = "METADATA_ROW_COUNT_INVALID";
    else if (row.owner_rows !== 1 || row.owner_message_id === null)
      reason = "OWNER_ROW_COUNT_INVALID";
    else if (row.owner_session_id !== row.session_id) reason = "OWNER_SESSION_MISMATCH";
    else if (row.owner_workspace_id !== row.workspace_id) reason = "OWNER_WORKSPACE_MISMATCH";
    else if (row.owner_provisional !== 0) reason = "OWNER_PROVISIONAL";
    else if (!inWindow(row.owner_ts, window)) reason = "OWNER_TIMESTAMP_INVALID_OR_OUTSIDE_WINDOW";
    let sourceMatches = cycle.scope.sourceIdentity === undefined;
    if (reason === null && cycle.scope.sourceIdentity !== undefined) {
      if (row.file_path_hash === null) reason = "SOURCE_IDENTITY_UNAVAILABLE";
      else {
        sourceMatches =
          effectEventSourceIdentity(row.workspace_id, row.file_path_hash) ===
          cycle.scope.sourceIdentity;
        if (!sourceMatches) reason = "SOURCE_IDENTITY_MISMATCH";
      }
    }
    if (reason === null && cycle.scope.tool !== undefined) {
      try {
        if (effectToolIdentity(row.tool_name) !== cycle.scope.tool)
          reason = "TOOL_IDENTITY_MISMATCH";
      } catch {
        reason = "TOOL_IDENTITY_INVALID";
      }
    }
    if (reason !== null) increment(excluded, reason);
    const eligible = reason === null;
    if (eligible) {
      eligibleSessionIds.add(row.session_id);
      if (row.owner_message_id !== null) eligibleOwnerIds.add(row.owner_message_id);
    }
    return {
      ...row,
      eligible,
      sourceMatchingWrite:
        (eligible || reason === "TOOL_IDENTITY_MISMATCH") &&
        sourceMatches &&
        /^(edit|write)$/i.test(row.tool_name) &&
        row.file_path_hash !== null,
    };
  });
  return {
    rows,
    eligibleRows: rows.filter((row) => row.eligible),
    eligibleSessionIds,
    eligibleOwnerIds,
    excluded,
  };
}

function summaryMix(values: Array<string | null>): MixSummary {
  const counts: Record<string, number> = {};
  for (const value of values) if (value !== null) counts[value] = (counts[value] ?? 0) + 1;
  const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(ordered).reduce((sum, count) => sum + count, 0);
  return { available: total > 0, total, counts: ordered };
}

function scopedMix(data: ScopedWindowData, column: "model" | "parser" | "tool"): MixSummary {
  if (column === "tool") return summaryMix(data.eligibleRows.map((row) => row.tool_name));
  const owners = new Map<string, string | null>();
  for (const row of data.eligibleRows)
    if (row.owner_message_id !== null && !owners.has(row.owner_message_id))
      owners.set(
        row.owner_message_id,
        column === "model" ? row.owner_model : row.owner_parser_version,
      );
  return summaryMix([...owners.values()]);
}

function scopedD7(data: ScopedWindowData): AggregateEvidence {
  const bySession = new Map<string, ScopedEventRow[]>();
  for (const row of data.rows) {
    const rows = bySession.get(row.session_id) ?? [];
    rows.push(row);
    bySession.set(row.session_id, rows);
  }
  let sum = 0;
  let sessionN = 0;
  for (const rows of bySession.values()) {
    const eligibleOwners = new Set(
      rows.filter((row) => row.eligible).map((row) => row.owner_message_id as string),
    );
    if (eligibleOwners.size === 0) continue;
    const analysis = analyzeD7LoopEvents(
      rows.map((row) => ({
        event_id: row.event_id,
        tool_name: row.tool_name,
        input_hash: row.input_hash,
        exit_class: row.exit_class,
        file_path_hash: row.file_path_hash,
        eligible: row.eligible,
        source_matching_write: row.sourceMatchingWrite,
      })),
    );
    const flaggedOwners = new Set(
      rows
        .filter((row) => row.eligible && analysis.flaggedEventIds.has(row.event_id))
        .map((row) => row.owner_message_id as string),
    );
    sum += flaggedOwners.size / eligibleOwners.size;
    sessionN++;
  }
  return {
    value: sessionN === 0 || data.eligibleOwnerIds.size === 0 ? null : sum / sessionN,
    denominator: sessionN === 0 ? 0 : sessionN,
    exposureN: data.eligibleOwnerIds.size,
    sessionN,
    excluded: { ...data.excluded, ...(sessionN === 0 ? { NO_ELIGIBLE_SESSIONS: 1 } : {}) },
  };
}

function scopedD2(db: Db, data: ScopedWindowData, window: ObservationWindow): AggregateEvidence {
  if (data.eligibleSessionIds.size === 0)
    return {
      ...emptyEvidence("NO_ELIGIBLE_SESSIONS"),
      excluded: { ...data.excluded, NO_ELIGIBLE_SESSIONS: 1 },
    };
  const rows = db
    .prepare(
      `SELECT t.session_id,t.context_tokens
         FROM turns t JOIN sessions s ON s.session_id=t.session_id
        WHERE s.state='RECONCILED' AND t.provisional=0
          AND t.ts>=? AND t.ts<? ORDER BY t.session_id,t.ts,t.message_id`,
    )
    .all(window.from, window.to) as Array<{ session_id: string; context_tokens: number }>;
  const minima = new Map<string, number>();
  for (const row of rows) {
    if (!data.eligibleSessionIds.has(row.session_id)) continue;
    minima.set(
      row.session_id,
      Math.min(minima.get(row.session_id) ?? Number.POSITIVE_INFINITY, row.context_tokens),
    );
  }
  const values = [...minima.values()].sort((a, b) => a - b);
  if (values.length === 0)
    return {
      ...emptyEvidence("NO_ELIGIBLE_TURNS"),
      excluded: { ...data.excluded, NO_ELIGIBLE_TURNS: 1 },
    };
  const median = quantile(values, 0.5);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    value: values.reduce((sum, value) => sum + value, 0) / values.length,
    denominator: values.length,
    exposureN: values.length,
    sessionN: values.length,
    excluded: data.excluded,
    ...(median === undefined ? {} : { median }),
    ...(q1 === undefined ? {} : { q1 }),
    ...(q3 === undefined ? {} : { q3 }),
  };
}

function scopedGuardrails(
  data: ScopedWindowData,
  definitions: EffectCycle["guardrailDefinitions"],
): GuardrailObservation[] {
  const completed = data.eligibleRows.filter((row) => row.result_bytes !== null);
  const incompleteN = data.eligibleRows.length - completed.length;
  const completedSessions = new Set(completed.map((row) => row.session_id)).size;
  const errors = completed.filter(
    (row) => row.exit_class === "ERROR" || row.exit_class === "TEST_FAIL",
  ).length;
  const completedEvidence: AggregateEvidence = {
    value: completed.length === 0 ? null : errors / completed.length,
    denominator: completed.length,
    exposureN: completed.length,
    sessionN: completedSessions,
    excluded: { ...data.excluded, ...(incompleteN > 0 ? { INCOMPLETE_RESULT: incompleteN } : {}) },
  };
  let recoveryCount = 0;
  const bySession = new Map<string, ScopedEventRow[]>();
  for (const row of completed.filter((event) => event.is_test_command === 1)) {
    const rows = bySession.get(row.session_id) ?? [];
    rows.push(row);
    bySession.set(row.session_id, rows);
  }
  for (const rows of bySession.values()) {
    let failureAt: number | null = null;
    for (const row of rows) {
      const at = Date.parse(row.ts);
      if (row.exit_class === "TEST_FAIL") failureAt = at;
      else if (row.exit_class === "OK" && failureAt !== null && failureAt < at) {
        recoveryCount++;
        failureAt = null;
      }
    }
  }
  const recoveryEvidence: AggregateEvidence = {
    value: recoveryCount,
    denominator: completed.length,
    exposureN: recoveryCount,
    sessionN: completedSessions,
    excluded: completedEvidence.excluded,
  };
  return definitions.map((definition) => {
    if (definition.guardrailId === "completed-tool-error-rate")
      return {
        ...definition,
        availability: "SUPPORTED" as const,
        before: completedEvidence,
        after: completedEvidence,
        direction: "INSUFFICIENT_DATA" as const,
        reasonCodes: [],
        evidence: {},
      };
    if (definition.guardrailId === "strict-test-recovery-sequences")
      return {
        ...definition,
        availability: "SUPPORTED" as const,
        before: recoveryEvidence,
        after: recoveryEvidence,
        direction: "STABLE" as const,
        reasonCodes: ["DESCRIPTIVE_ONLY"],
        evidence: { directional: false },
      };
    return unsupportedGuardrail(
      definition.guardrailId,
      definition.methodVersion,
      definition.unit,
      definition.guardrailId === "interruption-burden"
        ? "INTERRUPTS_UNSUPPORTED"
        : "GUARDRAIL_UNSUPPORTED",
    );
  });
}

function floorContext(
  db: Db,
  window: ObservationWindow,
  workspaceId: string | null,
): AggregateEvidence {
  const rows = db
    .prepare(
      `SELECT s.session_id, MIN(t.context_tokens) AS floor_value
         FROM sessions s
         JOIN turns t ON t.session_id = s.session_id AND t.provisional = 0
        WHERE s.state = 'RECONCILED'
          AND s.last_turn_at >= ? AND s.last_turn_at < ?
          ${scopeClause("s", workspaceId)}
        GROUP BY s.session_id
        ORDER BY s.session_id`,
    )
    .all(...paramsForScope(window, workspaceId)) as SessionFloorRow[];
  const values = rows.map((row) => row.floor_value).sort((a, b) => a - b);
  if (values.length === 0) return emptyEvidence("NO_ELIGIBLE_SESSIONS");
  const total = values.reduce((sum, value) => sum + value, 0);
  const median = quantile(values, 0.5);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    value: total / values.length,
    denominator: values.length,
    exposureN: values.length,
    sessionN: values.length,
    excluded: {},
    ...(median === undefined ? {} : { median }),
    ...(q1 === undefined ? {} : { q1 }),
    ...(q3 === undefined ? {} : { q3 }),
  };
}

function turnAggregate(
  db: Db,
  window: ObservationWindow,
  workspaceId: string | null,
  kind: "D4" | "D8",
): AggregateEvidence {
  const select =
    kind === "D4"
      ? `COUNT(*) AS exposure_n,
         COUNT(DISTINCT s.session_id) AS session_n,
         SUM(CASE WHEN ${PREMIUM_MODEL_SQL} THEN 1 ELSE 0 END) AS numerator,
         COUNT(*) AS denominator`
      : `COUNT(*) AS exposure_n,
         COUNT(DISTINCT s.session_id) AS session_n,
         SUM(t.cache_read_tokens) AS numerator,
         SUM(t.cache_write_5m + t.cache_write_1h + t.cache_write_other) AS denominator`;
  const row = db
    .prepare(
      `SELECT ${select}
         FROM turns t
         JOIN sessions s ON s.session_id = t.session_id
        WHERE s.state = 'RECONCILED'
          AND s.last_turn_at >= ? AND s.last_turn_at < ?
          AND t.ts >= ? AND t.ts < ?
          AND t.provisional = 0 AND t.is_sidechain = 0
          AND t.model != '<synthetic>'
          ${scopeClause("s", workspaceId)}`,
    )
    .get(
      window.from,
      window.to,
      window.from,
      window.to,
      ...(workspaceId === null ? [] : [workspaceId]),
    ) as {
    exposure_n: number;
    session_n: number;
    numerator: number | null;
    denominator: number | null;
  };
  const denominator = row.denominator ?? 0;
  const numerator = row.numerator ?? 0;
  const value =
    denominator === 0
      ? null
      : kind === "D4"
        ? 100 * (1 - numerator / denominator)
        : numerator / denominator;
  return {
    value,
    denominator,
    exposureN: row.exposure_n,
    sessionN: row.session_n,
    excluded: denominator === 0 ? { DENOMINATOR_ZERO: 1 } : {},
  };
}

function d1Aggregate(
  db: Db,
  window: ObservationWindow,
  opaqueIdentity: string | undefined,
  resolver: SqlObserverOptions["resolveSourceIdentity"],
  after: boolean,
): AggregateEvidence {
  if (opaqueIdentity === undefined || resolver === undefined)
    return emptyEvidence("SOURCE_UNRESOLVED");
  const source = resolver(opaqueIdentity);
  if (source === null) return emptyEvidence("SOURCE_UNRESOLVED");
  const comparator = after
    ? "observed_at > ? AND observed_at <= ?"
    : "observed_at >= ? AND observed_at <= ?";
  const row = db
    .prepare(
      `SELECT tokens, file_hash, observed_at
         FROM context_inventory_history
        WHERE workspace_id = ? AND component = ? AND file_ref = ?
          AND ${comparator}
        ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(source.workspaceId, source.component, source.fileRef, window.from, window.to) as
    | { tokens: number; file_hash: string; observed_at: string }
    | undefined;
  if (row === undefined) return emptyEvidence(after ? "NO_CHANGED_OBSERVATION" : "NO_BASELINE");
  return {
    value: row.tokens,
    denominator: row.tokens,
    exposureN: 1,
    sessionN: null,
    excluded: {},
    snapshotRef: createHash("sha256")
      .update(`${opaqueIdentity}\0${row.file_hash}\0${row.observed_at}`)
      .digest("hex"),
  };
}

function mix(
  db: Db,
  window: ObservationWindow,
  workspaceId: string | null,
  column: "model" | "parser_version",
): MixSummary {
  const rows = db
    .prepare(
      `SELECT t.${column} AS category, COUNT(*) AS n
         FROM turns t JOIN sessions s ON s.session_id = t.session_id
        WHERE s.state = 'RECONCILED' AND s.last_turn_at >= ? AND s.last_turn_at < ?
          AND t.ts >= ? AND t.ts < ? AND t.provisional = 0 AND t.is_sidechain = 0
          ${scopeClause("s", workspaceId)}
        GROUP BY t.${column} ORDER BY t.${column}`,
    )
    .all(
      window.from,
      window.to,
      window.from,
      window.to,
      ...(workspaceId === null ? [] : [workspaceId]),
    ) as Array<{ category: string; n: number }>;
  return {
    available: rows.length > 0,
    total: rows.reduce((sum, row) => sum + row.n, 0),
    counts: Object.fromEntries(rows.map((row) => [row.category, row.n])),
  };
}

function toolMix(db: Db, window: ObservationWindow, workspaceId: string | null): MixSummary {
  const rows = db
    .prepare(
      `SELECT te.tool_name AS category, COUNT(*) AS n
         FROM tool_events te JOIN sessions s ON s.session_id = te.session_id
        WHERE s.state = 'RECONCILED' AND s.last_turn_at >= ? AND s.last_turn_at < ?
          AND te.ts >= ? AND te.ts < ? ${scopeClause("s", workspaceId)}
        GROUP BY te.tool_name ORDER BY te.tool_name`,
    )
    .all(
      window.from,
      window.to,
      window.from,
      window.to,
      ...(workspaceId === null ? [] : [workspaceId]),
    ) as Array<{ category: string; n: number }>;
  return {
    available: rows.length > 0,
    total: rows.reduce((sum, row) => sum + row.n, 0),
    counts: Object.fromEntries(rows.map((row) => [row.category, row.n])),
  };
}

function unsupportedGuardrail(
  id: string,
  methodVersion: string,
  unit: string,
  reason: string,
): GuardrailObservation {
  return {
    guardrailId: id,
    methodVersion,
    availability: "UNSUPPORTED",
    unit,
    before: emptyEvidence(reason),
    after: emptyEvidence(reason),
    direction: "INSUFFICIENT_DATA",
    reasonCodes: [reason],
    evidence: {},
  };
}

export function createSqlObservationProvider(
  options: SqlObserverOptions = {},
): ObservationProvider {
  return {
    observe(db, cycle, beforeWindow, afterWindow): ObservationBundle {
      // A persisted cycle is frozen to its target method. Do not reinterpret an
      // older metric/alias through a newer handler merely because the names match.
      const implementedHandler = findHandler(cycle.detectorId, cycle.metricId, cycle.methodVersion);
      const ws = cycle.scope.workspaceId;
      const usesScopedEvents =
        cycle.detectorId === "D7" ||
        implementedHandler?.target.metricId === "d2-floor-context-scoped";
      let before: AggregateEvidence;
      let after: AggregateEvidence;
      let scopedBefore: ScopedWindowData | null = null;
      let scopedAfter: ScopedWindowData | null = null;
      if (cycle.detectorId === "D1") {
        before = d1Aggregate(
          db,
          beforeWindow,
          cycle.scope.sourceIdentity,
          options.resolveSourceIdentity,
          false,
        );
        after = d1Aggregate(
          db,
          afterWindow,
          cycle.scope.sourceIdentity,
          options.resolveSourceIdentity,
          true,
        );
      } else if (cycle.detectorId === "D2") {
        if (usesScopedEvents) {
          scopedBefore = scopedWindow(db, cycle, beforeWindow);
          scopedAfter = scopedWindow(db, cycle, afterWindow);
          before = scopedD2(db, scopedBefore, beforeWindow);
          after = scopedD2(db, scopedAfter, afterWindow);
        } else {
          // Keep the original workspace-only D2 query and method intact.
          before = floorContext(db, beforeWindow, ws);
          after = floorContext(db, afterWindow, ws);
        }
      } else if (cycle.detectorId === "D7" && usesScopedEvents) {
        scopedBefore = scopedWindow(db, cycle, beforeWindow);
        scopedAfter = scopedWindow(db, cycle, afterWindow);
        before = scopedD7(scopedBefore);
        after = scopedD7(scopedAfter);
      } else if (cycle.detectorId === "D4" || cycle.detectorId === "D8") {
        before = turnAggregate(db, beforeWindow, ws, cycle.detectorId);
        after = turnAggregate(db, afterWindow, ws, cycle.detectorId);
      } else {
        before = emptyEvidence("HANDLER_UNAVAILABLE");
        after = emptyEvidence("HANDLER_UNAVAILABLE");
      }

      const contextGuardrail =
        cycle.detectorId === "D1"
          ? {
              guardrailId: "d2-context-exposure",
              methodVersion: "d2-floor-context-v2",
              availability: "SUPPORTED" as const,
              unit: "tokens",
              before: floorContext(db, beforeWindow, ws),
              after: floorContext(db, afterWindow, ws),
              direction: "INSUFFICIENT_DATA" as const,
              reasonCodes: [],
              evidence: {},
            }
          : null;
      const scopedGuardrailBefore =
        scopedBefore === null ? null : scopedGuardrails(scopedBefore, cycle.guardrailDefinitions);
      const scopedGuardrailAfter =
        scopedAfter === null ? null : scopedGuardrails(scopedAfter, cycle.guardrailDefinitions);
      const guardrails = cycle.guardrailDefinitions.map((definition) => {
        if (contextGuardrail !== null && definition.guardrailId === contextGuardrail.guardrailId)
          return contextGuardrail;
        if (scopedGuardrailBefore !== null && scopedGuardrailAfter !== null) {
          const beforeGuardrail = scopedGuardrailBefore.find(
            (item) =>
              item.guardrailId === definition.guardrailId &&
              item.methodVersion === definition.methodVersion &&
              item.unit === definition.unit,
          );
          const afterGuardrail = scopedGuardrailAfter.find(
            (item) =>
              item.guardrailId === definition.guardrailId &&
              item.methodVersion === definition.methodVersion &&
              item.unit === definition.unit,
          );
          if (beforeGuardrail !== undefined && afterGuardrail !== undefined)
            return { ...afterGuardrail, before: beforeGuardrail.before };
        }
        const reason =
          definition.guardrailId === "interruption-burden"
            ? "INTERRUPTS_UNSUPPORTED"
            : definition.guardrailId === "api-error-rate"
              ? "REQUEST_EXPOSURE_UNAVAILABLE"
              : "ESF3_EVIDENCE_UNAVAILABLE";
        return unsupportedGuardrail(
          definition.guardrailId,
          definition.methodVersion,
          definition.unit,
          reason,
        );
      });
      const parserBefore =
        scopedBefore === null
          ? mix(db, beforeWindow, ws, "parser_version")
          : scopedMix(scopedBefore, "parser");
      const parserAfter =
        scopedAfter === null
          ? mix(db, afterWindow, ws, "parser_version")
          : scopedMix(scopedAfter, "parser");
      return {
        metricId: cycle.metricId,
        methodVersion: implementedHandler?.target.methodVersion ?? "HANDLER_UNAVAILABLE",
        queryDefinitionVersion: EFFECT_QUERY_VERSION,
        scopeFingerprint: createHash("sha256").update(JSON.stringify(cycle.scope)).digest("hex"),
        parserVersions: [
          ...new Set([...Object.keys(parserBefore.counts), ...Object.keys(parserAfter.counts)]),
        ].sort(),
        parserMix: { before: parserBefore, after: parserAfter },
        before,
        after,
        modelMix: {
          before:
            scopedBefore === null
              ? mix(db, beforeWindow, ws, "model")
              : scopedMix(scopedBefore, "model"),
          after:
            scopedAfter === null
              ? mix(db, afterWindow, ws, "model")
              : scopedMix(scopedAfter, "model"),
        },
        toolMix: {
          before:
            scopedBefore === null ? toolMix(db, beforeWindow, ws) : scopedMix(scopedBefore, "tool"),
          after:
            scopedAfter === null ? toolMix(db, afterWindow, ws) : scopedMix(scopedAfter, "tool"),
        },
        taskMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        guardrails,
      };
    },
  };
}
