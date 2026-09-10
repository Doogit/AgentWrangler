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
import { analyzeD7LoopEvents } from "../d7-loop-analysis.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

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
}

type CoverageRow = Omit<EventRow, "owner_message_id" | "block_index"> & {
  owner_message_id: string | null;
  block_index: number | null;
  metadata_rows: number;
  owner_eligible: number;
  covered_event: number;
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

export const d7Detector: Detector = {
  id: "D7",
  name: "LOOP_RETRY_WASTE",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const candidateRows = db
      .prepare(
        `WITH metadata AS (
               SELECT event_id, COUNT(*) AS metadata_rows,
                      MAX(file_path_hash) AS file_path_hash,
                      MAX(owner_message_id) AS owner_message_id,
                      MAX(block_index) AS block_index
                 FROM tool_event_metadata
                GROUP BY event_id
             ),
             owners AS (
               SELECT message_id, COUNT(*) AS owner_rows,
                      MAX(session_id) AS owner_session_id,
                      MAX(workspace_id) AS owner_workspace_id,
                      MAX(ts) AS owner_ts,
                      MAX(provisional) AS owner_provisional,
                      MAX(input_tokens) AS input_tokens,
                      MAX(output_tokens) AS output_tokens,
                      MAX(cache_read_tokens) AS cache_read_tokens,
                      MAX(cache_write_5m) AS cache_write_5m,
                      MAX(cache_write_1h) AS cache_write_1h,
                      MAX(cache_write_other) AS cache_write_other
                 FROM turns
                GROUP BY message_id
             ),
             params(from_ts, as_of_ts) AS (VALUES (?, ?)),
             candidates AS (
               SELECT e.event_id, e.session_id, e.ts AS event_ts, e.tool_name,
                      e.input_hash, e.exit_class,
                      s.workspace_id AS session_workspace_id,
                      m.file_path_hash, m.owner_message_id, m.block_index,
                      COALESCE(m.metadata_rows, 0) AS metadata_rows,
                      COALESCE(t.owner_rows, 0) AS owner_rows,
                      t.owner_session_id, t.owner_workspace_id, t.owner_ts,
                      t.owner_provisional,
                      t.input_tokens, t.output_tokens, t.cache_read_tokens,
                      t.cache_write_5m, t.cache_write_1h, t.cache_write_other,
                      p.from_ts, p.as_of_ts
                 FROM tool_events e INDEXED BY idx_tool_ts_session_event
                 JOIN sessions s
                   ON s.session_id = e.session_id
                  AND s.state = 'RECONCILED'
                 LEFT JOIN metadata m ON m.event_id = e.event_id
                 LEFT JOIN owners t ON t.message_id = m.owner_message_id
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
               tool_name, input_hash, exit_class, file_path_hash, owner_message_id, block_index,
               input_tokens, output_tokens, cache_read_tokens,
               cache_write_5m, cache_write_1h, cache_write_other,
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

    const rows = candidateRows.filter((row) => row.covered_event === 1) as EventRow[];

    if (rows.length === 0) {
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

    const fired: Fired[] = [];
    const workspaceContexts = new Map<
      string,
      ReturnType<typeof getEsfObservedTestRecoveryContext>
    >();
    for (const [sessionId, session] of bySession) {
      const {
        identicalCalls,
        testFails,
        redundantReads,
        threeGramLoops,
        repeatExcessEventIds,
        flaggedEventIds,
      } = analyzeD7LoopEvents(session.rows);
      if (flaggedEventIds.size === 0) continue;

      const flaggedTurns = new Map<string, EventRow>();
      const repeatExcessTurns = new Map<string, EventRow>();
      for (const row of session.rows) {
        if (flaggedEventIds.has(row.event_id)) flaggedTurns.set(row.owner_message_id, row);
        if (repeatExcessEventIds.has(row.event_id)) {
          repeatExcessTurns.set(row.owner_message_id, row);
        }
      }

      let repeatExcessTurnCapWeightedTokens = 0;
      for (const row of repeatExcessTurns.values()) {
        repeatExcessTurnCapWeightedTokens += capWeightForTurn(row, capReadCoeff);
      }
      const totalTurns = totalTurnsBySession.get(sessionId) ?? 0;
      const loopTurnShare = totalTurns > 0 ? flaggedTurns.size / totalTurns : 0;
      const coverage = coverageBySession.get(sessionId);
      if (!coverage || coverage.denominator === 0) {
        throw new Error("D7 coverage denominator missing for fired session");
      }
      const ownerTurnMetadataCoverage = Number(
        (coverage.covered / coverage.denominator).toFixed(6),
      );

      // Workspace observation context is a separate denominator from this
      // session's native matcher and metadata coverage. Freeze its exact window.
      if (!workspaceContexts.has(session.workspaceId)) {
        workspaceContexts.set(
          session.workspaceId,
          getEsfObservedTestRecoveryContext(db, {
            workspaceId: session.workspaceId,
            from: ctx.fromIso,
            to: ctx.toIso,
          }),
        );
      }

      fired.push({
        scopeKey: `D7|${sessionId}`,
        category: "SESSION_HYGIENE",
        scope_workspace_id: session.workspaceId,
        lever:
          "Interrupt repeated attempts, restate the goal and latest failure, split the task when the loop persists, and read a file before editing it while avoiding redundant re-reads.",
        target_metric: "loop_flagged_turn_share",
        modeled_savings_u_per_wk: null,
        modeled_formula: {
          model: "D7_LOOP_RETRY_WASTE_EXPOSURE_V2",
          kind: "DIRECTIONAL_UNVALIDATED",
          inputs: {
            repeat_excess_turn_cap_weighted_tokens: repeatExcessTurnCapWeightedTokens,
            repeat_excess_event_count: repeatExcessEventIds.size,
            repeat_excess_turn_count: repeatExcessTurns.size,
            loop_flagged_turn_count: flaggedTurns.size,
            total_turn_count: totalTurns,
            loop_flagged_turn_share: Number(loopTurnShare.toFixed(6)),
            owner_turn_metadata_coverage: ownerTurnMetadataCoverage,
            cap_read_coefficient: capReadCoeff,
          },
          expression:
            "cap-weighted exposure of turns owning repeat-excess events; not an avoidable-token or USD savings estimate",
        },
        evidence: {
          ...workspaceContexts.get(session.workspaceId),
          title: `Stop repeated attempts: ${flaggedTurns.size} affected turn${flaggedTurns.size === 1 ? "" : "s"} in this session`,
          session_id: sessionId,
          workspace_id: session.workspaceId,
          loop_flagged_event_count: flaggedEventIds.size,
          loop_flagged_turn_count: flaggedTurns.size,
          repeat_excess_event_count: repeatExcessEventIds.size,
          repeat_excess_turn_count: repeatExcessTurns.size,
          total_turn_count: totalTurns,
          loop_flagged_turn_share: Number(loopTurnShare.toFixed(6)),
          owner_turn_metadata_coverage: ownerTurnMetadataCoverage,
          owner_turn_metadata_covered_event_count: coverage.covered,
          owner_turn_metadata_denominator_event_count: coverage.denominator,
          identical_call_event_count: identicalCalls.size,
          test_fail_event_count: testFails.size,
          redundant_read_event_count: redundantReads.size,
          three_gram_loop_event_count: threeGramLoops.size,
          repeat_excess_turn_cap_weighted_tokens: repeatExcessTurnCapWeightedTokens,
          thresholds_unvalidated: true,
          savings_claim:
            "repeat-excess owning-turn exposure only; no avoidable-token or USD savings claim",
          privacy_caveat:
            "Evidence contains structural counts and identifiers only; raw paths, path hashes, tool input/output, commands, and transcript content are excluded.",
          coverage_caveat:
            "Forward-only enrichment: historical or malformed events without owner-turn metadata are ignored safely.",
          steps: [
            "Interrupt after the same attempt or failure repeats",
            "Restate the goal, constraints, and latest failure before retrying",
            "Split the task into a smaller independently verifiable step",
            "Read the target before editing, then avoid re-reading it unless an edit changed it",
          ],
        },
      });
    }

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
      note: `${fired.length} session(s) with loop/retry waste`,
    };
  },
};
