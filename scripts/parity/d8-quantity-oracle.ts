/**
 * Independent C1 quantity oracle for D8 (CACHE_WRITE_CHURN). Read-only. Written from the documented rules
 * (.claude/audits/certification/p3-cache/2026-09-25-engine-fixes.md + -rq4.md), NOT from the detector code.
 *
 * Rules re-implemented here:
 *  - Thread = (session_id, is_sidechain, agent_id). Gaps are measured to the previous turn of the SAME thread
 *    (the previous turn may lie before the rec window).
 *  - TTL for a gap = the thread's prior cache-write tier: 1h -> 60 min, 5m -> 5 min; no prior write: main 60 / sub 5.
 *  - D8 counts gaps LONGER than the TTL (gaps <= TTL are B1's). D8 counts main-thread turns only.
 *  - Churn event: creation (5m+1h+other) >= 50k, cache_read < 0.2 x creation, gap > TTL. (RQ4 "D8 definition".)
 *  - Base prefix = median full context of the first main-thread turn of each session that STARTS in the window
 *    (resumed sessions have no fresh prefix); a fresh start writes it anyway, so net = sum max(0, creation - base).
 *  - Non-provisional turns only.
 *
 * Checks:
 *  (a) Billing: for churn turns (sample <= 200) the DB cache_read / cache_write_5m / cache_write_1h equal the raw
 *      `usage` block in the Claude Code transcript JSONL. Missing files / ids are skipped, not failures.
 *  (b) Quantity: per D8 rec (own week = [facts.last_seen_week_start, +7d), scope = workspace) the recomputed event
 *      count, total creation tokens and net churn tokens equal the stored facts within +-10% (TOLERANCE).
 * Verdict: FAIL on any (a) mismatch or (b) rec outside tolerance; UNPROVEN if nothing was checked; else PASS.
 * Recs whose own week does not overlap the caller's window are not checked.
 *
 * Note: the audit doc prices churn as (write - read); the stored/real quantity subtracts the base prefix instead
 * (reads are ~0 on a churn turn by definition, so the two differ only by base vs read). Reported as `net_wr_*`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const TOLERANCE = 0.1;
const MIN_CREATION = 50_000;
const READ_RATIO = 0.2;
const WEEK_MS = 7 * 864e5;
const SAMPLE = 200;

export type Window = { from: string; to: string };
export type Usage = { read: number; w5: number; w1: number };
export type TranscriptReader = (file: string) => Map<string, Usage[]> | null;
export type Result = {
  verdict: "PASS" | "FAIL" | "UNPROVEN";
  counts: Record<string, number>;
  issues: Array<{ kind: string; detail: string }>;
};

type Turn = {
  message_id: string;
  session_id: string;
  ts: string;
  is_sidechain: number;
  agent_id: string | null;
  ctx: number;
  r: number;
  w5: number;
  w1: number;
  wo: number;
};
type Churn = { turn: Turn; creation: number };

const creationOf = (t: Turn) => t.w5 + t.w1 + t.wo;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2
    ? (s[m] as number)
    : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

/** Recompute churn events + base prefix for one workspace and week window. */
export function recompute(db: Database.Database, workspace: string, from: string, to: string) {
  const sessions = (
    db
      .prepare(
        "SELECT DISTINCT session_id FROM turns WHERE workspace_id=? AND ts>=? AND ts<? AND provisional=0",
      )
      .all(workspace, from, to) as Array<{ session_id: string }>
  ).map((r) => r.session_id);
  const events: Churn[] = [];
  const starts: number[] = [];
  const stmt = db.prepare(
    `SELECT message_id, session_id, ts, is_sidechain, agent_id, context_tokens ctx,
       cache_read_tokens r, cache_write_5m w5, cache_write_1h w1, cache_write_other wo
     FROM turns WHERE session_id=? AND provisional=0 AND ts<? ORDER BY ts, message_id`,
  );
  let longest = 0;
  for (const sid of sessions) {
    const rows = stmt.all(sid, to) as Turn[];
    const firstMain = rows.find((t) => t.is_sidechain === 0);
    if (firstMain && firstMain.ts >= from) starts.push(firstMain.ctx);
    const threads = new Map<string, Turn[]>();
    for (const t of rows) {
      if (t.is_sidechain !== 0) continue; // D8 is main-thread only
      const k = `${t.is_sidechain}|${t.agent_id ?? ""}`;
      const a = threads.get(k);
      if (a) a.push(t);
      else threads.set(k, [t]);
    }
    for (const ts of threads.values()) {
      let tier: "5m" | "1h" | null = null;
      let prev: Turn | null = null;
      for (const t of ts) {
        const cr = creationOf(t);
        if (prev && t.ts >= from) {
          const gapMin = (Date.parse(t.ts) - Date.parse(prev.ts)) / 60000;
          const ttl = tier === "5m" ? 5 : 60;
          if (cr >= MIN_CREATION && t.r < READ_RATIO * cr && gapMin > ttl) {
            events.push({ turn: t, creation: cr });
            longest = Math.max(longest, gapMin);
          }
        }
        if (t.w1 > 0 || t.w5 > 0) tier = t.w1 >= t.w5 ? "1h" : "5m";
        prev = t;
      }
    }
  }
  const base = median(starts);
  return {
    events,
    base,
    total: events.reduce((s, e) => s + e.creation, 0),
    net: events.reduce((s, e) => s + Math.max(0, e.creation - base), 0),
    netWR: events.reduce((s, e) => s + Math.max(0, e.creation - e.turn.r), 0),
    sessions: new Set(events.map((e) => e.turn.session_id)).size,
    longest,
  };
}

