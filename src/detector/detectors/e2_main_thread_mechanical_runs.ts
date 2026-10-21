/**
 * E2 MAIN_THREAD_MECHANICAL_RUNS (rec reset U10, routing).
 *
 * A run is 3+ consecutive main-thread turns on a strong model (Opus or Fable) of a RECONCILED
 * session, each making only shell, Read, Grep or Glob calls with under 300 output tokens. A
 * text-only strong turn neither counts nor breaks a run; any other main turn breaks it.
 *
 * Saving per run: the run's actual cost minus a Sonnet subagent doing the same turns: a fresh
 * 30K context that grows by what the main context grew each turn (read at the cache-read price,
 * the growth written at the 5-minute write price), the run's own output, plus one 30K dispatch
 * write, plus the main-model turn that hands the run off (priced as the run's first turn: it
 * re-reads the same main context and writes about as much). Where cache reads cost the same on
 * both models (Opus 5.5), only a large main context leaves a saving. Fires once per workspace
 * when the summed saving is >= 1% of its window spend.
 *
 * Non-summable: run turns can also be E1 pre-edit turns, and their results are carry-priced by
 * D6/A1 on later turns.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, spendByWorkspace } from "../../query/spend.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { e2Estimate } from "../savings.js";
import { tierPriceVector } from "../tier-price.js";
import type { DetectorV2, FiredV2 } from "../types.js";

export const E2_MIN_RUN_TURNS = 3;
export const E2_MAX_OUTPUT_TOKENS = 300;
/** A fresh subagent's starting context: system prompt, tools and the brief. */
export const E2_SUBAGENT_BASE_TOKENS = 30_000;
/** Audit materiality floor: the saving must reach this % of the workspace's window spend. */
export const E2_MIN_PCT_OF_SPEND = 1;
const MECHANICAL_TOOLS = new Set(["Bash", "PowerShell", "Read", "Grep", "Glob"]);
const STRONG_MODEL = /opus|fable|mythos/i;

interface TurnRow {
  readonly workspace_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly ts: string;
  readonly model: string | null;
  readonly output_tokens: number;
  readonly context_tokens: number;
  readonly cost_equiv_u: number;
  readonly calls: number;
  readonly mechanical_calls: number;
}

export interface MechanicalRun {
  readonly workspace_id: string;
  readonly session_id: string;
  readonly message_ids: readonly string[];
  readonly first_ts: string;
  readonly cost_u: number;
  /** The Sonnet subagent plus the main-model handoff turn. */
  readonly subagent_u: number;
}

export const e2FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "E2",
  rule_id: "E2_MAIN_THREAD_MECHANICAL_RUNS",
  labels: ["MAIN_THREAD_MECHANICAL_RUNS"],
  metrics: {
    RUNS: { kind: "COUNT" },
    RUN_TURNS: { kind: "COUNT" },
    RUN_SESSIONS: { kind: "COUNT" },
    RUN_COST_U: { kind: "NUMBER", min: 0 },
    SUBAGENT_COST_U: { kind: "NUMBER", min: 0 },
    SAVING_U: { kind: "NUMBER" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "e2-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "MODEL",
    lever:
      "Send runs of shell, read and search steps to one Sonnet subagent that returns a short summary; keep the main session on its model.",
    target_metric: "main_thread_mechanical_run_cost",
    title: "Mechanical runs on the main model",
  },
} as const);

/**
 * The window's mechanical runs, each priced as actual and as a Sonnet subagent. Shared with the
 * card's evidence query so both read the same runs.
 */
export function mechanicalRuns(
  db: Db,
  scope: { fromIso: string; toIso: string; sessionIds?: readonly string[] },
): MechanicalRun[] {
  const sessionFilter =
    scope.sessionIds === undefined
      ? ""
      : `AND t.session_id IN (${scope.sessionIds.map(() => "?").join(", ")})`;
  const rows = db
    .prepare(
      `SELECT t.workspace_id, t.session_id, t.message_id, t.ts, t.model, t.output_tokens,
              t.input_tokens + t.cache_read_tokens + t.cache_write_5m + t.cache_write_1h
                + t.cache_write_other AS context_tokens,
              COALESCE(t.cost_equiv_u, 0) AS cost_equiv_u,
              (SELECT COUNT(*) FROM tool_event_metadata m WHERE m.owner_message_id = t.message_id) AS calls,
              (SELECT COUNT(*) FROM tool_event_metadata m JOIN tool_events e ON e.event_id = m.event_id
                WHERE m.owner_message_id = t.message_id
                  AND e.tool_name IN (${[...MECHANICAL_TOOLS].map(() => "?").join(", ")})) AS mechanical_calls
         FROM turns t
         JOIN sessions s ON s.session_id = t.session_id
        WHERE s.state = 'RECONCILED' AND t.is_sidechain = 0 AND t.provisional = 0
          AND t.ts >= ? AND t.ts < ? ${sessionFilter}
        ORDER BY t.session_id, t.ts, t.message_id`,
    )
    .all(...MECHANICAL_TOOLS, scope.fromIso, scope.toIso, ...(scope.sessionIds ?? [])) as TurnRow[];

  const [, outPrice, readPrice, write5mPrice] = tierPriceVector(db, "sonnet-5");
  const runs: MechanicalRun[] = [];
  let current: { row: TurnRow; growth: number }[] = [];
  const flush = (): void => {
    if (current.length >= E2_MIN_RUN_TURNS) {
      let context = E2_SUBAGENT_BASE_TOKENS;
      let subagent = E2_SUBAGENT_BASE_TOKENS * write5mPrice;
      for (const { row, growth } of current) {
        subagent += context * readPrice + growth * write5mPrice + row.output_tokens * outPrice;
        context += growth;
      }
      const first = current[0] as { row: TurnRow };
      subagent += first.row.cost_equiv_u;
      runs.push({
        workspace_id: first.row.workspace_id,
        session_id: first.row.session_id,
        message_ids: current.map(({ row }) => row.message_id),
        first_ts: first.row.ts,
        cost_u: current.reduce((sum, { row }) => sum + row.cost_equiv_u, 0),
        subagent_u: subagent,
      });
    }
    current = [];
  };

  let previous: TurnRow | undefined;
  for (const row of rows) {
    if (row.session_id !== previous?.session_id) {
      flush();
      previous = undefined;
    }
    const strong = STRONG_MODEL.test(row.model ?? "");
    if (
      strong &&
      row.calls > 0 &&
      row.mechanical_calls === row.calls &&
      row.output_tokens < E2_MAX_OUTPUT_TOKENS
    ) {
      // What the main context grew by since the previous main turn: the new results and output.
      // A session's first turn has no previous one; its context is the base the dispatch covers.
      const growth =
        previous === undefined ? 0 : Math.max(0, row.context_tokens - previous.context_tokens);
      current.push({ row, growth });
    } else if (row.calls > 0 || !strong) {
      flush();
    }
    previous = row;
  }
  flush();
  return runs;
}

