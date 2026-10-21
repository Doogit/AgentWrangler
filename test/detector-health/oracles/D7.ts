/**
 * D7 LOOP_RETRY_WASTE oracle, both lanes, written ONLY from the dh-contracts.md D7 card (+ Appendix S2/S3 and the
 * A2 card steps 3-5 it points to). No imports from src/**.
 *
 *  - Loop lane (card "Card quantity (loop finding, repeat excess)"): per workspace, round(0.5 x sum of stored
 *    cost_equiv_u over the distinct owner turns holding >= 1 repeat-excess event); null (no finding value) when 0.
 *    Graded as figure "modeled" (the loop card has no headline).
 *  - XREAD lane (card "Headline (net, XREAD card only)"): per workspace, round(sum of ledger claim values) over the
 *    redundant re-reads (each non-origin session's first read of a qualifying identity), ledger rounding PER CLAIM.
 *    Graded as figure "headline".
 *
 * `oracleD7` returns both lanes' findings (keys `D7|<ws>` and `D7-XREAD|<ws>`); `oracleD7Loop` / `oracleD7Xread`
 * return one lane each so a lane can be graded against its own card row.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding, OracleResult } from "./types.js";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const BYTES_CAP = 25_600; // A1_RESULT_BYTES_THRESHOLD: result_bytes > cap is ineligible
const FRACTION = 0.5; // D7_AVOIDANCE_FRACTION (ASSUMED)
const COVERAGE_FLOOR = 0.8;
const MAX_GAP_MS = 120_000;
const MIN_READS = 10;
const MIN_SESSIONS = 2;
const MAX_SESSION_SHARE = 0.8;
const MIN_PCT_OF_SPEND = 0.1;
const ROW_CAP = 500;
const DEFAULT_BPT = 2.7;
const CARRY_CAP = 75;
const COLLAPSE_MIN_PREV = 50_000;
const COLLAPSE_SHARE = 0.5;

// Appendix S3 rules 25-27.
const HOOK_BLOCK = /^PreToolUse:\S+ hook error\b/;
// F30: a shell error without "Exit code N" never ran (a guard's own deny text, a denial, a rejection).
const SHELL_RAN = /^\s*Exit code -?\d+/;
const POLL_OR_BRIDGE = /^mcp__.*(browser|chrome|playwright)/i;
const POLL_TOOLS = new Set(["Monitor", "TaskOutput", "BashOutput"]);
const norm = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, " ").toLowerCase();
  return t === "" ? null : t;
};

function prices5(json: string | null): number[] | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as unknown;
    if (
      Array.isArray(p) &&
      p.length === 5 &&
      p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
    )
      return p as number[];
  } catch {
    /* unusable snapshot */
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Loop lane
// ---------------------------------------------------------------------------------------------------------------

interface LoopRow {
  id: string;
  session: string;
  ts: string;
  tool: string;
  stored_hash: string | null;
  exit: string | null;
  rbytes: number | null;
  tec: string | null;
  bi: number;
  fp: string | null;
  owner: string;
  ws: string;
  side: number;
  agent: string | null;
  cost: number | null;
  cmd: string | null;
  err: string | null;
}

interface Ev {
  id: string;
  tms: number;
  tool: string;
  ih: string | null;
  exit: string | null;
  rbytes: number | null;
  fp: string | null;
  owner: string;
  elig: boolean;
  key: string | null;
}

function toEv(r: LoopRow): Ev {
  const ih = norm(r.cmd ?? r.err) ?? r.stored_hash;
  const guard =
    r.err !== null &&
    (HOOK_BLOCK.test(r.err) ||
      ((r.tool === "Bash" || r.tool === "PowerShell") && !SHELL_RAN.test(r.err)));
  const poll = r.exit !== "ERROR" && (POLL_TOOLS.has(r.tool) || POLL_OR_BRIDGE.test(r.tool));
  const notRead = r.tool === "Edit" && r.tec === "NOT_READ";
  const tooBig = r.rbytes !== null && r.rbytes > BYTES_CAP;
  const elig = !(guard || poll || notRead || tooBig);
  let key: string | null = null;
  if (elig) {
    key = `${r.tool.length}:${r.tool}${ih ?? ""}`;
    if (r.tool.toLowerCase() === "read" && r.rbytes !== null) key += `#${r.rbytes}`;
  }
  return {
    id: r.id,
    tms: Date.parse(r.ts),
    tool: r.tool,
    ih,
    exit: r.exit,
    rbytes: r.rbytes,
    fp: r.fp,
    owner: r.owner,
    elig,
    key,
  };
}

