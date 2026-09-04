/**
 * src/query/api/effectiveness.ts — EF1 delivery-path and abandoned-spend metrics.
 *
 * These functions surface per-session delivery signals (turns to first commit,
 * deep-abandoned classification) and split the RV9a abandoned spend by session
 * depth. SEC-101: only counts, durations, booleans, and microUSD integers are
 * returned — no transcript content, commit SHAs, or tool names.
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

// ---------------------------------------------------------------------------
// Return shape interfaces
// ---------------------------------------------------------------------------

/** Per-session delivery signals (EF1). */
export interface SessionDelivery {
  /** Count of non-sidechain turns (is_sidechain=0) up to and including the first commit turn's ts. Null when no commit occurred. */
  turns_to_first_commit: number | null;
  /** True when: user_turn_count >= 10 AND no commit AND state === 'RECONCILED'. Never true for LIVE sessions. */
  deep_abandoned: boolean;
}

/** EF1 split of RV9a abandoned spend by session depth. */
export interface AbandonedSpendSplit {
  /** Reconciled spend (microUSD) from abandoned sessions with user_turn_count >= 10. */
  deep_abandoned_spend_u: number;
  /** Reconciled spend (microUSD) from abandoned sessions with user_turn_count < 10. */
  early_abandoned_spend_u: number;
}

