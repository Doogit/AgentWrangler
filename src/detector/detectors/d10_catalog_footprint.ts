/**
 * D10 CATALOG_FOOTPRINT.
 *
 * U7: D10 reads the per-item catalog rows (catalog_items, written by the
 * ContextInventoryProbe) and builds a disable-list: enabled plugins and standalone skills
 * with no recorded use in the window, largest first. Skill names and descriptions are
 * resident on every turn whatever the Tool-Search mode, so their savings are priced under
 * every state. MCP tool schemas are never sized (they come from the running server), so an
 * unused MCP server is listed only when its schemas load upfront and never adds savings.
 *
 * Gate (replaces the unreachable fixed 40k-token target): the modeled saving is ≥ 0.5% of
 * global spend in the window OR the removable tokens are ≥ 5% of mean context per turn.
 */

import type { Db } from "../../db/open.js";
import { pctOfSpend, workspaceSpendU } from "../../query/spend.js";
import type { ClaimProducer } from "../claim-ledger.js";
import {
  GLOBAL_WORKSPACE_ID,
  type ToolSearchState,
  parseToolSearchState,
} from "../context-probe.js";
import { DETECTOR_CONTRACTS } from "../contracts.js";
import { recId } from "../rec-id.js";
import { D1_D10_AVOIDANCE_FRACTION, d10Estimate, d10Savings } from "../savings.js";
import { turnKey } from "../turn-claim.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";
import { blendedCacheReadPriceGlobal } from "../write-price.js";

/** Card gate: modeled saving as % of global spend in the window. */
export const D10_MIN_PCT_OF_SPEND = 0.5;
/** Card gate: removable tokens as a share of mean context per turn. */
export const D10_MIN_CONTEXT_SHARE = 0.05;
/** Bound on the disable-list carried in the payload. */
const D10_MAX_LIST_ITEMS = 30;

/** D10's ASSUMED avoidance-fraction [min, max], read from the quantity contract (F1). */
const D10_FRACTION_CONSTANT = DETECTOR_CONTRACTS.D10?.constants.find(
  (constant) => constant.name === "D1_D10_AVOIDANCE_FRACTION",
);
const D10_FRACTION_RANGE: readonly [number, number] =
  D10_FRACTION_CONSTANT && D10_FRACTION_CONSTANT.status === "ASSUMED"
    ? [D10_FRACTION_CONSTANT.min, D10_FRACTION_CONSTANT.max]
    : [0.33, 0.7]; // fallback literal mirrors contracts.ts DETECTOR_CONTRACTS.D10

interface CatalogItemRow {
  kind: "skill" | "plugin" | "mcp_server";
  name: string;
  plugin: string | null;
  usage_key: string | null;
  tokens: number | null;
}

interface SettingsStateRow {
  attribution_version: string;
}

/** One disable-list entry. */
export interface D10Candidate {
  kind: "skill" | "plugin" | "mcp_server";
  name: string;
  /** null for MCP servers (schema size not measurable locally). */
  tokens: number | null;
  /** Last recorded use (YYYY-MM-DD) before the window, or null when never recorded. */
  lastUsed: string | null;
}

/** Everything evaluate() and the claim producer share. */
export interface D10Assessment {
  itemCount: number;
  catalogTokens: number;
  candidates: D10Candidate[];
  removableTokens: number;
  unmeasuredMcpServerCount: number;
  skillUseUntrackedCount: number;
  meanContextTokens: number;
  turnsInWindow: number;
  readPrice: number;
  savingsU: number | null;
  pctOfSpend: number | null;
  fires: boolean;
}

function catalogStateLabel(state: ToolSearchState | null): string {
  switch (state?.effective_catalog_state) {
    case "alwaysLoad":
      return `alwaysLoad keeps ${state.always_load_count} MCP server(s) upfront`;
    case "deferred":
      return "Tool Search defers MCP tool definitions until they are needed";
    case "threshold":
      return "Tool Search uses threshold loading, so some MCP definitions may be upfront";
    case "upfront":
      return "MCP tool definitions load upfront because Tool Search is disabled";
    default:
      return "MCP tool load behavior is unknown";
  }
}