/** Repeat-excess event ids in one context (S2 with the card's size rule; signal 5 only when covered). */
function excessEvents(evs: Ev[], covered: boolean): Set<string> {
  const out = new Set<string>();
  const excessFromFirstNewMessage = (run: Ev[]): void => {
    if (new Set(run.map((e) => e.owner)).size < 3) return;
    for (let i = 1; i < run.length; i++)
      if ((run[i] as Ev).owner !== (run[i - 1] as Ev).owner) {
        for (let j = i; j < run.length; j++) out.add((run[j] as Ev).id);
        return;
      }
  };

  // 1. Identical-call run.
  let run: Ev[] = [];
  for (const e of evs) {
    if (e.elig && e.key !== null && run.length > 0 && (run[0] as Ev).key === e.key) run.push(e);
    else {
      excessFromFirstNewMessage(run);
      run = e.elig && e.key !== null ? [e] : [];
    }
  }
  excessFromFirstNewMessage(run);

  // 2. Test-fail run (>= 3 events, not collapsed by message).
  run = [];
  const flushTest = (): void => {
    if (run.length >= 3) for (let i = 1; i < run.length; i++) out.add((run[i] as Ev).id);
  };
  for (const e of evs) {
    if (e.elig && e.exit === "TEST_FAIL") run.push(e);
    else {
      flushTest();
      run = [];
    }
  }
  flushTest();

  // 3. Same-region reads (Edit/Write on the path closes its groups; an ineligible event closes all).
  interface Grp {
    reads: Ev[];
    size: number | null;
    path: string;
  }
  const groups = new Map<string, Grp>();
  const finalize = (g: Grp): void => {
    if (g.reads.length >= 3)
      for (let i = 1; i < g.reads.length; i++) out.add((g.reads[i] as Ev).id);
  };
  const closeAll = (): void => {
    for (const g of groups.values()) finalize(g);
    groups.clear();
  };
  for (const e of evs) {
    if (!e.elig) {
      closeAll();
      continue;
    }
    if (e.tool.toLowerCase() === "read" && e.fp !== null && e.ih !== null) {
      const k = `${e.fp}\u0000${e.ih}`;
      const g = groups.get(k);
      if (g && g.size !== e.rbytes) {
        finalize(g);
        groups.set(k, { reads: [e], size: e.rbytes, path: e.fp });
      } else if (g) g.reads.push(e);
      else groups.set(k, { reads: [e], size: e.rbytes, path: e.fp });
    } else if ((e.tool === "Edit" || e.tool === "Write") && e.fp !== null) {
      for (const [k, g] of [...groups]) {
        if (g.path === e.fp) {
          finalize(g);
          groups.delete(k);
        }
      }
    }
  }
  closeAll();

  // 4. Three-gram loop over maximal segments of non-null keys; excess = everything after the first triple.
  let s0 = 0;
  while (s0 < evs.length) {
    if ((evs[s0] as Ev).key === null) {
      s0++;
      continue;
    }
    let e0 = s0;
    while (e0 < evs.length && (evs[e0] as Ev).key !== null) e0++;
    const k = evs.slice(s0, e0).map((e) => e.key as string);
    let s = 0;
    while (s + 8 < k.length) {
      let L = 0;
      while (s + L + 3 < k.length && k[s + L] === k[s + L + 3]) L++;
      const total = L + 3;
      const allSame = k[s] === k[s + 1] && k[s + 1] === k[s + 2];
      if (Math.floor(total / 3) >= 3 && !allSame) {
        for (let i = s + 3; i < s + total; i++) out.add((evs[s0 + i] as Ev).id);
        s += total;
      } else s++;
    }
    s0 = e0;
  }

  // 5. Error run: same tool, identical normalised text, each within 120 s of the previous; covered sessions only.
  if (covered) {
    run = [];
    for (const e of evs) {
      const prev = run[run.length - 1];
      if (
        e.elig &&
        e.exit === "ERROR" &&
        prev !== undefined &&
        prev.tool === e.tool &&
        prev.ih === e.ih &&
        e.tms - prev.tms <= MAX_GAP_MS
      )
        run.push(e);
      else {
        excessFromFirstNewMessage(run);
        run = e.elig && e.exit === "ERROR" ? [e] : [];
      }
    }
    excessFromFirstNewMessage(run);
  }
  return out;
}