/** Options for getAbandonedSpendSplit — mirrors DeliveryQueryOpts. */
export interface AbandonedSpendSplitOpts {
  /** null = global (all workspaces). */
  workspaceId: string | null;
  /** ISO-8601 window bounds (inclusive lower, exclusive upper). */
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// computeSessionDelivery
// ---------------------------------------------------------------------------

/**
 * Compute EF1 delivery signals for one session.
 *
 * firstCommitTs is the MIN(ts) from tool_events where commit_sha IS NOT NULL.
 * turns_to_first_commit counts non-sidechain turns (is_sidechain=0) with ts <= firstCommitTs.
 * deep_abandoned is true only for RECONCILED sessions with >= 10 user turns and no commit.
 */
export function computeSessionDelivery(db: Db, sessionId: string): SessionDelivery {
  const commitRow = db
    .prepare(
      `SELECT MIN(ts) AS first_commit_ts
         FROM tool_events
        WHERE session_id = ? AND commit_sha IS NOT NULL`,
    )
    .get(sessionId) as { first_commit_ts: string | null };

  const firstCommitTs = commitRow.first_commit_ts;

  let turns_to_first_commit: number | null = null;
  if (firstCommitTs !== null) {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM turns
          WHERE session_id = ? AND is_sidechain = 0 AND ts <= ?`,
      )
      .get(sessionId, firstCommitTs) as { n: number };
    turns_to_first_commit = countRow.n;
  }

  const sessRow = db
    .prepare("SELECT user_turn_count, state FROM sessions WHERE session_id = ?")
    .get(sessionId) as { user_turn_count: number; state: string } | undefined;

  const user_turn_count = sessRow?.user_turn_count ?? 0;
  const state = sessRow?.state ?? "";

  const deep_abandoned = user_turn_count >= 10 && firstCommitTs === null && state === "RECONCILED";

  return { turns_to_first_commit, deep_abandoned };
}

// ---------------------------------------------------------------------------
// getAbandonedSpendSplit
// ---------------------------------------------------------------------------

/**
 * Split the RV9a abandoned spend into deep (>= 10 user turns) and early (< 10).
 *
 * Uses the exact same abandoned-session definition and window as
 * getDeliveryMetrics so that deep + early === getDeliveryMetrics(...).abandoned_spend_u.
 * Provisional turns are excluded from spend exactly as delivery does.
 */
export function getAbandonedSpendSplit(db: Db, opts: AbandonedSpendSplitOpts): AbandonedSpendSplit {
  const workspaceFilter = opts.workspaceId === null ? "" : " AND t.workspace_id = ?";
  const params: (string | number)[] =
    opts.workspaceId === null ? [opts.from, opts.to] : [opts.from, opts.to, opts.workspaceId];

  const row = db
    .prepare(
      `WITH in_window_turns AS (
         SELECT t.session_id, t.workspace_id, t.cost_equiv_u, t.provisional
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ?${workspaceFilter}
       ),
       in_window_sessions AS (
         SELECT DISTINCT session_id, workspace_id
           FROM in_window_turns
       ),
       session_flags AS (
         SELECT iws.session_id,
                EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.commit_sha IS NOT NULL
                ) AS is_commit_session,
                EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.tool_name IN ('Bash', 'Write', 'Edit', 'NotebookEdit')
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM tool_events te
                   WHERE te.session_id = iws.session_id
                     AND te.commit_sha IS NOT NULL
                ) AS is_abandoned_session
           FROM in_window_sessions iws
       ),
       session_spend AS (
         SELECT session_id,
                COALESCE(SUM(CASE WHEN provisional = 0 THEN cost_equiv_u END), 0) AS spend_u
           FROM in_window_turns
          GROUP BY session_id
       )
       SELECT
         COALESCE(SUM(
           CASE WHEN sf.is_abandoned_session AND s.user_turn_count >= 10
                THEN ss.spend_u ELSE 0 END
         ), 0) AS deep_abandoned_spend_u,
         COALESCE(SUM(
           CASE WHEN sf.is_abandoned_session AND s.user_turn_count < 10
                THEN ss.spend_u ELSE 0 END
         ), 0) AS early_abandoned_spend_u
         FROM session_flags sf
         JOIN session_spend ss USING (session_id)
         JOIN sessions s USING (session_id)`,
    )
    .get(...params) as { deep_abandoned_spend_u: number; early_abandoned_spend_u: number };

  return {
    deep_abandoned_spend_u: row.deep_abandoned_spend_u,
    early_abandoned_spend_u: row.early_abandoned_spend_u,
  };
}

// ---------------------------------------------------------------------------
// EF2 — Non-artifact closure proxy
// ---------------------------------------------------------------------------

/** Classification of a single no-commit session's closure outcome. */
export type ClosureStatus = "RESOLVED" | "UNRESOLVED" | "PENDING" | "EXCLUDED";

/**
 * Aggregate closure-proxy result for a workspace (or global).
 *
 * resolved_share = resolved / (resolved + unresolved); null when no session
 * has matured yet (both counts are zero).  PENDING sessions are excluded from
 * the denominator — the share is over matured sessions only.
 *
 * SEC-101: no session ids are stored or returned here.
 */
export interface ClosureProxy {
  no_commit_session_count: number;
  resolved_count: number;
  unresolved_count: number;
  pending_count: number;
  resolved_share: number | null;
  window_hours: number;
  workspace_id: string | null;
}

/**
 * Classify all no-commit RECONCILED sessions and return an aggregate proxy.
 *
 * A no-commit session S (state='RECONCILED', no tool_events.commit_sha):
 *   - PENDING  : now < last_turn_at + windowHours (window not elapsed yet)
 *   - UNRESOLVED: matured AND another session S' in the same workspace has
 *                  first_turn_at in (last_turn_at, last_turn_at + windowHours]
 *   - RESOLVED  : matured AND no such follow-up session found
 *   - EXCLUDED  : session has a commit (not counted in no_commit_session_count)
 *
 * Time arithmetic uses Date.parse on ISO strings; Date.now() is never called.
 */
export function getClosureProxy(
  db: Db,
  opts: { workspaceId: string | null; now: string; windowHours?: number },
): ApiResponse<ClosureProxy> {
  const windowHours = opts.windowHours ?? 48;
  const nowMs = Date.parse(opts.now);
  const windowMs = windowHours * 3600 * 1000;
  const note = `Directional: a re-open within ${windowHours}h may be unrelated work; burst-working operators will false-flag as unresolved. PENDING until the window elapses.`;

  const workspaceFilter = opts.workspaceId === null ? "" : " AND s.workspace_id = ?";
  const params: string[] = opts.workspaceId === null ? [] : [opts.workspaceId];

  type CandidateRow = { session_id: string; workspace_id: string; last_turn_at: string };
  const candidates = db
    .prepare(
      `SELECT s.session_id, s.workspace_id, s.last_turn_at
         FROM sessions s
        WHERE s.state = 'RECONCILED'
          AND s.last_turn_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tool_events te
             WHERE te.session_id = s.session_id AND te.commit_sha IS NOT NULL
          )${workspaceFilter}`,
    )
    .all(...params) as CandidateRow[];

  const emptyProxy = (): ClosureProxy => ({
    no_commit_session_count: 0,
    resolved_count: 0,
    unresolved_count: 0,
    pending_count: 0,
    resolved_share: null,
    window_hours: windowHours,
    workspace_id: opts.workspaceId,
  });

  if (candidates.length === 0) {
    return buildResponse(emptyProxy(), {
      claim_kind: "EXPERIMENTAL",
      n: 0,
      window: { from: opts.now, to: opts.now },
      qualification: { provisional_excluded: false, unpriced_turns: 0, claim_kinds_count: 1, note },
      ...(opts.workspaceId === null ? {} : { drilldown_ids: { workspace_id: opts.workspaceId } }),
    });
  }

  // Fetch all sessions in the candidate workspaces for the follow-up check.
  const uniqueWsIds = [...new Set(candidates.map((c) => c.workspace_id))];
  const placeholders = uniqueWsIds.map(() => "?").join(",");
  type WsSessionRow = { session_id: string; workspace_id: string; first_turn_at: string };
  const wsSessions = db
    .prepare(
      `SELECT session_id, workspace_id, first_turn_at
         FROM sessions
        WHERE workspace_id IN (${placeholders}) AND first_turn_at IS NOT NULL`,
    )
    .all(...uniqueWsIds) as WsSessionRow[];

  const byWs = new Map<string, WsSessionRow[]>();
  for (const s of wsSessions) {
    const arr = byWs.get(s.workspace_id) ?? [];
    arr.push(s);
    byWs.set(s.workspace_id, arr);
  }

  let resolved_count = 0;
  let unresolved_count = 0;
  let pending_count = 0;

  for (const c of candidates) {
    const lastMs = Date.parse(c.last_turn_at);
    const matured = nowMs >= lastMs + windowMs;

    if (!matured) {
      pending_count++;
      continue;
    }

    const siblings = byWs.get(c.workspace_id) ?? [];
    const reopened = siblings.some((s2) => {
      if (s2.session_id === c.session_id) return false;
      const s2Ms = Date.parse(s2.first_turn_at);
      return s2Ms > lastMs && s2Ms <= lastMs + windowMs;
    });

    if (reopened) {
      unresolved_count++;
    } else {
      resolved_count++;
    }
  }

  const no_commit_session_count = resolved_count + unresolved_count + pending_count;
  const maturedCount = resolved_count + unresolved_count;
  const resolved_share = maturedCount === 0 ? null : resolved_count / maturedCount;

  const proxy: ClosureProxy = {
    no_commit_session_count,
    resolved_count,
    unresolved_count,
    pending_count,
    resolved_share,
    window_hours: windowHours,
    workspace_id: opts.workspaceId,
  };

  return buildResponse(proxy, {
    claim_kind: "EXPERIMENTAL",
    n: no_commit_session_count,
    window: { from: opts.now, to: opts.now },
    qualification: { provisional_excluded: false, unpriced_turns: 0, claim_kinds_count: 1, note },
    ...(opts.workspaceId === null ? {} : { drilldown_ids: { workspace_id: opts.workspaceId } }),
  });
}

/**
 * Per-session closure status for drill-down.
 *
 * Same logic as getClosureProxy but for a single session.
 * Time arithmetic uses Date.parse on ISO strings; Date.now() is never called.
 */
export function getSessionClosureStatus(
  db: Db,
  sessionId: string,
  opts: { now: string; windowHours?: number },
): ClosureStatus {
  const windowHours = opts.windowHours ?? 48;
  const windowMs = windowHours * 3600 * 1000;

  // A session with any commit is EXCLUDED from the no-commit classification.
  const hasCommit = db
    .prepare("SELECT 1 FROM tool_events WHERE session_id = ? AND commit_sha IS NOT NULL LIMIT 1")
    .get(sessionId);
  if (hasCommit) return "EXCLUDED";

  type SessRow = { workspace_id: string; last_turn_at: string | null; state: string };
  const sess = db
    .prepare("SELECT workspace_id, last_turn_at, state FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessRow | undefined;

  // If the session is missing or not a RECONCILED no-commit session, it cannot mature.
  if (!sess || sess.state !== "RECONCILED" || sess.last_turn_at === null) return "PENDING";

  const nowMs = Date.parse(opts.now);
  const lastMs = Date.parse(sess.last_turn_at);
  const matured = nowMs >= lastMs + windowMs;

  if (!matured) return "PENDING";

  // Check for a follow-up session in the same workspace within the closure window.
  type FollowRow = { session_id: string; first_turn_at: string };
  const followups = db
    .prepare(
      `SELECT session_id, first_turn_at FROM sessions
        WHERE workspace_id = ? AND session_id != ?
          AND first_turn_at IS NOT NULL AND first_turn_at > ?`,
    )
    .all(sess.workspace_id, sessionId, sess.last_turn_at) as FollowRow[];

  const reopened = followups.some((s2) => {
    const s2Ms = Date.parse(s2.first_turn_at);
    return s2Ms > lastMs && s2Ms <= lastMs + windowMs;
  });

  return reopened ? "UNRESOLVED" : "RESOLVED";
}
