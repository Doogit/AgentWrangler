/** Local API facade for the ESF3 work-record store. */
import type { Db } from "../../db/open.js";
import {
  DaemonIdIssuer,
  type OpaqueIdKind,
  WorkRecordError,
  attachContext,
  attachSession,
  closeoutWorkRecord,
  createWorkRecord,
  deleteWorkRecord,
  detachContext,
  detachSession,
  editWorkRecord,
  getWorkAllocation,
  getWorkRecord,
  listWorkRecords,
  recomputeWorkAllocation,
  setWorkRecordArchived,
} from "../../work-records/index.js";
import { buildResponse } from "../envelope.js";
import type { ClaimKind, ResponseMeta } from "../envelope.js";

const issuers = new WeakMap<Db, DaemonIdIssuer>();
const ID_KINDS: readonly OpaqueIdKind[] = [
  "WORK_RECORD",
  "MUTATION",
  "EXTERNAL_REF",
  "CONTEXT_REF",
  "ALLOCATION_REVISION",
];

function issuerFor(db: Db): DaemonIdIssuer {
  let issuer = issuers.get(db);
  if (issuer === undefined) {
    issuer = new DaemonIdIssuer();
    issuers.set(db, issuer);
  }
  return issuer;
}

/** Keep ESF3's local structured responses in the daemon's frozen API envelope. */
export function workRecordResponse<T>(
  data: T,
  options: {
    n?: number;
    workspaceId?: string;
    claimKind?: ClaimKind;
    meta?: Partial<ResponseMeta>;
  } = {},
) {
  return buildResponse(data, {
    claim_kind: options.claimKind ?? "EXACT",
    metric_definition_version: "esf-1",
    n: options.n ?? 1,
    drilldown_ids: options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId },
    ...options.meta,
  });
}

export function issueWorkRecordId(db: Db, raw: unknown) {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof (raw as Record<string, unknown>).kind !== "string"
  ) {
    throw new WorkRecordError(400, "INVALID_REQUEST", "kind is required");
  }
  const kind = (raw as { kind: string }).kind;
  if (!ID_KINDS.includes(kind as OpaqueIdKind)) {
    throw new WorkRecordError(400, "INVALID_REQUEST", "kind is invalid");
  }
  return issuerFor(db).issue(kind as OpaqueIdKind);
}

export function createWorkRecordRoute(db: Db, raw: unknown) {
  return createWorkRecord(db, issuerFor(db), raw);
}
export function editWorkRecordRoute(db: Db, raw: unknown) {
  return editWorkRecord(db, issuerFor(db), raw);
}
export function closeoutWorkRecordRoute(db: Db, raw: unknown) {
  return closeoutWorkRecord(db, issuerFor(db), raw);
}
export function setWorkRecordArchivedRoute(db: Db, raw: unknown, archived: boolean) {
  return setWorkRecordArchived(db, issuerFor(db), raw, archived);
}
export function attachWorkRecordSessionRoute(db: Db, raw: unknown) {
  return attachSession(db, issuerFor(db), raw);
}
export function detachWorkRecordSessionRoute(db: Db, raw: unknown) {
  return detachSession(db, issuerFor(db), raw);
}
export function attachWorkRecordContextRoute(db: Db, raw: unknown) {
  return attachContext(db, issuerFor(db), raw);
}
export function detachWorkRecordContextRoute(db: Db, raw: unknown) {
  return detachContext(db, issuerFor(db), raw);
}
export function deleteWorkRecordRoute(db: Db, raw: unknown) {
  return deleteWorkRecord(db, issuerFor(db), raw);
}
export function recomputeWorkAllocationRoute(db: Db, raw: unknown) {
  return recomputeWorkAllocation(db, issuerFor(db), raw);
}
export { getWorkAllocation, getWorkRecord, listWorkRecords, WorkRecordError };

/** Read pricing qualifications from the frozen report, never current turns. */
export function getWorkAllocationClaimKinds(db: Db, allocationId: string): number {
  const row = db
    .prepare(`
    SELECT COUNT(DISTINCT json_extract(claim.value, '$.value')) AS n
    FROM work_session_allocations a,
      json_each(a.parser_claim_summary, '$.cost_claim_counts') claim
    WHERE a.allocation_revision_id = ? AND json_extract(claim.value, '$.count') > 0
  `)
    .get(allocationId) as { n: number };
  return row.n;
}
