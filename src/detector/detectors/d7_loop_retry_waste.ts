/**
 * D7 LOOP_RETRY_WASTE.
 *
 * Detects three privacy-safe structural loop signals in reconciled sessions:
 * repeated identical tool calls, repeated TEST_FAIL results, and repeated reads
 * of one path/region identity without an intervening edit/write to that path.
 * Raw tool inputs, outputs, commands, paths, and path hashes never leave the
 * query/detection boundary.
 */

import type { Db } from "../../db/open.js";
import { getEsfObservedTestRecoveryContext } from "../../query/api/esf-observations.js";
import { capWeightForTurn, resolveCapReadCoeff } from "../../query/cap-weighted.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import { resolveBytesPerToken } from "../calibration.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { analyzeD7LoopEvents, isClaimedByC3 } from "../d7-loop-analysis.js";
import { recId } from "../rec-id.js";
import { createResultCarry, resultClaimsForEvent } from "../result-claims.js";
import {
  D7_AVOIDANCE_FRACTION,
  ESTIMATOR_BYTES_PER_TOKEN,
  carryPriceUsdPerMtok,
  d7Estimate,
  d7LoopSavings,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";
import { A1_RESULT_BYTES_THRESHOLD } from "./a1_tool_result_bloat.js";

/** D7's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const D7_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D7?.constants.find(
  (constant) => constant.name === "D7_AVOIDANCE_FRACTION",
);
const D7_FRACTION_RANGE: readonly [number, number] =
  D7_FRACTION_CONSTANT && D7_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D7_FRACTION_CONSTANT.min, D7_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D7

/**
 * Sessions whose owner-turn-metadata coverage is below this floor suppress the
 * two enrichment-sensitive friction signals (same-tool ERROR runs and
 * Edit-without-prior-Read): a dropped unenriched event could otherwise fabricate
 * a false consecutive-error run or a false missing establishing Read. The live 7d
 * slice has a per-session coverage median of ~0.98; 0.8 keeps the vast majority
 * of sessions while dropping only the low-coverage tail.
 */
const OWNER_TURN_METADATA_COVERAGE_FLOOR = 0.8;

/**
 * Item 4: a file read this many+ times across >= 2 reconciled sessions in the
 * workspace window is a cross-subagent redundant-read tax (e.g. every subagent
 * re-opening the master plan). Derived from the live 7d slice — 10 keeps the
 * flagship 100+-read case and its neighbours while staying quiet on incidental
 * shared reads. Weighted by result_bytes (the returned content), not input_bytes.
 */
const MIN_CROSS_SESSION_READS = 10;
/** XREAD card gate: the re-reads' carry cost as a % of the workspace's spend in the window (U7). */
const D7_XREAD_MIN_PCT_OF_SPEND = 0.1;
// R2.7: reads with results over A1_RESULT_BYTES_THRESHOLD are A1's; D7 counts only the rest.
/**
 * No single session may account for more than 80% of a path's reads: this
 * excludes a dominant-session re-read (such as 9+1) while retaining genuinely
 * shared work. The boundary is inclusive so an 8+2 split still qualifies.
 */
const MAX_SESSION_SHARE = 0.8;
/** Perf guard: bound the redundant-read scan output (Item-4 cold-path budget). */
const CROSS_SESSION_READ_ROW_CAP = 500;

/** Top files per workspace whose read the card names; bounds the transcript lookups. */
const TOP_READ_FILES = 5;
/** Calls of the loop example the card reads back. */
const LOOP_EXAMPLE_CALLS = 5;

/**
 * One re-read identity (F7, 2026-10-04): a path, the region read (`input_hash` covers offset and
 * limit) and the result size. A later session's read is redundant only when it got back what an
 * earlier session already had; another region, or a file that changed size, is new context.
 */
interface CrossSessionReadRow {
  workspace_id: string;
  file_path_hash: string;
  input_hash: string | null;
  result_bytes: number;
  read_count: number;
  session_count: number;
  total_result_bytes: number;
  session_list: string;
}

/**
 * The qualifying (workspace, file_path_hash) rollup rows themselves — same gates, same
 * LIMIT 500 / ordering — shared by the detector's own rollup and `d7xClaimProducer` (P3.L L3)
 * so they agree on exactly which paths qualify.
 */
function qualifyingCrossSessionReadPaths(db: Db, ctx: DetectorContext): CrossSessionReadRow[] {
  return db
    .prepare(
      // D7b1: a session that edits a file has to read it again, so its reads of that file are left out.
      // The edited set is probed with NOT IN (an indexed list, built once). A correlated NOT EXISTS
      // over this CTE re-ran it once per read row: ~20 s on the live DB. Both columns are non-null
      // (session_id is NOT NULL, file_path_hash is filtered), so NOT IN matches NOT EXISTS exactly.
      `WITH edited AS (
         SELECT DISTINCT e.session_id, m.file_path_hash
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ?
          AND e.tool_name IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
          AND m.file_path_hash IS NOT NULL
       ),
       per_session_reads AS (
         SELECT s.workspace_id,
                m.file_path_hash,
                e.input_hash,
                COALESCE(e.result_bytes, 0) AS result_bytes,
                e.session_id,
                COUNT(*) AS session_read_count,
                SUM(COALESCE(e.result_bytes, 0)) AS session_result_bytes
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ? AND e.tool_name = 'Read'
          AND m.file_path_hash IS NOT NULL
          AND COALESCE(e.result_bytes, 0) <= ?
          AND (e.session_id, m.file_path_hash) NOT IN (
            SELECT session_id, file_path_hash FROM edited)
        GROUP BY s.workspace_id, m.file_path_hash, e.input_hash, COALESCE(e.result_bytes, 0),
                 e.session_id
       )
       -- T9: a read identity qualifies on all its reads, but counts one read per session (of the
       -- session's average size): repeats inside a session are the loop card's.
       SELECT workspace_id, file_path_hash, input_hash, result_bytes,
              SUM(session_read_count) AS read_count,
              COUNT(*) AS session_count,
              SUM(session_result_bytes / session_read_count) AS total_result_bytes,
              GROUP_CONCAT(session_id, char(31)) AS session_list
         FROM per_session_reads
        GROUP BY workspace_id, file_path_hash, input_hash, result_bytes
       HAVING read_count >= ?
          AND session_count >= 2
          AND CAST(MAX(session_read_count) AS REAL) / read_count <= ?
        ORDER BY total_result_bytes DESC
        LIMIT ?`,
    )
    .all(
      ctx.fromIso,
      ctx.toIso,
      ctx.fromIso,
      ctx.toIso,
      A1_RESULT_BYTES_THRESHOLD,
      MIN_CROSS_SESSION_READS,
      MAX_SESSION_SHARE,
      CROSS_SESSION_READ_ROW_CAP,
    ) as CrossSessionReadRow[];
}

/**
 * Workspace-scoped rollup of the same file_path_hash read across multiple
 * sessions in the window, weighted by result_bytes. One Fired per workspace with
 * qualifying paths. SEC-101: emits only counts and byte sums — never the path
 * hash itself.
 */
function crossSessionRedundantReads(db: Db, ctx: DetectorContext): Fired[] {
  const rows = qualifyingCrossSessionReadPaths(db, ctx);

  const byWorkspace = new Map<
    string,
    {
      /** Read identities: each one's first session is the origin, not a re-read. */
      paths: number;
      files: Set<string>;
      reads: number;
      bytes: number;
      maxReads: number;
      maxSessions: number;
      sessions: Set<string>;
    }
  >();
  for (const row of rows) {
    const agg = byWorkspace.get(row.workspace_id) ?? {
      paths: 0,
      files: new Set<string>(),
      reads: 0,
      bytes: 0,
      maxReads: 0,
      maxSessions: 0,
      sessions: new Set<string>(),
    };
    for (const sessionId of row.session_list.split("\u001f")) agg.sessions.add(sessionId);
    agg.paths += 1;
    agg.files.add(row.file_path_hash);
    agg.reads += row.session_count;
    agg.bytes += row.total_result_bytes;
    if (row.read_count > agg.maxReads) {
      agg.maxReads = row.read_count;
      agg.maxSessions = row.session_count;
    }
    byWorkspace.set(row.workspace_id, agg);
  }

  const bpt = resolveBytesPerToken(db);
  // The latest read of a path: its tool_use id is how the card finds the path in the transcript.
  const latestRead = db.prepare(
    `SELECT e.event_id
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
       JOIN tool_event_metadata m ON m.event_id = e.event_id
      WHERE s.workspace_id = ? AND m.file_path_hash = ?
        AND e.input_hash IS ? AND COALESCE(e.result_bytes, 0) = ?
        AND e.ts >= ? AND e.ts < ? AND e.tool_name = 'Read'
        AND COALESCE(e.result_bytes, 0) <= ?
      ORDER BY e.ts DESC, e.event_id DESC
      LIMIT 1`,
  );
  const topReadEventIds = (workspaceId: string): string[] =>
    rows
      .filter((row) => row.workspace_id === workspaceId)
      .sort((a, b) => b.read_count - a.read_count || b.total_result_bytes - a.total_result_bytes)
      // A file re-read in two regions is still one file on the card.
      .filter((row, i, all) => all.findIndex((r) => r.file_path_hash === row.file_path_hash) === i)
      .slice(0, TOP_READ_FILES)
      .flatMap((row) => {
        const read = latestRead.get(
          workspaceId,
          row.file_path_hash,
          row.input_hash,
          row.result_bytes,
          ctx.fromIso,
          ctx.toIso,
          A1_RESULT_BYTES_THRESHOLD,
        ) as { event_id: string } | undefined;
        return read === undefined ? [] : [read.event_id];
      });

  // U7: each redundant re-read is priced along its owner chain (one cache write, then a read on
  // every later turn), the same walk and 2.7 bytes/token fallback as the ledger claims.
  const bytesPerToken = bpt.calibrated ? bpt.ratio : ESTIMATOR_BYTES_PER_TOKEN;
  const resultCarry = createResultCarry(db);
  const carryCostByWorkspace = new Map<string, number>();
  for (const read of redundantCrossSessionReads(db, ctx, rows)) {
    const carried = resultCarry(read.session_id, read.ts, read.owner_message_id);
    if (carried === undefined || carried.carry === 0) continue;
    const costU =
      ((read.result_bytes ?? 0) / bytesPerToken) *
      carryPriceUsdPerMtok(carried.carry, carried.writePrice, carried.readPrice);
    carryCostByWorkspace.set(
      read.workspaceId,
      (carryCostByWorkspace.get(read.workspaceId) ?? 0) + costU,
    );
  }
  const fromMs = Date.parse(ctx.fromIso);
  const toMs = Date.parse(ctx.toIso);

  const fired: Fired[] = [];
  for (const [workspaceId, agg] of byWorkspace) {
    const carryCostU = carryCostByWorkspace.get(workspaceId) ?? 0;
    // Settled % floor: a priced re-read cost under 0.1% of the workspace's spend is noise. An
    // unpriceable cost (no owner turn data) keeps the card, with no $.
    if (
      carryCostU > 0 &&
      (pctOfSpend(carryCostU, workspaceSpendU(db, workspaceId, fromMs, toMs)) ?? 0) <
        D7_XREAD_MIN_PCT_OF_SPEND
    ) {
      continue;
    }
    const modeledSavingsU = carryCostU > 0 ? Math.round(carryCostU * D7_AVOIDANCE_FRACTION) : null;

    fired.push({
      scopeKey: `D7-XREAD|${workspaceId}`,
      scope_workspace_id: workspaceId,
      modeled_savings_u_per_wk: modeledSavingsU,
      // Basis E: the re-reads' carry cost x the avoidance fraction (the ledger claims use the same).
      modeled_formula_json: {
        estimate: {
          ...d7Estimate({ xread: true }),
          rank_value_u_per_wk: modeledSavingsU ?? 0,
          label: bpt.calibrated
            ? "cross-session reread carry estimate"
            : "cross-session reread carry estimate (2.7 bytes per token, not calibrated)",
        },
      },
      payload: {
        version: 1,
        template_id: "D7_CROSS_SESSION_REREAD",
        facts: {
          workspace_id: workspaceId,
          redundant_path_count: agg.files.size,
          total_redundant_read_count: agg.reads,
          total_redundant_result_bytes: agg.bytes,
          max_path_read_count: agg.maxReads,
          max_path_session_count: agg.maxSessions,
          session_ids: [...agg.sessions].sort().slice(0, 20),
          session_count: agg.sessions.size,
          top_read_event_ids: topReadEventIds(workspaceId),
        },
      },
    });
  }
  return fired;
}

/**
 * SEC-101: harness tool names are a fixed enum and safe to render; MCP tool names
 * (`mcp__<server>__<tool>`) can leak internal infra, so they collapse to a fixed
 * category label in any human-readable step. The full name stays only in the
 * structural evidence counts.
 */
function toolStepLabel(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  return /browser|chrome/i.test(toolName) ? "An MCP browser tool" : "An MCP tool";
}

interface EventRow {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  tool_name: string;
  input_hash: string | null;
  exit_class: string | null;
  file_path_hash: string | null;
  owner_message_id: string;
  block_index: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  /** Ingest's by-class price of the owner turn (µUSD); NULL = unpriceable. */
  cost_equiv_u: number | null;
  /** The owner turn's pricing snapshot `[input, output, cacheRead, write5m, write1h]`. */
  unit_prices_json: string | null;
  /** The owner turn's subagent id; null for the main thread (R6-10). */
  context: string | null;
  eligible: boolean;
}

/** A repeat turn's cost split for display: read, write and input+output µUSD (and tokens). */
interface LoopCost {
  readTokens: number;
  writeTokens: number;
  ioTokens: number;
  readU: number;
  writeU: number;
  ioU: number;
  costU: number;
}

const zeroLoopCost = (): LoopCost => ({
  readTokens: 0,
  writeTokens: 0,
  ioTokens: 0,
  readU: 0,
  writeU: 0,
  ioU: 0,
  costU: 0,
});

/**
 * Adds a repeat turn to the loop's cost (review 5 B1). The total is ingest's stored
 * `cost_equiv_u` (no second price path); the components come from the turn's own snapshot, for
 * display only, with `cache_write_other` priced as 5m (`pricing.ts`). A NULL-cost turn adds 0.
 */
function addLoopCost(total: LoopCost, row: EventRow): void {
  if (row.cost_equiv_u === null) return;
  const [input = 0, output = 0, read = 0, write5m = 0, write1h = 0] =
    row.unit_prices_json === null ? [] : (JSON.parse(row.unit_prices_json) as number[]);
  const write5mTokens = row.cache_write_5m + row.cache_write_other;
  total.readTokens += row.cache_read_tokens;
  total.writeTokens += write5mTokens + row.cache_write_1h;
  total.ioTokens += row.input_tokens + row.output_tokens;
  total.readU += row.cache_read_tokens * read;
  total.writeU += write5mTokens * write5m + row.cache_write_1h * write1h;
  total.ioU += row.input_tokens * input + row.output_tokens * output;
  total.costU += row.cost_equiv_u;
}

/** Tools whose repeat is waiting for something to finish, not a retry. */
const POLL_TOOLS = new Set(["Monitor", "TaskOutput", "BashOutput"]);
const GUARD_BLOCK = /^PreToolUse:\S+ hook error\b/;
/** A shell command that ran and failed reports "Exit code N"; any other shell error never ran. */
const SHELL_RAN = /^\s*Exit code -?\d+/;

/**
 * F7 (2026-10-04): a call that is no loop evidence, so it only ends a sequence. A successful
 * browser call repeats while a page loads (`computer` wait, screenshot), a poll tool repeats while
 * a job runs, and a call a PreToolUse guard blocked is C9's. F30 (2026-10-14): a guard that denies
 * with its own reason text has no "hook error" prefix, so a Bash/PowerShell error without
 * "Exit code N" (the command never ran) is one too.
 */
export function isD7NonLoopCall(
  toolName: string,
  exitClass: string | null,
  errorText: string | null,
): boolean {
  if (errorText !== null && GUARD_BLOCK.test(errorText)) return true;
  if (
    errorText !== null &&
    (toolName === "Bash" || toolName === "PowerShell") &&
    !SHELL_RAN.test(errorText)
  )
    return true;
  if (exitClass === "ERROR") return false;
  return POLL_TOOLS.has(toolName) || /^mcp__.*(browser|chrome|playwright)/i.test(toolName);
}

/** A tool result over 25 KB: A1 owns it, so the loop card does not count it (T9, R2.7). */
export function isA1Result(resultBytes: number | null): boolean {
  return resultBytes !== null && resultBytes > A1_RESULT_BYTES_THRESHOLD;
}

type CoverageRow = Omit<EventRow, "owner_message_id" | "block_index" | "eligible"> & {
  result_bytes: number | null;
  error_text: string | null;
  tool_error_class: string | null;
  tool_error_classifier_version: string | null;
  owner_message_id: string | null;
  block_index: number | null;
  metadata_rows: number;
  owner_eligible: number;
  covered_event: number;
  content_text: string | null;
};

interface SessionCoverage {
  denominator: number;
  covered: number;
}

interface SessionTotalsRow {
  session_id: string;
  turn_count: number;
}

interface SessionSignals {
  workspaceId: string;
  rows: EventRow[];
}

export function normalizedClusterText(text: string | null): string | null {
  if (text === null) return null;
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "" ? null : normalized;
}

export const d7Detector: Detector = {
  contractVersion: 1,
  // U9 r4: a same-tool error run needs one unchanged input/error text.
  version: "D7@u9-1",
  scope: "session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
      "tool_event_content",
      "ingest_metric_events",
    ],
  },
  id: "D7",
  name: "LOOP_RETRY_WASTE",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const candidateRows = db
      .prepare(
        `WITH params(from_ts, as_of_ts) AS (VALUES (?, ?)),
             candidates AS (
               SELECT e.event_id, e.session_id, e.ts AS event_ts, e.tool_name,
                      e.input_hash, e.exit_class, e.result_bytes,
                      e.tool_error_class, e.tool_error_classifier_version,
                      COALESCE(json_extract(c.content_json, '$.command'),
                               json_extract(c.content_json, '$.error')) AS content_text,
                      json_extract(c.content_json, '$.error') AS error_text,
                      s.workspace_id AS session_workspace_id,
                      m.file_path_hash, m.owner_message_id, m.block_index,
                      CASE WHEN m.event_id IS NULL THEN 0 ELSE 1 END AS metadata_rows,
                      CASE WHEN t.message_id IS NULL THEN 0 ELSE 1 END AS owner_rows,
                      t.session_id AS owner_session_id, t.workspace_id AS owner_workspace_id,
                      t.ts AS owner_ts, t.provisional AS owner_provisional,
                      t.input_tokens, t.output_tokens, t.cache_read_tokens,
                      t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
                      t.cost_equiv_u, ps.unit_prices_json, t.agent_id AS context,
                      p.from_ts, p.as_of_ts
                 FROM tool_events e INDEXED BY idx_tool_ts_session_event
                 JOIN sessions s
                   ON s.session_id = e.session_id
                  AND s.state = 'RECONCILED'
                 LEFT JOIN tool_event_content c ON c.event_id = e.event_id
                 LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
                 LEFT JOIN turns t ON t.message_id = m.owner_message_id
                 LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
                 CROSS JOIN params p
             ),
             classified AS (
               SELECT *,
                      CASE WHEN strftime('%s', event_ts) IS NULL THEN 1 ELSE 0 END AS event_malformed,
                      CASE WHEN strftime('%s', event_ts) IS NOT NULL
                                AND julianday(event_ts) >= julianday(from_ts)
                                AND julianday(event_ts) < julianday(as_of_ts)
                           THEN 1 ELSE 0 END AS in_window,
                      CASE WHEN metadata_rows = 1 AND owner_rows = 1
                                AND owner_session_id = session_id
                                AND owner_workspace_id = session_workspace_id
                                AND owner_provisional = 0
                                AND strftime('%s', owner_ts) IS NOT NULL
                                AND julianday(owner_ts) >= julianday(from_ts)
                                AND julianday(owner_ts) < julianday(as_of_ts)
                           THEN 1 ELSE 0 END AS owner_eligible
                 FROM candidates
             ),
             eligible AS (
               SELECT *, in_window AS denominator_event,
                      CASE WHEN in_window = 1 AND owner_eligible = 1
                           THEN 1 ELSE 0 END AS covered_event
                 FROM classified
             )
        SELECT event_id, session_id, session_workspace_id AS workspace_id, event_ts AS ts,
               tool_name, input_hash, exit_class, result_bytes,
               tool_error_class, tool_error_classifier_version, content_text, error_text, file_path_hash, owner_message_id, block_index,
               input_tokens, output_tokens, cache_read_tokens,
               cache_write_5m, cache_write_1h, cache_write_other,
               cost_equiv_u, unit_prices_json, context,
               metadata_rows, owner_eligible, covered_event
          FROM eligible
         WHERE denominator_event = 1
         ORDER BY session_id ASC, ts ASC, block_index ASC, event_id ASC`,
      )
      .all(ctx.fromIso, ctx.toIso) as CoverageRow[];

    const coverageBySession = new Map<string, SessionCoverage>();
    for (const row of candidateRows) {
      const coverage = coverageBySession.get(row.session_id) ?? { denominator: 0, covered: 0 };
      coverage.denominator += 1;
      if (row.covered_event === 1) coverage.covered += 1;
      coverageBySession.set(row.session_id, coverage);
    }

    const coveredRows = candidateRows.filter((row) => row.covered_event === 1);
    // U7: an event C3 (Edit before Read) already owns is no loop evidence here; it only ends a sequence.
    const rows = coveredRows.map(({ content_text, error_text, result_bytes, ...row }) => ({
      ...row,
      // The content slice supersedes input_hash for migration-028-backed
      // events. Retain the hash for uncaptured tools and historical rows.
      input_hash: normalizedClusterText(content_text) ?? row.input_hash,
      result_bytes,
      // T9: a result over 25 KB is A1's; it stays a sequence boundary but flags no loop. F7: so
      // does a poll or a guard block.
      eligible:
        !isA1Result(result_bytes) &&
        !isD7NonLoopCall(row.tool_name, row.exit_class, error_text) &&
        !isClaimedByC3(row),
    })) as EventRow[];

    // Item 4 is a workspace-window rollup independent of the per-session enriched
    // matcher, so it must fire even when no session clears the coverage filter.
    const crossSessionFired = crossSessionRedundantReads(db, ctx);

    if (rows.length === 0) {
      if (crossSessionFired.length > 0) {
        return {
          fired: crossSessionFired,
          status: "ACTIVE",
          note: `${crossSessionFired.length} workspace(s) with cross-session redundant reads`,
        };
      }
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note: "0 enriched tool events available in the trailing window; forward-only D7 coverage has not started",
      };
    }

    const bySession = new Map<string, SessionSignals>();
    for (const row of rows) {
      const session = bySession.get(row.session_id) ?? {
        workspaceId: row.workspace_id,
        rows: [],
      };
      session.rows.push(row);
      bySession.set(row.session_id, session);
    }

    const totalRows = db
      .prepare(
        `SELECT t.session_id, COUNT(*) AS turn_count
           FROM turns t INDEXED BY idx_turns_ts_provisional_session
           JOIN sessions s ON s.session_id = t.session_id
          WHERE t.ts >= ? AND t.ts < ?
            AND t.provisional = 0
            AND s.state = 'RECONCILED'
          GROUP BY t.session_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as SessionTotalsRow[];
    const totalTurnsBySession = new Map(totalRows.map((row) => [row.session_id, row.turn_count]));
    const capReadCoeff = resolveCapReadCoeff(db);

    // Group sessions by workspace for per-workspace rollup.
    const byWorkspace = new Map<string, string[]>();
    for (const [sessionId, session] of bySession) {
      const ids = byWorkspace.get(session.workspaceId) ?? [];
      ids.push(sessionId);
      byWorkspace.set(session.workspaceId, ids);
    }

    const fired: Fired[] = [];
    for (const [workspaceId, sessionIds] of byWorkspace) {
      let loopFlaggedEventCount = 0;
      let loopFlaggedTurnCount = 0;
      let repeatExcessEventCount = 0;
      let repeatExcessTurnCount = 0;
      let repeatExcessTurnCapWeightedTokens = 0;
      const loopCost = zeroLoopCost();
      let identicalCallEventCount = 0;
      let testFailEventCount = 0;
      let redundantReadEventCount = 0;
      let threeGramLoopEventCount = 0;
      let errorLoopEventCount = 0;
      let editWithoutReadEventCount = 0;
      let totalTurnCount = 0;
      let coveredSum = 0;
      let denominatorSum = 0;
      let shareSum = 0;
      let anyFrictionSuppressed = false;
      const errorToolLabels = new Set<string>();
      const contributingSessionIds: string[] = [];
      // The most-repeated flagged call in the workspace (same tool and input), as the card's example.
      let loopExample: string[] = [];

      for (const sessionId of sessionIds) {
        const session = bySession.get(sessionId);
        if (!session) continue;

        // Friction signals (same-tool ERROR runs, Edit-without-prior-Read) rely on
        // within-session adjacency, so gate them on this session's own owner-turn
        // metadata coverage; a dropped unenriched event could otherwise fabricate a
        // false consecutive-error run or a false missing establishing Read.
        const coverage = coverageBySession.get(sessionId);
        if (!coverage || coverage.denominator === 0) {
          throw new Error("D7 coverage denominator missing for fired session");
        }
        const sessionCoverage = Number((coverage.covered / coverage.denominator).toFixed(6));
        const includeFrictionSignals = sessionCoverage >= OWNER_TURN_METADATA_COVERAGE_FLOOR;

        const {
          identicalCalls,
          testFails,
          redundantReads,
          threeGramLoops,
          errorRuns,
          editWithoutRead,
          repeatExcessEventIds,
          flaggedEventIds,
        } = analyzeD7LoopEvents(session.rows, { includeFrictionSignals });
        if (flaggedEventIds.size === 0) continue;

        const flaggedTurns = new Map<string, EventRow>();
        const repeatExcessTurns = new Map<string, EventRow>();
        for (const row of session.rows) {
          if (flaggedEventIds.has(row.event_id)) flaggedTurns.set(row.owner_message_id, row);
          if (repeatExcessEventIds.has(row.event_id)) {
            repeatExcessTurns.set(row.owner_message_id, row);
          }
        }

        let sessionRepeatExcessCapWeighted = 0;
        for (const row of repeatExcessTurns.values()) {
          sessionRepeatExcessCapWeighted += capWeightForTurn(row, capReadCoeff);
          addLoopCost(loopCost, row);
        }
        for (const row of session.rows) {
          if (errorRuns.has(row.event_id)) errorToolLabels.add(toolStepLabel(row.tool_name));
        }
        const repeatedCalls = new Map<string, string[]>();
        for (const row of session.rows) {
          if (!flaggedEventIds.has(row.event_id) || row.input_hash === null) continue;
          const key = `${row.context ?? ""}\0${row.tool_name}\0${row.input_hash}`;
          repeatedCalls.set(key, [...(repeatedCalls.get(key) ?? []), row.event_id]);
        }
        for (const calls of repeatedCalls.values()) {
          if (calls.length > loopExample.length) loopExample = calls;
        }
        if (!includeFrictionSignals) anyFrictionSuppressed = true;

        const totalTurns = totalTurnsBySession.get(sessionId) ?? 0;
        const loopTurnShare = totalTurns > 0 ? flaggedTurns.size / totalTurns : 0;

        contributingSessionIds.push(sessionId);
        loopFlaggedEventCount += flaggedEventIds.size;
        loopFlaggedTurnCount += flaggedTurns.size;
        repeatExcessEventCount += repeatExcessEventIds.size;
        repeatExcessTurnCount += repeatExcessTurns.size;
        repeatExcessTurnCapWeightedTokens += sessionRepeatExcessCapWeighted;
        identicalCallEventCount += identicalCalls.size;
        testFailEventCount += testFails.size;
        redundantReadEventCount += redundantReads.size;
        threeGramLoopEventCount += threeGramLoops.size;
        errorLoopEventCount += errorRuns.size;
        editWithoutReadEventCount += editWithoutRead.size;
        totalTurnCount += totalTurns;
        coveredSum += coverage.covered;
        denominatorSum += coverage.denominator;
        shareSum += loopTurnShare;
      }

      if (contributingSessionIds.length === 0) continue;

      contributingSessionIds.sort();
      const sessionCount = contributingSessionIds.length;
      // loop_flagged_turn_share = unweighted mean of per-session flagged-turn shares.
      const loopFlaggedTurnShare = Number((shareSum / sessionCount).toFixed(6));
      const ownerTurnMetadataCoverage = Number((coveredSum / denominatorSum).toFixed(6));

      // Workspace observation context is workspace-keyed; call once per workspace.
      const workspaceObsCtx = getEsfObservedTestRecoveryContext(db, {
        workspaceId,
        from: ctx.fromIso,
        to: ctx.toIso,
      });

      const steps: string[] = [];
      if (errorLoopEventCount > 0) {
        const subject = errorToolLabels.size === 1 ? [...errorToolLabels][0] : "The same tool";
        steps.push(
          `${subject} failed 3+ times in a row this session — interrupt, read the error, and change approach before retrying.`,
        );
      }
      steps.push(
        "Interrupt after the same attempt or failure repeats",
        "Restate the goal, constraints, and latest failure before retrying",
        "Split the task into a smaller independently verifiable step",
        "Read the target before editing, then avoid re-reading it unless an edit changed it",
      );

      // Review 5 B1: Σ the repeat turns' stored cost, each at its model's price.
      const modeledSavingsLoop =
        loopCost.costU > 0 ? d7LoopSavings(loopCost.costU, D7_AVOIDANCE_FRACTION).savingsU : null;

      fired.push({
        scopeKey: `D7|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: modeledSavingsLoop,
        // Basis P: rank value passes the stored modeled figure through.
        modeled_formula_json: {
          estimate: { ...d7Estimate({}), rank_value_u_per_wk: modeledSavingsLoop ?? 0 },
        },
        payload: {
          version: 1,
          template_id: "D7_RETRY_LOOP",
          facts: {
            session_ids: contributingSessionIds,
            session_count: sessionCount,
            workspace_id: workspaceId,
            loop_flagged_event_count: loopFlaggedEventCount,
            loop_flagged_turn_count: loopFlaggedTurnCount,
            repeat_excess_event_count: repeatExcessEventCount,
            repeat_excess_turn_count: repeatExcessTurnCount,
            total_turn_count: totalTurnCount,
            loop_flagged_turn_share: loopFlaggedTurnShare,
            owner_turn_metadata_coverage: ownerTurnMetadataCoverage,
            owner_turn_metadata_covered_event_count: coveredSum,
            owner_turn_metadata_denominator_event_count: denominatorSum,
            identical_call_event_count: identicalCallEventCount,
            test_fail_event_count: testFailEventCount,
            redundant_read_event_count: redundantReadEventCount,
            three_gram_loop_event_count: threeGramLoopEventCount,
            error_loop_event_count: errorLoopEventCount,
            edit_without_prior_read_event_count: editWithoutReadEventCount,
            owner_turn_metadata_coverage_floor: OWNER_TURN_METADATA_COVERAGE_FLOOR,
            friction_signals_suppressed_below_coverage_floor: anyFrictionSuppressed,
            repeat_excess_turn_cap_weighted_tokens: repeatExcessTurnCapWeightedTokens,
            repeat_excess_read_tokens: loopCost.readTokens,
            repeat_excess_write_tokens: loopCost.writeTokens,
            repeat_excess_io_tokens: loopCost.ioTokens,
            repeat_excess_read_u: Math.round(loopCost.readU),
            repeat_excess_write_u: Math.round(loopCost.writeU),
            repeat_excess_io_u: Math.round(loopCost.ioU),
            repeat_excess_cost_u: loopCost.costU,
            ...(loopExample.length === 0
              ? {}
              : {
                  loop_example_event_ids: loopExample.slice(0, LOOP_EXAMPLE_CALLS),
                  loop_example_call_count: loopExample.length,
                }),
          },
        },
      });
    }

    fired.push(...crossSessionFired);

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no reconciled session met a loop/retry threshold",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length - crossSessionFired.length} workspace(s) with loop/retry waste; ${crossSessionFired.length} workspace(s) with cross-session redundant reads`,
    };
  },
};

