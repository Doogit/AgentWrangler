/**
 * D10 CATALOG_FOOTPRINT.
 *
 * This detector reports the derived MCP/plugin/skill catalog as an estimate.
 * The ContextInventoryProbe records Tool-Search configuration facts separately
 * in a zero-token SETTINGS_SYSTEM row, so D10 can distinguish deferred tools
 * from server-level alwaysLoad exemptions without persisting catalog content.
 * Per-turn loaded-tool attribution and economic savings remain gated on R11.
 */

import type { Db } from "../../db/open.js";
import {
  GLOBAL_WORKSPACE_ID,
  type ToolSearchState,
  parseToolSearchState,
} from "../context-probe.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/** Retained as the unvalidated catalog-size review threshold. */
export const D10_CATALOG_FOOTPRINT_TARGET_TOKENS = 40_000;

interface CatalogRow {
  file_ref: string;
  file_hash: string;
  tokens: number;
  probed_at: string;
}

interface SettingsStateRow {
  attribution_version: string;
}

function catalogStateLabel(state: ToolSearchState): string {
  switch (state.effective_catalog_state) {
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

function statusNote(state: ToolSearchState, catalogTokens: number, withinTarget: boolean): string {
  const target = D10_CATALOG_FOOTPRINT_TARGET_TOKENS;
  const comparison = withinTarget ? "is within" : "exceeds";
  return `catalog estimate ${catalogTokens} token(s) ${comparison} ${target} target; ${catalogStateLabel(state)}; loaded-tool economics are not measured`;
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

function catalogRows(db: Db): CatalogRow[] {
  return db
    .prepare(
      `SELECT file_ref, file_hash, tokens, probed_at
         FROM context_inventory
        WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'
        ORDER BY file_ref`,
    )
    .all(GLOBAL_WORKSPACE_ID) as CatalogRow[];
}

function configEvidence(state: ToolSearchState): Record<string, unknown> {
  return {
    tool_search_mode: state.tool_search_mode,
    effective_catalog_state: state.effective_catalog_state,
    configured_value: state.configured_value,
    always_load_flags: state.always_load_flags,
    always_load_count: state.always_load_count,
    always_load_flags_truncated: state.always_load_flags_truncated,
    catalog_item_count: state.catalog_item_count,
    catalog_item_count_truncated: state.catalog_item_count_truncated,
    catalog_hash: state.catalog_hash,
  };
}

export const d10Detector: Detector = {
  id: "D10",
  name: "CATALOG_FOOTPRINT",

  evaluate(db: Db, _ctx: DetectorContext): DetectorOutcome {
    const rows = catalogRows(db);
    const state = stateRow(db);

    if (rows.length === 0) {
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note:
          state === null
            ? "catalog estimate unavailable; Tool-Search config state is not measured"
            : `catalog estimate unavailable; ${catalogStateLabel(state)}`,
      };
    }
    if (state === null) {
      return {
        fired: [],
        status: "NOT_EVALUATED",
        note: "catalog inventory is estimated, but Tool-Search config state is not measured",
      };
    }

    const catalogTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const withinTarget = catalogTokens <= D10_CATALOG_FOOTPRINT_TARGET_TOKENS;
    if (withinTarget) {
      return {
        fired: [],
        status: "INACTIVE",
        note: statusNote(state, catalogTokens, true),
      };
    }

    const delta = catalogTokens - D10_CATALOG_FOOTPRINT_TARGET_TOKENS;
    const latestProbedAt = rows.reduce<string | null>(
      (latest, row) => (latest === null || row.probed_at > latest ? row.probed_at : latest),
      null,
    );
    const refs = rows.map((row) => row.file_ref);
    const evidence: Record<string, unknown> = {
      title: `Review ${state.effective_catalog_state} tool catalog: ${Math.round(catalogTokens / 1000)}K tokens`,
      component: "MCP_SCHEMAS",
      file_ref: refs.length === 1 ? refs[0] : null,
      file_refs: refs,
      source_count: rows.length,
      catalog_tokens: catalogTokens,
      catalog_target_tokens: D10_CATALOG_FOOTPRINT_TARGET_TOKENS,
      delta_context_tokens: delta,
      estimate: true,
      priority: "down-ranked",
      thresholds_unvalidated: true,
      loaded_tool_telemetry: "unavailable",
      probed_at: latestProbedAt,
      ...configEvidence(state),
      steps: [
        "Review enabled MCP servers, plugins, and skills in the local Claude catalog",
        "Keep only the small set of MCP servers that need alwaysLoad on every turn",
        "Disable rarely used plugins or leave infrequent tools deferred",
        "Re-measure: ContextInventoryProbe refreshes catalog and config facts on the next daemon pass",
      ],
    };

    const fired: Fired = {
      scopeKey: "D10|global|MCP_SCHEMAS",
      category: "TOOLING",
      scope_workspace_id: null,
      lever: "Too many connected tools, plugins, and skills",
      target_metric: "catalog_context_tokens",
      // R11 is required before catalog size can become a freed-headroom claim.
      modeled_savings_u_per_wk: null,
      modeled_formula: {
        model: "D10_CATALOG_FOOTPRINT_CONFIG_V1",
        inputs: {
          catalog_tokens: catalogTokens,
          catalog_target_tokens: D10_CATALOG_FOOTPRINT_TARGET_TOKENS,
          delta_context_tokens: delta,
          catalog_item_count: state.catalog_item_count,
          always_load_count: state.always_load_count,
        },
        kind: "estimate",
      },
      evidence,
    };

    return {
      fired: [fired],
      status: "ACTIVE",
      note: statusNote(state, catalogTokens, false),
    };
  },
};
