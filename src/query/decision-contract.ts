import { createHash } from "node:crypto";
import { methodForFamily } from "./api/decision-method-registry.js";
import type { FamilyId } from "./api/opportunity-composer-types.js";

export const DECISION_CONTRACT_TEMPLATE = "RIQ_DECISION_V1" as const;
export const DECISION_CONTRACT_STATUS = "DECISION_V1_VALIDATED" as const;

const FAMILIES: readonly FamilyId[] = [
  "EXPLAIN_USAGE_CHANGE",
  "TOOL_OUTPUT_RETRY_CONCENTRATION",
  "CONTEXT_CACHE_BEHAVIOR",
];
const OPAQUE_EVIDENCE_ID = /^[A-Za-z0-9_.-]{1,160}$/;
const OPAQUE_WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const RESERVED_GLOBAL_SCOPES = new Set(["global", "__global__"]);

export interface PersistedDecisionContractRow {
  rec_id: string;
  provenance: string;
  detector_id: string | null;
  category: string | null;
  scope_workspace_id: string | null;
  lever: string | null;
  target_metric: string;
  evidence_json: string;
  contract_version: number | null;
  template_id: string | null;
  contract_status: string;
  rule_id: string | null;
}

export interface DecisionPayloadV1 {
  decision_identity: string;
  riq_family: FamilyId;
}

export function recIdForDecision(workspaceId: string | null, decisionIdentity: string): string {
  const scope =
    workspaceId === null
      ? "global"
      : `workspace-${createHash("sha1").update(workspaceId).digest("hex").slice(0, 16)}`;
  const hash = createHash("sha1").update(decisionIdentity).digest("hex").slice(0, 16);
  return `riq-${scope}-${hash}`;
}

export function exactDecisionWorkspaceId(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      OPAQUE_WORKSPACE_ID.test(value) &&
      !RESERVED_GLOBAL_SCOPES.has(value))
  );
}

export function exactDecisionIdentity(value: unknown, family: FamilyId): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  const prefix = `${family}:`;
  if (!value.startsWith(prefix)) return false;
  const ids = value.slice(prefix.length).split(",");
  if (ids.length === 0 || ids.length > 20 || ids.some((id) => !OPAQUE_EVIDENCE_ID.test(id)))
    return false;
  return ids.every((id, index) => {
    const previous = ids[index - 1];
    return index === 0 || (previous !== undefined && previous <= id);
  });
}

/** Exact, fail-closed contract for the non-detector RIQ effect-source row. */
export function trustedDecisionContract(
  row: PersistedDecisionContractRow,
): DecisionPayloadV1 | null {
  try {
    if (
      row.contract_status !== DECISION_CONTRACT_STATUS ||
      row.contract_version !== 1 ||
      row.template_id !== DECISION_CONTRACT_TEMPLATE ||
      row.rule_id !== null ||
      row.provenance !== "RULE" ||
      !exactDecisionWorkspaceId(row.scope_workspace_id)
    )
      return null;
    const parsed = JSON.parse(row.evidence_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    if (
      Object.keys(payload).length !== 2 ||
      !Object.hasOwn(payload, "decision_identity") ||
      !Object.hasOwn(payload, "riq_family") ||
      typeof payload.riq_family !== "string" ||
      !FAMILIES.includes(payload.riq_family as FamilyId)
    )
      return null;
    const family = payload.riq_family as FamilyId;
    if (!exactDecisionIdentity(payload.decision_identity, family)) return null;
    const method = methodForFamily(family);
    if (
      method === null ||
      row.detector_id !== method.detectorId ||
      row.target_metric !== method.targetMetric ||
      row.category !== method.category ||
      row.lever !== family ||
      row.rec_id !== recIdForDecision(row.scope_workspace_id, payload.decision_identity)
    )
      return null;
    return {
      decision_identity: payload.decision_identity,
      riq_family: family,
    };
  } catch {
    return null;
  }
}
