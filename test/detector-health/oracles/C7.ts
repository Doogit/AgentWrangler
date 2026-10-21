/**
 * C7 BASH_FAILURE_CLUSTER_V2 reliability oracle. Written ONLY from the dh-contracts.md C7 card plus Appendix S0, S2
 * and S3. No imports from src/**.
 *
 * Graded figure = reliability headline: per workspace, the FULL snapshot-priced cost of each distinct recovery turn
 * R(t) of the issuing turns t that own a failed Bash call in a qualifying cluster (>= 3 per workspace, session,
 * signature), minus turns removed by the D7 repeat-excess pre-exclusion (S2). Count = failed Bash calls in all
 * qualifying clusters of the workspace.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_FAILURES = 3;
const AVOIDANCE = 0.5;

// Appendix S3 regexes, verbatim.
const CHECK_COMMAND =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i;
const HOOK_BLOCK = /^PreToolUse:\S+ hook error\b/;
const CDP_TIMEOUT =
  /\bCDP sendCommand "[^"\n]+" timed out after \d+ms|^The "[^"\n]+" tool did not respond in time\b/;
const USER_REJECT = /^The user doesn't want to (?:proceed with this tool use|take this action)/;
const FAIL_PARSE = /^Exit code (\d+)\r?\n?([\s\S]*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const PATHS = /(?:[a-z]:|\.{1,2})?[\\/](?:[^\s\\/'"`:]+[\\/])*[^\s\\/'"`:]*/g;
const HEX = /\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/g;
const DIGITS = /\d+/g;
const POLL_OR_BRIDGE = /^mcp__.*(browser|chrome|playwright)/i;

function isBenignFailure(command: string | null, error: string | null): boolean {
  // Bash only: rule 11 (Edit/Write) and rule 10 (Artifact) do not apply; the browser-answer test is chrome tools only.
  if (
    error !== null &&
    (HOOK_BLOCK.test(error) || CDP_TIMEOUT.test(error) || USER_REJECT.test(error))
  )
    return true;
  if (command === null || error === null) return false;
  if (/^Exit code [1-9]\d*\b/.test(error) && CHECK_COMMAND.test(command)) return true;
  if (/^Exit code 128\b/.test(error) && /\btaskkill\b/i.test(command)) return true;
  if (
    /^Exit code 1\b/.test(error) &&
    /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/.test(command)
  )
    return true;
  if (error.trim() === "Exit code 1" && /\bGet-NetTCPConnection\b/i.test(command)) return true;
  return false;
}

/** Rules 19-24. Null when the error has no "Exit code N" prefix or no output line. */
function signature(error: string): string | null {
  const m = FAIL_PARSE.exec(error);
  if (!m) return null;
  const body = (m[2] ?? "").trim();
  if (!body) return null;
  const line = (body.split(/\r?\n/)[0] ?? "")
    .replace(ANSI, "")
    .toLowerCase()
    .replace(PATHS, "<path>")
    .replace(HEX, "<hex>")
    .replace(DIGITS, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return line ? `${m[1]}|${line}` : null;
}

const norm = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, " ").toLowerCase();
  return t === "" ? null : t;
};

