import type { EsfObservationCohort } from "../../query/api/esf-observations";
import type { WindowFilter } from "../../query/api/overview";
import type { ApiResponse } from "../../query/envelope";

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Evidence could not be loaded (HTTP ${response.status}).`);
  return response.json() as Promise<T>;
}

export function fetchEsfObservations(
  workspaceId: string | null,
  filter: WindowFilter,
): Promise<ApiResponse<EsfObservationCohort>> {
  const params = new URLSearchParams();
  if (workspaceId !== null) params.set("workspace_id", workspaceId);
  if (filter.preset !== undefined) params.set("preset", filter.preset);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  return readJson(`/api/esf/observations?${params.toString()}`);
}

/** Complete session aggregate, deliberately independent of timeline pagination. */
export function fetchSessionEsfObservations(
  sessionId: string,
): Promise<ApiResponse<EsfObservationCohort>> {
  return readJson(`/api/esf/session-observations/${encodeURIComponent(sessionId)}`);
}
