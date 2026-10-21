/**
 * P3.L L5 oracle: expected D4 ledger claims from plain SQL. Imports no src/ code, so it is
 * independent of the producer it checks (design §6 L5). Compare with `ledger-conservation.ts`
 * on the same --db/--from/--to window.
 *
 * Model (spec F2 v2 items 1, 5, 6: residual repricing, slice `model:*`):
 * - Fire: per workspace, Opus subagent turns (is_sidechain = 1, model LIKE '%opus%',
 *   provisional = 0) in the window, grouped by agent (agent_id, else 'session:<id>'). A lookup
 *   agent has EVERY turn at context ≥ 50k and output ≤ 500. Fires on ≥ 5 Opus subagent turns,
 *   lookup-turn share ≥ 40%, and a positive avg input/output Opus−Sonnet differential.
 * - Claims: every turn of a lookup agent in a fired workspace, all five components, raw = the
 *   cell, fraction 0.5, counterfactual = the Sonnet (sonnet-4 tier) price of that component
 *   (freshest pricing_snapshots row, else list price). value = tokens × max(0, turn price −
 *   Sonnet price); a priced cell worth $0 is not claimed; an unpriced turn is worth 0.
 * - Ledger scope: the ledger bills every non-provisional turn (no Explore/Plan exclusion), so no
 *   turn is out of scope (`outOfLedgerScope` stays 0).
 * - standalone = Σ round(T × 0.5) × net. residual (with --others) = Σ min(round(T × 0.5),
 *   T − others) × net, where `others` is the tokens higher-priority spend claims own in that
 *   cell. `--others` is the JSON from `l5-ledger-cells.ts` (the ledger WITHOUT D4); only its
 *   per-cell token counts are read, the D4 math here stays independent.
 * - cardEstimate = the detector's figure: all lookup turns priced at the freshest opus-tier
 *   snapshot, × 0.5 (differs from the ledger on opus-5-5 turns, which the ledger prices at
 *   their own snapshot).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import Database from "better-sqlite3";

// Mirrors of src constants; a drift here is a finding, not a fix.
const FRACTION = 0.5; // D4_REALIZABLE_AVOIDANCE_FRACTION
const MIN_CONTEXT = 50_000;
const MAX_OUTPUT = 500;
const MIN_TURNS = 5;
const MIN_SHARE = 0.4;
const SONNET_LIST = [3, 15, 0.3, 3.75, 6]; // LIST_PRICES["sonnet-4"]
const OPUS_LIST = [5, 25, 0.5, 6.25, 10]; // LIST_PRICES.opus
const COMPONENTS = ["input", "output", "cacheRead", "cw5m", "cw1h"] as const;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i] ?? "", argv[i + 1] ?? "");
  const db = args.get("--db");
  if (!db)
    throw new Error("Usage: l5-d4-oracle.ts --db <path> [--from ISO --to ISO] [--others <json>]");
  const to = new Date(args.get("--to") ?? Date.now());
  const from = new Date(args.get("--from") ?? to.getTime() - 7 * 86_400_000);
  return { db, fromIso: from.toISOString(), toIso: to.toISOString(), others: args.get("--others") };
}

function recId(detector: string, scopeWs: string | null, scopeKey: string): string {
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  return `rec-${detector}-${scopeWs ?? "global"}-${hash}`;
}

interface Turn {
  message_id: string;
  session_id: string;
  workspace_id: string;
  agent_key: string;
  context_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
  in_ledger: number;
}

const { db: dbPath, fromIso, toIso, others: othersPath } = parseArgs(process.argv);
const db = new Database(dbPath, { readonly: true });

function tierPrices(tier: string, fallback: number[]): number[] {
  const row = db
    .prepare(
      "SELECT unit_prices_json FROM pricing_snapshots WHERE model_tier = ? ORDER BY stale_after DESC LIMIT 1",
    )
    .get(tier) as { unit_prices_json: string } | undefined;
  if (!row) return fallback;
  const p = JSON.parse(row.unit_prices_json) as number[];
  return [0, 1, 2, 3, 4].map((i) => p[i] ?? 0);
}
const sonnet = tierPrices("sonnet-4", SONNET_LIST);
const opusTier = tierPrices("opus", OPUS_LIST);

/** Five µ$/token prices, or null when unpriced (mirrors the ledger's validity rule). */
function turnPrices(t: Turn): number[] | null {
  if (t.unit_prices_json === null) return null;
  try {
    const p = JSON.parse(t.unit_prices_json) as unknown;
    if (
      Array.isArray(p) &&
      p.length === 5 &&
      p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
    )
      return p as number[];
  } catch {
    /* unpriced */
  }
  return null;
}

const turns = db
  .prepare(
    `SELECT t.message_id, t.session_id, t.workspace_id, t.context_tokens,
            COALESCE(t.agent_id, 'session:' || t.session_id) AS agent_key,
            t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, ps.unit_prices_json,
            1 AS in_ledger
       FROM turns t LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
      WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0
        AND t.is_sidechain = 1 AND t.model LIKE '%opus%'`,
  )
  .all(fromIso, toIso) as Turn[];

