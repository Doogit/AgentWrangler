/**
 * D11 TOOL_ERROR_RATE reliability oracle. Written ONLY from the dh-contracts.md D11 card and Appendices S0, S2, S3.
 * No imports from src/**. Graded figure "reliability": the card headline is Math.round(main ?? 0), the full
 * snapshot-priced cost of the RECOVERY turns after the worse shell's shell-level ERROR calls on main-chain turns.
 * Subagent-chain errors only feed the separate "in subagents" figure and are not graded here.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_CALLS = 50;
const MIN_HIGHER_ERRORS = 3;
const RATE_RATIO = 1.5;
const MIN_RUN = 3;
const ERROR_GAP_MS = 120_000;

// Appendix S3 rules 17, 18, 26, 27, 11 (verbatim).
const SHELL_FAILURE =
  /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|: command not found|bad substitution|is not recognized as the name of a cmdlet|^ParserError:|CategoryInfo\s*:\s*ParserError|Unexpected token .* in expression or statement|The string is missing the terminator|is not a valid statement separator|An empty pipe element is not allowed|Missing expression after/im;
const RAN = /^Exit code \d+/;
const GUARD_BLOCK = /^PreToolUse:\S+ hook error\b/;
const BRIDGE = /^mcp__.*(browser|chrome|playwright)/i;
const NOT_READ = /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i;

interface Ev {
  id: string;
  session: string;
  ws: string;
  ts: string;
  tool: string;
  exit: string | null;
  bi: number;
  owner: string;
  inputHash: string | null;
  resultBytes: number | null;
  command: string | null;
  error: string | null;
  sidechain: number;
  provisional: number;
  turnTs: string;
}

const norm = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, " ").toLowerCase();
  return t === "" ? null : t;
};

/** S2: owner turns removed from candidacy as repeat-excess (signals 1, 2, 5; signals 3 and 4 not modelled). */
function repeatExcessTurns(chain: Ev[]): Set<string> {
  const out = new Set<string>();
  const text = (e: Ev) => norm(e.command ?? e.error) ?? e.inputHash;
  const eligible = (e: Ev) => {
    if (e.error !== null && GUARD_BLOCK.test(e.error)) return false;
    // F30: a shell error without "Exit code N" never ran (a guard's own deny text, a denial).
    if (e.error !== null && (e.tool === "Bash" || e.tool === "PowerShell") && !RAN.test(e.error))
      return false;
    if (
      e.exit !== "ERROR" &&
      (["Monitor", "TaskOutput", "BashOutput"].includes(e.tool) || BRIDGE.test(e.tool))
    )
      return false;
    if (e.tool === "Edit" && e.error !== null && NOT_READ.test(e.error)) return false;
    return true;
  };
  const key = (e: Ev) =>
    `${e.tool.length}:${e.tool}${text(e) ?? ""}${e.tool === "Read" && e.resultBytes !== null ? `#${e.resultBytes}` : ""}`;
  const excessFrom = (run: Ev[]) => {
    const first = run[0] as Ev;
    const k = run.findIndex((e) => e.owner !== first.owner);
    if (k < 0) return;
    for (const e of run.slice(k)) out.add(e.owner);
  };
  const distinctMsgs = (run: Ev[]) => new Set(run.map((e) => e.owner)).size;
  // Split into maximal runs of eligible events; ineligible events are hard boundaries.
  let seg: Ev[] = [];
  const flush = () => {
    // signal 1: same key
    let run: Ev[] = [];
    const end1 = () => {
      if (run.length > 0 && distinctMsgs(run) >= MIN_RUN) excessFrom(run);
      run = [];
    };
    for (const e of seg) {
      if (run.length > 0 && key(run[0] as Ev) === key(e)) run.push(e);
      else {
        end1();
        run = [e];
      }
    }
    end1();
    // signal 2: consecutive TEST_FAIL, any tool
    let tf: Ev[] = [];
    const end2 = () => {
      if (tf.length >= MIN_RUN) for (const e of tf.slice(1)) out.add(e.owner);
      tf = [];
    };
    for (const e of seg) {
      if (e.exit === "TEST_FAIL") tf.push(e);
      else end2();
    }
    end2();
    // signal 5: consecutive ERROR, same tool, same text, each within 120 s of previous
    let er: Ev[] = [];
    const end5 = () => {
      if (er.length > 0 && distinctMsgs(er) >= MIN_RUN) excessFrom(er);
      er = [];
    };
    for (const e of seg) {
      const prev = er[er.length - 1];
      if (
        e.exit === "ERROR" &&
        prev &&
        prev.tool === e.tool &&
        text(prev) === text(e) &&
        Date.parse(e.ts) - Date.parse(prev.ts) <= ERROR_GAP_MS
      )
        er.push(e);
      else {
        end5();
        if (e.exit === "ERROR") er = [e];
      }
    }
    end5();
    seg = [];
  };
  for (const e of chain) {
    if (eligible(e)) seg.push(e);
    else flush();
  }
  flush();
  return out;
}

function recoveryValue(db: Database.Database, messageId: string): number {
  const r = db
    .prepare(
      `SELECT t.input_tokens i, t.output_tokens o, t.cache_read_tokens cr, t.cache_write_5m w5, t.cache_write_1h w1,
              p.unit_prices_json pj
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.message_id = ?`,
    )
    .get(messageId) as
    | { i: number; o: number; cr: number; w5: number; w1: number; pj: string | null }
    | undefined;
  if (!r || !r.pj) return 0;
  let p: unknown;
  try {
    p = JSON.parse(r.pj);
  } catch {
    return 0;
  }
  if (
    !Array.isArray(p) ||
    p.length !== 5 ||
    !p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
  )
    return 0;
  // $/MTok == µ$/token. cache_write_other is NOT claimed (S0 item 6).
  const [pi, po, pr, p5, p1] = p as number[] as [number, number, number, number, number];
  return r.i * pi + r.o * po + r.cr * pr + r.w5 * p5 + r.w1 * p1;
}

