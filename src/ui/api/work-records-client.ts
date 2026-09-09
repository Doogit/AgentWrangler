/** Browser-only ESF3 client. Prepared operations retain IDs and bytes for explicit retry. */
import type { ApiResponse } from "../../query/envelope";
import type {
  AllocationSummary,
  DeleteResult,
  EffortBand,
  IssuedOpaqueId,
  MutationResult,
  OpaqueIdKind,
  OutcomeState,
  RepairBand,
  TaskIntent,
  WorkRecordView,
} from "../../work-records/types";

export type WorkResponse<T> = Omit<ApiResponse<T>, "data"> & { data: T };

export class WorkRecordsClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      code === "REVISION_CONFLICT"
        ? "Revision conflict. Reload the record and review your change; nothing was overwritten."
        : code === "SOURCE_DELETED"
          ? "Source deleted. Historical evidence may be incomplete."
          : code === "UNSUPPORTED_VERSION" || status === 404 || status === 503
            ? "Work-record evidence unavailable."
            : `Request failed (${code}, HTTP ${status}).`,
    );
    this.name = "WorkRecordsClientError";
  }
}

async function request<T>(path: string, method = "GET", body?: string): Promise<WorkResponse<T>> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    const response = await fetch("/api/token", { signal: AbortSignal.timeout(8000) });
    const payload = response.ok ? ((await response.json()) as { token?: unknown }) : {};
    if (typeof payload.token !== "string" || !payload.token)
      throw new WorkRecordsClientError(401, "AUTHORIZATION_UNAVAILABLE");
    headers["X-AgentWrangler-Token"] = payload.token;
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkRecordsClientError(
      response.status,
      typeof payload?.code === "string" ? payload.code : "REQUEST_FAILED",
    );
  if (!payload || !("data" in payload) || !payload.meta)
    throw new WorkRecordsClientError(502, "MALFORMED_RESPONSE");
  if (payload.data === null) throw new WorkRecordsClientError(503, "UNAVAILABLE");
  return payload as WorkResponse<T>;
}

const base = "/api/work-records";
const pathFor = (id: string) => `${base}/${encodeURIComponent(id)}`;
export const listWorkRecords = (workspaceId: string) =>
  request<WorkRecordView[]>(
    `${base}?${new URLSearchParams({ workspace_id: workspaceId, include_archived: "true" })}`,
  );
export const getWorkRecord = (id: string) => request<WorkRecordView>(pathFor(id));
export const getWorkAllocation = (id: string) =>
  request<AllocationSummary>(`${base}/allocations/${encodeURIComponent(id)}`);
export const issueWorkRecordId = (kind: OpaqueIdKind) =>
  request<IssuedOpaqueId>(`${base}/ids`, "POST", JSON.stringify({ kind }));

export interface PreparedOperation<T> {
  run: () => Promise<WorkResponse<T>>;
}
function prepare<T>(
  path: string,
  method: string,
  fields: object,
  ids: ReadonlyArray<readonly [string, OpaqueIdKind]>,
): PreparedOperation<T> {
  // Copy at preparation time, before asynchronous issuance or editable UI state can change.
  const body: Record<string, unknown> = { ...fields };
  let serialized: string | undefined;
  let inFlight: Promise<WorkResponse<T>> | undefined;
  return {
    run() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        for (const [field, kind] of ids) {
          if (body[field] === undefined) body[field] = (await issueWorkRecordId(kind)).data.id;
        }
        serialized ??= JSON.stringify(body);
        return request<T>(path, method, serialized);
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
export function prepareCreateWorkRecord(workspaceId: string, taskIntent: TaskIntent) {
  return prepare<MutationResult>(
    base,
    "POST",
    { workspace_id: workspaceId, task_intent: taskIntent },
    [["work_record_id", "WORK_RECORD"]],
  );
}
export interface FeedbackFields {
  outcome_state: OutcomeState;
  repair_band: RepairBand;
  effort_band: EffortBand;
}
export type WorkRecordAction =
  | { action: "edit"; fields: FeedbackFields & { task_intent: TaskIntent } }
  | {
      action: "closeout";
      fields: Omit<FeedbackFields, "outcome_state"> & {
        outcome_state: Exclude<OutcomeState, "ACTIVE">;
      };
    }
  | { action: "archive" | "reopen" }
  | { action: "attach-session" | "detach-session"; sessionId: string }
  | { action: "attach-context" }
  | { action: "detach-context"; contextId: string };
export function prepareWorkRecordAction(
  recordId: string,
  revision: number,
  action: WorkRecordAction,
) {
  let route: string = action.action;
  const fields: Record<string, unknown> = { expected_revision_no: revision };
  const ids: Array<[string, OpaqueIdKind]> = [["mutation_id", "MUTATION"]];
  if (action.action === "edit" || action.action === "closeout") {
    Object.assign(fields, action.fields);
    if (action.action === "edit") fields.feedback_source = "USER_EDIT";
  } else if (action.action === "attach-session") {
    route = "sessions";
    fields.session_id = action.sessionId;
  } else if (action.action === "detach-session")
    route = `sessions/${encodeURIComponent(action.sessionId)}/detach`;
  else if (action.action === "attach-context") {
    route = "contexts";
    fields.context_kind = "WORKTREE";
    ids.push(["context_ref_id", "CONTEXT_REF"]);
  } else if (action.action === "detach-context") {
    route = `contexts/${encodeURIComponent(action.contextId)}/detach`;
    fields.context_kind = "WORKTREE";
  }
  return prepare<MutationResult>(`${pathFor(recordId)}/${route}`, "POST", fields, ids);
}
export function prepareDeleteWorkRecord(recordId: string, revision: number, confirm: true) {
  return prepare<DeleteResult>(
    `${pathFor(recordId)}/delete`,
    "DELETE",
    { expected_revision_no: revision, confirm },
    [["mutation_id", "MUTATION"]],
  );
}
export function prepareWorkAllocation(
  workspaceId: string,
  from: string,
  to: string,
  evidenceAsOf = new Date().toISOString(),
) {
  return prepare<{ allocation: AllocationSummary; replayed: boolean }>(
    `${base}/allocations/recompute`,
    "POST",
    { workspace_id: workspaceId, cohort_from: from, cohort_to: to, evidence_as_of: evidenceAsOf },
    [
      ["mutation_id", "MUTATION"],
      ["allocation_revision_id", "ALLOCATION_REVISION"],
    ],
  );
}
