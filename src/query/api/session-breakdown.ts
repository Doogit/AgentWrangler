/** Session-scoped cost, tool, and chart-marker aggregates. */
import type { Db } from "../../db/open.js";
import { getQueryDb } from "../db-context.js";
import { type ApiResponse, buildResponse } from "../envelope.js";
import { sessionLoopFlaggedMessageIds } from "./session-drivers.js";

export interface SessionBreakdown {
  cost_rows: Array<{
    model: string;
    is_sidechain: boolean;
    turn_count: number;
    cost_u: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_write_other: number;
  }>;
  tools: Array<{
    tool_name: string;
    calls: number;
    errors: number;
    total_result_bytes: number;
    max_result_bytes: number;
    first_error_at: string | null;
    last_error_at: string | null;
    first_error_turn_index: number | null;
    error_breakdown: Array<{
      tool_error_class: string | null;
      bash_command_family: string | null;
      count: number;
    }>;
  }>;
  tool_error_turn_indices: number[];
  loop_turn_indices: number[];
}

export function getSessionBreakdown(
  sessionId: string,
  db: Db = getQueryDb(),
): ApiResponse<SessionBreakdown | null> {
  const session = db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
  if (session === undefined) {
    return buildResponse(null, {
      claim_kind: "OBS_PROXY",
      n: 0,
      drilldown_ids: { session_id: sessionId },
    });
  }
  const cost_rows = (
    db
      .prepare(`SELECT model, is_sidechain, COUNT(*) AS turn_count,
    COALESCE(SUM(cost_equiv_u), 0) AS cost_u,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,
    SUM(cache_write_other) AS cache_write_other
    FROM turns WHERE session_id = ? GROUP BY model, is_sidechain
    ORDER BY model, is_sidechain`)
      .all(sessionId) as Array<{
      model: string;
      is_sidechain: number;
      turn_count: number;
      cost_u: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_5m: number;
      cache_write_1h: number;
      cache_write_other: number;
    }>
  ).map((row) => ({ ...row, is_sidechain: row.is_sidechain === 1 }));
  const turnIndices = new Map(
    (
      db
        .prepare("SELECT message_id FROM turns WHERE session_id = ? ORDER BY ts, message_id")
        .all(sessionId) as Array<{ message_id: string }>
    ).map((turn, index) => [turn.message_id, index]),
  );
  const events = db
    .prepare(`SELECT e.ts, e.tool_name, e.exit_class, e.tool_error_class,
    e.bash_command_family, e.result_bytes, m.owner_message_id
    FROM tool_events e LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
    WHERE e.session_id = ? ORDER BY e.ts, e.event_id`)
    .all(sessionId) as Array<{
    ts: string;
    tool_name: string;
    exit_class: string | null;
    tool_error_class: string | null;
    bash_command_family: string | null;
    result_bytes: number | null;
    owner_message_id: string | null;
  }>;
  const tools = new Map<string, SessionBreakdown["tools"][number]>();
  const errorIndices = new Set<number>();
  for (const event of events) {
    let tool = tools.get(event.tool_name);
    if (tool === undefined) {
      tool = {
        tool_name: event.tool_name,
        calls: 0,
        errors: 0,
        total_result_bytes: 0,
        max_result_bytes: 0,
        first_error_at: null,
        last_error_at: null,
        first_error_turn_index: null,
        error_breakdown: [],
      };
      tools.set(event.tool_name, tool);
    }
    tool.calls++;
    tool.total_result_bytes += event.result_bytes ?? 0;
    tool.max_result_bytes = Math.max(tool.max_result_bytes, event.result_bytes ?? 0);
    if (event.exit_class !== "ERROR") continue;
    tool.errors++;
    tool.first_error_at ??= event.ts;
    tool.last_error_at = event.ts;
    const index =
      event.owner_message_id === null ? undefined : turnIndices.get(event.owner_message_id);
    if (index !== undefined) {
      errorIndices.add(index);
      tool.first_error_turn_index ??= index;
    }
    const family = event.tool_name === "Bash" ? event.bash_command_family : null;
    const group = tool.error_breakdown.find(
      (item) =>
        item.tool_error_class === event.tool_error_class && item.bash_command_family === family,
    );
    if (group === undefined)
      tool.error_breakdown.push({
        tool_error_class: event.tool_error_class,
        bash_command_family: family,
        count: 1,
      });
    else group.count++;
  }
  const loopOwners = sessionLoopFlaggedMessageIds(db, sessionId);
  const data: SessionBreakdown = {
    cost_rows,
    tools: [...tools.values()].sort(
      (a, b) => b.errors - a.errors || b.calls - a.calls || a.tool_name.localeCompare(b.tool_name),
    ),
    tool_error_turn_indices: [...errorIndices].sort((a, b) => a - b),
    loop_turn_indices: [...loopOwners]
      .flatMap((id) => {
        const index = turnIndices.get(id);
        return index === undefined ? [] : [index];
      })
      .sort((a, b) => a - b),
  };
  return buildResponse(data, {
    claim_kind: "OBS_PROXY",
    n: events.length,
    drilldown_ids: { session_id: sessionId },
  });
}
