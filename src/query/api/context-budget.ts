/** Fail-open context-budget measurement for the local hook. */

import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { DEFAULT_HOOK_CONFIG, type HookConfig, readHookConfig } from "./hook-config.js";

export interface ContextBudget {
  stage: "ok" | "soft" | "hard";
  context_tokens: number;
  soft_at: number;
  hard_at: number;
  window: number;
  usage_pct: number;
  model: string | null;
  recommended_action: "clear" | "compact";
  reason: string;
  ts: string | null;
  stale_s: number | null;
  session_id: string;
}

const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

/**
 * The transcript records only a base model id (e.g. `claude-opus-4-8`), never the
 * context-window variant, so the true window is unknowable from the data alone. We take
 * the user-declared window and floor it to a tier at least as large as the biggest context
 * the session has actually reached — a 200k-window model can never exceed 200k tokens, so a
 * session that has is provably a larger-window variant. This prevents false "near the limit"
 * warnings when the declared window is left at the standard default on a large-window model.
 */
function effectiveWindow(declaredWindow: number, maxObserved: number): number {
  let floor: number;
  if (maxObserved > LARGE_WINDOW) floor = maxObserved;
  else if (maxObserved > STANDARD_WINDOW) floor = LARGE_WINDOW;
  else floor = STANDARD_WINDOW;
  return Math.max(declaredWindow, floor);
}

function okBudget(sessionId: string, reason: string, config: HookConfig): ContextBudget {
  const window = config.context_window;
  return {
    stage: "ok",
    context_tokens: 0,
    soft_at: Math.round(config.soft_pct * window),
    hard_at: Math.round(config.hard_pct * window),
    window,
    usage_pct: 0,
    model: null,
    recommended_action: "compact",
    reason,
    ts: null,
    stale_s: null,
    session_id: sessionId,
  };
}

function response(data: ContextBudget): ApiResponse<ContextBudget> {
  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: data.ts === null ? 0 : 1,
    drilldown_ids: { session_id: data.session_id },
  });
}

/**
 * Return a strictly fail-open budget result. This endpoint exposes only session
 * identifiers and measured numbers; it never reads or returns transcript text.
 */
export function getContextBudget(sessionId: string): ApiResponse<ContextBudget> {
  try {
    const db = getQueryDb();
    const config = readHookConfig(db);
    const latest = db
      .prepare(
        `SELECT ts, model, context_tokens
           FROM turns
          WHERE session_id = ?
          ORDER BY ts DESC, rowid DESC
          LIMIT 1`,
      )
      .get(sessionId) as { ts: string; model: string; context_tokens: number } | undefined;
    if (latest === undefined) {
      const session = db
        .prepare("SELECT 1 AS present FROM sessions WHERE session_id = ? LIMIT 1")
        .get(sessionId) as { present: number } | undefined;
      return response(
        okBudget(sessionId, session === undefined ? "unknown_session" : "no_turns", config),
      );
    }

    const timestamp = Date.parse(latest.ts);
    if (!Number.isFinite(timestamp)) {
      return response(okBudget(sessionId, "invalid_timestamp", config));
    }
    const staleSeconds = Math.max(0, (Date.now() - timestamp) / 1_000);

    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(context_tokens), 0) AS max_ctx
           FROM turns
          WHERE session_id = ?`,
      )
      .get(sessionId) as { max_ctx: number };
    const maxObserved = Math.max(0, maxRow.max_ctx ?? 0);
    const window = effectiveWindow(config.context_window, maxObserved);
    const softAt = Math.round(config.soft_pct * window);
    const hardAt = Math.round(config.hard_pct * window);

    if (staleSeconds > config.stale_s) {
      const stale = okBudget(sessionId, "stale", config);
      stale.soft_at = softAt;
      stale.hard_at = hardAt;
      stale.window = window;
      stale.ts = latest.ts;
      stale.model = latest.model;
      stale.stale_s = staleSeconds;
      return response(stale);
    }

    const contextTokens = Math.max(0, latest.context_tokens ?? 0);
    const stage = contextTokens >= hardAt ? "hard" : contextTokens >= softAt ? "soft" : "ok";
    return response({
      stage,
      context_tokens: contextTokens,
      soft_at: softAt,
      hard_at: hardAt,
      window,
      usage_pct: contextTokens / window,
      model: latest.model,
      recommended_action: stage === "hard" ? "clear" : "compact",
      reason: stage,
      ts: latest.ts,
      stale_s: staleSeconds,
      session_id: sessionId,
    });
  } catch {
    return response(okBudget(sessionId, "unavailable", DEFAULT_HOOK_CONFIG));
  }
}
