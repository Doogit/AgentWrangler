/**
 * RIQ5 decision → ESF effect-cycle track flow.
 *
 * A served decision is keyed on `decision_identity` (family + sorted opaque
 * evidence ids) and carries no rec_id; the ESF effect lifecycle is keyed on a
 * real `recommendations` row. This module bridges the two:
 *
 *  - TRACKABLE families (decision-method-registry) synthesize a stable
 *    `riq-`-prefixed recommendations row (never minted or clobbered by the
 *    DetectorEngine's `rec-` upsert) and open a REAL effect cycle via the
 *    existing effect-service, unchanged.
 *  - MANUAL families record a completed-change attestation (ALREADY_DONE
 *    relevance feedback) with NO cycle — spec §RIQ5: no silent handler
 *    inheritance; unsupported families say manual measurement.
 *
 * Both paths require explicit completed-change confirmation. SEC-101: the
 * synthesized row's evidence_json holds only the decision identity + family.
 */

import type { Db } from "../../db/open.js";
import { GLOBAL_WORKSPACE_ID } from "../../detector/context-probe.js";
import { ESF_EFFECT_WRITER_ENABLED } from "../../effects/gate.js";
import { findHandler } from "../../effects/index.js";
import type { EffectCycle } from "../../effects/types.js";
import {
  DECISION_CONTRACT_STATUS,
  DECISION_CONTRACT_TEMPLATE,
  exactDecisionIdentity,
  exactDecisionWorkspaceId,
  recIdForDecision,
  trustedDecisionContract,
} from "../decision-contract.js";
import { methodForFamily } from "./decision-method-registry.js";
import { EffectRequestError, latestEffectCycle, trackCompletedChange } from "./effect-service.js";
import { setFeedback } from "./feedback-store.js";
import type { FamilyId } from "./opportunity-composer-types.js";

/** Decision-level trackability, mirroring effect-service's EffectCapability. */
export interface DecisionTrackCapability {
  mode: "TRACKABLE" | "MANUAL";
  /** Reason MANUAL, or null when TRACKABLE. */
  reason: "NO_VALIDATED_METHOD" | "HANDLER_UNAVAILABLE" | "WRITER_DISABLED" | null;
}

export type DecisionTrackResult =
  | { mode: "TRACKABLE"; supported: true; cycle: EffectCycle; replayed: boolean }
  | { mode: "TRACKABLE"; supported: false; reason: string }
  | { mode: "MANUAL"; recorded: true };

export interface TrackDecisionInput {
  decision_identity: string;
  family: FamilyId;
  /** null = global scope (scope_key __global__); the synthesized rec is NULL-scoped. */
  workspace_id: string | null;
  /** Must be true — explicit confirmation the change is applied. */
  completed_change: boolean;
  /** Operator reported a concurrent change (confounds attribution). */
  concurrent_change?: boolean;
  /** Distinguishes a fresh track from a retrack after stop; keeps idempotency stable. */
  intent?: string;
}

/** scope_key for feedback storage — matches decision-view / feedback-store. */
function scopeKey(workspaceId: string | null): string {
  return workspaceId ?? GLOBAL_WORKSPACE_ID;
}

/**
 * Deterministic synthetic rec_id for a tracked decision. The `riq-` prefix is
 * one the DetectorEngine never emits (`rec-<detector>-<scope>-<sha1>`), so this
 * row is never overwritten or fired-over on the next ingest.
 */
export { recIdForDecision } from "../decision-contract.js";

/** Whether a decision family can open a real measured cycle. */
export function decisionTrackability(family: FamilyId): DecisionTrackCapability {
  const method = methodForFamily(family);
  if (method === null) return { mode: "MANUAL", reason: "NO_VALIDATED_METHOD" };
  if (!ESF_EFFECT_WRITER_ENABLED) return { mode: "MANUAL", reason: "WRITER_DISABLED" };
  if (findHandler(method.detectorId, method.targetMetric) === null)
    return { mode: "MANUAL", reason: "HANDLER_UNAVAILABLE" };
  return { mode: "TRACKABLE", reason: null };
}