interface XreadEventRow {
  event_id: string;
  session_id: string;
  ts: string;
  result_bytes: number | null;
  owner_message_id: string | null;
}

/**
 * The redundant re-reads of the qualifying paths: each path's first read is the origin (not
 * redundant); every OTHER session's own first read of that path is a redundant re-read. Shared
 * by the XREAD card's $ and the ledger claims (`d7xClaimProducer`), so both price the same reads.
 */
function redundantCrossSessionReads(
  db: Db,
  ctx: DetectorContext,
  paths: readonly CrossSessionReadRow[],
): Array<{ workspaceId: string } & XreadEventRow> {
  const readStmt = db.prepare(
    `SELECT e.event_id, e.session_id, e.ts, e.result_bytes, m.owner_message_id
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE s.workspace_id = ? AND m.file_path_hash = ?
          AND e.input_hash IS ? AND COALESCE(e.result_bytes, 0) = ?
          AND e.ts >= ? AND e.ts < ? AND e.tool_name = 'Read'
          AND COALESCE(e.result_bytes, 0) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM tool_events ed
            JOIN tool_event_metadata mm ON mm.event_id = ed.event_id
           WHERE ed.session_id = e.session_id AND mm.file_path_hash = ?
             AND ed.tool_name IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
             AND ed.ts >= ? AND ed.ts < ?)
        ORDER BY e.ts ASC, e.event_id ASC`,
  );

  const redundant: Array<{ workspaceId: string } & XreadEventRow> = [];
  for (const path of paths) {
    const reads = readStmt.all(
      path.workspace_id,
      path.file_path_hash,
      path.input_hash,
      path.result_bytes,
      ctx.fromIso,
      ctx.toIso,
      A1_RESULT_BYTES_THRESHOLD,
      path.file_path_hash,
      ctx.fromIso,
      ctx.toIso,
    ) as XreadEventRow[];

    // One read per session (its first, since `reads` is already ts/event_id ordered);
    // the earliest session across the path is the origin, not a redundant re-read.
    const firstBySession = new Map<string, XreadEventRow>();
    for (const read of reads) {
      if (!firstBySession.has(read.session_id)) firstBySession.set(read.session_id, read);
    }
    const firstReads = [...firstBySession.values()];
    for (const read of firstReads.slice(1)) {
      redundant.push({ workspaceId: path.workspace_id, ...read });
    }
  }
  redundant.sort((a, b) => a.ts.localeCompare(b.ts) || a.event_id.localeCompare(b.event_id));
  return redundant;
}

