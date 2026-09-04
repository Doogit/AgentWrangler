/**
 * src/detector/detectors/d1_ctx_always_loaded.ts — D1 CTX_ALWAYS_LOADED_OVERSIZE.
 *
 * Fires PER-SOURCE against per-source token targets (UNVALIDATED defaults).
 * For each context_inventory row:
 *   - fire when source_tokens > D1_SOURCE_TARGETS[component]
 *   - delta = source_tokens - target (trimmable portion)
 *   - weekly savings µUSD = delta × turns_per_week × blended_cache_read_price
 *
 * GLOBAL sources (workspace_id = '__global__'): multiply turns_per_week by the
 * count of active (non-global) workspaces; set scope_workspace_id = null.
 * PER-WORKSPACE sources: keep the real workspace_id as scope_workspace_id.
 *
 * scopeKey = `D1|<workspace_id_or_global>|<component>|<file_ref-basename>`
 * so rec_id is stable and unique per source.
 *
 * When context_inventory is empty, returns NOT_EVALUATED (ContextInventoryProbe
 * not yet run or no sources found).
 */

import * as path from "node:path";
import type { Db } from "../../db/open.js";
import { LIST_PRICES } from "../../ingest/pricing.js";
import { GLOBAL_WORKSPACE_ID } from "../context-probe.js";
import { D1_SOURCE_TARGETS, d1Savings } from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/** Opus list cache-read price ($/MTok) — anchor when a workspace has no cache reads. */
const OPUS_CACHE_READ_PRICE = LIST_PRICES.opus?.[2] ?? 0.5;

interface InventoryRow {
  probe_id: string;
  workspace_id: string;
  component: string;
  file_ref: string;
  tokens: number;
  probed_at: string;
}

interface TurnMetrics {
  turns_per_week: number;
  cache_read_tokens: number;
  cache_read_spend_u: number;
}

/** Steps[] wording per component — numbered, source-specific action plan. */
function stepsFor(component: string, fileRef: string): string[] {
  switch (component) {
    case "CLAUDE_MD":
      return [
        `Open ${fileRef}`,
        "Move changelog/history/rationale prose to a linked doc",
        "Keep current-state rules + pointers only",
        "Re-measure: probe re-sizes on next daemon pass",
      ];
    case "MEMORY":
      return [
        `Review memory files under ${fileRef}`,
        "Delete stale or duplicate memories",
        "Consolidate overlapping facts into concise entries",
        "Re-measure: probe re-sizes on next daemon pass",
      ];
    case "MCP_SCHEMAS":
      return [
        "List enabled plugins/skills in ~/.claude/plugins and ~/.claude/skills",
        "Identify rarely-used skills from recent session activity",
        "Extract to on-demand usage or disable the plugin",
        "Re-measure: probe re-sizes on next daemon pass",
      ];
    default:
      return [`Trim ${fileRef} to reduce always-loaded context`];
  }
}

/** Short imperative title per component — written into evidence.title (read by toCard). */
function titleFor(component: string, tokens: number, target: number): string {
  const label =
    component === "CLAUDE_MD" ? "CLAUDE.md" : component === "MEMORY" ? "memory" : "MCP schemas";
  const fromK = Math.round(tokens / 1_000);
  const toK = Math.round(target / 1_000);
  return `Trim ${label}: ${fromK}K→${toK}K tokens`;
}

/** Lever label per component. */
function leverFor(component: string): string {
  switch (component) {
    case "CLAUDE_MD":
      return "Move changelog/history prose out of CLAUDE.md; keep current-state + pointers.";
    case "MEMORY":
      return "Prune stale/duplicate memories; consolidate overlapping facts.";
    case "MCP_SCHEMAS":
      return "Identify rarely-used skills/plugins; extract to on-demand or disable.";
    default:
      return "Trim always-loaded context source to the per-source target.";
  }
}

