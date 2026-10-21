/**
 * E1 ORIENTATION_BEFORE_FIRST_EDIT.
 *
 * For RECONCILED sessions whose first main-thread edit (Edit/Write/MultiEdit/NotebookEdit) falls
 * in the window, counts the main-thread turns before that edit. Per workspace (>= 8 such
 * sessions), sessions over the p75 count are long orientations; their turns after the p50-th
 * are the excess. Fires once per workspace when the excess costs >= 1% of its window spend.
 * Percentiles are nearest-rank over the workspace's own sessions, so a handoff-heavy workspace
 * is judged against itself.
 *
 * The estimate claims the excess turns' own cost only. The reads in those turns are also tool
 * results D6/A1 carry-price on later turns, so the estimate is non-summable.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, spendByWorkspace } from "../../query/spend.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { e1Estimate } from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";

/** A workspace needs this many editing sessions for its percentiles to mean anything. */
export const E1_MIN_EDITING_SESSIONS = 8;
/** Audit materiality floor: the excess must reach this % of the workspace's window spend. */
export const E1_MIN_PCT_OF_SPEND = 1;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

interface FirstEditRow {
  readonly workspace_id: string;
  readonly session_id: string;
  readonly event_id: string;
  readonly ts: string;
  /** The turn that issued the edit; its first JSONL line is earlier than the edit block's. */
  readonly owner_ts: string;
}

interface PreEditTurn {
  readonly cost_equiv_u: number;
}

interface EditingSession extends FirstEditRow {
  readonly preEdit: readonly PreEditTurn[];
}

export const e1FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "E1",
  rule_id: "E1_ORIENTATION_BEFORE_FIRST_EDIT",
  labels: ["ORIENTATION_BEFORE_FIRST_EDIT"],
  metrics: {
    EDITING_SESSIONS: { kind: "COUNT" },
    SESSIONS_OVER_P75: { kind: "COUNT" },
    EXCESS_TURNS: { kind: "COUNT" },
    EXCESS_COST_U: { kind: "NUMBER", min: 0 },
    PRE_EDIT_P50: { kind: "COUNT" },
    PRE_EDIT_P75: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "e1-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "SESSION_HYGIENE",
    lever:
      'Put a "Start here" block in the handoff or CLAUDE.md: the exact files and line ranges, the next command, and the gate, so a session starts editing without a long read-around.',
    target_metric: "pre_edit_excess_turns",
    title: "Long orientation before the first edit",
  },
} as const);

