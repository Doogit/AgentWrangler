/**
 * A2 BACKGROUND_AGENT_TRANSCRIPT_BLOAT_V2 headline oracle, written only from the amended dh-contracts.md A2 card.
 * Graded on the card's NET ledger headline ("Headline (net)" steps 1-6):
 *  - results: TaskOutput, ts in [now-7d, now), 10240 < bytes <= 25600, owner turn in the SAME session, main chain, settled;
 *    processed (ts, event_id); raw = round((bytes - 10240) / bpt), skipped when <= 0 (bpt = user_config else 2.7);
 *  - chain = owner's (session, sidechain 0, agent NULL) turns with ts strictly after the result; stops at a verified
 *    compact boundary after the result, a context collapse (prev > 50000 and this < 0.5 x prev), or after 75 later turns;
 *  - first later turn only: write claim split by its own 5m/1h mix (no move to the next turn when it is unsettled or
 *    out of window); other later turns: cache-read claim; only settled in-window turns can be claimed;
 *  - raw clamped to billed minus raw already claimed by A2 on the cell; then PER CLAIM requested = round(raw x 0.5),
 *    tokens = min(requested, billed - tokens already owned), valued at that turn's own snapshot (no snapshot = $0).
 * The card exists only when the 0.1 percent spend gate passed, so the gate is recomputed here from the card's text.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_BYTES = 10240;
const MAX_BYTES = 25600;
const DEFAULT_BPT = 2.7;
const CARRY_CAP = 75;
const COLLAPSE_MIN_PREV = 50_000;
const COLLAPSE_SHARE = 0.5;
const AVOIDANCE = 0.5;
const MIN_PCT_OF_SPEND = 0.1;

interface Ev {
  event_id: string;
  ts: string;
  session_id: string;
  tool_name: string;
  result_bytes: number;
  owner_message_id: string | null;
}

interface Turn {
  message_id: string;
  ts: string;
  context_tokens: number;
  provisional: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  workspace_id: string;
  unit_prices_json: string | null;
}

type Comp = "read" | "w5" | "w1";

function prices(json: string | null): [number, number, number, number, number] | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as unknown;
    if (
      Array.isArray(p) &&
      p.length === 5 &&
      p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
    )
      return p as [number, number, number, number, number];
  } catch {
    // unusable snapshot
  }
  return null;
}

export const oracleA2: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  let bpt = DEFAULT_BPT;
  const hasUc = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_config'")
    .get();
  if (hasUc) {
    const row = db.prepare("SELECT value FROM user_config WHERE key = 'bytes_per_token'").get() as
      | { value: string | null }
      | undefined;
    const v = row?.value == null ? Number.NaN : Number(row.value);
    if (Number.isFinite(v) && v > 0) bpt = v;
  }

  const evs = db
    .prepare(
      `SELECT e.event_id, e.ts, e.session_id, e.tool_name, e.result_bytes, m.owner_message_id
       FROM tool_events e
       LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
       WHERE e.tool_name = 'TaskOutput' AND e.ts >= ? AND e.ts < ? AND e.result_bytes > ? AND e.result_bytes <= ?
       ORDER BY e.ts, e.event_id`,
    )
    .all(fromIso, toIso, MIN_BYTES, MAX_BYTES) as Ev[];

  const ownerStmt = db.prepare(
    `SELECT t.session_id, t.ts, t.workspace_id, t.provisional, t.is_sidechain, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.message_id = ?`,
  );
  const chainStmt = db.prepare(
    `SELECT t.message_id, t.ts, t.context_tokens, t.provisional, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, t.workspace_id, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.session_id = ? AND t.is_sidechain = 0 AND t.agent_id IS NULL
     ORDER BY t.ts, t.message_id`,
  );
  const boundaryStmt = db.prepare(
    `SELECT MIN(event_ts) AS ts FROM ingest_metric_events
     WHERE session_id = ? AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED'
       AND event_ts > ?`,
  );
  const spendStmt = db.prepare(
    "SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
  );

  const chains = new Map<string, Turn[]>();
  const rawUsed = new Map<string, number>(); // raw tokens A2 claimed per (turn, component)
  const owned = new Map<string, number>(); // final tokens A2 owns per (turn, component)
  const byWs = new Map<
    string,
    {
      events: number;
      bytes: number;
      tokens: number;
      value: number;
      gateCost: number;
      owners: Set<string>;
    }
  >();

  for (const ev of evs) {
    if (!ev.owner_message_id) continue;
    const owner = ownerStmt.get(ev.owner_message_id) as
      | {
          session_id: string;
          ts: string;
          workspace_id: string;
          provisional: number;
          is_sidechain: number;
          unit_prices_json: string | null;
        }
      | undefined;
    if (
      !owner ||
      owner.session_id !== ev.session_id ||
      owner.is_sidechain !== 0 ||
      owner.provisional !== 0
    )
      continue;
    const ws = owner.workspace_id;
    const w = byWs.get(ws) ?? {
      events: 0,
      bytes: 0,
      tokens: 0,
      value: 0,
      gateCost: 0,
      owners: new Set<string>(),
    };
    byWs.set(ws, w);
    w.events++;
    w.bytes += ev.result_bytes;

    let chain = chains.get(ev.session_id);
    if (!chain) {
      chain = chainStmt.all(ev.session_id) as Turn[];
      chains.set(ev.session_id, chain);
    }
    const bound = (boundaryStmt.get(ev.session_id, ev.ts) as { ts: string | null }).ts;
    const startIdx = chain.findIndex((t) => t.ts > ev.ts);
    const later: Turn[] = [];
    if (startIdx >= 0) {
      for (let i = startIdx; i < chain.length && later.length < CARRY_CAP; i++) {
        const t = chain[i] as Turn;
        const prev = i > 0 ? (chain[i - 1] as Turn) : null;
        if (bound !== null && t.ts >= bound) break;
        if (
          prev &&
          prev.context_tokens > COLLAPSE_MIN_PREV &&
          t.context_tokens < COLLAPSE_SHARE * prev.context_tokens
        )
          break;
        later.push(t);
      }
    }

    // Spend gate input: full result_bytes / bpt at the owner's write price + read price x (carry - 1), no 0.5.
    const op = prices(owner.unit_prices_json);
    if (op && later.length > 0) {
      w.gateCost += (ev.result_bytes / bpt) * (op[3] + op[2] * (later.length - 1));
    }

    const raw = Math.round((ev.result_bytes - MIN_BYTES) / bpt);
    if (raw <= 0 || later.length === 0) continue;

    const claim = (t: Turn, comp: Comp, tokens: number): void => {
      if (tokens <= 0) return;
      if (t.provisional !== 0 || t.ts < fromIso || t.ts >= toIso) return;
      const billed =
        comp === "read" ? t.cache_read_tokens : comp === "w5" ? t.cache_write_5m : t.cache_write_1h;
      const key = `${t.message_id}|${comp}`;
      const rawClaim = Math.min(tokens, Math.max(0, billed - (rawUsed.get(key) ?? 0)));
      if (rawClaim <= 0) return;
      rawUsed.set(key, (rawUsed.get(key) ?? 0) + rawClaim);
      const requested = Math.round(rawClaim * AVOIDANCE);
      const final = Math.min(requested, Math.max(0, billed - (owned.get(key) ?? 0)));
      if (final <= 0) return;
      owned.set(key, (owned.get(key) ?? 0) + final);
      const p = prices(t.unit_prices_json);
      if (!p) return; // unpriced: owns its tokens, worth 0
      w.tokens += final;
      w.value += final * (comp === "read" ? p[2] : comp === "w5" ? p[3] : p[4]);
      w.owners.add(t.message_id);
    };

    const first = later[0] as Turn;
    const cw = first.cache_write_5m + first.cache_write_1h;
    const r5 = cw > 0 ? Math.round((raw * first.cache_write_5m) / cw) : raw;
    claim(first, "w5", r5);
    claim(first, "w1", raw - r5);
    for (const t of later.slice(1)) claim(t, "read", raw);
  }

  const findings: OracleFinding[] = [];
  const turnsChecked = new Set<string>();
  for (const [ws, w] of byWs) {
    const spend = (spendStmt.get(ws, fromIso, toIso) as { s: number }).s;
    const gatePasses = spend > 0 && (w.gateCost / spend) * 100 >= MIN_PCT_OF_SPEND;
    if (!gatePasses) continue;
    for (const o of w.owners) turnsChecked.add(o);
    const headline = Math.round(w.value);
    findings.push({
      scope: { workspace_id: ws, key: `A2|${ws}` },
      quantities: [
        { name: "task_output_results", unit: "events", value: w.events },
        { name: "total_bytes", unit: "bytes", value: w.bytes },
        { name: "claimed_tokens", unit: "tokens", value: w.tokens },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "A2_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md A2 card (ASSUMED, range 0.33 to 0.7)",
        },
        {
          name: "bytes_per_token",
          value: bpt,
          source: "dh-contracts.md A2 card (user_config calibrated ratio when present, else 2.7)",
        },
        {
          name: "no_competing_claims",
          value: 1,
          source:
            "dh-contracts.md A2 card: D1/D10/A1 above A2 assumed to take nothing (0.00 percent cut measured)",
        },
        {
          name: "no_cross_family_cut_below",
          value: 1,
          source: "dh-contracts.md A2 card: D7/D12/D6/D2/D8/B1/B3/D4/D9 only get what A2 leaves",
        },
        {
          name: "chain_cap_collapse_boundary",
          value: CARRY_CAP,
          source:
            "dh-contracts.md A2 card step 3 (75 later turns, context collapse 50000/0.5, verified compact boundary)",
        },
        {
          name: "spend_gate_pct",
          value: MIN_PCT_OF_SPEND,
          source:
            "dh-contracts.md A2 card (card exists only if gate passed; gate uses full bytes/bpt at owner write + read x (carry-1))",
        },
      ],
      modeled_u: headline,
      count: w.events,
    });
  }
  return {
    findings,
    turns_checked: [...turnsChecked],
    note: `A2: ${evs.length} TaskOutput results in (10240, 25600] in window across ${byWs.size} workspaces; competing claims not modelled`,
  };
};
