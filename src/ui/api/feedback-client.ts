import type { CooldownInput, MaterialityBand } from "../../query/api/decision-ranker-types";
import type { FeedbackKind, FeedbackRow, GoalPreference } from "../../query/api/feedback-store";
/**
 * Browser client for the RIQ3 relevance-feedback + goal-preference store.
 * Enveloped, token-gated writes (mirrors work-records-client). Exposed for
 * RIQ4 to wire a feedback control; no page uses it yet.
 */
import type { ApiResponse } from "../../query/envelope";

export type { FeedbackKind, FeedbackRow, GoalPreference, MaterialityBand };

export type FeedbackResponse<T> = Omit<ApiResponse<T>, "data"> & { data: T };

export class FeedbackClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Feedback request failed (${code}, HTTP ${status}).`);
    this.name = "FeedbackClientError";
  }
}

async function request<T>(
  path: string,
  method = "GET",
  body?: string,
): Promise<FeedbackResponse<T>> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    const response = await fetch("/api/token", { signal: AbortSignal.timeout(8000) });
    const payload = response.ok ? ((await response.json()) as { token?: unknown }) : {};
    if (typeof payload.token !== "string" || !payload.token)
      throw new FeedbackClientError(401, "AUTHORIZATION_UNAVAILABLE");
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
    throw new FeedbackClientError(
      response.status,
      typeof payload?.code === "string" ? payload.code : "REQUEST_FAILED",
    );
  if (!payload || !("data" in payload) || !payload.meta)
    throw new FeedbackClientError(502, "MALFORMED_RESPONSE");
  return payload as FeedbackResponse<T>;
}

const base = "/api/recommendations";
const scopeQuery = (scopeKey: string) => `?${new URLSearchParams({ scope_key: scopeKey })}`;

export interface SetFeedbackFields {
  scope_key: string;
  rec_identity: string;
  feedback: FeedbackKind;
  cooldown_until?: string | null;
  dismissed_materiality_band?: MaterialityBand | null;
}

export const listFeedback = (scopeKey: string) =>
  request<FeedbackRow[]>(`${base}/feedback${scopeQuery(scopeKey)}`);

export const setFeedback = (fields: SetFeedbackFields) =>
  request<FeedbackRow>(`${base}/feedback`, "POST", JSON.stringify(fields));

export const undoFeedback = (scopeKey: string, recIdentity: string) =>
  request<{ scope_key: string; rec_identity: string; soft_deleted: boolean }>(
    `${base}/feedback/undo`,
    "POST",
    JSON.stringify({ scope_key: scopeKey, rec_identity: recIdentity }),
  );

export const deleteFeedback = (scopeKey: string, recIdentity: string) =>
  request<{ scope_key: string; rec_identity: string; removed: number }>(
    `${base}/feedback`,
    "DELETE",
    JSON.stringify({ scope_key: scopeKey, rec_identity: recIdentity }),
  );

export const getGoal = (scopeKey: string) =>
  request<{ scope_key: string; goal: GoalPreference }>(`${base}/goal${scopeQuery(scopeKey)}`);

export const setGoal = (scopeKey: string, goal: GoalPreference) =>
  request<{ scope_key: string; goal: GoalPreference }>(
    `${base}/goal`,
    "POST",
    JSON.stringify({ scope_key: scopeKey, goal }),
  );

export const resetGoal = (scopeKey: string) =>
  request<{ scope_key: string; goal: GoalPreference }>(
    `${base}/goal/reset`,
    "POST",
    JSON.stringify({ scope_key: scopeKey }),
  );

export type { CooldownInput };