function stateRow(db: Db): ToolSearchState | null {
  const row = db
    .prepare(
      `SELECT attribution_version
         FROM context_inventory
        WHERE workspace_id = ? AND component = 'SETTINGS_SYSTEM'
        ORDER BY probed_at DESC
        LIMIT 1`,
    )
    .get(GLOBAL_WORKSPACE_ID) as SettingsStateRow | undefined;
  return row === undefined ? null : parseToolSearchState(row.attribution_version);
}

/** Only upfront/alwaysLoad states keep MCP tool schemas resident every turn. */
function mcpSchemasResident(state: ToolSearchState | null): boolean {
  return (
    state?.effective_catalog_state === "upfront" || state?.effective_catalog_state === "alwaysLoad"
  );
}

function day(ts: string | null): string | null {
  return ts === null ? null : ts.slice(0, 10);
}

/** Per-item usage and the disable-list for the window. Null when the probe wrote no items. */
export function assessCatalog(
  db: Db,
  ctx: DetectorContext,
  state: ToolSearchState | null,
): D10Assessment | null {
  const items = db
    .prepare(
      `SELECT kind, name, plugin, usage_key, tokens FROM catalog_items
        ORDER BY kind, name`,
    )
    .all() as CatalogItemRow[];
  if (items.length === 0) return null;

  // Skill use: last use before the window, and whether it was used inside it.
  const skillUse = new Map<string, { last: string; inWindow: boolean }>();
  for (const row of db
    .prepare(
      `SELECT m.skill_name AS name, MAX(e.ts) AS last,
              MAX(CASE WHEN e.ts >= ? AND e.ts < ? THEN 1 ELSE 0 END) AS in_window
         FROM tool_event_skills m JOIN tool_events e ON e.event_id = m.event_id
        WHERE e.ts < ?
        GROUP BY m.skill_name`,
    )
    .all(ctx.fromIso, ctx.toIso, ctx.toIso) as Array<{
    name: string;
    last: string;
    in_window: number;
  }>) {
    skillUse.set(row.name, { last: row.last, inWindow: row.in_window === 1 });
  }
  // Skill calls ingested before skill names were recorded: their skill is unknown.
  const skillUseUntrackedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tool_events e
           LEFT JOIN tool_event_skills m ON m.event_id = e.event_id
          WHERE e.tool_name = 'Skill' AND m.skill_name IS NULL AND e.ts >= ? AND e.ts < ?`,
      )
      .get(ctx.fromIso, ctx.toIso) as { n: number }
  ).n;

  // MCP use by tool-name prefix; only scanned when an MCP server is configured.
  const mcpUse = new Map<string, { last: string; inWindow: boolean }>();
  const servers = items.filter((item) => item.kind === "mcp_server" && item.usage_key !== null);
  if (servers.length > 0) {
    const tools = db
      .prepare(
        `SELECT tool_name, MAX(ts) AS last,
                MAX(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS in_window
           FROM tool_events WHERE tool_name LIKE 'mcp%' AND ts < ?
          GROUP BY tool_name`,
      )
      .all(ctx.fromIso, ctx.toIso) as Array<{ tool_name: string; last: string; in_window: number }>;
    for (const server of servers) {
      const key = server.usage_key as string;
      for (const tool of tools) {
        if (!tool.tool_name.startsWith(key)) continue;
        const prev = mcpUse.get(key);
        mcpUse.set(key, {
          last: prev === undefined || tool.last > prev.last ? tool.last : prev.last,
          inWindow: (prev?.inWindow ?? false) || tool.in_window === 1,
        });
      }
    }
  }

  const useOf = (item: CatalogItemRow) =>
    item.usage_key === null
      ? undefined
      : item.kind === "skill"
        ? skillUse.get(item.usage_key)
        : mcpUse.get(item.usage_key);

  const candidates: D10Candidate[] = [];
  for (const item of items) {
    if (item.kind === "plugin") {
      // A plugin is unused when none of its skills or MCP servers was used in the window.
      const children = items.filter((child) => child.plugin === item.name && child !== item);
      const uses = children.map(useOf).filter((use) => use !== undefined);
      if (uses.some((use) => use.inWindow)) continue;
      const last = uses.reduce<string | null>(
        (latest, use) => (latest === null || use.last > latest ? use.last : latest),
        null,
      );
      candidates.push({
        kind: "plugin",
        name: item.name,
        tokens: item.tokens,
        lastUsed: day(last),
      });
    } else if (item.plugin === null) {
      // Plugin-owned skills/servers are covered by their plugin's row.
      if (item.kind === "mcp_server" && !mcpSchemasResident(state)) continue;
      const use = useOf(item);
      if (use?.inWindow) continue;
      candidates.push({
        kind: item.kind,
        name: item.name,
        tokens: item.tokens,
        lastUsed: day(use?.last ?? null),
      });
    }
  }
  candidates.sort(
    (a, b) =>
      (b.tokens ?? -1) - (a.tokens ?? -1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const removableTokens = candidates.reduce((sum, c) => sum + (c.tokens ?? 0), 0);
  const catalogTokens = items
    .filter((item) => item.kind === "plugin" || (item.kind === "skill" && item.plugin === null))
    .reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const turns = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(AVG(context_tokens), 0) AS mean
         FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0`,
    )
    .get(ctx.fromIso, ctx.toIso) as { n: number; mean: number };
  const readPrice = blendedCacheReadPriceGlobal(db, ctx.fromIso, ctx.toIso);
  const savingsU =
    removableTokens > 0 && readPrice > 0 && turns.n > 0
      ? d10Savings(removableTokens, turns.n, readPrice, D1_D10_AVOIDANCE_FRACTION).savingsU
      : null;
  const pct = pctOfSpend(
    savingsU,
    workspaceSpendU(db, null, Date.parse(ctx.fromIso), Date.parse(ctx.toIso)),
  );
  const fires =
    removableTokens > 0 &&
    ((pct !== null && pct >= D10_MIN_PCT_OF_SPEND) ||
      (turns.mean > 0 && removableTokens >= D10_MIN_CONTEXT_SHARE * turns.mean));

  return {
    itemCount: items.length,
    catalogTokens,
    candidates,
    removableTokens,
    unmeasuredMcpServerCount: items.filter((item) => item.kind === "mcp_server").length,
    skillUseUntrackedCount,
    meanContextTokens: Math.round(turns.mean),
    turnsInWindow: turns.n,
    readPrice,
    savingsU,
    pctOfSpend: pct,
    fires,
  };
}

