/**
 * C1 TOOL_ERROR_RATE.
 *
 * Compares each tool's error rate with the trailing-window corpus baseline.
 * The persisted V2 envelope contains bounded aggregates, the outlier tool names
 * and structural anchors.
 */

import type { Db } from "../../db/open.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { c1Estimate } from "../savings.js";
import {
  C1_BASELINE_MULTIPLIER,
  C1_MIN_TOOL_CALLS,
  C1_MIN_TOOL_ERRORS,
  c1Outcome,
  claimedTurnCost,
  d11WorseShells,
  wastedTurnClaims,
} from "../turn-claim.js";
import type { DetectorV2, FiredV2 } from "../types.js";

export { C1_BASELINE_MULTIPLIER };

interface ToolEventRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly tool_name: string;
  readonly exit_class: string | null;
  readonly command_text: string | null;
  readonly error_text: string | null;
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
}

interface ToolAggregate {
  readonly toolName: string;
  readonly rows: ToolEventRow[];
  readonly errors: ToolEventRow[];
}

/** C1's own counting rule (shell calls by the D11 outcome); see `c1Outcome`. */
function outcome(row: ToolEventRow): "ERROR" | "OK" | null {
  return c1Outcome(row.tool_name, row.exit_class, row.command_text, row.error_text);
}
function isError(row: ToolEventRow): boolean {
  return outcome(row) === "ERROR";
}

export const c1FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "C1",
  rule_id: "C1_TOOL_ERROR_RATE",
  labels: ["TOOL_ERROR_RATE_OUTLIER"],
  metrics: {
    TOOL_CALL_COUNT: { kind: "COUNT" },
    TOOL_ERROR_COUNT: { kind: "COUNT" },
    TOOL_ERROR_RATE: { kind: "RATIO" },
    CORPUS_CALL_COUNT: { kind: "COUNT" },
    CORPUS_ERROR_COUNT: { kind: "COUNT" },
    CORPUS_ERROR_RATE: { kind: "RATIO" },
    RATE_MULTIPLE: { kind: "NUMBER", min: 0 },
    // The outlier tools, most errors first, comma-separated: the counts above cover all of them.
    OUTLIER_TOOLS: { kind: "TEXT", max: 2_000 },
    // Review 5 M10: the turns the saving prices, so the card can show its inputs. Optional:
    // findings written before it lack it.
    CLAIMED_TURN_COUNT: { kind: "COUNT", optional: true },
    // U9 r6: this tool's ERROR results that were not counted as failures (browser timeouts, hook
    // blocks, rejected calls ...), so the card can say why the DB shows more errors than it counts.
    EXCLUDED_ERROR_COUNT: { kind: "COUNT", optional: true },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "DETERMINISTIC",
      posture: "REVIEW",
      provenance: { source: "RULE", version: "c1-v1" },
    },
    routing: { tier: "T3" },
  },
  presentation: {
    category: "TOOLING",
    lever: "Find the causes behind the failed tool calls before retrying or replacing the tool.",
    target_metric: "tool_error_rate",
    title: "Tool error-rate outlier",
  },
} as const);