/** Default reader: parse a transcript JSONL into message id -> usage blocks. null = file missing. */
export const fileReader: TranscriptReader = (file) => {
  if (!fs.existsSync(file)) return null;
  const out = new Map<string, Usage[]>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("usage")) continue;
    // biome-ignore lint/suspicious/noExplicitAny: untyped transcript JSON
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    const id = o?.message?.id ?? o?.uuid;
    if (!u || typeof id !== "string") continue;
    const cc = u.cache_creation;
    const w5 = cc?.ephemeral_5m_input_tokens ?? (cc ? 0 : (u.cache_creation_input_tokens ?? 0));
    const w1 = cc?.ephemeral_1h_input_tokens ?? 0;
    const a = out.get(id) ?? [];
    a.push({ read: u.cache_read_input_tokens ?? 0, w5, w1 });
    out.set(id, a);
  }
  return out;
};

function candidateFiles(db: Database.Database, t: Turn): string[] {
  const row = db.prepare("SELECT file_path FROM sessions WHERE session_id=?").get(t.session_id) as
    | { file_path: string }
    | undefined;
  if (!row) return [];
  const files = [row.file_path];
  if (t.agent_id) {
    const dir = path.join(path.dirname(row.file_path), t.session_id, "subagents");
    files.push(path.join(dir, `agent-${t.agent_id}.jsonl`));
  }
  return files;
}