export const e2Detector: DetectorV2 = {
  contractVersion: 2,
  version: "E2@u10-2", // review: the saving charges the main-model handoff turn.
  scope: "cross-session",
  inputs: {
    // spendByWorkspace reads turns + workspaces; tierPriceVector reads pricing_snapshots.
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "pricing_snapshots",
      "tool_events",
      "tool_event_metadata",
    ],
  },
  descriptor: e2FindingDescriptor,
  id: "E2",
  name: "MAIN_THREAD_MECHANICAL_RUNS",

  evaluate(db: Db, ctx) {
    const byWorkspace = new Map<string, MechanicalRun[]>();
    for (const run of mechanicalRuns(db, { fromIso: ctx.fromIso, toIso: ctx.toIso })) {
      const runs = byWorkspace.get(run.workspace_id);
      if (runs === undefined) byWorkspace.set(run.workspace_id, [run]);
      else runs.push(run);
    }
    const spendByWs = new Map(
      spendByWorkspace(db, ctx.fromIso, ctx.toIso).map((s) => [s.workspace_id, s.cost_equiv_u]),
    );

    const fired: FiredV2[] = [];
    for (const [workspaceId, runs] of [...byWorkspace.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const costU = runs.reduce((sum, run) => sum + run.cost_u, 0);
      const subagentU = runs.reduce((sum, run) => sum + run.subagent_u, 0);
      const savingU = costU - subagentU;
      if ((pctOfSpend(savingU, spendByWs.get(workspaceId)) ?? 0) < E2_MIN_PCT_OF_SPEND) continue;

      // Sessions by their summed saving, largest first.
      const bySession = new Map<string, { saving: number; firstTs: string; firstId: string }>();
      for (const run of runs) {
        const session = bySession.get(run.session_id);
        if (session === undefined) {
          bySession.set(run.session_id, {
            saving: run.cost_u - run.subagent_u,
            firstTs: run.first_ts,
            firstId: run.message_ids[0] as string,
          });
        } else session.saving += run.cost_u - run.subagent_u;
      }
      const sessions = [...bySession.entries()].sort(
        (a, b) => b[1].saving - a[1].saving || a[0].localeCompare(b[0]),
      );
      const estimate = e2Estimate({ costEquivU: savingU });
      fired.push({
        scopeKey: `E2|${workspaceId}`,
        scope_workspace_id: workspaceId,
        modeled_savings_u_per_wk: estimate.rank_value_u_per_wk,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: e2FindingDescriptor.rule_id,
            label: "MAIN_THREAD_MECHANICAL_RUNS",
            assessment: e2FindingDescriptor.defaults.assessment,
            routing: e2FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // The sessions with the largest saving, each anchored at its first run.
            anchors: sessions.slice(0, 5).map(([sessionId, session]) => ({
              session_id: findingIds.session(sessionId),
              timestamp: session.firstTs,
              message_id: findingIds.message(session.firstId),
            })),
            session_ids: sessions.slice(0, 20).map(([sessionId]) => sessionId),
            estimate,
            impact: { kind: "COST", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics: {
              RUNS: { kind: "COUNT", value: runs.length },
              RUN_TURNS: {
                kind: "COUNT",
                value: runs.reduce((sum, run) => sum + run.message_ids.length, 0),
              },
              RUN_SESSIONS: { kind: "COUNT", value: bySession.size },
              RUN_COST_U: { kind: "NUMBER", value: Math.round(costU) },
              SUBAGENT_COST_U: { kind: "NUMBER", value: Math.round(subagentU) },
              SAVING_U: { kind: "NUMBER", value: Math.round(savingU) },
            },
          },
          e2FindingDescriptor,
        ),
      });
    }

    if (fired.length > 0) {
      return { fired, status: "ACTIVE", note: `${fired.length} workspace(s) with mechanical runs` };
    }
    return {
      fired,
      status: "INACTIVE",
      note:
        byWorkspace.size === 0
          ? "no mechanical runs on a strong main model in the window"
          : `subagent saving under ${E2_MIN_PCT_OF_SPEND}% of spend`,
    };
  },
};