export const c1Detector: DetectorV2 = {
  contractVersion: 2,
  // U9 r3: a missing path on Read/Grep/Glob is C2's, not a C1 failure. r6: records EXCLUDED_ERROR_COUNT.
  version: "C1@u9-3",
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
      "tool_event_content",
      "ingest_metric_events",
    ],
  },
  descriptor: c1FindingDescriptor,
  id: "C1",
  name: "TOOL_ERROR_RATE_V2",

  evaluate(db: Db, ctx) {
    const c1Claimed = wastedTurnClaims(db, ctx).get("C1") ?? new Set<string>();
    // A shell D11 flags in a workspace is D11's there; C1 leaves those calls out (T9).
    const d11Shells = d11WorseShells(db, ctx);
    const rows = (
      db
        .prepare(
          `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, e.tool_name, e.exit_class,
                json_extract(c.content_json, '$.command') AS command_text,
                json_extract(c.content_json, '$.error') AS error_text,
                m.owner_message_id, t.cost_equiv_u
           FROM tool_events e
           JOIN tool_event_metadata m ON m.event_id = e.event_id
           LEFT JOIN tool_event_content c ON c.event_id = e.event_id
           JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
           JOIN sessions s ON s.session_id = e.session_id
          WHERE e.ts >= ? AND e.ts < ?
            AND s.state = 'RECONCILED'
            AND m.owner_message_id IS NOT NULL
            AND t.is_sidechain = 0
            AND t.provisional = 0
          ORDER BY e.tool_name ASC, e.ts ASC, e.event_id ASC`,
        )
        .all(ctx.fromIso, ctx.toIso) as ToolEventRow[]
    ).filter((row) => row.tool_name !== d11Shells.get(row.workspace_id) && outcome(row) !== null);

    const corpusErrors = rows.filter(isError).length;
    if (rows.length === 0 || corpusErrors === 0) {
      return { fired: [], status: "INACTIVE", note: "no classified main-chain tool errors" };
    }
    const corpusRate = corpusErrors / rows.length;

    const byTool = new Map<string, ToolAggregate>();
    for (const row of rows) {
      const aggregate = byTool.get(row.tool_name);
      if (aggregate === undefined) {
        byTool.set(row.tool_name, {
          toolName: row.tool_name,
          rows: [row],
          errors: isError(row) ? [row] : [],
        });
      } else {
        aggregate.rows.push(row);
        if (isError(row)) aggregate.errors.push(row);
      }
    }

    // Qualifying outlier tools (enough calls, error rate > 2x corpus), alphabetical for stable output.
    const qualifying = [...byTool.values()]
      .filter(
        (a) =>
          a.rows.length >= C1_MIN_TOOL_CALLS &&
          a.errors.length >= C1_MIN_TOOL_ERRORS &&
          a.errors.length / a.rows.length > C1_BASELINE_MULTIPLIER * corpusRate,
      )
      .sort((a, b) => a.toolName.localeCompare(b.toolName));
    if (qualifying.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no tool exceeded twice the corpus error rate",
      };
    }

    // One finding per outlier tool, busiest first: unrelated tools (a browser bridge, a shell, an
    // MCP server) have unrelated causes, so each gets its own card. A single failed turn can error
    // in several tools, so a turn is priced once, by the busiest tool that has it — the anti
    // double-count invariant, using only C1's own claimed turns.
    const pricedTurns = new Set<string>();
    const fired: FiredV2[] = [];
    for (const tool of [...qualifying].sort(
      (a, b) => b.errors.length - a.errors.length || a.toolName.localeCompare(b.toolName),
    )) {
      const priceable = tool.errors.filter(
        (row) => !pricedTurns.has(`${row.session_id}|${row.owner_message_id}`),
      );
      const { summedCostU, claimedTurnCount } = claimedTurnCost(priceable, c1Claimed);
      for (const row of priceable) {
        if (c1Claimed.has(`${row.session_id}|${row.owner_message_id}`)) {
          pricedTurns.add(`${row.session_id}|${row.owner_message_id}`);
        }
      }
      const estimate = c1Estimate({ costEquivU: summedCostU });
      const modeledSavingsU = claimedTurnCount > 0 ? estimate.rank_value_u_per_wk : null;
      const toolCalls = tool.rows.length;
      const toolErrors = tool.errors.length;
      const toolRate = toolErrors / toolCalls;
      const ordered = [...tool.errors].sort(
        (x, y) => x.ts.localeCompare(y.ts) || x.event_id.localeCompare(y.event_id),
      );
      const sessionIds = [...new Set(ordered.map((row) => row.session_id))].sort().slice(0, 20);
      const examples = ordered.slice(-5);
      fired.push({
        scopeKey: `C1|${tool.toolName}`,
        scope_workspace_id: null,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: c1FindingDescriptor.rule_id,
            label: "TOOL_ERROR_RATE_OUTLIER",
            assessment: c1FindingDescriptor.defaults.assessment,
            routing: c1FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            // This detector has no per-anchor CEU contribution.
            anchors: examples.map((row) => ({
              session_id: findingIds.session(row.session_id),
              timestamp: row.ts,
              event_id: findingIds.event(row.event_id),
            })),
            session_ids: sessionIds,
            estimate,
            impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
            verdict: { value: "SUPPORTED", method: "RULE" },
            metrics: {
              TOOL_CALL_COUNT: { kind: "COUNT", value: toolCalls },
              TOOL_ERROR_COUNT: { kind: "COUNT", value: toolErrors },
              TOOL_ERROR_RATE: { kind: "RATIO", value: toolRate },
              CORPUS_CALL_COUNT: { kind: "COUNT", value: rows.length },
              CORPUS_ERROR_COUNT: { kind: "COUNT", value: corpusErrors },
              CORPUS_ERROR_RATE: { kind: "RATIO", value: corpusRate },
              RATE_MULTIPLE: { kind: "NUMBER", value: toolRate / corpusRate },
              OUTLIER_TOOLS: { kind: "TEXT", value: tool.toolName.slice(0, 2_000) },
              CLAIMED_TURN_COUNT: { kind: "COUNT", value: claimedTurnCount },
              EXCLUDED_ERROR_COUNT: {
                kind: "COUNT",
                value: tool.rows.filter((row) => row.exit_class === "ERROR" && !isError(row))
                  .length,
              },
            },
          },
          c1FindingDescriptor,
        ),
      });
    }

    return {
      fired,
      status: "ACTIVE",
      note: `tool error-rate outlier(s) across ${qualifying.length} tool(s)`,
    };
  },
};