/**
 * Upsert the synthetic recommendations row for a trackable decision. ON CONFLICT
 * DO NOTHING: the row is stable and its state (PROPOSED → ADOPTED) is owned by
 * the effect-service track path, never reset by a re-track.
 */
function upsertDecisionRec(
  db: Db,
  input: TrackDecisionInput,
  recId: string,
  detectorId: string,
  targetMetric: string,
  category: string,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
        lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at, adopted_at, dismissed_until,
        contract_version, template_id, contract_status, rule_id)
     VALUES (?, 'RULE', ?, NULL, ?, ?, ?, NULL, '{}', ?, ?, 'PROPOSED', ?, NULL, NULL,
             1, ?, ?, NULL)
     ON CONFLICT(rec_id) DO NOTHING`,
  ).run(
    recId,
    detectorId,
    category,
    input.workspace_id,
    input.family,
    JSON.stringify({ decision_identity: input.decision_identity, riq_family: input.family }),
    targetMetric,
    nowIso,
    DECISION_CONTRACT_TEMPLATE,
    DECISION_CONTRACT_STATUS,
  );
}

/**
 * Track a decision. TRACKABLE families open a real effect cycle; MANUAL families
 * record an ALREADY_DONE attestation with no cycle. Throws EffectRequestError(400)
 * when completed_change is not explicitly confirmed.
 */
export function trackDecision(
  db: Db,
  input: TrackDecisionInput,
  now = new Date(),
): DecisionTrackResult {
  if (input.completed_change !== true)
    throw new EffectRequestError(400, "Confirm that the change is complete before tracking.");
  if (!exactDecisionIdentity(input.decision_identity, input.family))
    throw new EffectRequestError(400, "decision_identity does not match family.");
  if (!exactDecisionWorkspaceId(input.workspace_id))
    throw new EffectRequestError(400, "workspace_id must be a bounded opaque identifier or null.");

  const capability = decisionTrackability(input.family);
  const nowIso = now.toISOString();

  if (capability.mode === "MANUAL") {
    setFeedback(
      db,
      {
        scope_key: scopeKey(input.workspace_id),
        rec_identity: input.decision_identity,
        feedback: "ALREADY_DONE",
      },
      nowIso,
    );
    return { mode: "MANUAL", recorded: true };
  }

  const method = methodForFamily(input.family);
  // capability.mode === "TRACKABLE" guarantees a method; narrow for the type system.
  if (method === null) throw new EffectRequestError(500, "Trackable family lost its method.");
  const recId = recIdForDecision(input.workspace_id, input.decision_identity);
  const idempotencyKey = `riq5:${input.decision_identity}:${input.intent ?? "track"}`;

  return db
    .transaction((): DecisionTrackResult => {
      upsertDecisionRec(
        db,
        input,
        recId,
        method.detectorId,
        method.targetMetric,
        method.category,
        nowIso,
      );
      const result = trackCompletedChange(
        db,
        {
          rec_id: recId,
          idempotency_key: idempotencyKey,
          completed_change: true,
          ...(input.concurrent_change === true ? { concurrent_change: true } : {}),
        },
        now,
      );
      return result.supported
        ? { mode: "TRACKABLE", supported: true, cycle: result.cycle, replayed: result.replayed }
        : { mode: "TRACKABLE", supported: false, reason: result.reason };
    })
    .immediate();
}

const FAMILIES: readonly FamilyId[] = [
  "EXPLAIN_USAGE_CHANGE",
  "TOOL_OUTPUT_RETRY_CONCENTRATION",
  "CONTEXT_CACHE_BEHAVIOR",
];

/** Validate a track-decision request body; rejects unknown fields (route layer). */
export function parseTrackDecisionRequest(raw: unknown): TrackDecisionInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EffectRequestError(400, "Expected an object.");
  const b = raw as Record<string, unknown>;
  const allowed = [
    "decision_identity",
    "family",
    "workspace_id",
    "completed_change",
    "concurrent_change",
    "intent",
  ];
  if (Object.keys(b).some((k) => !allowed.includes(k)))
    throw new EffectRequestError(400, "Unknown request field.");
  if (
    typeof b.decision_identity !== "string" ||
    b.decision_identity.length === 0 ||
    b.decision_identity.length > 1024
  )
    throw new EffectRequestError(400, "decision_identity is required.");
  if (typeof b.family !== "string" || !FAMILIES.includes(b.family as FamilyId))
    throw new EffectRequestError(400, "family is invalid.");
  if (b.workspace_id !== undefined && !exactDecisionWorkspaceId(b.workspace_id))
    throw new EffectRequestError(400, "workspace_id must be a bounded opaque identifier or null.");
  if (b.completed_change !== true && b.completed_change !== false)
    throw new EffectRequestError(400, "completed_change must be a boolean.");
  if (b.concurrent_change !== undefined && typeof b.concurrent_change !== "boolean")
    throw new EffectRequestError(400, "concurrent_change must be a boolean.");
  if (
    b.intent !== undefined &&
    (typeof b.intent !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(b.intent))
  )
    throw new EffectRequestError(400, "intent must be an opaque token.");
  return {
    decision_identity: b.decision_identity,
    family: b.family as FamilyId,
    workspace_id: (b.workspace_id as string | null | undefined) ?? null,
    completed_change: b.completed_change as boolean,
    ...(b.concurrent_change !== undefined
      ? { concurrent_change: b.concurrent_change as boolean }
      : {}),
    ...(b.intent !== undefined ? { intent: b.intent as string } : {}),
  };
}

/** Route wrapper: parse + track. Throws EffectRequestError for a bad request. */
export function trackDecisionRoute(db: Db, raw: unknown): DecisionTrackResult {
  return trackDecision(db, parseTrackDecisionRequest(raw));
}

/** Latest effect cycle for a decision, or null when it has never been tracked. */
export function latestCycleForDecision(
  db: Db,
  workspaceId: string | null,
  decisionIdentity: string,
): EffectCycle | null {
  return latestEffectCycle(db, recIdForDecision(workspaceId, decisionIdentity));
}

/**
 * Decision identities that have an effect cycle, grouped by disposition for the
 * decision-view: `open` (being measured → demote via active_conflicts, closes F2)
 * vs `terminal` (FINALIZED/STOPPED/UNSUPPORTED → suppress re-surfacing). Reads
 * only the RIQ5-synthesized rows.
 */
export function decisionCycleDispositions(
  db: Db,
  workspaceId: string | null,
): { open: Set<string>; terminal: Set<string> } {
  const rows = db
    .prepare(
      `SELECT r.rec_id, r.provenance, r.detector_id, r.category, r.scope_workspace_id,
              r.lever, r.target_metric, r.evidence_json, r.contract_version, r.template_id,
              r.contract_status, r.rule_id, c.state AS state
         FROM effect_cycles c JOIN recommendations r ON r.rec_id = c.rec_id
        WHERE r.scope_workspace_id IS ?
          AND r.contract_status = ?
          AND r.template_id = ?`,
    )
    .all(workspaceId, DECISION_CONTRACT_STATUS, DECISION_CONTRACT_TEMPLATE) as Array<
    Parameters<typeof trustedDecisionContract>[0] & { state: string }
  >;
  const open = new Set<string>();
  const terminal = new Set<string>();
  for (const row of rows) {
    const trusted = trustedDecisionContract(row);
    if (trusted === null) continue;
    const identity = trusted.decision_identity;
    if (row.state === "OPEN_SETTLING" || row.state === "OPEN_MEASURING") open.add(identity);
    else terminal.add(identity);
  }
  return { open, terminal };
}