function loopLane(
  db: Database.Database,
  now: Date,
): { findings: OracleFinding[]; checked: string[] } {
  const startIso = new Date(now.getTime() - WEEK_MS).toISOString();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, e.tool_name tool, e.input_hash stored_hash,
              e.exit_class exit, e.result_bytes rbytes, e.tool_error_class tec,
              m.block_index bi, m.file_path_hash fp, m.owner_message_id owner,
              t.workspace_id ws, t.is_sidechain side, t.agent_id agent, t.cost_equiv_u cost,
              json_extract(c.content_json, '$.command') cmd, json_extract(c.content_json, '$.error') err
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       LEFT JOIN tool_event_content c ON c.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED' AND t.provisional = 0
         AND t.session_id = e.session_id AND t.workspace_id = s.workspace_id
         AND t.ts >= ? AND t.ts < ?
       ORDER BY t.workspace_id, e.session_id, e.ts, m.block_index, e.event_id`,
    )
    .all(startIso, nowIso, startIso, nowIso) as LoopRow[];

  // Per-session owner-turn coverage (signal 5 floor): covered events / all in-window tool events of the session.
  const totals = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT e.session_id s, COUNT(*) n FROM tool_events e
       JOIN sessions ss ON ss.session_id = e.session_id
       WHERE e.ts >= ? AND e.ts < ? AND ss.state = 'RECONCILED' GROUP BY e.session_id`,
    )
    .all(startIso, nowIso) as Array<{ s: string; n: number }>)
    totals.set(r.s, r.n);
  const covCount = new Map<string, number>();
  const groupsMap = new Map<string, LoopRow[]>();
  for (const r of rows) {
    covCount.set(r.session, (covCount.get(r.session) ?? 0) + 1);
    const g = `${r.session}\u0000${r.side ? (r.agent ?? "") : ""}\u0000${r.side}`;
    const l = groupsMap.get(g) ?? [];
    l.push(r);
    groupsMap.set(g, l);
  }

  // Excess owner turns, per workspace; each distinct turn once.
  const turnsByWs = new Map<string, Map<string, number | null>>();
  const excessEventsByWs = new Map<string, number>();
  for (const list of groupsMap.values()) {
    const first = list[0] as LoopRow;
    const covered =
      (covCount.get(first.session) ?? 0) /
        (totals.get(first.session) ?? Number.POSITIVE_INFINITY) >=
      COVERAGE_FLOOR;
    const ex = excessEvents(list.map(toEv), covered);
    if (ex.size === 0) continue;
    const turns = turnsByWs.get(first.ws) ?? new Map<string, number | null>();
    for (const r of list)
      if (ex.has(r.id)) {
        turns.set(r.owner, r.cost);
        excessEventsByWs.set(first.ws, (excessEventsByWs.get(first.ws) ?? 0) + 1);
      }
    turnsByWs.set(first.ws, turns);
  }

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, turns] of [...turnsByWs].sort((a, b) => a[0].localeCompare(b[0]))) {
    let sum = 0;
    for (const [id, c] of turns) {
      sum += c ?? 0;
      checked.push(id);
    }
    const value = sum > 0 ? Math.round(FRACTION * sum) : null;
    findings.push({
      scope: { workspace_id: ws, key: `D7|${ws}` },
      quantities: [
        { name: "repeat_excess_events", unit: "events", value: excessEventsByWs.get(ws) ?? 0 },
        { name: "repeat_excess_owner_turns", unit: "turns", value: turns.size },
      ],
      measured_u: sum > 0 ? sum : null,
      assumptions: [
        {
          name: "D7_AVOIDANCE_FRACTION",
          value: FRACTION,
          source: "dh-contracts.md D7 card (ASSUMED)",
        },
        {
          name: "NO_CROSS_FAMILY_CUT",
          value: 0,
          source: "loop card is not on the ledger; standalone estimate, no ownership cut",
        },
      ],
      // null when the summed cost is 0: the card shows no figure, graded as absent.
      modeled_u: value,
    });
  }
  return { findings, checked };
}

