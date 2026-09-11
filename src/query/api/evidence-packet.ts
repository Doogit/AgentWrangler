/**
 * RIQ1 aggregate-only packet builder. This module deliberately projects no
 * whole DB row: all output is bounded counts, enum labels, or opaque IDs.
 */

import { createHash } from "node:crypto";
import type { Db } from "../../db/open.js";
import { getEsfObservations } from "./esf-observations.js";
import {
  EVIDENCE_PACKET_VERSION,
  EVIDENCE_QUERY_DEFINITION_VERSION,
  type EvidenceFact,
  type EvidencePacket,
  type EvidencePacketScope,
  type MeasuredFact,
  type ToolClass,
  type UnavailableFact,
} from "./evidence-packet-types.js";

export {
  EVIDENCE_PACKET_VERSION,
  EVIDENCE_QUERY_DEFINITION_VERSION,
  type EvidenceFact,
  type EvidencePacket,
  type EvidencePacketScope,
  type ToolClass,
} from "./evidence-packet-types.js";

const METHOD = "riq1-evidence-packet-1";
const MAX_TOOL_CLASSES = 32;
const TOOL_CLASSES: readonly ToolClass[] = [
  "FILE_READ",
  "FILE_WRITE",
  "SEARCH",
  "SHELL",
  "WEB",
  "CUSTOM_TOOL",
  "UNKNOWN",
];

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function evidenceId(kind: string, source: string): string {
  return `ev_${hash({ version: METHOD, kind, source }).slice(0, 24)}`;
}

function unavailable(reason: UnavailableFact["reason"] = "NO_ELIGIBLE_DATA"): UnavailableFact {
  return { state: "UNAVAILABLE", reason, method: METHOD };
}

function unknown(reason: UnavailableFact["reason"] = "NOT_REPORTED"): UnavailableFact {
  return { state: "UNKNOWN", reason, method: METHOD };
}

function measured<T>(
  value: T,
  unit: string,
  denominator: number,
  provenance: string[],
  evidence_ids: string[],
): MeasuredFact<T> {
  return { value, unit, denominator, method: METHOD, provenance, evidence_ids };
}

function classifyTool(name: string): ToolClass {
  if (name === "Read") return "FILE_READ";
  if (["Glob", "Grep"].includes(name)) return "SEARCH";
  if (["Write", "Edit", "NotebookEdit"].includes(name)) return "FILE_WRITE";
  if (["Bash", "local_command"].includes(name)) return "SHELL";
  if (["WebFetch", "WebSearch"].includes(name)) return "WEB";
  return "CUSTOM_TOOL";
}

function durationMs(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from);
}

function compatiblePrior(
  scope: EvidencePacketScope,
  prior: NonNullable<EvidencePacketScope["prior"]>,
): boolean {
  return (
    prior.workspaceId === scope.workspaceId &&
    (prior.toolClass ?? null) === (scope.toolClass ?? null) &&
    durationMs(prior.from, prior.to) === durationMs(scope.from, scope.to)
  );
}

function defaultPrior(scope: EvidencePacketScope): NonNullable<EvidencePacketScope["prior"]> {
  const duration = durationMs(scope.from, scope.to);
  return {
    workspaceId: scope.workspaceId,
    from: new Date(Date.parse(scope.from) - duration).toISOString(),
    to: scope.from,
    ...(scope.toolClass === undefined ? {} : { toolClass: scope.toolClass }),
  };
}

interface TurnAggregate {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
}