/** One printable line per disable-list entry (CATALOG_LABEL-safe). */
export function candidateLabel(c: D10Candidate, untrackedSkillCalls = 0): string {
  const size = c.tokens === null ? "size not measured" : `~${c.tokens} tokens`;
  // Skill calls ingested before skill names were tracked may be uses of this item, so "no
  // recorded use" would overstate what is known.
  const never =
    untrackedSkillCalls > 0 && c.kind !== "mcp_server"
      ? "not seen in tracked skill calls"
      : "no recorded use";
  const used = c.lastUsed === null ? never : `last used ${c.lastUsed}`;
  return `${c.kind} ${c.name.replace(/[^\x20-\x5F\x61-\x7E]/g, "?").slice(0, 120)} (${size}; ${used})`;
}

export const d10ClaimProducer: ClaimProducer = {
  detectorId: "D10",
  *produce(db, ctx) {
    const assessment = assessCatalog(db, ctx, stateRow(db));
    if (assessment === null || !assessment.fires) return;
    const claimRecId = recId("D10", null, "D10|global|MCP_SCHEMAS");
    const turns = db
      .prepare(
        `SELECT t.session_id, t.message_id, t.workspace_id, t.cache_read_tokens
           FROM turns t
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0 AND t.cache_read_tokens > 0
          ORDER BY t.session_id, t.message_id`,
      )
      .all(ctx.fromIso, ctx.toIso) as Array<{
      session_id: string;
      message_id: string;
      workspace_id: string;
      cache_read_tokens: number;
    }>;
    for (const turn of turns) {
      const tokens = Math.min(assessment.removableTokens, turn.cache_read_tokens);
      if (tokens <= 0) continue;
      yield {
        detectorId: "D10",
        workspaceId: turn.workspace_id,
        sessionId: turn.session_id,
        turnKey: turnKey(turn.session_id, turn.message_id),
        component: "cacheRead" as const,
        slice: "prefix:mcp_schemas",
        tokens,
        fraction: D1_D10_AVOIDANCE_FRACTION,
        fractionRange: D10_FRACTION_RANGE,
        assumed: true,
        recId: claimRecId,
      };
    }
  },
};