export const d1Detector: Detector = {
  id: "D1",
  name: "CTX_ALWAYS_LOADED_OVERSIZE",
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    // Early exit when there is nothing to evaluate.
    const inventoryCount = (
      db.prepare("SELECT COUNT(*) AS n FROM context_inventory").get() as { n: number }
    ).n;
    if (inventoryCount === 0) {
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note: "no context_inventory rows — run ContextInventoryProbe first",
      };
    }

    // Only sources with an active D1 contract are evaluable. MCP_SCHEMAS is a
    // catalog estimate and is intentionally owned by the gated D10 detector.
    const rows = db
      .prepare(
        `SELECT probe_id, workspace_id, component, file_ref, tokens, probed_at
           FROM context_inventory
          WHERE component IN ('CLAUDE_MD', 'MEMORY')`,
      )
      .all() as InventoryRow[];

    if (rows.length === 0) {
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note:
          inventoryCount === 0
            ? "no context_inventory rows — run ContextInventoryProbe first"
            : "no evaluable context_inventory rows — catalog estimates are gated behind D10 load-state telemetry",
      };
    }

    // Count active (non-global) workspaces for the global multiplier.
    const activeWorkspaceCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE workspace_id != ?")
        .get(GLOBAL_WORKSPACE_ID) as { n: number }
    ).n;

    // Turn metrics for ALL non-global workspaces (used for global sources).
    const globalMetrics = db
      .prepare(
        `SELECT COUNT(*) AS turns_per_week,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_read_tokens *
                  (SELECT CAST(json_extract(ps.unit_prices_json, '$[2]') AS REAL)
                     FROM pricing_snapshots ps
                    WHERE ps.snapshot_id = t.pricing_snapshot_id)), 0) AS cache_read_spend_u
           FROM turns t
          WHERE t.workspace_id != ? AND t.ts >= ? AND t.ts < ?`,
      )
      .get(GLOBAL_WORKSPACE_ID, ctx.fromIso, ctx.toIso) as TurnMetrics;

    const fired: Fired[] = [];

    for (const row of rows) {
      const target = D1_SOURCE_TARGETS[row.component];
      if (target === undefined) continue; // unsupported component — skip
      if (row.tokens <= target) continue; // within target — no rec

      const delta = row.tokens - target;
      const isGlobal = row.workspace_id === GLOBAL_WORKSPACE_ID;
      const scope: "global" | "workspace" = isGlobal ? "global" : "workspace";

      // Turn metrics: global sources use all-workspace aggregate; per-workspace
      // sources query only their own workspace.
      let metrics: TurnMetrics;
      if (isGlobal) {
        metrics = globalMetrics;
      } else {
        metrics = db
          .prepare(
            `SELECT COUNT(*) AS turns_per_week,
                    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                    COALESCE(SUM(cache_read_tokens *
                      (SELECT CAST(json_extract(ps.unit_prices_json, '$[2]') AS REAL)
                         FROM pricing_snapshots ps
                        WHERE ps.snapshot_id = t.pricing_snapshot_id)), 0) AS cache_read_spend_u
               FROM turns t
              WHERE t.workspace_id = ? AND t.ts >= ? AND t.ts < ?`,
          )
          .get(row.workspace_id, ctx.fromIso, ctx.toIso) as TurnMetrics;
      }

      // Effective turns: for global, the total already spans all workspaces.
      // workspace_multiplier is stored in evidence for display transparency.
      const effectiveTurns = isGlobal ? metrics.turns_per_week : metrics.turns_per_week;

      const blendedPrice =
        metrics.cache_read_tokens > 0
          ? metrics.cache_read_spend_u / metrics.cache_read_tokens
          : OPUS_CACHE_READ_PRICE;

      const { savingsU, formula } = d1Savings(
        delta,
        effectiveTurns,
        Number(blendedPrice.toFixed(6)),
      );

      // Skip dormant workspaces: no turns in-window ⇒ zero modeled savings this week,
      // so the rec would be noise ("prune memory · 0 tokens/wk freed"). Latent bloat in
      // an inactive workspace resurfaces on a later pass once it has activity again.
      if (savingsU === 0) continue;

      const fileBasename = path.basename(row.file_ref);
      // scopeKey uses workspace_id (or 'global' for __global__) to keep it unique
      // across workspaces with the same component+basename.
      const scopeSegment = isGlobal ? "global" : row.workspace_id;
      const scopeKey = `D1|${scopeSegment}|${row.component}|${fileBasename}`;

      const evidenceBase: Record<string, unknown> = {
        title: titleFor(row.component, row.tokens, target),
        component: row.component,
        file_ref: row.file_ref,
        source_tokens: row.tokens,
        source_target: target,
        delta_context_tokens: delta,
        turns_per_week: effectiveTurns,
        modeled_savings_basis: "LIST_EQUIV",
        billed_cost_claim: "UNAVAILABLE",
        scope,
        steps: stepsFor(row.component, row.file_ref),
      };
      if (isGlobal) {
        evidenceBase.workspace_multiplier = activeWorkspaceCount;
      }

      fired.push({
        scopeKey,
        category: "CONTEXT",
        scope_workspace_id: isGlobal ? null : row.workspace_id,
        lever: leverFor(row.component),
        target_metric: "avg_context_per_turn",
        modeled_savings_u_per_wk: savingsU,
        modeled_formula: formula,
        evidence: evidenceBase,
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "all context_inventory sources within per-source targets",
      };
    }
    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} source(s) exceed their per-source target (CLAUDE_MD=${D1_SOURCE_TARGETS.CLAUDE_MD}, MEMORY=${D1_SOURCE_TARGETS.MEMORY}); catalog estimates are gated behind D10 load-state telemetry`,
    };
  },
};