// Group by workspace → agent.
const byWs = new Map<string, Map<string, Turn[]>>();
for (const t of turns) {
  const agents = byWs.get(t.workspace_id) ?? new Map<string, Turn[]>();
  byWs.set(t.workspace_id, agents);
  const list = agents.get(t.agent_key) ?? [];
  list.push(t);
  agents.set(t.agent_key, list);
}

const others: Record<string, number> = othersPath
  ? (JSON.parse(fs.readFileSync(othersPath, "utf8")) as { cells: Record<string, number> }).cells
  : {};

interface RecTotals {
  workspace: string;
  totalOpusTurns: number;
  lookupTurns: number;
  share: number;
  claimTurns: number;
  outOfLedgerScope: number;
  unpricedTurns: number;
  claims: number;
  standaloneTokens: number;
  standalone_u: number;
  residualTokens: number;
  residual_u: number;
  /** Σ standalone − residual over turns where any higher-priority claim owns a cell. */
  touchedTurns: number;
  untouchedStandalone_u: number;
  untouchedResidual_u: number;
  cardEstimate_u: number;
}
const byRec: Record<string, RecTotals> = {};
const notFired: Record<string, { totalOpusTurns: number; lookupTurns: number; share: number }> =
  {};

for (const [ws, agents] of byWs) {
  const total = [...agents.values()].reduce((s, l) => s + l.length, 0);
  const lookup = [...agents.values()].filter((l) =>
    l.every((t) => t.context_tokens >= MIN_CONTEXT && t.output_tokens <= MAX_OUTPUT),
  );
  const lookupTurns = lookup.flat();
  const share = total > 0 ? lookupTurns.length / total : 0;
  const n = lookupTurns.length;
  const avgIn = n ? Math.round(lookupTurns.reduce((s, t) => s + t.input_tokens, 0) / n) : 0;
  const avgOut = n ? Math.round(lookupTurns.reduce((s, t) => s + t.output_tokens, 0) / n) : 0;
  const headline = avgIn * (opusTier[0]! - sonnet[0]!) + avgOut * (opusTier[1]! - sonnet[1]!);
  if (total < MIN_TURNS || n === 0 || share < MIN_SHARE || !(headline > 0)) {
    notFired[ws] = { totalOpusTurns: total, lookupTurns: n, share: Number(share.toFixed(4)) };
    continue;
  }
  const rec = recId("D4", ws, `D4|${ws}`);
  const r: RecTotals = {
    workspace: ws,
    totalOpusTurns: total,
    lookupTurns: n,
    share: Number(share.toFixed(4)),
    claimTurns: 0,
    outOfLedgerScope: 0,
    unpricedTurns: 0,
    claims: 0,
    standaloneTokens: 0,
    standalone_u: 0,
    residualTokens: 0,
    residual_u: 0,
    touchedTurns: 0,
    untouchedStandalone_u: 0,
    untouchedResidual_u: 0,
    cardEstimate_u: 0,
  };
  byRec[rec] = r;
  for (const t of lookupTurns) {
    const cells = [
      t.input_tokens,
      t.output_tokens,
      t.cache_read_tokens,
      t.cache_write_5m,
      t.cache_write_1h,
    ];
    cells.forEach((T, i) => {
      r.cardEstimate_u += T * (opusTier[i]! - sonnet[i]!) * FRACTION;
    });
    if (!t.in_ledger) {
      r.outOfLedgerScope += 1;
      continue;
    }
    r.claimTurns += 1;
    const p = turnPrices(t);
    if (p === null) r.unpricedTurns += 1;
    const tk = `${t.session_id}|${t.message_id}`;
    let touched = false;
    let turnStandalone = 0;
    let turnResidual = 0;
    cells.forEach((T, i) => {
      if (T <= 0) return;
      const requested = Math.round(T * FRACTION);
      if (requested <= 0) return;
      const net = p === null ? 0 : Math.max(0, p[i]! - sonnet[i]!);
      if (p !== null && net === 0) return; // the ledger rejects a $0 reprice on a priced turn
      const owned = others[JSON.stringify([tk, COMPONENTS[i]])] ?? 0;
      if (owned > 0) touched = true;
      const residual = Math.max(0, Math.min(requested, T - owned));
      r.claims += 1;
      r.standaloneTokens += requested;
      r.residualTokens += residual;
      turnStandalone += requested * net;
      turnResidual += residual * net;
    });
    r.standalone_u += turnStandalone;
    r.residual_u += turnResidual;
    if (touched) r.touchedTurns += 1;
    else {
      r.untouchedStandalone_u += turnStandalone;
      r.untouchedResidual_u += turnResidual;
    }
  }
}

const $ = (u: number) => Number((u / 1e6).toFixed(4));
console.log(
  JSON.stringify(
    {
      window: { fromIso, toIso },
      sonnetPricesU: sonnet,
      opusTierPricesU: opusTier,
      othersFile: othersPath ?? null,
      byRec: Object.fromEntries(
        Object.entries(byRec).map(([rec, r]) => [
          rec,
          {
            ...r,
            standaloneUsd: $(r.standalone_u),
            residualUsd: $(r.residual_u),
            cardEstimateUsd: $(r.cardEstimate_u),
          },
        ]),
      ),
      notFired,
    },
    null,
    2,
  ),
);
