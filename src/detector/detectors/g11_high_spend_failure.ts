/** G11 HIGH_SPEND_OBSERVED_FAILURE. Outcome-linked, fail-closed spend comparison. */

import type { Db } from "../../db/open.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import {
  createFindingEnvelopeV2,
  defineFindingDescriptorV2,
  findingIds,
} from "../privacy-contract.js";
import { G11_AVOIDANCE_FRACTION, g11Estimate, g11Savings } from "../savings.js";
import type { DetectorV2, FiredV2 } from "../types.js";
import { blendedCacheReadPriceForWorkspace } from "../write-price.js";

export const G11_MIN_COMPARISON_WORK_ITEMS = 20;
const G11_TRAILING_COMPARISON_DAYS = 90;
/** A work item must be at least this % of its workspace's 90-day spend to be flagged (U7). */
const G11_MIN_PCT_OF_90D_SPEND = 1;

interface WorkItemSpendRow {
  readonly work_item_id: string;
  readonly workspace_id: string;
  readonly terminal_at: string;
  readonly outcome: "OBSERVED_SUCCESS" | "OBSERVED_SUCCESS_WITH_DEFERRALS" | "OBSERVED_FAILURE";
  /** All token columns on the item's turns (input, output, cache reads and writes). */
  readonly input_cache_tokens: number;
  /** The item's turns' own cost_equiv_u (µ$): output and cache writes priced as such. */
  readonly cost_u: number;
}

interface AnchorRow {
  readonly session_id: string;
  readonly message_id: string;
  readonly ts: string;
}

export const g11FindingDescriptor = defineFindingDescriptorV2({
  owner_detector_id: "G11",
  rule_id: "G11_HIGH_SPEND_OBSERVED_FAILURE",
  labels: ["HIGH_SPEND_OBSERVED_FAILURE"],
  metrics: {
    WORK_ITEM_ID: { kind: "OPAQUE_ID", source: "WORK_ITEM" },
    INPUT_CACHE_TOKENS: { kind: "TOKENS" },
    WORKSPACE_P90_INPUT_CACHE_TOKENS: { kind: "TOKENS" },
    COMPARISON_WORK_ITEM_COUNT: { kind: "COUNT" },
  },
  facets: ["impact", "verdict", "metrics"],
  defaults: {
    assessment: {
      kind: "CORRELATIONAL",
      posture: "REVIEW",
      provenance: { source: "OUTCOME_LINK", version: "g11-v1" },
    },
    routing: { tier: "INVESTIGATE" },
  },
  presentation: {
    category: "TOOLING",
    lever:
      "Review the linked failed work item before attributing high token use to a specific cause.",
    target_metric: "input_cache_tokens_per_work_item",
    title: "High-spend linked failure",
  },
} as const);

function percentile90(values: readonly number[]): number | null {
  if (values.length < G11_MIN_COMPARISON_WORK_ITEMS) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * 0.9) - 1];
  return value === undefined ? null : value;
}

/**
 * Return only fully attributable terminal work items. A linked session must be
 * uniquely linked, belong to the same workspace, be reconciled, and contain at
 * least one non-provisional usage row. This prevents a partial work-item total
 * from entering either the baseline or a candidate finding.
 */