// ---------------------------------------------------------------------------------------------------------------
// XREAD lane
// ---------------------------------------------------------------------------------------------------------------

interface ReadRow {
  id: string;
  session: string;
  ts: string;
  ih: string | null;
  rb: number | null;
  ws: string;
  fp: string;
  owner: string | null;
}

interface ChainTurn {
  id: string;
  ts: string;
  ctx: number;
  provisional: number;
  read: number;
  w5: number;
  w1: number;
  prices: number[] | null;
}

type Comp = "read" | "w5" | "w1";

function bytesPerToken(db: Database.Database): number {
  try {
    const r = db.prepare("SELECT value FROM user_config WHERE key = 'bytes_per_token'").get() as
      | { value: string | null }
      | undefined;
    const v = r?.value == null ? Number.NaN : Number(r.value);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_BPT;
  } catch {
    return DEFAULT_BPT;
  }
}

function xreadLane(
  db: Database.Database,
  now: Date,
  applyGate = true,
): { findings: OracleFinding[]; checked: string[] } {
  const fromIso = new Date(now.getTime() - WEEK_MS).toISOString();
  const toIso = now.toISOString();
  const bpt = bytesPerToken(db);

  // (1) qualifying read identities.
  const reads = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, e.input_hash ih, e.result_bytes rb,
              s.workspace_id ws, m.file_path_hash fp, m.owner_message_id owner
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       WHERE e.tool_name = 'Read' AND s.state = 'RECONCILED' AND e.ts >= ? AND e.ts < ?
         AND m.file_path_hash IS NOT NULL AND COALESCE(e.result_bytes, 0) <= ?
       ORDER BY e.ts, e.event_id`,
    )
    .all(fromIso, toIso, BYTES_CAP) as ReadRow[];
  const edited = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT e.session_id s, m.file_path_hash fp FROM tool_events e
       JOIN sessions ss ON ss.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       WHERE e.tool_name IN ('Edit','MultiEdit','Write','NotebookEdit') AND ss.state = 'RECONCILED'
         AND e.ts >= ? AND e.ts < ? AND m.file_path_hash IS NOT NULL`,
    )
    .all(fromIso, toIso) as Array<{ s: string; fp: string }>)
    edited.add(`${r.s}\u0000${r.fp}`);

  interface Ident {
    ws: string;
    rows: ReadRow[];
    bySession: Map<string, ReadRow[]>;
    totalBytes: number;
  }
  const idents = new Map<string, Ident>();
  for (const r of reads) {
    if (edited.has(`${r.session}\u0000${r.fp}`)) continue;
    const k = `${r.ws}\u0000${r.fp}\u0000${r.ih ?? ""}\u0000${r.rb ?? ""}`;
    let g = idents.get(k);
    if (!g) {
      g = { ws: r.ws, rows: [], bySession: new Map(), totalBytes: 0 };
      idents.set(k, g);
    }
    g.rows.push(r);
    const sl = g.bySession.get(r.session) ?? [];
    sl.push(r);
    g.bySession.set(r.session, sl);
  }
  const qualifying = [...idents.values()]
    .filter((g) => {
      const total = g.rows.length;
      const busiest = Math.max(...[...g.bySession.values()].map((l) => l.length));
      return (
        total >= MIN_READS &&
        g.bySession.size >= MIN_SESSIONS &&
        busiest / total <= MAX_SESSION_SHARE
      );
    })
    .map((g) => {
      // sum over sessions of the session's average read size (identical size within an identity).
      let tb = 0;
      for (const l of g.bySession.values()) tb += l.reduce((s, r) => s + (r.rb ?? 0), 0) / l.length;
      g.totalBytes = tb;
      return g;
    })
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, ROW_CAP);

  // (2) redundant re-reads: every non-origin session's first read of an identity, fed in (ts, event_id) order.
  const redundant: ReadRow[] = [];
  for (const g of qualifying) {
    const firsts = [...g.bySession.values()]
      .map((l) => l[0] as ReadRow) // rows are already in (ts, event_id) order
      .sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
    for (const f of firsts.slice(1)) redundant.push(f);
  }
  redundant.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));

  // Chains, boundaries, spend.
  const ownerStmt = db.prepare(
    "SELECT session_id, is_sidechain, agent_id FROM turns WHERE message_id = ?",
  );
  const chainStmt = db.prepare(
    `SELECT t.message_id id, t.ts, t.context_tokens ctx, t.provisional, t.cache_read_tokens "read",
            t.cache_write_5m w5, t.cache_write_1h w1, p.unit_prices_json pj
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.session_id = ? AND t.is_sidechain = ? AND ((? IS NULL AND t.agent_id IS NULL) OR t.agent_id = ?)
     ORDER BY t.ts, t.message_id`,
  );
  const boundaryStmt = db.prepare(
    `SELECT MIN(event_ts) AS ts FROM ingest_metric_events
     WHERE session_id = ? AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED'
       AND event_ts > ?`,
  );
  const spendStmt = db.prepare(
    "SELECT COALESCE(SUM(cost_equiv_u), 0) s FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ? AND provisional = 0",
  );
  const chains = new Map<string, Array<ChainTurn>>();

  const used = new Map<string, number>(); // raw tokens claimed per (turn, component)
  const usedFinal = new Map<string, number>(); // final (post-0.5) tokens per (turn, component)
  interface Acc {
    value: number;
    tokens: number;
    claims: number;
    gateCost: number;
    redundant: number;
    owners: Set<string>;
  }
  const byWs = new Map<string, Acc>();

  for (const ev of redundant) {
    const w = byWs.get(ev.ws) ?? {
      value: 0,
      tokens: 0,
      claims: 0,
      gateCost: 0,
      redundant: 0,
      owners: new Set<string>(),
    };
    byWs.set(ev.ws, w);
    w.redundant++;
    if (!ev.owner) continue;
    const owner = ownerStmt.get(ev.owner) as
      | { session_id: string; is_sidechain: number; agent_id: string | null }
      | undefined;
    if (!owner) continue;
    const raw = Math.round((ev.rb ?? 0) / bpt);
    if (raw <= 0) continue;
    const agent = owner.is_sidechain ? owner.agent_id : null;
    const ck = `${owner.session_id}|${owner.is_sidechain}|${agent ?? ""}`;
    let chain = chains.get(ck);
    if (!chain) {
      chain = (
        chainStmt.all(owner.session_id, owner.is_sidechain, agent, agent) as Array<{
          id: string;
          ts: string;
          ctx: number;
          provisional: number;
          read: number;
          w5: number;
          w1: number;
          pj: string | null;
        }>
      ).map((t) => ({
        id: t.id,
        ts: t.ts,
        ctx: t.ctx,
        provisional: t.provisional,
        read: t.read,
        w5: t.w5,
        w1: t.w1,
        prices: prices5(t.pj),
      }));
      chains.set(ck, chain);
    }
    const bound = (boundaryStmt.get(owner.session_id, ev.ts) as { ts: string | null }).ts;
    const startIdx = chain.findIndex((t) => t.ts > ev.ts);
    if (startIdx < 0) continue;
    const later: ChainTurn[] = [];
    for (let i = startIdx; i < chain.length && later.length < CARRY_CAP; i++) {
      const t = chain[i] as ChainTurn;
      const prev = i > 0 ? (chain[i - 1] as ChainTurn) : null;
      if (bound !== null && t.ts >= bound) break;
      if (prev && prev.ctx > COLLAPSE_MIN_PREV && t.ctx < COLLAPSE_SHARE * prev.ctx) break;
      later.push(t);
    }
    if (later.length === 0) continue;

    // Card gate cost (no caps, no 0.5): result tokens x (owner 5m write + owner read x (carry - 1)).
    const ownerTurn = chain.find((t) => t.id === ev.owner);
    if (ownerTurn?.prices) {
      const [, , pr, pw5] = ownerTurn.prices as [number, number, number, number, number];
      w.gateCost += ((ev.rb ?? 0) / bpt) * (pw5 + pr * (later.length - 1));
    }

    const claim = (t: ChainTurn, comp: Comp, tokens: number): void => {
      if (tokens <= 0) return;
      if (t.provisional !== 0 || t.ts < fromIso || t.ts >= toIso) return;
      const billed = comp === "read" ? t.read : comp === "w5" ? t.w5 : t.w1;
      const key = `${t.id}|${comp}`;
      const rawClaim = Math.min(tokens, Math.max(0, billed - (used.get(key) ?? 0)));
      used.set(key, (used.get(key) ?? 0) + rawClaim);
      const frac = Math.min(
        Math.round(rawClaim * FRACTION),
        Math.max(0, billed - (usedFinal.get(key) ?? 0)),
      );
      if (frac <= 0) return;
      usedFinal.set(key, (usedFinal.get(key) ?? 0) + frac);
      if (!t.prices) return; // tokens owned, worth 0
      const [, , pr, pw5, pw1] = t.prices as [number, number, number, number, number];
      w.tokens += frac;
      w.claims++;
      w.value += frac * (comp === "read" ? pr : comp === "w5" ? pw5 : pw1);
      w.owners.add(t.id);
    };

    const firstLater = later[0] as ChainTurn;
    const cw = firstLater.w5 + firstLater.w1;
    if (cw > 0) {
      const r5 = Math.round((raw * firstLater.w5) / cw);
      claim(firstLater, "w5", r5);
      claim(firstLater, "w1", raw - r5);
    }
    for (const t of later.slice(1)) claim(t, "read", raw);
  }

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, w] of [...byWs].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Card gate: carry cost >= 0.1% of workspace spend; an unpriceable cost (or no spend to compare) keeps the card.
    const spend = (spendStmt.get(ws, fromIso, toIso) as { s: number }).s;
    const gatePct = spend > 0 ? (w.gateCost / spend) * 100 : null;
    if (applyGate && w.gateCost > 0 && gatePct !== null && gatePct < MIN_PCT_OF_SPEND) continue;
    for (const o of w.owners) checked.push(o);
    const headline = Math.round(w.value);
    findings.push({
      scope: { workspace_id: ws, key: `D7-XREAD|${ws}` },
      quantities: [
        { name: "gate_pct_x1000", unit: "count", value: Math.round((gatePct ?? -1) * 1000) },
        { name: "redundant_rereads", unit: "events", value: w.redundant },
        { name: "claimed_tokens", unit: "tokens", value: w.tokens },
        { name: "ledger_claims", unit: "count", value: w.claims },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "D7_AVOIDANCE_FRACTION",
          value: FRACTION,
          source: "dh-contracts.md D7 card (ASSUMED)",
        },
        {
          name: "BYTES_PER_TOKEN",
          value: bpt,
          source: "user_config bytes_per_token when valid, else 2.7 (card)",
        },
        {
          name: "NO_COMPETING_CLAIMS",
          value: 0,
          source:
            "dh-contracts.md D7 card Headline assumptions: D1, D10, A1, A2 sit above D7; measured 0.00% cut live; oracle assumes none within +/-3%",
        },
        {
          name: "ROW_CAP_GLOBAL",
          value: ROW_CAP,
          source:
            "top-500 identity cap applied across all workspaces (card does not say per workspace)",
        },
      ],
      modeled_u: headline,
    });
  }
  return { findings, checked };
}

