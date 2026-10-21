/**
 * D7 LOOP_RETRY_WASTE silence probe (card: docs/plans/dh-contracts.md D7). Independent recount of both findings:
 * loop/retry (signals 1-5) and cross-session redundant reads (XREAD).
 * Reads base ingest rows only (tool_events, tool_event_metadata, tool_event_content text, turns, sessions).
 * No classifier columns (exit_class / tool_error_class) are read.
 */

import type Database from "better-sqlite3";
import type { ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RUN = 3;
const MIN_TRIGRAM = 3;
const MAX_GAP_MS = 120_000;
const COVERAGE_FLOOR = 0.8;
const BYTES_CAP = 25600;
const XREAD_MIN_READS = 10;
const XREAD_MIN_SESSIONS = 2;
const XREAD_MAX_SHARE = 0.8;
const XREAD_MIN_PCT = 0.1;

const POLLING = new Set(["Monitor", "TaskOutput", "BashOutput"]);
const HOOK_BLOCK = /hook (blocked|denied|error)|blocked by (a )?hook|PreToolUse|PostToolUse/i;
const NOT_READ = /has not been read|must read .* first|read it first/i;
const TEST_CMD =
  /\b(vitest|jest|pytest|mocha|phpunit|rspec|(npm|yarn|pnpm)( run)? test|cargo test|go test|dotnet test)\b/i;
const BROWSER_MCP = /^mcp__.*(chrome|browser|playwright)/i;

interface Row {
  sid: string;
  ws: string;
  ts: string;
  tool: string;
  inputHash: string | null;
  bytes: number | null;
  fh: string | null;
  block: number | null;
  covered: number;
  sidechain: number | null;
  agent: string | null;
  err: unknown;
  cmd: unknown;
  msg: string | null;
  /** The owner turn's pricing snapshot `[input, output, cacheRead, write5m, write1h]`. */
  prices: string | null;
}

interface El {
  key: string;
  failed: boolean;
  errNorm: string;
  tool: string;
  inputHash: string | null;
  tsMs: number;
  testFail: boolean;
  fh: string | null;
  write: boolean;
  readKey: string | null;
  /** Owning assistant message: calls in one message are issued before any result is seen. */
  msg: string | null;
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

interface SessionStats {
  maxRun: number; // signals 1, 2, 3 and (coverage-gated) 5
  maxTrigram: number;
  coverage: number;
}

function analyseContext(els: El[], coverageOk: boolean): { run: number; tri: number } {
  let run = 0;
  const bump = (n: number): void => {
    if (n > run) run = n;
  };
  // Signal 1: identical call repeated back to back (a later message only, as signal 5).
  let n1 = 0;
  // Signal 2: consecutive test failures.
  let n2 = 0;
  // Signal 5: consecutive failed calls, same tool, same error or input, each within 120 s. Only a
  // call in a later message (after the failure was seen) extends the run (operator 2026-10-14, F14).
  let n5 = 0;
  let prev: El | null = null;
  // Signal 3: same read region, no intervening Edit/Write to that path.
  const reads = new Map<string, Map<string, number>>(); // fh -> readKey -> count
  for (const e of els) {
    const sameMsg = prev !== null && prev.msg !== null && prev.msg === e.msg;
    n1 = prev && prev.key === e.key ? (sameMsg ? n1 : n1 + 1) : 1;
    bump(n1);
    n2 = e.testFail ? n2 + 1 : 0;
    bump(n2);
    if (e.failed) {
      const chain =
        prev?.failed &&
        prev.tool === e.tool &&
        (prev.errNorm === e.errNorm || (e.inputHash !== null && prev.inputHash === e.inputHash)) &&
        e.tsMs - prev.tsMs <= MAX_GAP_MS;
      n5 = !chain ? 1 : sameMsg ? n5 : n5 + 1;
      if (coverageOk) bump(n5);
    } else n5 = 0;
    if (e.fh !== null) {
      if (e.write) reads.delete(e.fh);
      else if (e.readKey !== null) {
        let m = reads.get(e.fh);
        if (!m) {
          m = new Map();
          reads.set(e.fh, m);
        }
        const c = (m.get(e.readKey) ?? 0) + 1;
        m.set(e.readKey, c);
        bump(c);
      }
    }
    prev = e;
  }
  // Signal 4: a three-call pattern repeated back to back.
  let tri = 0;
  for (let i = 0; i + 5 < els.length; i++) {
    let reps = 1;
    while (
      i + 3 * reps + 2 < els.length &&
      [0, 1, 2].every((o) => (els[i + o] as El).key === (els[i + 3 * reps + o] as El).key)
    )
      reps++;
    if (reps > tri) tri = reps;
  }
  return { run, tri };
}

export function probeD7(db: Database.Database, now: Date): ProbeResult {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.session_id AS sid, s.workspace_id AS ws, e.ts AS ts, e.tool_name AS tool,
              e.input_hash AS inputHash, e.result_bytes AS bytes,
              m.file_path_hash AS fh, m.block_index AS block,
              (t.message_id IS NOT NULL) AS covered, t.is_sidechain AS sidechain, t.agent_id AS agent,
              json_extract(c.content_json, '$.error') AS err,
              json_extract(c.content_json, '$.command') AS cmd, m.owner_message_id AS msg,
              (SELECT p.unit_prices_json FROM pricing_snapshots p
                WHERE p.snapshot_id = t.pricing_snapshot_id) AS prices
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
                          AND t.workspace_id = s.workspace_id AND t.provisional = 0
                          AND t.ts >= ? AND t.ts < ?
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ?
        ORDER BY e.ts, m.block_index, e.event_id`,
    )
    .all(from, to, from, to) as Row[];

  // ---- Loop/retry finding ----
  const bySession = new Map<
    string,
    { ws: string; total: number; covered: number; ctx: Map<string, El[]> }
  >();
  let brk = 0;
  for (const r of rows) {
    let s = bySession.get(r.sid);
    if (!s) {
      s = { ws: r.ws, total: 0, covered: 0, ctx: new Map() };
      bySession.set(r.sid, s);
    }
    s.total += 1;
    if (!r.covered) continue;
    s.covered += 1;
    const err = typeof r.err === "string" ? r.err : null;
    const cmd = typeof r.cmd === "string" ? r.cmd : "";
    const failed = err !== null;
    const ineligible =
      (r.bytes ?? 0) > BYTES_CAP ||
      POLLING.has(r.tool) ||
      (BROWSER_MCP.test(r.tool) && !failed) ||
      (failed && HOOK_BLOCK.test(err as string)) ||
      // F30: a shell error without "Exit code N" never ran (a guard's own deny text, a denial).
      (failed &&
        (r.tool === "Bash" || r.tool === "PowerShell") &&
        !/^\s*Exit code -?\d+/i.test(err as string)) ||
      (r.tool === "Edit" && failed && NOT_READ.test(err as string));
    const ctxKey = r.sidechain ? `sub:${r.agent ?? ""}` : "main";
    const isRead = r.tool === "Read";
    // input_hash is NULL for every Bash/PowerShell event on live data: identify those by stored
    // command text; an event with neither is unique (never "identical" to its neighbour).
    const ident = r.inputHash ?? (cmd !== "" ? `cmd:${norm(cmd)}` : `__noid${brk++}`);
    const el: El = ineligible
      ? {
          key: `__break${brk++}`,
          failed: false,
          errNorm: "",
          tool: r.tool,
          inputHash: null,
          tsMs: Date.parse(r.ts),
          testFail: false,
          fh: null,
          write: false,
          readKey: null,
          msg: r.msg,
        }
      : {
          key: `${r.tool}|${ident}${isRead ? `|${r.bytes ?? ""}` : ""}`,
          failed,
          errNorm: err === null ? "" : norm(err),
          tool: r.tool,
          inputHash: r.inputHash ?? (cmd !== "" ? ident : null),
          tsMs: Date.parse(r.ts),
          testFail:
            (r.tool === "Bash" || r.tool === "PowerShell") &&
            err !== null &&
            /^\s*Exit code -?\d+/i.test(err) &&
            TEST_CMD.test(cmd),
          fh: r.fh,
          write: r.tool === "Edit" || r.tool === "Write",
          readKey: isRead ? `${r.inputHash ?? ""}|${r.bytes ?? ""}` : null,
          msg: r.msg,
        };
    const key = `${ctxKey}`;
    const list = s.ctx.get(key) ?? [];
    list.push(el);
    s.ctx.set(key, list);
  }

  const wsLoop = new Map<string, { run: number; tri: number; coverage: number }>();
  for (const s of bySession.values()) {
    const coverage = s.total > 0 ? s.covered / s.total : 0;
    const st: SessionStats = { maxRun: 0, maxTrigram: 0, coverage };
    for (const els of s.ctx.values()) {
      const a = analyseContext(els, coverage >= COVERAGE_FLOOR);
      if (a.run > st.maxRun) st.maxRun = a.run;
      if (a.tri > st.maxTrigram) st.maxTrigram = a.tri;
    }
    const w = wsLoop.get(s.ws) ?? { run: 0, tri: 0, coverage: 0 };
    if (st.maxRun > w.run) w.run = st.maxRun;
    if (st.maxTrigram > w.tri) w.tri = st.maxTrigram;
    if (coverage > w.coverage) w.coverage = coverage;
    wsLoop.set(s.ws, w);
  }
  const loopCands = [...wsLoop.values()].filter((w) => w.run >= 2 || w.tri >= 2);
  const loopQual = loopCands.filter((w) => w.run >= MIN_RUN || w.tri >= MIN_TRIGRAM);
  const loopBest = [...loopCands].sort(
    (a, b) => Math.max(b.run, b.tri) - Math.max(a.run, a.tri),
  )[0];

  // ---- XREAD finding ----
  const edited = new Set<string>();
  for (const r of rows) {
    if ((r.tool === "Edit" || r.tool === "Write") && r.fh !== null) edited.add(`${r.sid}|${r.fh}`);
  }
  const ids = new Map<string, Map<string, number>>(); // ws|fh|input|bytes -> session -> reads
  const idWs = new Map<string, string>();
  const idReads = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.tool !== "Read" || r.fh === null || r.inputHash === null) continue;
    if ((r.bytes ?? 0) > BYTES_CAP) continue;
    if (edited.has(`${r.sid}|${r.fh}`)) continue;
    const id = `${r.ws}|${r.fh}|${r.inputHash}|${r.bytes ?? ""}`;
    let m = ids.get(id);
    if (!m) {
      m = new Map();
      ids.set(id, m);
      idWs.set(id, r.ws);
      idReads.set(id, []);
    }
    m.set(r.sid, (m.get(r.sid) ?? 0) + 1);
    idReads.get(id)?.push(r);
  }
  // Carry-cost gate, the card's chain (F16): each non-origin session's first read of the identity
  // is written once (5m write) and read on each later settled turn of its own context (main thread,
  // or the one subagent that read it), at most 75 turns, at the owner turn's snapshot prices (opus
  // list when it has none); a read with no owner turn is unpriced. No compaction cut-off, at
  // 2.7 bytes/token: still an upper bound on those two axes, so it can only qualify more.
  const opus = db
    .prepare(
      "SELECT unit_prices_json AS p FROM pricing_snapshots WHERE model_tier = 'opus' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { p: string } | undefined;
  const opusPrices = opus?.p ?? "[5,25,0.5,6.25,10]";
  const laterTurns = db.prepare(
    `SELECT count(*) AS n FROM turns WHERE session_id = ? AND ts > ? AND ts < ? AND provisional = 0
        AND is_sidechain = ? AND agent_id IS ?`,
  );
  const wsSpend = new Map<string, number>();
  for (const s of db
    .prepare(
      `SELECT workspace_id AS ws, sum(cost_equiv_u) / 1e6 AS usd FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0 GROUP BY workspace_id`,
    )
    .all(from, to) as { ws: string; usd: number | null }[])
    wsSpend.set(s.ws, s.usd ?? 0);
  const carryPct = (id: string): number | null => {
    const spend = wsSpend.get(idWs.get(id) as string) ?? 0;
    if (spend <= 0) return null;
    let usd = 0;
    const reads = idReads.get(id) ?? [];
    const seen = new Set([reads[0]?.sid]);
    for (const r of reads) {
      if (seen.has(r.sid)) continue;
      seen.add(r.sid);
      if (!r.covered) continue;
      const [, , readPrice = 0, writePrice = 0] = JSON.parse(r.prices ?? opusPrices) as number[];
      const n = (laterTurns.get(r.sid, r.ts, to, r.sidechain ? 1 : 0, r.agent) as { n: number }).n;
      const carry = Math.min(n, 75);
      if (carry > 0) usd += (((r.bytes ?? 0) / 2.7) * (writePrice + readPrice * (carry - 1))) / 1e6;
    }
    return (100 * usd) / spend;
  };
  interface X {
    ws: string;
    total: number;
    sessions: number;
    share: number;
    pct: number | null;
  }
  const xs: X[] = [];
  for (const [id, m] of ids) {
    const counts = [...m.values()];
    const total = counts.reduce((a, b) => a + b, 0);
    const vol = total >= XREAD_MIN_READS && m.size >= XREAD_MIN_SESSIONS;
    xs.push({
      ws: idWs.get(id) as string,
      total,
      sessions: m.size,
      share: Math.max(...counts) / total,
      pct: vol ? carryPct(id) : null,
    });
  }
  const xCands = xs.filter((x) => x.sessions >= 2 && x.total >= 2);
  // A null pct (no priced spend) passes: the card skips the gate only "when a cost exists".
  const xQual = xs.filter(
    (x) =>
      x.total >= XREAD_MIN_READS &&
      x.sessions >= XREAD_MIN_SESSIONS &&
      x.share <= XREAD_MAX_SHARE &&
      (x.pct === null || x.pct >= XREAD_MIN_PCT),
  );
  const xBest = [...xCands].sort((a, b) => b.total - a.total)[0];
  const xPcts = xs.filter((x) => x.pct !== null).map((x) => x.pct as number);
  const xPctBest = xPcts.length > 0 ? Math.max(...xPcts) : null;

  const gates: ProbeGate[] = [];
  if (loopBest) {
    const v = Math.max(loopBest.run, loopBest.tri);
    gates.push(
      {
        name: "MIN_RUN / MIN_TRIGRAM_REPEATS (loop signals 1-5, either)",
        value: v,
        threshold: MIN_RUN,
        op: ">=",
        pass: v >= MIN_RUN,
      },
      {
        name: "OWNER_TURN_METADATA_COVERAGE_FLOOR (needed for signal 5 only)",
        value: loopBest.coverage,
        threshold: COVERAGE_FLOOR,
        op: ">=",
        pass: loopBest.coverage >= COVERAGE_FLOOR,
      },
    );
  }
  if (xBest) {
    gates.push(
      {
        name: "MIN_CROSS_SESSION_READS",
        value: xBest.total,
        threshold: XREAD_MIN_READS,
        op: ">=",
        pass: xBest.total >= XREAD_MIN_READS,
      },
      {
        name: "XREAD sessions",
        value: xBest.sessions,
        threshold: XREAD_MIN_SESSIONS,
        op: ">=",
        pass: xBest.sessions >= XREAD_MIN_SESSIONS,
      },
      {
        name: "MAX_SESSION_SHARE",
        value: xBest.share,
        threshold: XREAD_MAX_SHARE,
        op: "<=",
        pass: xBest.share <= XREAD_MAX_SHARE,
      },
      {
        name: "D7_XREAD_MIN_PCT_OF_SPEND (upper bound, best volume-qualifying identity)",
        value: xPctBest,
        threshold: XREAD_MIN_PCT,
        op: ">=",
        pass: xPctBest === null || xPctBest >= XREAD_MIN_PCT,
      },
    );
  }
  const xQualWs = new Set(xQual.map((x) => x.ws)).size;
  const xCandWs = new Set(xCands.map((x) => x.ws)).size;
  return {
    candidates: loopCands.length + xCandWs,
    qualifying: loopQual.length + xQualWs,
    gates,
    note:
      "Counts = loop-finding workspaces + XREAD workspaces. Loop candidates: workspace with a relaxed run >=2 (or 3-call pattern x2); " +
      "qualifying: signal 1 identical call (tool+input_hash, or normalised command text when input_hash is NULL as for all live shell events; Read also result size) x3 consecutive,2 test-command failures x3 " +
      "(command text matches vitest/jest/pytest/npm test/... AND error text 'Exit code N'), 3 same Read region (input_hash+size) x3 without " +
      "Edit/Write to that path hash, 4 three-call pattern x3, 5 failed same-tool calls with same normalised error or input_hash x3 within 120 s in separate messages " +
      "(only if >=80% of the session's in-window events have a settled in-window owner turn). Contexts = main vs each subagent; " +
      "results >25600 B, Monitor/TaskOutput/BashOutput, successful browser MCP, hook-blocked, shell errors without 'Exit code N' (never ran, F30) and not-read Edit are sequence breakers. " +
      "Failed = tool_event_content $.error present (raw is_error); exit_class not read. XREAD: Read events <=25600 B, identity = " +
      "workspace+path hash+input_hash+size, sessions that edited/wrote the path drop their reads, qualifying = >=10 reads, >=2 sessions, " +
      "busiest session share <=0.8, and carry cost >=0.1% of workspace window spend on the card's chain (F16: each non-origin session's first read, " +
      "owner-turn 5m-write + cache-read on <=75 later turns of the read's own context (main or that subagent), opus list if unpriced snapshot, no owner turn = unpriced; " +
      "upper bound only on 2.7 B/token and no compaction cut-off; unpriced spend passes); " +
      "500-identity cap NOT re-derived. " +
      "A live-copy run should add a raw-JSONL is_error sample count.",
  };
}
