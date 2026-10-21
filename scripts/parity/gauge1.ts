/**
 * scripts/parity/gauge1.ts — Gauge 1 (parity) staging.
 *
 * Per golden session id:
 *  1. Queries the seed DB for allow-listed metric fields.
 *  2. Calls buildSafePacket — throws (SEC-101) if any non-allow-listed field slipped in.
 *  3. Queries engine recommendation metadata (ids/codes/state — no content).
 *  4. Emits a scoresheet JSON with the §6 RUBRIC as frozen input + empty marks.
 *  5. Optionally calls the prompt arm (FLAGGED, opt-in, default OFF).
 *
 * The rubric is FIXED INPUT — never derived from output. The packet contains
 * ONLY allow-listed fields; nothing else may enter the prompt arm.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { RUBRIC, emptyScoresheet } from "./rubric.js";
import { buildSafePacket } from "./sec101-allow-list.js";

/** An evidence packet safe for external use (SEC-101 enforced). */
export interface EvidencePacket {
  session_id: string;
  fields: Record<string, unknown>;
}

/** Engine rec metadata — ids/codes/state only, never content. */
export interface RecMetadata {
  rec_id: string;
  detector_id: string | null;
  state: string;
  modeled_savings_u_per_wk: number | null;
  target_metric: string | null;
}

export interface Gauge1Result {
  session_id: string;
  packet: EvidencePacket;
  engine_recs: RecMetadata[];
  scoresheet_path: string;
}

/**
 * FROZEN H3 adversarial baseline prompt version (feat-U13). Pinned before any
 * golden output is scored so the Claude-arm baseline provably cannot drift
 * between freeze and scoring — parity must not be won by a silently-weakened
 * baseline. buildPromptFromPacket is FROZEN under this id: any change to the
 * baseline prompt text/structure requires bumping this version and re-registering
 * the freeze in docs/plans/Archive/00-EXECUTION-PLAN-DW.md (§8 feat-U13) BEFORE re-scoring.
 * The baseline is deliberately STRONG: it hands the model the full safe evidence
 * packet AND the entire 7-point rubric, so a parity loss reflects the engine, not
 * a strawman baseline.
 */
export const BASELINE_PROMPT_VERSION = "u13-baseline-1";

/** Injectable prompt arm runner. Default implementation calls the Anthropic API. */
export type PromptArmFn = (packet: EvidencePacket, outDir: string) => Promise<void>;

export interface Gauge1Options {
  dbPath: string;
  goldenSessionIds: string[];
  outDir: string;
  /** Whether the Claude-prompt arm is enabled. Default: false. */
  promptArmEnabled?: boolean;
  /**
   * Frozen must-catch per session (from the golden set). Threaded into each
   * scoresheet so H3 scoring reads the must-catch alongside the rubric. Sessions
   * not present here get a null must-catch.
   */
  mustCatchBySession?: Record<string, string>;
  /**
   * Override the prompt arm function — used for testing to assert it is/isn't called.
   * When undefined and promptArmEnabled is true, the real API arm runs.
   */
  _promptArmFn?: PromptArmFn;
}

/**
 * Query allow-listed metric fields for a single session.
 * Returns only the fields that are present and non-null.
 */