// ---------------------------------------------------------------------------------------------------------------

function result(findings: OracleFinding[], checked: string[], note: string): OracleResult {
  return { findings, turns_checked: [...new Set(checked)], note };
}

export const oracleD7Loop: Oracle = (db, now) => {
  const l = loopLane(db, now);
  return result(
    l.findings,
    l.checked,
    "D7 loop lane: repeat-excess (S2 + size/poll/browser/guard/NOT_READ ineligibility, signal 5 at >=0.8 coverage), 0.5 x stored owner-turn cost",
  );
};

export const oracleD7Xread: Oracle = (db, now) => {
  const x = xreadLane(db, now);
  return result(
    x.findings,
    x.checked,
    "D7 XREAD lane: redundant re-reads (non-origin sessions' first read of >=10-read, >=2-session identities), per-claim ledger rounding, own-snapshot prices",
  );
};

/** Diagnostic only: the claim producer's view (no 0.1% card gate), to compare with ledger-level measurements. */
export const oracleD7XreadUngated: Oracle = (db, now) => {
  const x = xreadLane(db, now, false);
  return result(
    x.findings,
    x.checked,
    "D7 XREAD lane without the card's 0.1% spend gate (claim producer view)",
  );
};

export const oracleD7: Oracle = (db, now) => {
  const l = loopLane(db, now);
  const x = xreadLane(db, now);
  return result(
    [...l.findings, ...x.findings],
    [...l.checked, ...x.checked],
    "D7 both lanes (keys D7|ws = loop modeled figure, D7-XREAD|ws = XREAD headline)",
  );
};
