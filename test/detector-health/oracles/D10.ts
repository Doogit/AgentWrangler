/**
 * D10 CATALOG_FOOTPRINT headline oracle, written only from the dh-contracts.md D10 card.
 * Graded on the card's NET headline ("Headline (net)"), not the gross "Card quantity".
 * Card gate (global): catalog_items has rows; candidates (plugins none of whose child skills/MCP servers was used in
 * the window, and standalone skills with no use) sum to removable tokens > 0 (NULL tokens count 0; MCP servers are never
 * sized); and either (a) modelled saving (removable x settled turns x cache-read-weighted blended price x 0.5) >= 0.5%
 * of global spend, or (b) removable >= 5% of the mean context per turn (mean > 0).
 * Headline, over settled in-window turns (all workspaces and chains) with cache_read_tokens > 0:
 * tokens = round(min(removable, cache_read_tokens) x 0.5); value = tokens x that turn's own cache-read price
 * (snapshot index 2, no snapshot = 0); headline = round(sum of value). One global finding, no workspace.
 * Skill use = tool_event_skills.skill_name equal to the skill's usage_key; MCP use = tool_name starting with usage_key.
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_PCT_OF_SPEND = 0.5;
const MIN_CONTEXT_SHARE = 0.05;
const AVOIDANCE = 0.5;

interface Item {
  kind: "skill" | "plugin" | "mcp_server";
  name: string;
  plugin: string | null;
  usage_key: string | null;
  tokens: number | null;
}
interface TurnRow {
  message_id: string;
  context_tokens: number;
  cache_read_tokens: number;
  prices: string | null;
}

export const oracleD10: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const none = (note: string) => ({ findings: [], turns_checked: [], note });

  const items = db
    .prepare("SELECT kind, name, plugin, usage_key, tokens FROM catalog_items")
    .all() as Item[];
  if (items.length === 0) return none("D10: no catalog rows (NOT_EVALUATED)");

  const usedSkills = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT s.skill_name FROM tool_event_skills s JOIN tool_events e ON e.event_id = s.event_id
           WHERE e.ts >= ? AND e.ts < ?`,
        )
        .all(fromIso, toIso) as Array<{ skill_name: string }>
    ).map((r) => r.skill_name),
  );
  const toolNames = (
    db
      .prepare("SELECT DISTINCT tool_name FROM tool_events WHERE ts >= ? AND ts < ?")
      .all(fromIso, toIso) as Array<{ tool_name: string }>
  ).map((r) => r.tool_name);
  const used = (i: Item): boolean => {
    if (!i.usage_key) return false;
    if (i.kind === "skill") return usedSkills.has(i.usage_key);
    if (i.kind === "mcp_server") return toolNames.some((n) => n.startsWith(i.usage_key as string));
    return false;
  };

  let removable = 0;
  let candidates = 0;
  for (const i of items) {
    if (i.kind === "mcp_server") continue; // never sized: adds 0 whether or not listed
    if (i.kind === "skill") {
      if (i.plugin !== null) continue; // covered by its plugin's row
      if (used(i)) continue;
    } else {
      const children = items.filter((c) => c.kind !== "plugin" && c.plugin === i.plugin);
      if (children.some(used)) continue;
    }
    candidates++;
    removable += i.tokens ?? 0;
  }
  if (removable <= 0) return none(`D10: ${candidates} candidates, removable tokens 0`);

  const turns = db
    .prepare(
      `SELECT t.message_id, t.context_tokens, t.cache_read_tokens, p.unit_prices_json AS prices
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.provisional = 0 AND t.ts >= ? AND t.ts < ?
       ORDER BY t.ts, t.message_id`,
    )
    .all(fromIso, toIso) as TurnRow[];
  if (turns.length === 0) return none("D10: no settled turns in window");

  const readPrice = (t: TurnRow): number =>
    t.prices ? ((JSON.parse(t.prices) as number[])[2] ?? 0) : 0;
  const mean = turns.reduce((a, t) => a + t.context_tokens, 0) / turns.length;
  const gateB = mean > 0 && removable / mean >= MIN_CONTEXT_SHARE;

  let spend = 0;
  for (const v of priceTurns(
    db,
    turns.map((t) => t.message_id),
  ).values())
    spend += v;
  const readTotal = turns.reduce((a, t) => a + t.cache_read_tokens, 0);
  const blended =
    readTotal > 0
      ? turns.reduce((a, t) => a + t.cache_read_tokens * readPrice(t), 0) / readTotal
      : 0;
  const modelled = removable * turns.length * blended * AVOIDANCE;
  const gateA = modelled > 0 && spend > 0 && (modelled / spend) * 100 >= MIN_PCT_OF_SPEND;
  const pctNote = spend > 0 ? ((modelled / spend) * 100).toFixed(3) : "n/a";
  if (!gateA && !gateB)
    return none(
      `D10: below gates (a ${pctNote}% of spend, b ${((removable / (mean || 1)) * 100).toFixed(2)}% of mean context)`,
    );

  let value = 0;
  let claimed = 0;
  let claimTurns = 0;
  const checked: string[] = [];
  for (const t of turns) {
    if (t.cache_read_tokens <= 0) continue;
    const tokens = Math.round(Math.min(removable, t.cache_read_tokens) * AVOIDANCE);
    if (tokens <= 0) continue;
    claimed += tokens;
    claimTurns++;
    value += tokens * readPrice(t);
    checked.push(t.message_id);
  }

  const headline = Math.round(value);
  const finding: OracleFinding = {
    scope: { workspace_id: null, key: "D10|global|MCP_SCHEMAS" },
    quantities: [
      { name: "removable_tokens", unit: "tokens", value: removable },
      { name: "claimed_tokens", unit: "tokens", value: claimed },
      { name: "claimed_turns", unit: "turns", value: claimTurns },
    ],
    measured_u: headline,
    assumptions: [
      {
        name: "D1_D10_AVOIDANCE_FRACTION",
        value: AVOIDANCE,
        source: "dh-contracts.md D10 card, D1_D10_AVOIDANCE_FRACTION (ASSUMED, range 0.33 to 0.7)",
      },
      {
        name: "D10_NO_COMPETING_CLAIMS",
        value: 1,
        source:
          "dh-contracts.md D10 card, Headline assumptions: only D1 ranks above; measured 0.00 percent cut, assumed within +/-3 percent",
      },
      {
        name: "D10_CATALOG_IS_CURRENT_SNAPSHOT",
        value: 1,
        source:
          "dh-contracts.md D10 card, Headline assumptions: catalog_items is the current probe state, not windowed",
      },
      {
        name: "D10_MCP_UNSIZED_AND_NO_LIST_FALLBACK",
        value: 1,
        source:
          "dh-contracts.md D10 card: MCP servers add 0 tokens; unpriced turns claim $0 (no list-price fallback)",
      },
    ],
    modeled_u: headline,
    count: claimTurns,
  };
  return {
    findings: [finding],
    turns_checked: checked,
    note: `D10: ${candidates} candidates, removable ${removable} tokens, gate a ${pctNote}% gate b ${((removable / mean) * 100).toFixed(2)}%; net headline, no competing claims assumed`,
  };
};