function querySessionMetrics(db: Database.Database, session_id: string): Record<string, unknown> {
  type SessionRow = {
    session_id: string;
    workspace_id: string;
    first_turn_at: string | null;
    last_turn_at: string | null;
    turn_count: number;
  };

  const session = db
    .prepare(
      "SELECT session_id, workspace_id, first_turn_at, last_turn_at, turn_count " +
        "FROM sessions WHERE session_id = ?",
    )
    .get(session_id) as SessionRow | undefined;

  if (!session) return {};

  const row: Record<string, unknown> = {
    session_id: session.session_id,
    workspace_id: session.workspace_id,
    window_start: session.first_turn_at,
    window_end: session.last_turn_at,
    turn_count: session.turn_count,
  };

  // D6: tool-result bytes
  type ToolRow = { tool_result_bytes_total: number | null; tool_event_count: number };
  const toolAgg = db
    .prepare(
      "SELECT COALESCE(SUM(result_bytes), 0) AS tool_result_bytes_total, " +
        "COUNT(*) AS tool_event_count FROM tool_events WHERE session_id = ?",
    )
    .get(session_id) as ToolRow;
  row["tool_result_bytes_total"] = toolAgg.tool_result_bytes_total ?? 0;
  row["tool_event_count"] = toolAgg.tool_event_count;

  // D2 + D8: cache tokens
  type CacheRow = {
    cache_read_tokens_total: number;
    cache_write_5m_tokens: number;
    cache_write_1h_tokens: number;
    context_tokens_max: number;
  };
  const cacheAgg = db
    .prepare(
      "SELECT " +
        "COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens_total, " +
        "COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m_tokens, " +
        "COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h_tokens, " +
        "COALESCE(MAX(context_tokens), 0) AS context_tokens_max " +
        "FROM turns WHERE session_id = ?",
    )
    .get(session_id) as CacheRow;
  row["cache_read_tokens_total"] = cacheAgg.cache_read_tokens_total;
  row["cache_write_5m_tokens"] = cacheAgg.cache_write_5m_tokens;
  row["cache_write_1h_tokens"] = cacheAgg.cache_write_1h_tokens;
  row["context_tokens_max"] = cacheAgg.context_tokens_max;

  // D1: context inventory tokens for this workspace
  type CtxRow = { context_inventory_tokens_total: number; context_inventory_file_count: number };
  const ctxAgg = db
    .prepare(
      "SELECT COALESCE(SUM(tokens), 0) AS context_inventory_tokens_total, " +
        "COUNT(*) AS context_inventory_file_count " +
        "FROM context_inventory WHERE workspace_id = ?",
    )
    .get(session.workspace_id) as CtxRow;
  row["context_inventory_tokens_total"] = ctxAgg.context_inventory_tokens_total;
  row["context_inventory_file_count"] = ctxAgg.context_inventory_file_count;

  // D2 derived: cache_write_tokens_total (5m + 1h combined)
  row["cache_write_tokens_total"] =
    (cacheAgg.cache_write_5m_tokens ?? 0) + (cacheAgg.cache_write_1h_tokens ?? 0);

  // Friction counts (2026-09-21 widening). All counts of closed CHECK-constrained enums;
  // version-gated exactly as the consuming detectors gate. No text is read or returned.
  // C2/C3/C4/C5/C11: tool-result error classes (tool_events.tool_error_class).
  type ToolErrRow = {
    tool_error_count: number;
    err_NOT_FOUND: number;
    err_NOT_READ: number;
    err_STALE_STRING: number;
    err_PATCH_FAILED: number;
    err_MCP_CONTENT_TOO_LARGE: number;
    err_MODIFIED_SINCE_READ: number;
    err_MULTI_MATCH: number;
    err_READ_OUTPUT_TOO_LARGE: number;
    interrupt_count: number;
    intr_PURE_INTERRUPT: number;
    intr_KILLED_NO_PROMPT: number;
    intr_HUMAN_DENY: number;
    bashfail_BASH_GIT: number;
    bashfail_BASH_NPM: number;
    bashfail_BASH_PYTHON: number;
    bashfail_BASH_TEST: number;
    bashfail_BASH_BUILD: number;
    bashfail_BASH_OTHER: number;
  };
  const toolErr = db
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class IS NOT NULL THEN 1 ELSE 0 END) AS tool_error_count, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'NOT_FOUND' THEN 1 ELSE 0 END) AS err_NOT_FOUND, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'NOT_READ' THEN 1 ELSE 0 END) AS err_NOT_READ, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'STALE_STRING' THEN 1 ELSE 0 END) AS err_STALE_STRING, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'PATCH_FAILED' THEN 1 ELSE 0 END) AS err_PATCH_FAILED, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'MCP_CONTENT_TOO_LARGE' THEN 1 ELSE 0 END) AS err_MCP_CONTENT_TOO_LARGE, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'MODIFIED_SINCE_READ' THEN 1 ELSE 0 END) AS err_MODIFIED_SINCE_READ, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'MULTI_MATCH' THEN 1 ELSE 0 END) AS err_MULTI_MATCH, " +
        "SUM(CASE WHEN tool_error_classifier_version = 'tool-error-1' AND tool_error_class = 'READ_OUTPUT_TOO_LARGE' THEN 1 ELSE 0 END) AS err_READ_OUTPUT_TOO_LARGE, " +
        "SUM(CASE WHEN interrupt_classifier_version = 'interrupt-1' AND interrupt_kind IS NOT NULL THEN 1 ELSE 0 END) AS interrupt_count, " +
        "SUM(CASE WHEN interrupt_classifier_version = 'interrupt-1' AND interrupt_kind = 'PURE_INTERRUPT' THEN 1 ELSE 0 END) AS intr_PURE_INTERRUPT, " +
        "SUM(CASE WHEN interrupt_classifier_version = 'interrupt-1' AND interrupt_kind = 'KILLED_NO_PROMPT' THEN 1 ELSE 0 END) AS intr_KILLED_NO_PROMPT, " +
        "SUM(CASE WHEN interrupt_classifier_version = 'interrupt-1' AND interrupt_kind = 'HUMAN_DENY' THEN 1 ELSE 0 END) AS intr_HUMAN_DENY, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_GIT' THEN 1 ELSE 0 END) AS bashfail_BASH_GIT, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_NPM' THEN 1 ELSE 0 END) AS bashfail_BASH_NPM, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_PYTHON' THEN 1 ELSE 0 END) AS bashfail_BASH_PYTHON, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_TEST' THEN 1 ELSE 0 END) AS bashfail_BASH_TEST, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_BUILD' THEN 1 ELSE 0 END) AS bashfail_BASH_BUILD, " +
        "SUM(CASE WHEN bash_command_family = 'BASH_OTHER' THEN 1 ELSE 0 END) AS bashfail_BASH_OTHER " +
        "FROM tool_events WHERE session_id = ?",
    )
    .get(session_id) as ToolErrRow;
  row["tool_error_count"] = toolErr.tool_error_count ?? 0;
  row["err_NOT_FOUND"] = toolErr.err_NOT_FOUND ?? 0;
  row["err_NOT_READ"] = toolErr.err_NOT_READ ?? 0;
  row["err_STALE_STRING"] = toolErr.err_STALE_STRING ?? 0;
  row["err_PATCH_FAILED"] = toolErr.err_PATCH_FAILED ?? 0;
  row["err_MCP_CONTENT_TOO_LARGE"] = toolErr.err_MCP_CONTENT_TOO_LARGE ?? 0;
  row["err_MODIFIED_SINCE_READ"] = toolErr.err_MODIFIED_SINCE_READ ?? 0;
  row["err_MULTI_MATCH"] = toolErr.err_MULTI_MATCH ?? 0;
  row["err_READ_OUTPUT_TOO_LARGE"] = toolErr.err_READ_OUTPUT_TOO_LARGE ?? 0;
  row["interrupt_count"] = toolErr.interrupt_count ?? 0;
  row["intr_PURE_INTERRUPT"] = toolErr.intr_PURE_INTERRUPT ?? 0;
  row["intr_KILLED_NO_PROMPT"] = toolErr.intr_KILLED_NO_PROMPT ?? 0;
  row["intr_HUMAN_DENY"] = toolErr.intr_HUMAN_DENY ?? 0;
  row["bashfail_BASH_GIT"] = toolErr.bashfail_BASH_GIT ?? 0;
  row["bashfail_BASH_NPM"] = toolErr.bashfail_BASH_NPM ?? 0;
  row["bashfail_BASH_PYTHON"] = toolErr.bashfail_BASH_PYTHON ?? 0;
  row["bashfail_BASH_TEST"] = toolErr.bashfail_BASH_TEST ?? 0;
  row["bashfail_BASH_BUILD"] = toolErr.bashfail_BASH_BUILD ?? 0;
  row["bashfail_BASH_OTHER"] = toolErr.bashfail_BASH_OTHER ?? 0;

  // C9 denials + H1 destructive ops (ingest_metric_events closed enums).
  type MetricEvtRow = {
    denial_interrupt_cancel: number;
    denial_user_rejected: number;
    denial_hook_block: number;
    denial_deny_rule: number;
    destructive_op_count: number;
  };
  const metricEvt = db
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN classifier_label = 'interrupt-cancel' THEN 1 ELSE 0 END) AS denial_interrupt_cancel, " +
        "SUM(CASE WHEN classifier_label = 'user-rejected' THEN 1 ELSE 0 END) AS denial_user_rejected, " +
        "SUM(CASE WHEN classifier_label = 'hook-block' THEN 1 ELSE 0 END) AS denial_hook_block, " +
        "SUM(CASE WHEN classifier_label = 'deny-rule' THEN 1 ELSE 0 END) AS denial_deny_rule, " +
        "SUM(CASE WHEN destructive_op IS NOT NULL THEN 1 ELSE 0 END) AS destructive_op_count " +
        "FROM ingest_metric_events WHERE session_id = ?",
    )
    .get(session_id) as MetricEvtRow;
  const denialInterruptCancel = metricEvt.denial_interrupt_cancel ?? 0;
  const denialUserRejected = metricEvt.denial_user_rejected ?? 0;
  const denialHookBlock = metricEvt.denial_hook_block ?? 0;
  const denialDenyRule = metricEvt.denial_deny_rule ?? 0;
  row["denial_interrupt_cancel"] = denialInterruptCancel;
  row["denial_user_rejected"] = denialUserRejected;
  row["denial_hook_block"] = denialHookBlock;
  row["denial_deny_rule"] = denialDenyRule;
  row["denial_count"] =
    denialInterruptCancel + denialUserRejected + denialHookBlock + denialDenyRule;
  row["destructive_op_count"] = metricEvt.destructive_op_count ?? 0;

  return row;
}