/**
 * D7x ledger claims (P3.L L3): each redundant re-read gets a raw-token write + carry claim.
 * `raw` uses the calibrated bytes/token ratio when available, else the 2.7 estimator fallback
 * (same as A2's producer).
 */
export const d7xClaimProducer: ClaimProducer = {
  detectorId: "D7",
  *produce(db, ctx) {
    const bptResolution = resolveBytesPerToken(db);
    const bpt = bptResolution.calibrated ? bptResolution.ratio : ESTIMATOR_BYTES_PER_TOKEN;
    const redundant = redundantCrossSessionReads(db, ctx, qualifyingCrossSessionReadPaths(db, ctx));
    const budget = new Map<string, number>();
    for (const event of redundant) {
      const raw = Math.round((event.result_bytes ?? 0) / bpt);
      if (raw <= 0) continue;
      yield* resultClaimsForEvent(
        db,
        ctx,
        {
          detectorId: "D7",
          event: {
            eventId: event.event_id,
            sessionId: event.session_id,
            ts: event.ts,
            ownerMessageId: event.owner_message_id,
          },
          raw,
          includeCarry: true,
          recId: recId("D7", event.workspaceId, `D7-XREAD|${event.workspaceId}`),
          fraction: D7_AVOIDANCE_FRACTION,
          fractionRange: D7_FRACTION_RANGE,
        },
        budget,
      );
    }
  },
};