export const d10Detector: Detector = {
  contractVersion: 1,
  version: "D10@u9-1",
  scope: "cross-session",
  inputs: {
    tables: [
      "turns",
      "sessions",
      "workspaces",
      "user_config",
      "pricing_snapshots",
      "tool_events",
      "tool_event_skills",
      "context_inventory",
      "catalog_items",
    ],
  },
  id: "D10",
  name: "CATALOG_FOOTPRINT",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    const state = stateRow(db);
    const assessment = assessCatalog(db, ctx, state);
    if (assessment === null) {
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note: `no per-item catalog rows yet (ContextInventoryProbe); ${catalogStateLabel(state)}`,
      };
    }
    const a = assessment;
    const target = Math.round(D10_MIN_CONTEXT_SHARE * a.meanContextTokens);
    const summary = `${a.candidates.length} unused catalog item(s), ~${a.removableTokens} removable token(s) of ${a.catalogTokens} measured; ${catalogStateLabel(state)}`;
    if (!a.fires) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `${summary}; below gate (${D10_MIN_PCT_OF_SPEND}% of spend or ${D10_MIN_CONTEXT_SHARE * 100}% of mean context)`,
      };
    }

    const estimate = d10Estimate({
      deltaContextTokens: a.removableTokens,
      turnsPerWeek: a.savingsU === null ? 0 : a.turnsInWindow,
      cacheReadPriceUsdPerMtok: a.readPrice,
      reductionFraction: D1_D10_AVOIDANCE_FRACTION,
    });
    const sessionIds = (
      db
        .prepare(
          `SELECT DISTINCT session_id FROM turns
            WHERE ts >= ? AND ts < ? AND provisional = 0
            ORDER BY session_id LIMIT 20`,
        )
        .all(ctx.fromIso, ctx.toIso) as Array<{ session_id: string }>
    ).map((row) => row.session_id);

    const facts = {
      session_ids: sessionIds,
      catalog_tokens: a.catalogTokens,
      catalog_target_tokens: target,
      delta_context_tokens: a.removableTokens,
      catalog_item_count: state?.catalog_item_count ?? a.itemCount,
      always_load_count: state?.always_load_count ?? 0,
      removable_tokens: a.removableTokens,
      mean_context_tokens: a.meanContextTokens,
      disable_list: a.candidates
        .slice(0, D10_MAX_LIST_ITEMS)
        .map((c) => candidateLabel(c, a.skillUseUntrackedCount)),
      unmeasured_mcp_server_count: a.unmeasuredMcpServerCount,
      skill_use_untracked_count: a.skillUseUntrackedCount,
      ...(a.pctOfSpend === null ? {} : { pct_of_spend: Math.min(100, a.pctOfSpend) }),
    };

    const fired: Fired = {
      scopeKey: "D10|global|MCP_SCHEMAS",
      scope_workspace_id: null,
      modeled_savings_u_per_wk: a.savingsU,
      modeled_formula_json: { estimate },
      payload: {
        version: 1,
        template_id: "D10_CATALOG_FOOTPRINT",
        facts,
      },
    };

    return { fired: [fired], status: "ACTIVE", note: summary };
  },
};
