/**
 * Workspace context composition. v1 intentionally attributes only the
 * always-loaded local files we can measure; tool output stays in the residual.
 */

import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export type ContextCompositionKey = "always_loaded" | "session_residual";

export interface ContextCompositionRow {
  key: ContextCompositionKey;
  label: string;
  tokens: number;
  share: number | null;
}

/** A standalone workspace detail adjunct; WorkspaceDetail remains frozen. */
export interface ContextComposition {
  workspace_id: string;
  observed_context_tokens: number | null;
  observed_turns: number;
  inventory_rows: number;
  rows: [ContextCompositionRow, ContextCompositionRow];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compare current CLAUDE.md/MEMORY inventory with the inclusive provisional
 * seven-day context average. This deliberately never reads tool_result_bytes:
 * it is byte-sized and v1 leaves tool output lumped in the residual.
 */
export function getContextComposition(workspaceId: string): ApiResponse<ContextComposition> {
  const db = getQueryDb();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const inventory = db
    .prepare(
      `SELECT COUNT(*) AS inventory_rows, COALESCE(SUM(tokens), 0) AS always_loaded
         FROM context_inventory
        WHERE workspace_id IN (?, '__global__')
          AND component IN ('CLAUDE_MD', 'MEMORY')`,
    )
    .get(workspaceId) as { inventory_rows: number; always_loaded: number };
  const observed = db
    .prepare(
      `SELECT COUNT(*) AS observed_turns, AVG(context_tokens) AS observed_context_tokens
         FROM turns
        WHERE workspace_id = ? AND ts >= ? AND ts < ?`,
    )
    .get(workspaceId, fromIso, toIso) as {
    observed_turns: number;
    observed_context_tokens: number | null;
  };

  const alwaysLoaded = Math.max(inventory.always_loaded, 0);
  const observedContext = observed.observed_context_tokens;
  const residual = observedContext === null ? 0 : Math.max(observedContext - alwaysLoaded, 0);
  const total = observedContext === null ? 0 : alwaysLoaded + residual;
  const share = (tokens: number): number | null => (total > 0 ? tokens / total : null);
  const rows: [ContextCompositionRow, ContextCompositionRow] = [
    {
      key: "always_loaded",
      label: "always loaded",
      tokens: alwaysLoaded,
      share: share(alwaysLoaded),
    },
    {
      key: "session_residual",
      label: "session history + tool outputs (not itemized in v1)",
      tokens: residual,
      share: share(residual),
    },
  ];

  return buildResponse(
    {
      workspace_id: workspaceId,
      observed_context_tokens: observedContext,
      observed_turns: observed.observed_turns,
      inventory_rows: inventory.inventory_rows,
      rows,
    },
    {
      claim_kind: "OBS_PROXY",
      n: observed.observed_turns,
      window: { from: fromIso, to: toIso, preset: "7d" },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Provisional turns are included. v1 uses the current estimated CLAUDE.md and MEMORY inventory (±5–10% tokenizer error), excludes the system prompt and dynamic MCP schemas, and does not itemize the residual.",
      },
      drilldown_ids: { workspace_id: workspaceId },
    },
  );
}
