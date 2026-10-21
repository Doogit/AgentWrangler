/**
 * D14 INTERRUPT_CANCEL_CLASSIFICATION_V2 reliability oracle, from the dh-contracts.md D14 card and Appendix S0/S2/S3 only.
 * Card headline: reliability $/wk (upper bound) per (workspace, session, interrupt kind). Issuing events are the
 * qualifying interrupts; the priced turn is the RECOVERY turn of the event's owner turn (first settled main-chain
 * turn of the session after it), claimed in FULL at the snapshot component prices (cache_write_other not claimed).
 * Count (secondary) = qualifying events in the group.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const GOOD_INTERRUPT_MAX_TURNS = 2;
const AVOIDANCE = 0.5;

interface Ev {
  id: string;
  session: string;
  ts: string;
  kind: string;
  ws: string;
  owner: string;
  owner_ts: string;
}

interface Turn {
  message_id: string;
  ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}

/** Full-price claim of one turn at its own snapshot, or 0 when the snapshot is missing/malformed (S0 item 6). */
function claimU(t: Turn): number {
  if (!t.unit_prices_json) return 0;
  let p: unknown;
  try {
    p = JSON.parse(t.unit_prices_json);
  } catch {
    return 0;
  }
  if (!Array.isArray(p) || p.length < 5) return 0;
  const prices = p.slice(0, 5) as unknown[];
  if (!prices.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return 0;
  const [pin, pout, pread, pw5, pw1] = prices as number[];
  const toks = [
    t.input_tokens,
    t.output_tokens,
    t.cache_read_tokens,
    t.cache_write_5m,
    t.cache_write_1h,
  ];
  const pr = [pin, pout, pread, pw5, pw1] as number[];
  let sum = 0;
  for (let i = 0; i < 5; i++)
    if ((toks[i] as number) > 0) sum += (toks[i] as number) * (pr[i] as number);
  return sum; // unit prices are µ$ per token == $/MTok
}

export const oracleD14: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const events = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, e.interrupt_kind kind, s.workspace_id ws,
              m.owner_message_id owner, t.ts owner_ts
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       LEFT JOIN tool_event_content c ON c.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ?
         AND e.interrupt_kind IN ('PURE_INTERRUPT','KILLED_NO_PROMPT')
         AND e.interrupt_classifier_version = 'interrupt-1'
         AND s.state = 'RECONCILED'
         AND t.is_sidechain = 0 AND t.provisional = 0
         AND COALESCE(json_extract(c.content_json, '$.error'), '') NOT LIKE '[Tool call interrupted: the session ended%'
       ORDER BY e.session_id, e.ts, e.event_id`,
    )
    .all(from, to) as Ev[];

  const mainTurns = db.prepare(
    `SELECT t.message_id, t.ts, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.session_id = ? AND t.is_sidechain = 0 AND t.provisional = 0
     ORDER BY t.ts, t.message_id`,
  );
  const prompts = db.prepare(
    `SELECT user_turn_ts ts FROM ingest_metric_events
     WHERE session_id = ? AND is_user_turn = 1 AND is_interrupt = 0 AND is_compact_summary = 0
       AND user_turn_ts IS NOT NULL
     ORDER BY user_turn_ts`,
  );

  const bySession = new Map<string, Ev[]>();
  for (const e of events) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);

  interface Group {
    ws: string;
    session: string;
    kind: string;
    n: number;
    sumU: number;
  }
  const groups = new Map<string, Group>();
  const checked: string[] = [];
  let goodInterrupts = 0;

  for (const [sid, evs] of bySession) {
    const turns = mainTurns.all(sid) as Turn[];
    const userTs = (prompts.all(sid) as Array<{ ts: string }>).map((r) => r.ts);
    // recovery turn id -> (kind -> issuing events behind it), plus which event owner turns reached it
    const behind = new Map<string, Map<string, number>>();
    const kept: Array<{ e: Ev; recovery: Turn | null }> = [];

    for (const e of evs) {
      // Good interrupt: next user prompt after the call with <= 2 main settled turns between.
      const prompt = userTs.find((u) => u > e.ts);
      if (prompt !== undefined) {
        const between = turns.filter(
          (t) => t.message_id !== e.owner && t.ts > e.ts && t.ts < prompt,
        ).length;
        if (between <= GOOD_INTERRUPT_MAX_TURNS) {
          goodInterrupts++;
          continue;
        }
      }
      // Recovery turn: first settled main turn after the owner turn, ordered (ts, message_id).
      const recovery =
        turns.find(
          (t) =>
            t.message_id !== e.owner &&
            (t.ts > e.owner_ts || (t.ts === e.owner_ts && t.message_id > e.owner)),
        ) ?? null;
      kept.push({ e, recovery });
      if (recovery) {
        const m = behind.get(recovery.message_id) ?? new Map<string, number>();
        m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
        behind.set(recovery.message_id, m);
      }
    }

    // Each recovery turn is priced once, by the kind with most events behind it (ties: lowest rec key).
    const owningKind = new Map<string, string>();
    for (const [rid, m] of behind) {
      const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best) owningKind.set(rid, best[0]);
    }

    const priced = new Set<string>();
    for (const { e, recovery } of kept) {
      const key = `${e.ws}|${sid}|${e.kind}`;
      const g = groups.get(key) ?? { ws: e.ws, session: sid, kind: e.kind, n: 0, sumU: 0 };
      g.n++;
      if (
        recovery &&
        recovery.ts >= from &&
        recovery.ts < to &&
        owningKind.get(recovery.message_id) === e.kind &&
        !priced.has(recovery.message_id)
      ) {
        priced.add(recovery.message_id);
        g.sumU += claimU(recovery);
        checked.push(recovery.message_id);
      }
      groups.set(key, g);
    }
  }

  const findings: OracleFinding[] = [...groups.values()]
    .sort((a, b) => `${a.ws}${a.session}${a.kind}`.localeCompare(`${b.ws}${b.session}${b.kind}`))
    .map((g) => {
      const u = Math.round(g.sumU);
      return {
        scope: { workspace_id: g.ws, key: `D14|${g.ws}|${g.session}|${g.kind}` },
        quantities: [{ name: "interrupt_events", unit: "events" as const, value: g.n }],
        measured_u: u,
        // Reliability figure: full recovery-turn cost, upper bound; the card's x0.5 applies only to the modeled rank value.
        assumptions: [
          {
            name: "wasted-turn avoidance fraction (modelled share, not applied to reliability)",
            value: AVOIDANCE,
            source: "dh-contracts.md D14 card, wasted-turn avoidance fraction",
          },
        ],
        modeled_u: u,
        count: g.n,
      };
    });

  return {
    findings,
    turns_checked: checked,
    note: `D14: ${events.length} candidate interrupt events (interrupt-1, RECONCILED, main settled owner, not session-end) in window; ${goodInterrupts} dropped as good interrupts; ${findings.length} groups. $ = full snapshot-priced recovery turn (cache_write_other not claimed), one owner per recovery turn. No cross-family ownership cut (0 measured live).`,
  };
};