export const oracleD11: Oracle = (db, now) => {
  const startIso = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, s.workspace_id ws, e.ts ts, e.tool_name tool, e.exit_class exit,
              m.block_index bi, m.owner_message_id owner, e.input_hash inputHash, e.result_bytes resultBytes,
              json_extract(c.content_json, '$.command') command, json_extract(c.content_json, '$.error') error,
              t.is_sidechain sidechain, t.provisional provisional, t.ts turnTs
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
       LEFT JOIN tool_event_content c ON c.event_id = e.event_id
       LEFT JOIN turns t ON t.message_id = m.owner_message_id
       WHERE e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED'
       ORDER BY s.workspace_id, e.session_id, e.ts, m.block_index, e.event_id`,
    )
    .all(startIso, nowIso) as Ev[];

  // Counted shell calls per workspace (main and subagent pooled): d11Outcome.
  interface Shell {
    calls: number;
    errors: number;
    errEvents: Ev[];
  }
  const byWs = new Map<string, { Bash: Shell; PowerShell: Shell }>();
  for (const e of rows) {
    if (e.tool !== "Bash" && e.tool !== "PowerShell") continue;
    if (e.error !== null && !RAN.test(e.error)) continue; // never ran: excluded
    const g = byWs.get(e.ws) ?? {
      Bash: { calls: 0, errors: 0, errEvents: [] },
      PowerShell: { calls: 0, errors: 0, errEvents: [] },
    };
    const sh = g[e.tool];
    sh.calls++;
    if (e.exit === "ERROR" && e.error !== null && SHELL_FAILURE.test(e.error)) {
      sh.errors++;
      sh.errEvents.push(e);
    }
    byWs.set(e.ws, g);
  }

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, g] of [...byWs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (g.Bash.calls < MIN_CALLS || g.PowerShell.calls < MIN_CALLS) continue;
    const rB = g.Bash.errors / g.Bash.calls;
    const rP = g.PowerShell.errors / g.PowerShell.calls;
    const worse = rP > rB ? g.PowerShell : g.Bash;
    const rW = Math.max(rB, rP);
    const rO = Math.min(rB, rP);
    if (worse.errors < MIN_HIGHER_ERRORS) continue;
    if (rO === 0 ? !(rW > 0) : rW / rO < RATE_RATIO) continue;

    // Main-chain census for D7 pre-exclusion, per session.
    const sessions = new Set(worse.errEvents.map((e) => e.session));
    const excluded = new Set<string>();
    for (const sid of sessions) {
      const chain = rows.filter(
        (e) => e.session === sid && e.owner !== null && e.sidechain === 0 && e.provisional === 0,
      );
      for (const o of repeatExcessTurns(chain)) excluded.add(o);
    }

    // Issuing turns: main-chain, settled, owner present, not D7-excluded. Recovery = next settled main turn.
    const recovery = new Set<string>();
    let subagentErrors = 0;
    for (const e of worse.errEvents) {
      if (e.owner === null || e.provisional === null) continue;
      if (e.sidechain === 1) {
        subagentErrors++;
        continue;
      }
      if (e.provisional !== 0 || excluded.has(e.owner)) continue;
      const r = db
        .prepare(
          `SELECT message_id id, ts FROM turns
           WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?
           ORDER BY ts, message_id LIMIT 1`,
        )
        .get(e.session, e.turnTs) as { id: string; ts: string } | undefined;
      if (!r || r.ts < startIso || r.ts >= nowIso) continue;
      recovery.add(r.id);
      checked.push(e.owner, r.id);
    }
    let sum = 0;
    for (const id of recovery) sum += recoveryValue(db, id);
    const main = Math.round(sum);
    findings.push({
      scope: { workspace_id: ws, key: `D11|tool-error-rate|${ws}` },
      quantities: [
        { name: "bash_calls", unit: "events", value: g.Bash.calls },
        { name: "powershell_calls", unit: "events", value: g.PowerShell.calls },
        { name: "bash_errors", unit: "events", value: g.Bash.errors },
        { name: "powershell_errors", unit: "events", value: g.PowerShell.errors },
        { name: "worse_shell_subagent_errors", unit: "events", value: subagentErrors },
        { name: "recovery_turns", unit: "turns", value: recovery.size },
      ],
      measured_u: main,
      assumptions: [
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md Appendix S0 item 7 (reviewer f9bdb7b3)",
        },
        {
          name: "D7 pre-exclusion models signals 1, 2, 5 only (not same-region reads, three-gram)",
          value: 0,
          source: "dh-contracts.md Appendix S2",
        },
        {
          name: "calls/errors count only RECONCILED sessions, window by tool_events.ts, main and subagent pooled",
          value: 0,
          source: "dh-contracts.md D11 card Trigger",
        },
        {
          name: "headline is the main-chain figure Math.round(main ?? 0); subagent part not graded",
          value: 0,
          source: "dh-contracts.md D11 card Card quantity 1",
        },
      ],
      modeled_u: main,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note: `D11: ${findings.length} qualifying workspace(s). Reliability $ = full snapshot-priced recovery turn (next settled main-chain turn, in window) after each worse-shell shell-level ERROR call on a main-chain turn, distinct turns summed.`,
  };
};