interface Row {
  id: string;
  session: string;
  ts: string;
  tool: string;
  stored_hash: string | null;
  exit: string | null;
  rbytes: number | null;
  tec: string | null;
  fam: string | null;
  bi: number;
  fp: string | null;
  owner: string;
  ws: string;
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

function toEv(r: Row): Ev {
  const ih = norm(r.cmd ?? r.err) ?? r.stored_hash;
  const guard = r.err !== null && HOOK_BLOCK.test(r.err);
  const poll =
    r.exit !== "ERROR" &&
    (r.tool === "Monitor" ||
      r.tool === "TaskOutput" ||
      r.tool === "BashOutput" ||
      POLL_OR_BRIDGE.test(r.tool));
  const notRead = r.tool === "Edit" && r.tec === "NOT_READ";
  const elig = !(guard || poll || notRead);
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

/** Appendix S2: ids of repeat-excess events in one chain (here: one main-chain session). */
function excessEvents(evs: Ev[]): Set<string> {
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

  // 3. Same-region reads.
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

  // 4. Three-gram loop over maximal segments of non-null keys.
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

  // 5. Error run: same tool, identical normalised text, each within 120 s of the previous.
  run = [];
  for (const e of evs) {
    const prev = run[run.length - 1];
    if (
      e.elig &&
      e.exit === "ERROR" &&
      prev !== undefined &&
      prev.tool === e.tool &&
      prev.ih === e.ih &&
      e.tms - prev.tms <= 120_000
    )
      run.push(e);
    else {
      excessFromFirstNewMessage(run);
      run = e.elig && e.exit === "ERROR" ? [e] : [];
    }
  }
  excessFromFirstNewMessage(run);
  return out;
}

function snapshotPrices(json: string | null): number[] | null {
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

export const oracleC7: Oracle = (db: Database.Database, now: Date) => {
  const startIso = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, e.tool_name tool, e.input_hash stored_hash,
              e.exit_class exit, e.result_bytes rbytes, e.tool_error_class tec, e.bash_command_family fam,
              m.block_index bi, m.file_path_hash fp, m.owner_message_id owner, t.workspace_id ws,
              json_extract(c.content_json, '$.command') cmd, json_extract(c.content_json, '$.error') err
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       LEFT JOIN tool_event_content c ON c.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED' AND t.provisional = 0 AND t.is_sidechain = 0
       ORDER BY t.workspace_id, e.session_id, e.ts, m.block_index, e.event_id`,
    )
    .all(startIso, nowIso) as Row[];

  // Cluster the failed Bash calls per (workspace, session, signature).
  const clusters = new Map<string, { ws: string; session: string; evs: Row[] }>();
  const bySession = new Map<string, Row[]>();
  for (const r of rows) {
    const sl = bySession.get(r.session) ?? [];
    sl.push(r);
    bySession.set(r.session, sl);
    if (r.tool !== "Bash" || r.exit !== "ERROR" || r.err === null) continue;
    if (isBenignFailure(r.cmd, r.err)) continue;
    const sig = signature(r.err);
    if (sig === null) continue;
    const k = `${r.ws}\u0000${r.session}\u0000${sig}`;
    const c = clusters.get(k) ?? { ws: r.ws, session: r.session, evs: [] };
    c.evs.push(r);
    clusters.set(k, c);
  }

  interface WsAcc {
    failures: number;
    clusters: number;
    sessions: Set<string>;
    issuing: Map<string, string>; // issuing turn -> session
  }
  const byWs = new Map<string, WsAcc>();
  const excessBySession = new Map<string, Set<string>>();
  for (const c of clusters.values()) {
    if (c.evs.length < MIN_FAILURES) continue;
    const w = byWs.get(c.ws) ?? {
      failures: 0,
      clusters: 0,
      sessions: new Set(),
      issuing: new Map(),
    };
    w.failures += c.evs.length;
    w.clusters++;
    w.sessions.add(c.session);
    let ex = excessBySession.get(c.session);
    if (!ex) {
      ex = excessEvents((bySession.get(c.session) as Row[]).map(toEv));
      excessBySession.set(c.session, ex);
    }
    const owners = new Map((bySession.get(c.session) as Row[]).map((r) => [r.id, r.owner]));
    const excludedTurns = new Set([...ex].map((id) => owners.get(id) as string));
    for (const e of c.evs) if (!excludedTurns.has(e.owner)) w.issuing.set(e.owner, c.session);
    byWs.set(c.ws, w);
  }

  const turnStmt = db.prepare(
    `SELECT t.message_id id, t.ts ts, t.cost_equiv_u cost, t.input_tokens i, t.output_tokens o, t.cache_read_tokens cr,
            t.cache_write_5m w5, t.cache_write_1h w1, p.unit_prices_json prices
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id WHERE t.message_id = ?`,
  );
  const recStmt = db.prepare(
    `SELECT message_id id FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );
  type TurnRow = {
    id: string;
    ts: string;
    cost: number | null;
    i: number;
    o: number;
    cr: number;
    w5: number;
    w1: number;
    prices: string | null;
  };

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, w] of [...byWs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const recovery = new Set<string>();
    for (const [tid, session] of w.issuing) {
      const t = turnStmt.get(tid) as TurnRow | undefined;
      if (!t) continue;
      checked.push(tid);
      const r = recStmt.get(session, t.ts) as { id: string } | undefined;
      if (!r) continue;
      const rt = turnStmt.get(r.id) as TurnRow;
      if (rt.ts >= startIso && rt.ts < nowIso) recovery.add(r.id);
    }
    let sum = 0;
    for (const id of recovery) {
      checked.push(id);
      const t = turnStmt.get(id) as TurnRow;
      const p = snapshotPrices(t.prices);
      if (!p) continue;
      sum +=
        (t.i > 0 ? t.i * (p[0] as number) : 0) +
        (t.o > 0 ? t.o * (p[1] as number) : 0) +
        (t.cr > 0 ? t.cr * (p[2] as number) : 0) +
        (t.w5 > 0 ? t.w5 * (p[3] as number) : 0) +
        (t.w1 > 0 ? t.w1 * (p[4] as number) : 0);
    }
    const headline = Math.round(sum);
    findings.push({
      scope: { workspace_id: ws, key: `C7|${ws}` },
      quantities: [
        { name: "bash_failures", unit: "events", value: w.failures },
        { name: "clusters", unit: "count", value: w.clusters },
        { name: "sessions", unit: "sessions", value: w.sessions.size },
        { name: "issuing_turns", unit: "turns", value: w.issuing.size },
        { name: "recovery_turns", unit: "turns", value: recovery.size },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "wasted-turn avoidance fraction (modelled share only; NOT applied to the reliability headline)",
          value: AVOIDANCE,
          source: "dh-contracts.md C7 card, thresholds table",
        },
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md S0 item 7 (reviewer f9bdb7b3)",
        },
        {
          name: "D7 census stream = all in-window events of reconciled main-chain settled turns, per session",
          value: 1,
          source: "dh-contracts.md Appendix S2 (census event set not spelled out)",
        },
      ],
      modeled_u: headline,
      count: w.failures,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note: `C7: ${clusters.size} Bash signature groups, ${findings.length} workspaces with a cluster of >=${MIN_FAILURES}; headline = full snapshot-priced recovery turns (first later settled main-chain turn of the session, in window), after D7 pre-exclusion; modeled 0.5 share not applied.`,
  };
};