/** Nearest-rank percentile of an ascending list. */
function nearestRank(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

export const e1Detector: DetectorV2 = {
  contractVersion: 2,
  version: "E1@u8-2", // review: the edit turn is not a pre-edit turn; turns counted from session start.
  scope: "cross-session",
  inputs: {
    // spendByWorkspace reads turns + workspaces.
    tables: ["turns", "sessions", "workspaces", "tool_events", "tool_event_metadata"],
  },
  descriptor: e1FindingDescriptor,
  id: "E1",
  name: "ORIENTATION_BEFORE_FIRST_EDIT",

  evaluate(db: Db, ctx) {
    // Every main-thread edit, oldest first; the first row per session is its first edit.
    const editRows = db
      .prepare(
        `SELECT s.workspace_id, e.session_id, e.event_id, e.ts, t.ts AS owner_ts
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE s.state = 'RECONCILED'
            AND t.is_sidechain = 0
            AND t.provisional = 0
            AND e.tool_name IN (${EDIT_TOOLS.map(() => "?").join(", ")})
            AND e.ts < ?
          ORDER BY e.session_id, e.ts, e.event_id`,
      )
      .all(...EDIT_TOOLS, ctx.toIso) as FirstEditRow[];

    // From session start, so a session that began before the window keeps its full count.
    const preEditTurns = db.prepare(
      `SELECT COALESCE(cost_equiv_u, 0) AS cost_equiv_u
         FROM turns
        WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0
          AND ts < ?
        ORDER BY ts, message_id`,
    );

    const byWorkspace = new Map<string, EditingSession[]>();
    let previousSession: string | undefined;
    for (const row of editRows) {
      if (row.session_id === previousSession) continue;
      previousSession = row.session_id;
      // A session whose first edit predates the window has no pre-edit turns in it.
      if (row.ts < ctx.fromIso) continue;
      // Turns before the editing turn; the editing turn itself is productive work.
      const preEdit = preEditTurns.all(row.session_id, row.owner_ts) as PreEditTurn[];
      const sessions = byWorkspace.get(row.workspace_id);
      if (sessions === undefined) byWorkspace.set(row.workspace_id, [{ ...row, preEdit }]);
      else sessions.push({ ...row, preEdit });
    }

    const spendByWs = new Map(
      spendByWorkspace(db, ctx.fromIso, ctx.toIso).map((s) => [s.workspace_id, s.cost_equiv_u]),
    );

    const fired: FiredV2[] = [];
    let thinWorkspaces = 0;
    for (const [workspaceId, sessions] of [...byWorkspace.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (sessions.length < E1_MIN_EDITING_SESSIONS) {
        thinWorkspaces++;
        continue;
      }
      const counts = sessions.map((s) => s.preEdit.length).sort((a, b) => a - b);
      const p50 = nearestRank(counts, 0.5);
      const p75 = nearestRank(counts, 0.75);

      const long = sessions
        .filter((s) => s.preEdit.length > p75)
        .map((s) => {
          const excess = s.preEdit.slice(p50);
          return {
            session: s,
            turns: excess.length,
            costU: excess.reduce((sum, turn) => sum + turn.cost_equiv_u, 0),
          };
        });
      const excessTurns = long.reduce((sum, s) => sum + s.turns, 0);
      const excessCostU = long.reduce((sum, s) => sum + s.costU, 0);
      if ((pctOfSpend(excessCostU, spendByWs.get(workspaceId)) ?? 0) < E1_MIN_PCT_OF_SPEND) {
        continue;
      }

      const estimate = e1Estimate({ costEquivU: excessCostU });
      const top = [...long].sort(
        (a, b) =>
          b.turns - a.turns ||
          b.costU - a.costU ||
          a.session.session_id.localeCompare(b.session.session_id),
      );
      fired.push({
        scopeKey: `E1|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: estimate.rank_value_u_per_wk,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: e1FindingDescriptor.rule_id,
            label: "ORIENTATION_BEFORE_FIRST_EDIT",
            assessment: e1FindingDescriptor.defaults.assessment,
            routing: e1FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // The longest orientations, each anchored at its first edit.
            anchors: top.slice(0, 5).map(({ session }) => ({
              session_id: findingIds.session(session.session_id),
              timestamp: session.ts,
              event_id: findingIds.event(session.event_id),
            })),
            session_ids: top.slice(0, 20).map(({ session }) => session.session_id),
            estimate,
            impact: { kind: "COST", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics: {
              EDITING_SESSIONS: { kind: "COUNT", value: sessions.length },
              SESSIONS_OVER_P75: { kind: "COUNT", value: long.length },
              EXCESS_TURNS: { kind: "COUNT", value: excessTurns },
              EXCESS_COST_U: { kind: "NUMBER", value: Math.round(excessCostU) },
              PRE_EDIT_P50: { kind: "COUNT", value: p50 },
              PRE_EDIT_P75: { kind: "COUNT", value: p75 },
            },
          },
          e1FindingDescriptor,
        ),
      });
    }

    if (fired.length > 0) {
      return {
        fired,
        status: "ACTIVE",
        note: `${fired.length} workspace(s) with long orientation`,
      };
    }
    return {
      fired,
      status: "INACTIVE",
      note:
        byWorkspace.size === thinWorkspaces
          ? `no workspace has ${E1_MIN_EDITING_SESSIONS}+ editing sessions in the window`
          : `excess orientation under ${E1_MIN_PCT_OF_SPEND}% of spend`,
    };
  },
};
