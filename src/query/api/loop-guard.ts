/** Fail-open D7 repeated-failure circuit breaker for the local hook. */

import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import { DEFAULT_HOOK_CONFIG, readHookConfig } from "./hook-config.js";

export interface LoopGuard {
  stage: "ok" | "warn" | "block";
  session_id: string;
  identical_run_len: number;
  failing_run_len: number;
  fail_count_threshold: number;
  window_turns: number;
  reason: string;
  ts: string;
}

interface ToolEventRow {
  event_id: string;
  ts: string;
  input_hash: string | null;
  exit_class: string | null;
}

function response(data: LoopGuard): ApiResponse<LoopGuard> {
  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: data.failing_run_len,
    drilldown_ids: { session_id: data.session_id },
  });
}

function okGuard(
  sessionId: string,
  reason: string,
  failCountThreshold = DEFAULT_HOOK_CONFIG.d7_fail_count,
  windowTurns = DEFAULT_HOOK_CONFIG.d7_window_turns,
): LoopGuard {
  return {
    stage: "ok",
    session_id: sessionId,
    identical_run_len: 0,
    failing_run_len: 0,
    fail_count_threshold: failCountThreshold,
    window_turns: windowTurns,
    reason,
    ts: new Date().toISOString(),
  };
}

function isFailingExitClass(exitClass: string | null): boolean {
  return exitClass === "TEST_FAIL" || exitClass === "ERROR";
}

/**
 * Return a bounded, strictly fail-open D7 guard result. The endpoint returns
 * only measured counts and identifiers; tool input and transcript text remain
 * outside this query and response.
 */
export function getLoopGuard(sessionId: string): ApiResponse<LoopGuard> {
  try {
    const db = getQueryDb();
    const config = readHookConfig(db);
    const events = db
      .prepare(
        `SELECT event_id, ts, input_hash, exit_class
           FROM tool_events INDEXED BY idx_tool_ts_session_event
          WHERE session_id = ?
          ORDER BY ts DESC, event_id DESC
          LIMIT ?`,
      )
      .all(sessionId, config.d7_window_turns * 8) as ToolEventRow[];

    if (events.length === 0) {
      const session = db
        .prepare("SELECT 1 AS present FROM sessions WHERE session_id = ? LIMIT 1")
        .get(sessionId) as { present: number } | undefined;
      return response(
        okGuard(
          sessionId,
          session === undefined ? "unknown_session" : "no_events",
          config.d7_fail_count,
          config.d7_window_turns,
        ),
      );
    }

    if (events.some((event) => !Number.isFinite(Date.parse(event.ts)))) {
      return response(
        okGuard(sessionId, "invalid_timestamp", config.d7_fail_count, config.d7_window_turns),
      );
    }

    const latest = events[0];
    if (latest === undefined) {
      return response(
        okGuard(sessionId, "no_events", config.d7_fail_count, config.d7_window_turns),
      );
    }
    const inputHash = latest.input_hash;
    const trailingRun: ToolEventRow[] = [];
    if (inputHash !== null) {
      for (const event of events) {
        if (event.input_hash !== inputHash) break;
        trailingRun.push(event);
      }
    }
    const identicalRunLen = trailingRun.length;
    const failingRunLen = trailingRun.filter((event) =>
      isFailingExitClass(event.exit_class),
    ).length;
    const stage =
      failingRunLen >= config.d7_fail_count
        ? "block"
        : failingRunLen >= Math.max(2, config.d7_fail_count - 1)
          ? "warn"
          : "ok";

    return response({
      stage,
      session_id: sessionId,
      identical_run_len: identicalRunLen,
      failing_run_len: failingRunLen,
      fail_count_threshold: config.d7_fail_count,
      window_turns: config.d7_window_turns,
      reason:
        stage === "block"
          ? "repeated_identical_failures"
          : stage === "warn"
            ? "near_repeated_identical_failures"
            : "below_threshold",
      ts: latest.ts,
    });
  } catch {
    return response(okGuard(sessionId, "unavailable"));
  }
}
