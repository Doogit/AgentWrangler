/**
 * D10 CATALOG_FOOTPRINT probe. Written from the D10 contract card only.
 * `catalog_items` / `context_inventory` are probe-written (ContextInventoryProbe), not classifier columns;
 * no raw-JSONL sample count is available inside a DB-only probe, so the orchestrator must add one on live copies.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const MIN_PCT = 0.5;
const MIN_SHARE = 0.05;
const AVOIDANCE = 0.5;

interface Item {
  kind: string;
  name: string;
  plugin: string | null;
  usage_key: string | null;
  tokens: number | null;
}

export const probeD10: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const to = now.toISOString();

  const items = db
    .prepare("SELECT kind, name, plugin, usage_key, tokens FROM catalog_items")
    .all() as Item[];
  if (items.length === 0) {
    return {
      candidates: 0,
      qualifying: 0,
      gates: [],
      note: "no catalog_items rows (NOT_EVALUATED)",
    };
  }

  // Use in window: skill names from Skill calls; MCP use by tool-name prefix mcp__<server>__.
  const skillsUsed = new Set(
    (
      db
        .prepare(
          `SELECT k.skill_name AS n FROM tool_event_skills k JOIN tool_events e ON e.event_id = k.event_id
            WHERE e.ts >= ? AND e.ts < ?`,
        )
        .all(from, to) as { n: string }[]
    ).map((r) => r.n),
  );
  const toolNames = (
    db
      .prepare("SELECT DISTINCT tool_name AS n FROM tool_events WHERE ts >= ? AND ts < ?")
      .all(from, to) as { n: string }[]
  ).map((r) => r.n);
  const skillUsed = (i: Item): boolean =>
    skillsUsed.has(i.usage_key ?? i.name) || skillsUsed.has(i.name);
  const mcpUsed = (i: Item): boolean => {
    const key = i.usage_key ?? i.name;
    return toolNames.some((n) => n.startsWith(`mcp__${key}__`));
  };
  const used = (i: Item): boolean =>
    i.kind === "skill" ? skillUsed(i) : i.kind === "mcp_server" ? mcpUsed(i) : false;

  const childUsed = (pluginName: string): boolean =>
    items.some((c) => c.plugin === pluginName && c.kind !== "plugin" && used(c));

  // Candidates: unused plugins (via children) and unused standalone skills. MCP servers are never sized
  // (null counts as 0) so they add nothing to removable tokens whatever the upfront setting says.
  let candidates = 0;
  let removable = 0;
  for (const i of items) {
    if (i.kind === "plugin") {
      if (!childUsed(i.name)) {
        candidates++;
        removable += i.tokens ?? 0;
      }
    } else if (i.kind === "skill" && !i.plugin) {
      if (!skillUsed(i)) {
        candidates++;
        removable += i.tokens ?? 0;
      }
    }
  }

  const turnStats = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(AVG(context_tokens),0) AS mean, COALESCE(SUM(cost_equiv_u),0) AS spend,
              COALESCE(SUM(cache_read_tokens),0) AS cr
         FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ?`,
    )
    .get(from, to) as { n: number; mean: number; spend: number; cr: number };
  const priceRow = db
    .prepare(
      `SELECT SUM(t.cache_read_tokens * json_extract(p.unit_prices_json,'$[2]')) AS w, SUM(t.cache_read_tokens) AS tok
         FROM turns t JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
        WHERE t.provisional = 0 AND t.ts >= ? AND t.ts < ?`,
    )
    .get(from, to) as { w: number | null; tok: number | null };
  const price = priceRow.tok && priceRow.w ? priceRow.w / priceRow.tok : 0;

  const shareVal = turnStats.mean > 0 ? removable / turnStats.mean : null;
  const shareOk = removable > 0 && turnStats.mean > 0 && (shareVal as number) >= MIN_SHARE;
  const savingU =
    removable > 0 && price > 0 && turnStats.n > 0
      ? removable * turnStats.n * price * AVOIDANCE
      : null;
  const pct = savingU !== null && turnStats.spend > 0 ? (savingU / turnStats.spend) * 100 : null;
  const pctOk = pct !== null && pct >= MIN_PCT;
  const fires = candidates > 0 && removable > 0 && (shareOk || pctOk);

  return {
    candidates,
    qualifying: fires ? 1 : 0,
    gates: [
      {
        name: "D10_REMOVABLE_TOKENS",
        value: removable,
        threshold: 0,
        op: ">",
        pass: removable > 0,
      },
      {
        name: "D10_MIN_CONTEXT_SHARE",
        value: shareVal,
        threshold: MIN_SHARE,
        op: ">=",
        pass: shareOk,
      },
      { name: "D10_MIN_PCT_OF_SPEND", value: pct, threshold: MIN_PCT, op: ">=", pass: pctOk },
    ],
    note:
      "catalog_items (probe-written; raw-sample count not available here). Candidate = plugin with no used child " +
      "skill/MCP server, or standalone skill (no plugin) with no use in window; skill use = tool_event_skills " +
      "name matches usage_key/name, MCP use = tool_name prefix mcp__<key>__. Removable = sum of candidate tokens " +
      "(null = 0; MCP never sized). Gate b = removable / mean context of settled window turns; gate a = removable " +
      "x turns x cache-read-weighted price x 0.5 as % of settled window spend. Fires when either gate passes. " +
      "'Enabled' and the upfront-MCP setting are not modelled (no column in catalog_items; MCP adds 0 tokens anyway).",
  };
};
