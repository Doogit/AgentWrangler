/**
 * src/detector/detectors/d6_tool_result_bloat.ts — D6 TOOL_RESULT_BLOAT.
 *
 * A1's complement (U7): the many mid-size tool results (at or under A1's 25,600 B floor) that
 * each ride in context and are re-sent on every later turn of their chain. Each result is
 * priced with the shared carry helpers (one cache write plus a read on every later turn of its
 * owner chain, stopping at compaction, context collapse or 75 turns), over every tool. Size
 * only, never content — the privacy boundary holds.
 *
 * One owner per result, by construction: A1 owns every result over 25,600 B, A2 owns
 * TaskOutput results over 10 KiB (up to 25,600 B), D6 owns the rest.
 *
 * Gates: at least D6_MIN_SESSIONS sessions carry such results (a recurrence count), and a
 * workspace's carry cost reaches D6_MIN_PCT_OF_SPEND of its spend in the window.
 *
 * $: carry cost × D6_AVOIDANCE_FRACTION. With a calibrated bytes/token ratio it is a modeled
 * figure (basis P); without one it uses A1's 2.7 estimator and is labelled an estimate (basis E).
 *
 * scopeKey: "D6|<workspace_id>".
 */

import type { Db } from "../../db/open.js";
import { capWeightedTokens } from "../../query/cap-weighted.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import { resolveBytesPerToken } from "../calibration.js";
import type { Claim, ClaimProducer } from "../claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import { createResultCarry, resultClaimsForEvent } from "../result-claims.js";
import {
  D6_AVOIDANCE_FRACTION,
  D6_MIN_SESSIONS,
  ESTIMATOR_BYTES_PER_TOKEN,
  carryPriceUsdPerMtok,
  d6Estimate,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";
import { A1_RESULT_BYTES_THRESHOLD } from "./a1_tool_result_bloat.js";
import { A2_TASK_OUTPUT_BYTES_THRESHOLD } from "./a2_task_output_bloat.js";

/** Card gate: the results' carry cost as a % of the workspace's spend in the window (U7). */
export const D6_MIN_PCT_OF_SPEND = 1;

/**
 * RR U13: D6 prices only the bytes of a result above this size. The card's own rule names no byte
 * target (only "a file over about 300 lines", roughly 10 KiB), so the floor is the same 10 KiB
 * line A2 uses for TaskOutput. Smaller results are not bloat and are not priced.
 */
export const D6_EXCESS_FLOOR_BYTES = A2_TASK_OUTPUT_BYTES_THRESHOLD;
/** Uncalibrated bytes/token spans 2.7 (high cost) to 4 (low cost); the point is their mean. */
export const D6_BPT_HIGH_COST = ESTIMATOR_BYTES_PER_TOKEN;
export const D6_BPT_LOW_COST = 4;
const D6_BPT_UNCALIBRATED_POINT = (D6_BPT_HIGH_COST + D6_BPT_LOW_COST) / 2;

const excessBytes = (resultBytes: number) => Math.max(0, resultBytes - D6_EXCESS_FLOOR_BYTES);

interface ResultRow {
  session_id: string;
  workspace_id: string;
  ts: string;
  result_bytes: number;
  owner_message_id: string;
  tool_name: string;
}

interface SessionTotals {
  workspaceId: string;
  bytes: number;
  carryCostU: number;
  /** U9: the Read tool's share of these results. */
  readBytes: number;
  readCalls: number;
  /** U9 r3: every tool's bytes and calls, so the card names the second source after Read. */
  byTool: Map<string, { bytes: number; calls: number }>;
}

/** U9 r3: how many tools a card lists, largest first, as `<tool>|<bytes>|<calls>` labels. */
export const D6_TOP_TOOLS = 4;

/** U9: the sessions a card lists, largest first, as `<session id>|<bytes>|<turns>` labels. */
export const D6_TOP_SESSIONS = 5;

export const d6Detector: Detector = {
  contractVersion: 1,
  // U9: sessions ranked by bytes; Read share and top sessions; r3: top tools; r5: turn counts include provisional turns.
  version: "D6@u9-3",
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
      "ingest_metric_events",
    ],
  },
  id: "D6",
  name: "TOOL_RESULT_BLOAT",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const bptResolution = resolveBytesPerToken(db);
    // One bytes/token basis with A1 and A2: calibrated when measured, else the 2.7 estimator.
    const bytesPerToken = bptResolution.calibrated
      ? bptResolution.ratio
      : D6_BPT_UNCALIBRATED_POINT;
    const resultCarry = createResultCarry(db);

    const rows = db
      .prepare(
        `SELECT e.session_id, s.workspace_id, e.ts, e.result_bytes, m.owner_message_id, e.tool_name
           FROM tool_events e
           JOIN sessions s ON s.session_id = e.session_id
           JOIN tool_event_metadata m ON m.event_id = e.event_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.result_bytes > 0 AND e.result_bytes <= ?
            AND m.owner_message_id IS NOT NULL
            AND NOT (e.tool_name = 'TaskOutput' AND e.result_bytes > ?)
          ORDER BY e.session_id ASC, e.ts ASC, e.event_id ASC`,
      )
      .all(
        ctx.fromIso,
        ctx.toIso,
        A1_RESULT_BYTES_THRESHOLD,
        A2_TASK_OUTPUT_BYTES_THRESHOLD,
      ) as ResultRow[];

    // Per session: result bytes and their carry cost (µ$), each result along its owner chain.
    const bySession = new Map<string, SessionTotals>();
    for (const row of rows) {
      const carried = resultCarry(row.session_id, row.ts, row.owner_message_id);
      if (carried === undefined || carried.carry === 0) continue;
      const costU =
        (excessBytes(row.result_bytes) / bytesPerToken) *
        carryPriceUsdPerMtok(carried.carry, carried.writePrice, carried.readPrice);
      const isRead = row.tool_name === "Read";
      const totals = bySession.get(row.session_id);
      if (totals === undefined) {
        bySession.set(row.session_id, {
          workspaceId: row.workspace_id,
          bytes: row.result_bytes,
          carryCostU: costU,
          readBytes: isRead ? row.result_bytes : 0,
          readCalls: isRead ? 1 : 0,
          byTool: new Map([[row.tool_name, { bytes: row.result_bytes, calls: 1 }]]),
        });
      } else {
        const tool = totals.byTool.get(row.tool_name) ?? { bytes: 0, calls: 0 };
        tool.bytes += row.result_bytes;
        tool.calls++;
        totals.byTool.set(row.tool_name, tool);
        totals.bytes += row.result_bytes;
        totals.carryCostU += costU;
        if (isRead) {
          totals.readBytes += row.result_bytes;
          totals.readCalls++;
        }
      }
    }
    const carrying = [...bySession.entries()].filter(([, totals]) => totals.carryCostU > 0);

    // Recurrence gate: only surface when the pattern repeats across ≥ N sessions.
    if (carrying.length < D6_MIN_SESSIONS) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${carrying.length} bloated session(s) (< ${D6_MIN_SESSIONS} threshold)`,
      };
    }

    const byWorkspace = new Map<string, string[]>();
    for (const [sessionId, totals] of carrying) {
      const sessions = byWorkspace.get(totals.workspaceId);
      if (sessions === undefined) byWorkspace.set(totals.workspaceId, [sessionId]);
      else sessions.push(sessionId);
    }

    const capBySession = new Map(
      capWeightedTokens(db, { fromIso: ctx.fromIso, toIso: ctx.toIso, groupBy: "session_id" }).map(
        (r) => [r.group ?? "", r.cap_weighted_tokens],
      ),
    );
    const sessionStats = db.prepare(
      // U9 r5: turns count every turn in the window (a session still being read has provisional
      // turns, which printed "0 turns"); the cost stays settled turns only.
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(CASE WHEN provisional = 0 THEN cost_equiv_u END), 0) AS cost_u
         FROM turns WHERE session_id = ? AND ts >= ? AND ts < ?`,
    );
    const fromMs = Date.parse(ctx.fromIso);
    const toMs = Date.parse(ctx.toIso);

    const fired: Fired[] = [];
    for (const [workspaceId, sessionIds] of [...byWorkspace.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      let sumBytes = 0;
      let carryCostU = 0;
      let sumCap = 0;
      let sumTurns = 0;
      let sessionsCostU = 0;
      let readBytes = 0;
      let readCalls = 0;
      const turnsBySession = new Map<string, number>();
      const toolTotals = new Map<string, { bytes: number; calls: number }>();
      for (const sessionId of sessionIds) {
        const totals = bySession.get(sessionId);
        if (totals === undefined) continue;
        for (const [tool, part] of totals.byTool) {
          const sum = toolTotals.get(tool) ?? { bytes: 0, calls: 0 };
          sum.bytes += part.bytes;
          sum.calls += part.calls;
          toolTotals.set(tool, sum);
        }
        sumBytes += totals.bytes;
        carryCostU += totals.carryCostU;
        readBytes += totals.readBytes;
        readCalls += totals.readCalls;
        sumCap += capBySession.get(sessionId) ?? 0;
        const stats = sessionStats.get(sessionId, ctx.fromIso, ctx.toIso) as {
          turns: number;
          cost_u: number;
        };
        sumTurns += stats.turns;
        sessionsCostU += stats.cost_u;
        turnsBySession.set(sessionId, stats.turns);
      }
      // U9: ranked by result bytes (impact), not by id.
      const bytesOf = (id: string) => bySession.get(id)?.bytes ?? 0;
      const ranked = [...sessionIds].sort((a, b) => bytesOf(b) - bytesOf(a) || a.localeCompare(b));

      // Gate (settled % floor): the results' carry cost must reach 1% of the workspace's spend.
      const spendU = workspaceSpendU(db, workspaceId, fromMs, toMs);
      if ((pctOfSpend(carryCostU, spendU) ?? 0) < D6_MIN_PCT_OF_SPEND) continue;

      const savingsU = Math.round(carryCostU * D6_AVOIDANCE_FRACTION);
      // Share of those sessions' spend that is the results' carry (the card's stat).
      const carryShare =
        sessionsCostU > 0 ? Number(Math.min(1, carryCostU / sessionsCostU).toFixed(4)) : 0;
      const estimate = bptResolution.calibrated
        ? { ...d6Estimate({}), rank_value_u_per_wk: savingsU }
        : {
            ...d6Estimate({}),
            basis: "E" as const,
            rank_value_u_per_wk: savingsU,
            label: "tool-result carry estimate (2.7 to 4 bytes per token, not calibrated)",
          };

      fired.push({
        scopeKey: `D6|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: savingsU,
        modeled_formula_json: { estimate },
        payload: {
          version: 1,
          template_id: "D6_TOOL_RESULT_BLOAT",
          facts: {
            workspace_id: workspaceId,
            session_ids: ranked,
            session_count: sessionIds.length,
            tool_result_bytes: sumBytes,
            session_cap_weighted_tokens: sumCap,
            bloat_share: carryShare,
            turn_count: sumTurns,
            bytes_per_token: bytesPerToken,
            read_result_bytes: readBytes,
            read_call_count: readCalls,
            // Uncalibrated bytes/token: the saving scales with 1/bpt, so show 2.7 (high) to 4 (low).
            ...(bptResolution.calibrated
              ? {}
              : {
                  savings_low_u_per_wk: Math.round((savingsU * bytesPerToken) / D6_BPT_LOW_COST),
                  savings_high_u_per_wk: Math.round((savingsU * bytesPerToken) / D6_BPT_HIGH_COST),
                }),
            top_tools: [...toolTotals]
              .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
              .slice(0, D6_TOP_TOOLS)
              .map(([tool, part]) => `${tool}|${part.bytes}|${part.calls}`),
            top_sessions: ranked
              .slice(0, D6_TOP_SESSIONS)
              .map((id) => `${id}|${bytesOf(id)}|${turnsBySession.get(id) ?? 0}`),
          },
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${carrying.length} session(s) carry tool results, under ${D6_MIN_PCT_OF_SPEND}% of workspace spend`,
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with tool-result carry across ${carrying.length} session(s)`,
    };
  },
};

/** D6's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const D6_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D6?.constants.find(
  (constant) => constant.name === "D6_AVOIDANCE_FRACTION",
);
const D6_FRACTION_RANGE: readonly [number, number] =
  D6_FRACTION_CONSTANT && D6_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D6_FRACTION_CONSTANT.min, D6_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D6

/**
 * D6 ledger claims (RR U13): the spend-lane twin of A1's. D6 had a modeled $ but no claim
 * producer, so the ledger never allocated anything to the card and its headline read "Not
 * estimated". Each mid-size result (the same set `evaluate()` carries) claims a raw-token write on
 * the first later same-chain turn plus carry reads on every later turn, at the bytes/token basis
 * `evaluate()` uses. Only workspaces that have a stored D6 card (it passed the session-count and
 * spend gates) are claimed, so the ledger never allocates $ to a card that does not exist.
 */
export const d6ClaimProducer: ClaimProducer = {
  detectorId: "D6",
  *produce(db, ctx) {
    // The cards that exist: the card gates (session count, % of spend) already ran in `evaluate()`.
    const cards = new Set(
      (
        db.prepare("SELECT rec_id FROM recommendations WHERE detector_id = 'D6'").all() as Array<{
          rec_id: string;
        }>
      ).map((r) => r.rec_id),
    );
    if (cards.size === 0) return;
    const bptResolution = resolveBytesPerToken(db);
    const bytesPerToken = bptResolution.calibrated
      ? bptResolution.ratio
      : D6_BPT_UNCALIBRATED_POINT;
    const rows = db
      .prepare(
        `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.result_bytes, m.owner_message_id
           FROM tool_events e
           JOIN sessions s ON s.session_id = e.session_id
           JOIN tool_event_metadata m ON m.event_id = e.event_id
          WHERE e.ts >= ? AND e.ts < ?
            AND e.result_bytes > 0 AND e.result_bytes <= ?
            AND m.owner_message_id IS NOT NULL
            AND NOT (e.tool_name = 'TaskOutput' AND e.result_bytes > ?)
          ORDER BY e.ts ASC, e.event_id ASC`,
      )
      .all(
        ctx.fromIso,
        ctx.toIso,
        A1_RESULT_BYTES_THRESHOLD,
        A2_TASK_OUTPUT_BYTES_THRESHOLD,
      ) as Array<ResultRow & { event_id: string }>;

    // D6 has thousands of small results sharing the same later turns: merge them to one claim
    // per (turn, component) so the ledger allocates cells, not events (500k claims cost ~5 s).
    const merged = new Map<string, Claim>();
    const budget = new Map<string, number>();
    for (const row of rows) {
      const cardRecId = recId("D6", row.workspace_id, `D6|${row.workspace_id}`);
      if (!cards.has(cardRecId)) continue;
      const raw = Math.round(excessBytes(row.result_bytes) / bytesPerToken);
      if (raw <= 0) continue;
      for (const claim of resultClaimsForEvent(
        db,
        ctx,
        {
          detectorId: "D6",
          event: {
            eventId: row.event_id,
            sessionId: row.session_id,
            ts: row.ts,
            ownerMessageId: row.owner_message_id,
          },
          raw,
          includeCarry: true,
          recId: cardRecId,
          fraction: D6_AVOIDANCE_FRACTION,
          fractionRange: D6_FRACTION_RANGE,
        },
        budget,
      )) {
        const key = `${claim.turnKey}\0${claim.component}`;
        const held = merged.get(key);
        if (held === undefined) merged.set(key, { ...claim, slice: "result:d6" });
        else held.tokens += claim.tokens;
      }
    }
    yield* merged.values();
  },
};