function turnAggregate(db: Db, scope: EvidencePacketScope): TurnAggregate {
  const workspace = scope.workspaceId === null ? "" : " AND workspace_id = ?";
  const args =
    scope.workspaceId === null ? [scope.from, scope.to] : [scope.from, scope.to, scope.workspaceId];
  return db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
            COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h,
            COALESCE(SUM(cache_write_other), 0) AS cache_write_other
       FROM turns WHERE ts >= ? AND ts < ?${workspace} AND provisional = 0`,
    )
    .get(...args) as TurnAggregate;
}

/** Builds a deterministic, privacy-safe RIQ1 packet from the shared ESF cohort. */
export function buildEvidencePacket(db: Db, scope: EvidencePacketScope): EvidencePacket {
  if (!(durationMs(scope.from, scope.to) > 0))
    throw new Error("RIQ1 windows must be non-empty ISO half-open windows");
  if (scope.toolClass !== undefined && !TOOL_CLASSES.includes(scope.toolClass)) {
    throw new Error("RIQ1 tool scope must use a closed tool-class enum");
  }
  const evidenceAsOf = scope.evidenceAsOf ?? scope.to;
  const priorCandidate = scope.prior ?? defaultPrior(scope);
  const priorIsCompatible = compatiblePrior(scope, priorCandidate);
  const current = getEsfObservations(db, {
    workspaceId: scope.workspaceId,
    from: scope.from,
    to: scope.to,
  }).data;
  if (current === null) throw new Error("ESF cohort unexpectedly unavailable");
  const prior = priorIsCompatible
    ? getEsfObservations(db, {
        workspaceId: scope.workspaceId,
        from: priorCandidate.from,
        to: priorCandidate.to,
      }).data
    : null;
  // A caller-supplied revision is an identity input, never an exported string:
  // this prevents an accidental free-form revision label from becoming a leak.
  const sourceRevision = hash({
    requested_revision: scope.sourceRevision ?? null,
    current: current.watermark.source_fingerprint,
    prior: prior?.watermark.source_fingerprint ?? null,
  });
  const currentId = evidenceId("current-cohort", current.watermark.source_fingerprint);
  const priorId =
    prior === null ? null : evidenceId("prior-cohort", prior.watermark.source_fingerprint);
  const currentCost = current.resource.priced_cost_u;
  const currentCostFact =
    current.resource.priced_turn_count === 0
      ? unavailable()
      : measured(
          currentCost,
          "micro_usd_list_equivalent",
          current.resource.priced_turn_count,
          [currentId],
          [currentId],
        );
  const priorCostFact =
    prior === null || prior.resource.priced_turn_count === 0 || priorId === null
      ? unavailable(prior === null ? "UNSUPPORTED" : "NO_ELIGIBLE_DATA")
      : measured(
          prior.resource.priced_cost_u,
          "micro_usd_list_equivalent",
          prior.resource.priced_turn_count,
          [priorId],
          [priorId],
        );
  const comparison: EvidenceFact<{
    delta: number;
    direction: "INCREASE" | "DECREASE" | "UNCHANGED";
  }> = !priorIsCompatible
    ? {
        state: "UNAVAILABLE",
        reason: "UNSUPPORTED",
        method: `${METHOD}: incompatible prior scope, tool class, or duration`,
      }
    : "state" in currentCostFact || "state" in priorCostFact || prior === null
      ? unavailable()
      : measured(
          {
            delta: currentCost - prior.resource.priced_cost_u,
            direction:
              currentCost === prior.resource.priced_cost_u
                ? "UNCHANGED"
                : currentCost > prior.resource.priced_cost_u
                  ? "INCREASE"
                  : "DECREASE",
          },
          "micro_usd_list_equivalent_delta",
          current.resource.selected_session_count,
          [currentId, priorId as string],
          [currentId, priorId as string],
        );

  const tokens = turnAggregate(db, scope);
  const tokenBuckets: Record<string, number> = {
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    cache_read_tokens: tokens.cache_read_tokens,
    cache_write_5m: tokens.cache_write_5m,
    cache_write_1h: tokens.cache_write_1h,
    cache_write_other: tokens.cache_write_other,
  };
  const tokenFact =
    current.watermark.selected_turn_count === 0
      ? unavailable()
      : measured(
          tokenBuckets,
          "tokens",
          current.watermark.selected_turn_count,
          [currentId],
          [currentId],
        );
  const allocation = current.allocation_sessions
    .map((row) => row.priced_cost_u)
    .sort((a, b) => a - b);
  const distribution =
    allocation.length === 0
      ? unavailable()
      : measured(
          {
            min: allocation[0] as number,
            median: allocation[Math.floor((allocation.length - 1) / 2)] as number,
            max: allocation[allocation.length - 1] as number,
          },
          "micro_usd_list_equivalent_per_session",
          allocation.length,
          [currentId],
          [currentId],
        );
  const rawModelRows = db
    .prepare(
      `SELECT model, COUNT(*) AS turn_count FROM turns WHERE ts >= ? AND ts < ?${scope.workspaceId === null ? "" : " AND workspace_id = ?"} AND provisional = 0 GROUP BY model ORDER BY model`,
    )
    .all(
      ...(scope.workspaceId === null
        ? [scope.from, scope.to]
        : [scope.from, scope.to, scope.workspaceId]),
    ) as Array<{ model: string; turn_count: number }>;
  const modelRows = rawModelRows.map((row) => ({
    model_id: `model_${hash({ sourceRevision, model: row.model }).slice(0, 20)}`,
    turn_count: row.turn_count,
  }));
  const modelMix =
    modelRows.length === 0
      ? unavailable()
      : measured(
          modelRows,
          "turns",
          current.watermark.selected_turn_count,
          [currentId],
          [currentId],
        );
  const toolRows = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS event_count FROM tool_events te JOIN sessions s USING (session_id)
      WHERE te.ts >= ? AND te.ts < ? AND s.state = 'RECONCILED'${scope.workspaceId === null ? "" : " AND s.workspace_id = ?"}
      GROUP BY tool_name ORDER BY tool_name LIMIT ?`,
    )
    .all(
      ...(scope.workspaceId === null
        ? [scope.from, scope.to, MAX_TOOL_CLASSES]
        : [scope.from, scope.to, scope.workspaceId, MAX_TOOL_CLASSES]),
    ) as Array<{ tool_name: string; event_count: number }>;
  const safeTools = toolRows
    .map((row) => ({
      tool_id: `tool_${hash({ sourceRevision, name: row.tool_name }).slice(0, 20)}`,
      tool_class: classifyTool(row.tool_name),
      event_count: row.event_count,
    }))
    .filter((row) => scope.toolClass === undefined || row.tool_class === scope.toolClass);
  const toolFact =
    safeTools.length === 0
      ? unavailable()
      : measured(
          safeTools,
          "tool_events",
          current.resource.selected_session_count,
          [currentId],
          [currentId],
        );
  const actionRows = (
    scope.workspaceId === null
      ? db.prepare("SELECT rec_id, state FROM recommendations ORDER BY rec_id").all()
      : db
          .prepare(
            "SELECT rec_id, state FROM recommendations WHERE scope_workspace_id = ? OR scope_workspace_id IS NULL ORDER BY rec_id",
          )
          .all(scope.workspaceId)
  ) as Array<{
    rec_id: string;
    state: string;
  }>;
  const expired =
    scope.methodRevisionAt !== undefined &&
    Date.parse(evidenceAsOf) < Date.parse(scope.methodRevisionAt);
  const packetWithoutHash = {
    packet_version: EVIDENCE_PACKET_VERSION,
    query_definition_version: EVIDENCE_QUERY_DEFINITION_VERSION,
    evidence_as_of: evidenceAsOf,
    source_revision: sourceRevision,
    scope: {
      workspace_id: scope.workspaceId,
      tool_class: scope.toolClass ?? null,
      current_window: { from: scope.from, to: scope.to },
      prior_window: priorIsCompatible ? { from: priorCandidate.from, to: priorCandidate.to } : null,
      maturity_filters: {
        session_state: "RECONCILED" as const,
        provisional_turns_excluded: true as const,
      },
    },
    freshness: {
      status: expired ? ("EXPIRED" as const) : ("CURRENT" as const),
      reason: expired ? "EVIDENCE_PREDATES_METHOD_REVISION" : null,
    },
    coverage: {
      eligible_session_count: current.resource.reconciled_priced_session_count,
      excluded_live_session_count: current.resource.live_priced_session_count,
      unpriced_turn_count: current.resource.unpriced_turn_count,
      exclusions: [
        "LIVE sessions are excluded from eligible-session facts",
        "unpriced turns are not zero-cost",
      ],
    },
    facts: {
      current_list_price_equivalent_u: currentCostFact,
      prior_list_price_equivalent_u: priorCostFact,
      comparison,
      raw_token_buckets: tokenFact,
      session_cost_distribution_u: distribution,
      model_mix: modelMix,
      task_mix: unknown(),
      modeled_cap_headroom: unavailable("UNSUPPORTED"),
      tool_observations: toolFact,
      target_observations: unavailable("UNSUPPORTED"),
      guardrail_observations: unavailable("UNSUPPORTED"),
    },
    related_actions: {
      active_rec_ids: actionRows
        .filter(
          (row) => row.state === "PROPOSED" || row.state === "ADOPTED" || row.state === "MEASURING",
        )
        .map((row) => row.rec_id),
      completed_rec_ids: actionRows
        .filter((row) => row.state === "MEASURED_EFFECTIVE" || row.state === "MEASURED_NO_EFFECT")
        .map((row) => row.rec_id),
    },
    overlap_groups: [
      {
        evidence_id: currentId,
        fact_keys: [
          "current_list_price_equivalent_u",
          "raw_token_buckets",
          "session_cost_distribution_u",
          "model_mix",
          "tool_observations",
        ],
        session_count: current.resource.reconciled_priced_session_count,
      },
    ],
  };
  return { ...packetWithoutHash, packet_identity_hash: hash(packetWithoutHash) };
}
