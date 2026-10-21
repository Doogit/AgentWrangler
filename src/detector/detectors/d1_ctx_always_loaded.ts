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
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import type { ClaimProducer } from "../claim-ledger.js";
import { GLOBAL_WORKSPACE_ID } from "../context-probe.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import { D1_SOURCE_TARGETS, D1_TRIM_TO_TARGET_FRACTION, d1Estimate } from "../savings.js";
import { blendedTierPrice } from "../tier-price.js";
import { turnKey } from "../turn-claim.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/** D1's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const D1_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D1?.constants.find(
  (constant) => constant.name === "D1_TRIM_TO_TARGET_FRACTION",
);
export const D1_FRACTION_RANGE: readonly [number, number] =
  D1_FRACTION_CONSTANT && D1_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D1_FRACTION_CONSTANT.min, D1_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D1

/**
 * U0.1 (commit 1a2482df) switched the MEMORY probe from summing all memory files to
 * MEMORY.md only, without changing attribution_version — so history rows recorded before
 * this cutoff measure a different quantity than the current probe and are not a valid
 * as-of basis for MEMORY sources.
 */
export const D1_MEMORY_BASIS_SINCE = "2026-09-23T23:08:00.000Z";

interface InventoryRow {
  probe_id: string;
  workspace_id: string;
  component: string;
  file_ref: string;
  tokens: number;
  probed_at: string;
  attribution_version: string;
}

/** Source key the as-of helper prices a turn against. */
export interface AsOfSource {
  workspaceId: string;
  component: string;
  fileRef: string;
  currentTokens: number;
  /** Only history rows recorded under the same attribution basis are comparable. */
  attributionVersion: string;
}

/**
 * As-of token size for one source, keyed by turn timestamp: the latest
 * `context_inventory_history` row for (workspaceId, component, fileRef, attributionVersion)
 * with `observed_at <= turnTs`, else the source's current `context_inventory.tokens`.
 * History is loaded once (sorted ascending) and looked up per turn via binary search — no
 * per-turn query. Exported so D10 (same catalog-footprint quantity) reuses it.
 */