function terminalSpendRows(db: Db, fromIso: string, toIso: string): WorkItemSpendRow[] {
  return db
    .prepare(
      `SELECT wi.work_item_id,
              wi.workspace_id,
              COALESCE(wi.merged_at, wi.closed_at) AS terminal_at,
              oo.outcome,
              SUM(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_5m +
                  t.cache_write_1h + t.cache_write_other) AS input_cache_tokens,
              COALESCE(SUM(t.cost_equiv_u), 0) AS cost_u
         FROM work_items wi
         JOIN observed_outcomes oo ON oo.work_item_id = wi.work_item_id
         JOIN session_work_links l ON l.work_item_id = wi.work_item_id
         JOIN sessions s ON s.session_id = l.session_id
         JOIN turns t ON t.session_id = l.session_id AND t.provisional = 0
        WHERE wi.state IN ('MERGED', 'CLOSED')
          AND oo.outcome IN ('OBSERVED_SUCCESS', 'OBSERVED_SUCCESS_WITH_DEFERRALS', 'OBSERVED_FAILURE')
          AND COALESCE(wi.merged_at, wi.closed_at) >= ?
          AND COALESCE(wi.merged_at, wi.closed_at) < ?
          -- A session linked to several work items is split by turn time: each turn belongs to
          -- the nearest work item that finished at or after it, else the last one to finish.
          AND wi.work_item_id = (
            SELECT w2.work_item_id
              FROM session_work_links l2
              JOIN work_items w2 ON w2.work_item_id = l2.work_item_id
             WHERE l2.session_id = t.session_id
             ORDER BY (COALESCE(w2.merged_at, w2.closed_at, '9999') >= t.ts) DESC,
                      CASE WHEN COALESCE(w2.merged_at, w2.closed_at, '9999') >= t.ts
                           THEN COALESCE(w2.merged_at, w2.closed_at, '9999') END ASC,
                      COALESCE(w2.merged_at, w2.closed_at, '9999') DESC,
                      w2.work_item_id ASC
             LIMIT 1)
          AND NOT EXISTS (
            SELECT 1
              FROM session_work_links linked
              JOIN sessions linked_session ON linked_session.session_id = linked.session_id
             WHERE linked.work_item_id = wi.work_item_id
               AND (linked_session.workspace_id <> wi.workspace_id OR linked_session.state <> 'RECONCILED')
          )
          AND NOT EXISTS (
            SELECT 1
              FROM session_work_links linked
             WHERE linked.work_item_id = wi.work_item_id
               AND NOT EXISTS (
                 SELECT 1 FROM turns usage
                  WHERE usage.session_id = linked.session_id AND usage.provisional = 0
               )
          )
        GROUP BY wi.work_item_id, wi.workspace_id, terminal_at, oo.outcome
        ORDER BY wi.workspace_id ASC, terminal_at ASC, wi.work_item_id ASC`,
    )
    .all(fromIso, toIso) as WorkItemSpendRow[];
}

/** Per-session token totals (all columns) for a workspace over the baseline window. */
function sessionTotals(
  db: Db,
  workspaceId: string,
  excludeWorkItemId: string,
  fromIso: string,
  toIso: string,
): number[] {
  return (
    db
      .prepare(
        `SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_5m +
                    cache_write_1h + cache_write_other) AS total
           FROM turns
          WHERE workspace_id = ? AND ts >= ? AND ts < ? AND provisional = 0
            AND session_id NOT IN (
              SELECT session_id FROM session_work_links WHERE work_item_id = ?)
          GROUP BY session_id`,
      )
      .all(workspaceId, fromIso, toIso, excludeWorkItemId) as Array<{ total: number }>
  ).map((row) => row.total);
}

function newestAnchors(db: Db, workItemId: string): AnchorRow[] {
  const ordered = db
    .prepare(
      `SELECT t.session_id, t.message_id, t.ts
         FROM session_work_links l
         JOIN turns t ON t.session_id = l.session_id
        WHERE l.work_item_id = ? AND t.provisional = 0
        ORDER BY t.ts ASC, t.message_id ASC`,
    )
    .all(workItemId) as AnchorRow[];
  return ordered.slice(-5);
}