/** Query engine recommendation metadata for a workspace (recs are scoped to workspace). */
function queryEngineRecs(db: Database.Database, workspace_id: string): RecMetadata[] {
  return db
    .prepare(
      "SELECT rec_id, detector_id, state, modeled_savings_u_per_wk, target_metric " +
        "FROM recommendations WHERE scope_workspace_id = ? ORDER BY created_at DESC",
    )
    .all(workspace_id) as RecMetadata[];
}

/** Real prompt arm: calls the Anthropic API with the safe evidence packet. */
async function defaultPromptArmFn(packet: EvidencePacket, outDir: string): Promise<void> {
  // Dynamic import keeps the SDK out of the cold path.
  // This branch is NEVER reached unless promptArmEnabled=true is explicitly set.
  // The SDK is not a dependency; a variable specifier keeps tsc from resolving it.
  const sdk = "@anthropic-ai/sdk";
  const { default: Anthropic } = (await import(sdk)) as unknown as {
    default: new () => { messages: { create: (o: Record<string, unknown>) => Promise<unknown> } };
  };
  const client = new Anthropic();
  const prompt = buildPromptFromPacket(packet);
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const outPath = path.join(outDir, `prompt-arm-${packet.session_id}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        baseline_prompt_version: BASELINE_PROMPT_VERSION,
        packet_summary: {
          session_id: packet.session_id,
          field_count: Object.keys(packet.fields).length,
        },
        response,
      },
      null,
      2,
    ),
  );
}

/**
 * FROZEN baseline prompt (feat-U13, version BASELINE_PROMPT_VERSION). Do NOT
 * edit the text/structure without bumping BASELINE_PROMPT_VERSION and
 * re-registering the freeze — see that constant's doc comment.
 *
 * Exported so the H3 Claude-arm staging can emit the IDENTICAL frozen prompt
 * (packet + rubric) for the operator-chosen subagent baseline path, guaranteeing
 * the subagent arm and the API arm consume byte-identical prompts. Reuse this —
 * never re-type the preamble in a staging script, which would silently drift.
 */
export function buildPromptFromPacket(packet: EvidencePacket): string {
  const lines: string[] = [
    "You are reviewing Claude Code usage metrics for a single session.",
    "Based ONLY on the following aggregated metrics (no transcript content),",
    "provide a concrete, quantified recommendation with a paste-able artifact.",
    "",
    `Session: ${packet.session_id}`,
    `Workspace: ${String(packet.fields["workspace_id"] ?? "unknown")}`,
    `Window: ${String(packet.fields["window_start"] ?? "")} – ${String(packet.fields["window_end"] ?? "")}`,
    "",
    "Metrics:",
  ];
  for (const [k, v] of Object.entries(packet.fields)) {
    if (!["session_id", "workspace_id", "window_start", "window_end"].includes(k)) {
      lines.push(`  ${k}: ${String(v)}`);
    }
  }
  lines.push(
    "",
    "Provide one concrete recommendation meeting ALL of these criteria:",
    ...RUBRIC.map((r) => `  ${r.id} ${r.label}: ${r.description}`),
  );
  return lines.join("\n");
}

/** Run Gauge 1 for all golden sessions. Returns one result per session. */
export async function runGauge1(opts: Gauge1Options): Promise<Gauge1Result[]> {
  const db = new Database(opts.dbPath, { readonly: true });
  fs.mkdirSync(opts.outDir, { recursive: true });

  const armFn = opts._promptArmFn ?? defaultPromptArmFn;
  const results: Gauge1Result[] = [];

  for (const session_id of opts.goldenSessionIds) {
    const rawFields = querySessionMetrics(db, session_id);

    // SEC-101 hard gate: throws if any non-allow-listed field slipped in.
    const safeFields = buildSafePacket(rawFields);
    const packet: EvidencePacket = { session_id, fields: safeFields };

    const workspace_id = String(rawFields["workspace_id"] ?? "");
    const engine_recs = workspace_id ? queryEngineRecs(db, workspace_id) : [];

    const scoresheet = emptyScoresheet(session_id, opts.mustCatchBySession?.[session_id] ?? null);
    const scoresheetPath = path.join(opts.outDir, `scoresheet-${session_id}.json`);
    fs.writeFileSync(
      scoresheetPath,
      JSON.stringify(
        {
          rubric: RUBRIC,
          scoresheet,
          engine_recs_count: engine_recs.length,
          engine_rec_ids: engine_recs.map((r) => r.rec_id),
        },
        null,
        2,
      ),
    );

    if (opts.promptArmEnabled === true) {
      await armFn(packet, opts.outDir);
    }

    results.push({ session_id, packet, engine_recs, scoresheet_path: scoresheetPath });
  }

  db.close();
  return results;
}
