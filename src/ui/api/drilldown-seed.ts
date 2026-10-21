/**
 * src/ui/api/drilldown-seed.ts — drilldowns paint from the row the user clicked (P1-U6a).
 *
 * A list row already holds the detail header's main values, so the click stores them here and
 * the detail page renders its header at once while its own reads load. Also the session's
 * cheap first reads, which a row hover/focus prefetches (`usePrefetchOnIntent`).
 */

import { fetchSession, fetchTurnTimeline } from "./client";
import type { PrefetchQuery } from "./prefetch";
import { queryClient } from "./query-client";
import { queryKeys } from "./query-keys";

export interface SessionHeaderSeed {
  session_id: string;
  workspace_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  turn_count: number;
  cost_equiv_u: number;
  first_turn_at: string | null;
  last_turn_at: string | null;
}

export interface WorkspaceHeaderSeed {
  workspace_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  repo_path: string | null;
  cost_equiv_u: number;
  turns: number;
  usd_per_turn: number | null;
  avg_context_per_turn?: number | null | undefined;
  has_live: boolean;
}

export function seedSessionHeader(seed: SessionHeaderSeed): void {
  queryClient.setQueryData(queryKeys.sessionSeed(seed.session_id), seed);
}

export function readSessionSeed(sessionId: string): SessionHeaderSeed | undefined {
  return queryClient.getQueryData(queryKeys.sessionSeed(sessionId));
}

/** A workspace row's figures belong to the window it was listed in. */
export function seedWorkspaceHeader(preset: string, seed: WorkspaceHeaderSeed): void {
  queryClient.setQueryData(queryKeys.workspaceSeed(seed.workspace_id, preset), seed);
}

export function readWorkspaceSeed(
  workspaceId: string,
  preset: string,
): WorkspaceHeaderSeed | undefined {
  return queryClient.getQueryData(queryKeys.workspaceSeed(workspaceId, preset));
}

/** The session header read and the first turns page: what a row prefetches. */
export function sessionFirstReads(sessionId: string): PrefetchQuery[] {
  return [
    {
      queryKey: queryKeys.session(sessionId),
      queryFn: (signal) => fetchSession(sessionId, signal),
    },
    {
      queryKey: queryKeys.sessionTurns(sessionId, "first"),
      queryFn: (signal) => fetchTurnTimeline(sessionId, undefined, signal),
    },
  ];
}
