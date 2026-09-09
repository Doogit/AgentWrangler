import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { PREMIUM_MODEL_SQL } from "../ingest/pricing.js";
import { findHandler } from "./registry.js";
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
      const implementedHandler = findHandler(cycle.detectorId, cycle.metricId);
      const ws = cycle.scope.workspaceId;
      let before: AggregateEvidence;
      let after: AggregateEvidence;
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
        before = floorContext(db, beforeWindow, ws);
        after = floorContext(db, afterWindow, ws);
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
      const guardrails = cycle.guardrailDefinitions.map((definition) => {
        if (contextGuardrail !== null && definition.guardrailId === contextGuardrail.guardrailId)
          return contextGuardrail;
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
      const parserBefore = mix(db, beforeWindow, ws, "parser_version");
      const parserAfter = mix(db, afterWindow, ws, "parser_version");
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
          before: mix(db, beforeWindow, ws, "model"),
          after: mix(db, afterWindow, ws, "model"),
        },
        toolMix: { before: toolMix(db, beforeWindow, ws), after: toolMix(db, afterWindow, ws) },
        taskMix: {
          before: { available: false, total: 0, counts: {} },
          after: { available: false, total: 0, counts: {} },
        },
        guardrails,
      };
    },
  };
}