export const g11Detector: DetectorV2 = {
  contractVersion: 2,
  version: "G11@u7-1",
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "work_items",
      "observed_outcomes",
      "session_work_links",
    ],
    clock: true,
  },
  descriptor: g11FindingDescriptor,
  id: "G11",
  name: "HIGH_SPEND_OBSERVED_FAILURE_V2",

  evaluate(db: Db, ctx) {
    const comparisonFromIso = new Date(
      ctx.now.getTime() - G11_TRAILING_COMPARISON_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const comparisonRows = terminalSpendRows(db, comparisonFromIso, ctx.toIso).filter(
      (row) => Number.isSafeInteger(row.input_cache_tokens) && row.input_cache_tokens >= 0,
    );
    const candidates = comparisonRows.filter(
      (row) => row.terminal_at >= ctx.fromIso && row.outcome === "OBSERVED_FAILURE",
    );

    const byWorkspace = new Map<string, WorkItemSpendRow[]>();
    for (const row of comparisonRows) {
      const rows = byWorkspace.get(row.workspace_id);
      if (rows === undefined) byWorkspace.set(row.workspace_id, [row]);
      else rows.push(row);
    }

    const fired: FiredV2[] = [];
    for (const candidate of candidates) {
      // A candidate is evaluated against other terminal work items, never
      // against itself. This preserves the stated 20-item comparison floor.
      const comparison = (byWorkspace.get(candidate.workspace_id) ?? []).filter(
        (row) => row.work_item_id !== candidate.work_item_id,
      );
      let baseline = comparison.map((row) => row.input_cache_tokens);
      let p90 = percentile90(baseline);
      if (p90 === null) {
        // Too few terminal work items in this workspace: compare against its per-session p90.
        baseline = sessionTotals(
          db,
          candidate.workspace_id,
          candidate.work_item_id,
          comparisonFromIso,
          ctx.toIso,
        );
        p90 = percentile90(baseline);
      }
      if (p90 === null || candidate.input_cache_tokens < p90) continue;
      // Spend gate: the item is at least 1% of the workspace's 90-day spend (unknown spend is
      // not gated).
      const itemPct = pctOfSpend(
        candidate.cost_u,
        workspaceSpendU(
          db,
          candidate.workspace_id,
          Date.parse(comparisonFromIso),
          Date.parse(ctx.toIso),
        ),
      );
      if (itemPct !== null && itemPct < G11_MIN_PCT_OF_90D_SPEND) continue;
      const anchors = newestAnchors(db, candidate.work_item_id);
      if (anchors.length === 0) continue;

      const excess = Math.max(0, candidate.input_cache_tokens - p90);
      const readPrice = blendedCacheReadPriceForWorkspace(
        db,
        candidate.workspace_id,
        ctx.fromIso,
        ctx.toIso,
      );
      // The excess is priced at the item's own blended cost per token (output and writes
      // included); with no priced turns it falls back to the workspace cache-read price.
      const modeledSavingsU =
        candidate.cost_u > 0 && excess > 0 && candidate.input_cache_tokens > 0
          ? Math.round(
              (candidate.cost_u * excess * G11_AVOIDANCE_FRACTION) / candidate.input_cache_tokens,
            )
          : readPrice > 0 && excess > 0
            ? g11Savings(excess, G11_AVOIDANCE_FRACTION, readPrice).savingsU
            : null;
      // session_ids: unique sessions linked to this work_item (bounded to 20).
      const sessionIds = [...new Set(anchors.map((a) => a.session_id))].sort().slice(0, 20);
      // Basis P pass-through: estimate == modeled_savings_u_per_wk by construction.
      const estimate = { ...g11Estimate({}), rank_value_u_per_wk: modeledSavingsU ?? 0 };

      fired.push({
        scopeKey: `G11|${candidate.workspace_id}|${candidate.work_item_id}`,
        scope_workspace_id: candidate.workspace_id,
        modeled_savings_u_per_wk: modeledSavingsU,
        payload: createFindingEnvelopeV2(
          {
            version: 2,
            rule_id: g11FindingDescriptor.rule_id,
            label: "HIGH_SPEND_OBSERVED_FAILURE",
            assessment: g11FindingDescriptor.defaults.assessment,
            routing: g11FindingDescriptor.defaults.routing,
            window: { from: ctx.fromIso, to: ctx.toIso },
            anchors: anchors.map((anchor) => ({
              session_id: findingIds.session(anchor.session_id),
              message_id: findingIds.message(anchor.message_id),
              timestamp: anchor.ts,
            })),
            session_ids: sessionIds,
            estimate,
            impact: { kind: "COST", severity: "HIGH", direction: "REDUCE" },
            verdict: { value: "SUPPORTED", method: "CORRELATION" },
            metrics: {
              WORK_ITEM_ID: {
                kind: "OPAQUE_ID",
                value: findingIds.workItem(candidate.work_item_id),
              },
              INPUT_CACHE_TOKENS: { kind: "TOKENS", value: candidate.input_cache_tokens },
              WORKSPACE_P90_INPUT_CACHE_TOKENS: { kind: "TOKENS", value: p90 },
              COMPARISON_WORK_ITEM_COUNT: { kind: "COUNT", value: baseline.length },
            },
          },
          g11FindingDescriptor,
        ),
      });
    }

    return fired.length === 0
      ? {
          fired,
          status: "INACTIVE",
          note: "no high-spend observed failure with a complete 90-day baseline",
        }
      : {
          fired,
          status: "ACTIVE",
          note: `${fired.length} high-spend observed failure work item(s)`,
        };
  },
};
