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
import { capWeightForTurn, resolveCapReadCoeff } from "../../query/cap-weighted.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

const MIN_RUN = 3;
const MIN_TRIGRAM_REPEATS = 3;

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

function identicalCallKey(row: EventRow | undefined): string | null {
  return row === undefined || row.input_hash === null
    ? null
    : `${row.tool_name.length}:${row.tool_name}${row.input_hash}`;
}

function markRuns(
  rows: EventRow[],
  keyFor: (row: EventRow) => string | null,
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  let run: EventRow[] = [];
  let runKey: string | null = null;

  const flush = (): void => {
    if (run.length >= MIN_RUN) {
      for (const row of run) target.add(row.event_id);
      // The first event is the necessary baseline attempt. Only later events
      // contribute to the conservative repeat-excess exposure estimate.
      for (const row of run.slice(1)) excessTarget.add(row.event_id);
    }
    run = [];
    runKey = null;
  };

  for (const row of rows) {
    const key = keyFor(row);
    if (key !== null && key === runKey) {
      run.push(row);
    } else {
      flush();
      if (key !== null) {
        run = [row];
        runKey = key;
      }
    }
  }
  flush();
}

function markRedundantReads(
  rows: EventRow[],
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  const readsSinceWrite = new Map<string, Map<string, EventRow[]>>();

  const markIfQualifying = (reads: EventRow[] | undefined): void => {
    if (reads && reads.length >= MIN_RUN) {
      for (const row of reads) target.add(row.event_id);
      // Preserve one baseline read; only repeated reads are excess exposure.
      for (const row of reads.slice(1)) excessTarget.add(row.event_id);
    }
  };

  const flushPath = (pathIdentity: string): void => {
    const regions = readsSinceWrite.get(pathIdentity);
    if (regions !== undefined) {
      for (const reads of regions.values()) markIfQualifying(reads);
    }
    readsSinceWrite.delete(pathIdentity);
  };

  for (const row of rows) {
    const pathIdentity = row.file_path_hash;
    if (pathIdentity === null) continue;

    const tool = row.tool_name.toLowerCase();
    if (tool === "edit" || tool === "write") {
      flushPath(pathIdentity);
      continue;
    }
    if (tool !== "read" || row.input_hash === null) continue;

    // input_hash includes normalized file_path plus Read offset/limit, so
    // different chunks of one file remain distinct and do not look redundant.
    const regions = readsSinceWrite.get(pathIdentity) ?? new Map<string, EventRow[]>();
    const reads = regions.get(row.input_hash) ?? [];
    reads.push(row);
    regions.set(row.input_hash, reads);
    readsSinceWrite.set(pathIdentity, regions);
  }

  for (const regions of readsSinceWrite.values()) {
    for (const reads of regions.values()) markIfQualifying(reads);
  }
}

function markThreeGramLoops(
  rows: EventRow[],
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  const tripleLength = 3;
  const minimumRunLength = tripleLength * MIN_TRIGRAM_REPEATS;

  for (let start = 0; start <= rows.length - minimumRunLength; ) {
    const first = identicalCallKey(rows[start]);
    const second = identicalCallKey(rows[start + 1]);
    const third = identicalCallKey(rows[start + 2]);

    if (
      first === null ||
      second === null ||
      third === null ||
      (first === second && second === third)
    ) {
      start += 1;
      continue;
    }

    let end = start + tripleLength;
    while (
      end + tripleLength <= rows.length &&
      identicalCallKey(rows[end]) === first &&
      identicalCallKey(rows[end + 1]) === second &&
      identicalCallKey(rows[end + 2]) === third
    ) {
      end += tripleLength;
    }

    if (end - start < minimumRunLength) {
      start += 1;
      continue;
    }

    for (const row of rows.slice(start, end)) target.add(row.event_id);
    for (const row of rows.slice(start + tripleLength, end)) excessTarget.add(row.event_id);
    start = end;
  }
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
    for (const [sessionId, session] of bySession) {
      const identicalCalls = new Set<string>();
      const testFails = new Set<string>();
      const redundantReads = new Set<string>();
      const threeGramLoops = new Set<string>();
      const repeatExcessEventIds = new Set<string>();

      markRuns(session.rows, identicalCallKey, identicalCalls, repeatExcessEventIds);
      markRuns(
        session.rows,
        (row) => (row.exit_class === "TEST_FAIL" ? "TEST_FAIL" : null),
        testFails,
        repeatExcessEventIds,
      );
      markRedundantReads(session.rows, redundantReads, repeatExcessEventIds);
      markThreeGramLoops(session.rows, threeGramLoops, repeatExcessEventIds);

      const flaggedEventIds = new Set([
        ...identicalCalls,
        ...testFails,
        ...redundantReads,
        ...threeGramLoops,
      ]);
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
          title: `Break retry loops: ${flaggedTurns.size} flagged turn${flaggedTurns.size === 1 ? "" : "s"} in session`,
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