export function checkD8Quantity(
  db: Database.Database,
  window: Window,
  opts: { reader?: TranscriptReader; sample?: number } = {},
): Result {
  const reader = opts.reader ?? fileReader;
  const sampleN = opts.sample ?? SAMPLE;
  const issues: Result["issues"] = [];
  const counts = {
    recs_total: 0,
    recs_checked: 0,
    recs_skipped_window: 0,
    recs_out_of_tolerance: 0,
    churn_events: 0,
    billing_sampled: 0,
    billing_matched: 0,
    billing_mismatched: 0,
    billing_file_missing: 0,
    billing_id_not_found: 0,
    net_oracle_total: 0,
    net_stored_total: 0,
    net_wr_oracle_total: 0,
  };
  const recs = db
    .prepare(
      "SELECT rec_id, scope_workspace_id, evidence_json FROM recommendations WHERE detector_id='D8'",
    )
    .all() as Array<{ rec_id: string; scope_workspace_id: string | null; evidence_json: string }>;
  counts.recs_total = recs.length;
  const claimed: Turn[] = [];
  const wFrom = Date.parse(window.from);
  const wTo = Date.parse(window.to);
  const within = (n: number, stored: number) =>
    stored === 0 ? n === 0 : Math.abs(n - stored) / Math.abs(stored) <= TOLERANCE;

  for (const rec of recs) {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(rec.evidence_json).facts ?? {};
    } catch {
      continue;
    }
    const ws = (f.workspace_id as string) ?? rec.scope_workspace_id;
    const lsw = f.last_seen_week_start;
    if (typeof lsw !== "string" || !ws || !Number.isFinite(Date.parse(lsw))) continue;
    const rFrom = Date.parse(lsw);
    const rTo = rFrom + WEEK_MS;
    if (rTo <= wFrom || rFrom >= wTo) {
      counts.recs_skipped_window++;
      continue;
    }
    const res = recompute(db, ws, lsw, new Date(rTo).toISOString());
    counts.recs_checked++;
    counts.churn_events += res.events.length;
    counts.net_oracle_total += res.net;
    counts.net_wr_oracle_total += res.netWR;
    const storedNet = Number(f.net_churn_creation_tokens);
    counts.net_stored_total += Number.isFinite(storedNet) ? storedNet : 0;
    claimed.push(...res.events.map((e) => e.turn));
    const pairs: Array<[string, number, unknown]> = [
      ["net_churn_creation_tokens", res.net, f.net_churn_creation_tokens],
      ["total_churn_creation_tokens", res.total, f.total_churn_creation_tokens],
      ["churn_event_count", res.events.length, f.churn_event_count],
    ];
    let bad = false;
    for (const [name, mine, stored] of pairs) {
      if (typeof stored !== "number" || !within(mine, stored)) {
        bad = true;
        issues.push({
          kind: "quantity",
          detail: `${rec.rec_id} ${name}: oracle ${mine} vs stored ${String(stored)} (tol ${TOLERANCE * 100}%)`,
        });
      }
    }
    if (bad) counts.recs_out_of_tolerance++;
  }

  // (a) billing equality on up to `sampleN` claimed turns (evenly spread)
  const ordered = [...new Map(claimed.map((t) => [t.message_id, t])).values()].sort((a, b) =>
    a.ts < b.ts ? -1 : 1,
  );
  const step = Math.max(1, Math.ceil(ordered.length / sampleN));
  const sample = ordered.filter((_, i) => i % step === 0).slice(0, sampleN);
  const cache = new Map<string, Map<string, Usage[]> | null>();
  const load = (p: string) => {
    if (!cache.has(p)) cache.set(p, reader(p));
    return cache.get(p) ?? null;
  };
  for (const t of sample) {
    counts.billing_sampled++;
    let sawFile = false;
    let usages: Usage[] | undefined;
    for (const p of candidateFiles(db, t)) {
      const m = load(p);
      if (!m) continue;
      sawFile = true;
      usages = m.get(t.message_id);
      if (usages) break;
    }
    if (!sawFile) {
      counts.billing_file_missing++;
      continue;
    }
    if (!usages) {
      counts.billing_id_not_found++;
      continue;
    }
    // streamed duplicates: the final record is what is billed; accept it (or the largest) as the match
    const last = usages[usages.length - 1] as Usage;
    const ok = (u: Usage) => u.read === t.r && u.w5 === t.w5 && u.w1 === t.w1 + t.wo;
    if (ok(last) || usages.some(ok)) counts.billing_matched++;
    else {
      counts.billing_mismatched++;
      issues.push({
        kind: "billing",
        detail: `${t.message_id}: db read/5m/1h ${t.r}/${t.w5}/${t.w1} vs raw ${last.read}/${last.w5}/${last.w1}`,
      });
    }
  }

  const checked = counts.recs_checked + counts.billing_matched + counts.billing_mismatched;
  const verdict =
    counts.billing_mismatched > 0 || counts.recs_out_of_tolerance > 0
      ? "FAIL"
      : checked === 0
        ? "UNPROVEN"
        : "PASS";
  return { verdict, counts, issues };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const dbPath = arg("db");
  const from = arg("from");
  const to = arg("to");
  if (!dbPath || !from || !to) {
    console.error("usage: d8-quantity-oracle.ts --db <path> --from <iso> --to <iso>");
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  const r = checkD8Quantity(db, { from, to });
  console.log(`D8 C1 ${r.verdict} ${JSON.stringify(r.counts)}`);
  for (const i of r.issues.slice(0, 20)) console.error(`  ${i.kind}: ${i.detail}`);
  process.exit(r.verdict === "PASS" ? 0 : r.verdict === "FAIL" ? 1 : 3);
}