export function asOfTokensBySource(db: Db, source: AsOfSource): (turnTs: string) => number {
  const rows = db
    .prepare(
      `SELECT tokens, observed_at FROM context_inventory_history
        WHERE workspace_id = ? AND component = ? AND file_ref = ? AND attribution_version = ?
        ORDER BY observed_at ASC`,
    )
    .all(source.workspaceId, source.component, source.fileRef, source.attributionVersion) as Array<{
    tokens: number;
    observed_at: string;
  }>;
  const history =
    source.component === "MEMORY"
      ? rows.filter((row) => row.observed_at >= D1_MEMORY_BASIS_SINCE)
      : rows;
  return (turnTs: string): number => {
    let lo = 0;
    let hi = history.length - 1;
    let match = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = history[mid];
      if (candidate !== undefined && candidate.observed_at <= turnTs) {
        match = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const found = match >= 0 ? history[match] : undefined;
    return found?.tokens ?? source.currentTokens;
  };
}

/** scopeKey/scope_workspace_id for one D1 source — shared by evaluate() and d1ClaimProducer
 *  so their rec ids agree byte-for-byte. */
export function d1ScopeKey(row: {
  workspace_id: string;
  component: string;
  file_ref: string;
}): { scopeKey: string; scopeWorkspaceId: string | null } {
  const isGlobal = row.workspace_id === GLOBAL_WORKSPACE_ID;
  const scopeSegment = isGlobal ? "global" : row.workspace_id;
  const fileBasename = path.basename(row.file_ref);
  return {
    scopeKey: `D1|${scopeSegment}|${row.component}|${fileBasename}`,
    scopeWorkspaceId: isGlobal ? null : row.workspace_id,
  };
}

const ELIGIBLE_TURN = {
  MEMORY:
    "(t.is_sidechain = 0 OR EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type = 'fork'))",
  CLAUDE_MD:
    "(t.is_sidechain = 0 OR NOT EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type IN ('Explore', 'Plan')))",
} as const;

function eligibleTurn(component: "MEMORY" | "CLAUDE_MD"): string {
  return ELIGIBLE_TURN[component];
}

export const d1ClaimProducer: ClaimProducer = {
  detectorId: "D1",
  *produce(db, ctx) {
    const remainingByTurn = new Map<string, number>();
    const sources = db
      .prepare(`SELECT probe_id, workspace_id, component, file_ref, tokens, attribution_version
      FROM context_inventory WHERE component IN ('MEMORY', 'CLAUDE_MD')
      ORDER BY probe_id`)
      .all() as Pick<
      InventoryRow,
      "probe_id" | "workspace_id" | "component" | "file_ref" | "tokens" | "attribution_version"
    >[];
    for (const source of sources) {
      if (source.component !== "MEMORY" && source.component !== "CLAUDE_MD") continue;
      const target = D1_SOURCE_TARGETS[source.component];
      if (target === undefined) continue;
      if (source.tokens <= target) continue;
      // Same gate as the card: no card means no claim.
      if (!d1Assess(db, source as InventoryRow, ctx).passes) continue;
      const { scopeKey, scopeWorkspaceId } = d1ScopeKey(source);
      const claimRecId = recId("D1", scopeWorkspaceId, scopeKey);
      const asOf = asOfTokensBySource(db, {
        workspaceId: source.workspace_id,
        component: source.component,
        fileRef: source.file_ref,
        currentTokens: source.tokens,
        attributionVersion: source.attribution_version,
      });
      const workspaceFilter =
        source.workspace_id === GLOBAL_WORKSPACE_ID ? "t.workspace_id != ?" : "t.workspace_id = ?";
      const turns = db
        .prepare(`SELECT t.message_id, t.session_id, t.workspace_id, t.ts, t.cache_read_tokens
        FROM turns t WHERE ${workspaceFilter} AND t.ts >= ? AND t.ts < ?
        AND t.provisional = 0 AND ${eligibleTurn(source.component)}
        AND t.cache_read_tokens > 0 ORDER BY t.session_id, t.message_id`)
        .all(source.workspace_id, ctx.fromIso, ctx.toIso) as Array<{
        message_id: string;
        session_id: string;
        workspace_id: string;
        ts: string;
        cache_read_tokens: number;
      }>;
      for (const turn of turns) {
        const delta = asOf(turn.ts) - target;
        if (delta <= 0) continue;
        const key = turnKey(turn.session_id, turn.message_id);
        const remaining = remainingByTurn.get(key) ?? turn.cache_read_tokens;
        const tokens = Math.min(delta, remaining);
        if (tokens <= 0) continue;
        remainingByTurn.set(key, remaining - tokens);
        yield {
          detectorId: "D1",
          workspaceId: turn.workspace_id,
          sessionId: turn.session_id,
          turnKey: key,
          component: "cacheRead" as const,
          slice: `prefix:${source.probe_id}`,
          tokens,
          fraction: D1_TRIM_TO_TARGET_FRACTION,
          fractionRange: D1_FRACTION_RANGE,
          assumed: true,
          recId: claimRecId,
        };
      }
    }
  },
};

/** U7: a source must be at least this share of the scope's mean context per turn. */
const D1_MIN_CONTEXT_SHARE = 0.02;
/** U7: and its modeled saving at least this % of the scope's 7-day spend. */
const D1_MIN_PCT_OF_SPEND = 0.2;

interface TurnMetrics {
  turns_per_week: number;
  mean_context_tokens: number;
  cache_read_tokens: number;
  cache_read_spend_u: number;
}

/**
 * The one D1 card gate, shared by evaluate() and d1ClaimProducer so card and ledger agree:
 * a source must be at least 2% of the scope's mean context per turn, and its modeled saving at
 * least 0.2% of the scope's spend. Unknown spend cannot be gated. A scope with no turns
 * (zero saving) never passes.
 */
function d1Assess(
  db: Db,
  row: InventoryRow,
  ctx: { fromIso: string; toIso: string },
): {
  passes: boolean;
  savingsU: number;
  turnsPerWeek: number;
  estimate: ReturnType<typeof d1Estimate>;
  measuredContent: boolean;
} {
  const target = D1_SOURCE_TARGETS[row.component as "MEMORY" | "CLAUDE_MD"] ?? row.tokens;
  const component = row.component as "MEMORY" | "CLAUDE_MD";
  const isGlobal = row.workspace_id === GLOBAL_WORKSPACE_ID;
  // Global sources use the all-workspace aggregate; per-workspace sources only their own.
  const workspaceFilter = isGlobal ? "t.workspace_id != ?" : "t.workspace_id = ?";
  const metrics = db
    .prepare(
      `SELECT COUNT(*) AS turns_per_week,
                COALESCE(AVG(t.context_tokens), 0) AS mean_context_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_read_tokens *
                  (SELECT CAST(json_extract(ps.unit_prices_json, '$[2]') AS REAL)
                     FROM pricing_snapshots ps
                    WHERE ps.snapshot_id = t.pricing_snapshot_id)), 0) AS cache_read_spend_u
           FROM turns t
          WHERE ${workspaceFilter} AND t.ts >= ? AND t.ts < ?
            AND t.provisional = 0 AND ${eligibleTurn(component)}`,
    )
    .get(row.workspace_id, ctx.fromIso, ctx.toIso) as TurnMetrics;

  const blendedPrice =
    metrics.cache_read_tokens > 0
      ? metrics.cache_read_spend_u / metrics.cache_read_tokens
      : blendedTierPrice(
          db,
          db
            .prepare(
              `SELECT t.model AS model, COUNT(*) AS weight
                 FROM turns t
                WHERE ${workspaceFilter} AND t.ts >= ? AND t.ts < ?
                  AND t.provisional = 0 AND ${eligibleTurn(component)}
                GROUP BY t.model`,
            )
            .all(row.workspace_id, ctx.fromIso, ctx.toIso) as {
            model: string;
            weight: number;
          }[],
          2,
        );

  const measuredContent = row.attribution_version === "measured-pair-v1:2.1.280/claude-opus-5-5";
  const baseEstimate = d1Estimate({
    deltaContextTokens: row.tokens - target,
    turnsPerWeek: metrics.turns_per_week,
    cacheReadPriceUsdPerMtok: Number(blendedPrice.toFixed(6)),
    reductionFraction: D1_TRIM_TO_TARGET_FRACTION,
  });
  const estimate = measuredContent
    ? baseEstimate
    : {
        ...baseEstimate,
        label: "chars/4 token quantity estimate; unmeasured token uncertainty",
      };
  const savingsU = estimate.rank_value_u_per_wk ?? 0;
  const base = { savingsU, turnsPerWeek: metrics.turns_per_week, estimate, measuredContent };

  // Dormant scope: no turns in-window means zero modeled savings, so no card.
  if (savingsU === 0) return { ...base, passes: false };
  if (row.tokens < D1_MIN_CONTEXT_SHARE * metrics.mean_context_tokens) {
    return { ...base, passes: false };
  }
  const scopeSpendPct = pctOfSpend(
    savingsU,
    workspaceSpendU(
      db,
      isGlobal ? null : row.workspace_id,
      Date.parse(ctx.fromIso),
      Date.parse(ctx.toIso),
    ),
  );
  return { ...base, passes: scopeSpendPct === null || scopeSpendPct >= D1_MIN_PCT_OF_SPEND };
}

function sessionIdsForScope(
  db: Db,
  workspaceId: string | null,
  component: "MEMORY" | "CLAUDE_MD",
  fromIso: string,
  toIso: string,
): string[] {
  const workspaceFilter = workspaceId === null ? "t.workspace_id != ?" : "t.workspace_id = ?";
  return (
    db
      .prepare(
        `SELECT DISTINCT t.session_id FROM turns t
          WHERE ${workspaceFilter} AND t.ts >= ? AND t.ts < ?
          AND t.provisional = 0 AND ${eligibleTurn(component)}
          ORDER BY t.session_id LIMIT 20`,
      )
      .all(workspaceId ?? GLOBAL_WORKSPACE_ID, fromIso, toIso) as Array<{ session_id: string }>
  ).map((row) => row.session_id);
}

/** Steps[] wording per component — numbered, source-specific action plan. */
function stepsFor(component: string, fileRef: string): string[] {
  switch (component) {
    case "CLAUDE_MD":
      return [
        `Open ${fileRef}`,
        "Move changelogs, history, and background explanations to a linked document",
        "Keep only current rules and links here",
        "Check the size again after the next local scan",
      ];
    case "MEMORY":
      return [
        `Review memory files under ${fileRef}`,
        "Remove old or duplicate memories",
        "Combine overlapping facts into concise entries",
        "Check the size again after the next local scan",
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
      return "Move changelogs and history out of CLAUDE.md; keep current rules and links.";
    case "MEMORY":
      return "Remove old or duplicate memories and combine overlapping facts.";
    case "MCP_SCHEMAS":
      return "Identify rarely-used skills/plugins; extract to on-demand or disable.";
    default:
      return "Shorten this content that is loaded into every conversation.";
  }
}

export const d1Detector: Detector = {
  contractVersion: 1,
  // U9 r7: records top_workspace_turns (turn split across workspaces).
  version: "D1@u12-1", // U12: trim-to-target fraction 1 (was 0.5).
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "context_inventory",
      "subagent_meta",
    ],
  },
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
        `SELECT probe_id, workspace_id, component, file_ref, tokens, probed_at, attribution_version
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

    // Workspaces that actually ran an eligible turn this week, for the global multiplier (U7: the
    // card said "across 10" when 3 were active, because every registered workspace was counted).
    const activeWorkspaceTurns = (component: "MEMORY" | "CLAUDE_MD"): number[] =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM turns t
              WHERE t.workspace_id != ? AND t.ts >= ? AND t.ts < ?
                AND t.provisional = 0 AND ${eligibleTurn(component)}
              GROUP BY t.workspace_id ORDER BY n DESC`,
          )
          .all(GLOBAL_WORKSPACE_ID, ctx.fromIso, ctx.toIso) as { n: number }[]
      ).map((r) => r.n);

    const fired: Fired[] = [];

    for (const row of rows) {
      if (row.component !== "CLAUDE_MD" && row.component !== "MEMORY") continue;
      const target = D1_SOURCE_TARGETS[row.component];
      if (target === undefined) continue; // unsupported component — skip
      if (row.tokens <= target) continue; // within target — no rec

      const delta = row.tokens - target;
      const isGlobal = row.workspace_id === GLOBAL_WORKSPACE_ID;
      const scope: "global" | "workspace" = isGlobal ? "global" : "workspace";

      // Turn metrics, estimate and the card gate are shared with d1ClaimProducer (d1Assess).
      const assessment = d1Assess(db, row, ctx);
      if (!assessment.passes) continue;
      const { estimate, savingsU, measuredContent } = assessment;
      const wsTurns = isGlobal ? activeWorkspaceTurns(row.component) : [];
      // Effective turns: for global, the total already spans all workspaces.
      // workspace_multiplier is stored in evidence for display transparency.
      const effectiveTurns = assessment.turnsPerWeek;

      // scopeKey uses workspace_id (or 'global' for __global__) to keep it unique across
      // workspaces with the same component+basename — shared with d1ClaimProducer so rec
      // ids agree byte-for-byte.
      const { scopeKey, scopeWorkspaceId } = d1ScopeKey(row);
      const sessionIds = sessionIdsForScope(
        db,
        isGlobal ? null : row.workspace_id,
        row.component,
        ctx.fromIso,
        ctx.toIso,
      );

      fired.push({
        scopeKey,
        scope_workspace_id: scopeWorkspaceId,
        modeled_savings_u_per_wk: savingsU,
        modeled_formula_json: { estimate },
        payload: {
          version: 1,
          template_id: "D1_CONTEXT_ALWAYS_LOADED",
          facts: {
            component: row.component,
            probe_id: row.probe_id,
            attribution_method: measuredContent ? "MEASURED_CONTENT" : "CHARS4_ESTIMATE",
            session_ids: sessionIds,
            source_tokens: row.tokens,
            source_target: target,
            delta_context_tokens: delta,
            turns_per_week: effectiveTurns,
            scope,
            workspace_multiplier: isGlobal ? wsTurns.length : 1,
            // U9 r7: "Workspaces: 2" hid that one of them was a 5-turn probe.
            ...(isGlobal && wsTurns.length > 0 ? { top_workspace_turns: wsTurns[0] } : {}),
          },
        },
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
