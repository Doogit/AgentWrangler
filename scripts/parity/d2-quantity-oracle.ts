/**
 * Independent C1 quantity oracle for D2 (SESSION_LONG_FULL_CONTEXT). Read-only. Written from the documented rules,
 * not from the detector's code.
 *
 * Rules used (docs: spec-rec-trust-certification D2 row, spec-rec-trust C1, audit-A-measurement, contracts.ts):
 *  - Quantity: "weekly cache-read spend in qualifying long-context sessions" (cache-read TOKENS compared here).
 *  - Qualifying session: main-thread turns (is_sidechain = 0) in [from, to): more than 150 turns AND average
 *    context_tokens above 180,000. Sidechain turns are excluded.
 *  - Base prefix: median context_tokens of each session's first main-thread turn in the window. Compared too.
 *  - Per-rec window: the rec's own facts.last_seen_week_start + 7 days when stored, else the caller's window.
 *  - Scope: recs with scope_workspace_id restrict to that workspace; null = global.
 *  - ASSUMED constants (D2_CALLS_PER_SPLIT, D2_SUMMARY_TOKENS, 0.33-style fractions) are NOT validated.
 *
 * Tolerances: qualifying-session set must match EXACTLY; token quantity and base prefix within +/-10% per rec.
 * Billing equality (a): sampled DB turns must equal the raw transcript usage block EXACTLY (input, cache read,
 * cache write total, and the 5m/1h split when the transcript carries one).
 *
 * Verdict: FAIL on any (a) mismatch or (b) disagreement; UNPROVEN if nothing could be checked; else PASS.
 * Exit codes: 0 PASS, 1 FAIL, 3 UNPROVEN, 2 usage.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export interface D2OracleResult {
  verdict: "PASS" | "FAIL" | "UNPROVEN";
  counts: Record<string, number>;
  issues: Array<{ kind: string; detail: string }>;
}

const MIN_TURNS = 150;
const MIN_AVG_CONTEXT = 180_000;
const TOLERANCE = 0.1;
const SAMPLE_MAX = 200;
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface TurnRow {
  message_id: string;
  session_id: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function qualifying(db: Database.Database, from: string, to: string, workspace: string | null) {
  const ws = workspace ? "AND workspace_id = @ws" : "";
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) n, AVG(context_tokens) avg_ctx, SUM(cache_read_tokens) cr
         FROM turns WHERE is_sidechain = 0 AND ts >= @from AND ts < @to ${ws}
         GROUP BY session_id HAVING n > ${MIN_TURNS} AND avg_ctx > ${MIN_AVG_CONTEXT}`,
    )
    .all({ from, to, ws: workspace }) as Array<{ session_id: string; n: number; cr: number }>;
  return rows;
}

function basePrefix(
  db: Database.Database,
  from: string,
  to: string,
  workspace: string | null,
): number | null {
  const ws = workspace ? "AND workspace_id = @ws" : "";
  const rows = db
    .prepare(
      `SELECT t.context_tokens c FROM turns t WHERE t.is_sidechain = 0 AND t.ts >= @from AND t.ts < @to ${ws.replace("workspace_id", "t.workspace_id")}
         AND t.message_id = (SELECT x.message_id FROM turns x WHERE x.session_id = t.session_id AND x.is_sidechain = 0
                              AND x.ts >= @from AND x.ts < @to ORDER BY x.ts, x.message_id LIMIT 1)`,
    )
    .all({ from, to, ws: workspace }) as Array<{ c: number }>;
  return rows.length ? median(rows.map((r) => r.c)) : null;
}

function transcriptCandidates(
  sessionId: string,
  workspaceId: string,
  filePath: string | null,
): string[] {
  const out: string[] = [];
  if (filePath) {
    const norm = filePath.replace(/\\/g, "/");
    const dir = norm.replace(/\/[^/]*$/, "").replace(/\/[^/]+\/subagents$/, "");
    if (path.posix.basename(norm) === `${sessionId}.jsonl`) out.push(norm);
    out.push(`${dir}/${sessionId}.jsonl`);
  }
  out.push(path.join(os.homedir(), ".claude", "projects", workspaceId, `${sessionId}.jsonl`));
  return out;
}

interface RawUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  w5m: number | null;
  w1h: number | null;
}

function loadRaw(file: string): Map<string, RawUsage> {
  const map = new Map<string, RawUsage>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (!u || o.type !== "assistant") continue;
    const cc = u.cache_creation;
    const raw: RawUsage = {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      w5m: cc ? (cc.ephemeral_5m_input_tokens ?? 0) : null,
      w1h: cc ? (cc.ephemeral_1h_input_tokens ?? 0) : null,
    };
    // Streaming repeats the same message id; the last one carries the final usage.
    if (o.message.id) map.set(o.message.id, raw);
    if (o.uuid) map.set(o.uuid, raw);
  }
  return map;
}

function parseJson(s: unknown): any {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}

export function checkD2Quantity(
  db: Database.Database,
  window: { from: string; to: string },
): D2OracleResult {
  const issues: D2OracleResult["issues"] = [];
  const counts = {
    recs: 0,
    sessions_recomputed: 0,
    set_checks: 0,
    set_mismatch: 0,
    quantity_checks: 0,
    quantity_mismatch: 0,
    base_checks: 0,
    base_mismatch: 0,
    turns_sampled: 0,
    raw_matched: 0,
    raw_mismatched: 0,
    raw_file_missing: 0,
  };

  const recs = db
    .prepare(
      `SELECT rec_id, scope_workspace_id, evidence_json FROM recommendations WHERE detector_id = 'D2'`,
    )
    .all() as Array<{ rec_id: string; scope_workspace_id: string | null; evidence_json: string }>;
  counts.recs = recs.length;

  const sessionSet = new Map<string, string>(); // session_id -> workspace_id (for part (a))

  // (b) quantity recompute per rec
  for (const rec of recs) {
    const facts = parseJson(rec.evidence_json)?.facts;
    if (!facts) {
      issues.push({ kind: "evidence-unreadable", detail: rec.rec_id });
      continue;
    }
    let from = window.from;
    let to = window.to;
    if (
      typeof facts.last_seen_week_start === "string" &&
      !Number.isNaN(Date.parse(facts.last_seen_week_start))
    ) {
      from = new Date(Date.parse(facts.last_seen_week_start)).toISOString();
      to = new Date(Date.parse(facts.last_seen_week_start) + WEEK_MS).toISOString();
    }
    const q = qualifying(db, from, to, rec.scope_workspace_id);
    counts.sessions_recomputed += q.length;
    for (const s of q) {
      const w = db
        .prepare(`SELECT workspace_id FROM turns WHERE session_id = ? LIMIT 1`)
        .get(s.session_id) as { workspace_id: string };
      sessionSet.set(s.session_id, w.workspace_id);
    }

    counts.set_checks++;
    const got = q.map((r) => r.session_id).sort();
    const stored: string[] = Array.isArray(facts.session_ids) ? [...facts.session_ids].sort() : [];
    // The stored list is capped by the detector, so only require stored ⊆ recomputed and, when under the cap, equality.
    const capped = stored.length >= 20;
    const missingFromRecompute = stored.filter((s) => !got.includes(s));
    const extraInRecompute = capped ? [] : got.filter((s) => !stored.includes(s));
    if (missingFromRecompute.length || extraInRecompute.length) {
      counts.set_mismatch++;
      issues.push({
        kind: "session-set-mismatch",
        detail: `${rec.rec_id}: stored-not-qualifying=[${missingFromRecompute}] qualifying-not-stored=[${extraInRecompute}]`,
      });
    }
    if (
      typeof facts.qualifying_session_count === "number" &&
      facts.qualifying_session_count !== q.length
    ) {
      counts.set_mismatch++;
      issues.push({
        kind: "session-count-mismatch",
        detail: `${rec.rec_id}: stored ${facts.qualifying_session_count} vs recomputed ${q.length}`,
      });
    }

    counts.quantity_checks++;
    const tokens = q.reduce((s, r) => s + r.cr, 0);
    const storedTokens = facts.cache_read_tokens_per_week;
    if (typeof storedTokens !== "number") {
      counts.quantity_mismatch++;
      issues.push({
        kind: "quantity-field-missing",
        detail: `${rec.rec_id}: facts.cache_read_tokens_per_week absent`,
      });
    } else if (Math.abs(storedTokens - tokens) > TOLERANCE * Math.max(tokens, 1)) {
      counts.quantity_mismatch++;
      issues.push({
        kind: "quantity-mismatch",
        detail: `${rec.rec_id}: stored ${storedTokens} vs recomputed ${tokens} (${(((storedTokens - tokens) / Math.max(tokens, 1)) * 100).toFixed(1)}%)`,
      });
    }

    if (typeof facts.base_prefix_tokens === "number") {
      counts.base_checks++;
      const base = basePrefix(db, from, to, rec.scope_workspace_id);
      if (base === null || Math.abs(facts.base_prefix_tokens - base) > TOLERANCE * base) {
        counts.base_mismatch++;
        issues.push({
          kind: "base-prefix-mismatch",
          detail: `${rec.rec_id}: stored ${facts.base_prefix_tokens} vs recomputed ${base}`,
        });
      }
    }
  }

  // (a) billing equality; use the caller window's qualifying set when no rec supplied one.
  if (sessionSet.size === 0) {
    for (const s of qualifying(db, window.from, window.to, null)) {
      const w = db
        .prepare(`SELECT workspace_id FROM turns WHERE session_id = ? LIMIT 1`)
        .get(s.session_id) as { workspace_id: string };
      sessionSet.set(s.session_id, w.workspace_id);
      counts.sessions_recomputed++;
    }
  }
  const ids = [...sessionSet.keys()];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const all = db
      .prepare(
        `SELECT message_id, session_id, input_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other
           FROM turns WHERE is_sidechain = 0 AND session_id IN (${marks}) ORDER BY session_id, ts, message_id`,
      )
      .all(...ids) as TurnRow[];
    const stride = Math.max(1, Math.ceil(all.length / SAMPLE_MAX));
    const sample = all.filter((_, i) => i % stride === 0).slice(0, SAMPLE_MAX);
    counts.turns_sampled = sample.length;

    const rawBySession = new Map<string, Map<string, RawUsage> | null>();
    for (const sid of ids) {
      const row = db.prepare(`SELECT file_path FROM sessions WHERE session_id = ?`).get(sid) as
        | { file_path: string }
        | undefined;
      const file = transcriptCandidates(sid, sessionSet.get(sid)!, row?.file_path ?? null).find(
        (f) => fs.existsSync(f),
      );
      rawBySession.set(sid, file ? loadRaw(file) : null);
    }

    for (const t of sample) {
      const raw = rawBySession.get(t.session_id);
      if (!raw) {
        counts.raw_file_missing++;
        continue;
      }
      const r = raw.get(t.message_id);
      if (!r) {
        counts.raw_mismatched++;
        issues.push({ kind: "turn-not-in-transcript", detail: `${t.session_id} ${t.message_id}` });
        continue;
      }
      const dbWrite = t.cache_write_5m + t.cache_write_1h + t.cache_write_other;
      const diffs: string[] = [];
      if (t.input_tokens !== r.input) diffs.push(`input db=${t.input_tokens} raw=${r.input}`);
      if (t.cache_read_tokens !== r.cacheRead)
        diffs.push(`cache_read db=${t.cache_read_tokens} raw=${r.cacheRead}`);
      if (dbWrite !== r.cacheWrite) diffs.push(`cache_write db=${dbWrite} raw=${r.cacheWrite}`);
      if (r.w5m !== null && t.cache_write_5m !== r.w5m)
        diffs.push(`write_5m db=${t.cache_write_5m} raw=${r.w5m}`);
      if (r.w1h !== null && t.cache_write_1h !== r.w1h)
        diffs.push(`write_1h db=${t.cache_write_1h} raw=${r.w1h}`);
      if (diffs.length) {
        counts.raw_mismatched++;
        issues.push({
          kind: "usage-mismatch",
          detail: `${t.session_id} ${t.message_id}: ${diffs.join("; ")}`,
        });
      } else counts.raw_matched++;
    }
  }

  const checked =
    counts.raw_matched +
    counts.raw_mismatched +
    counts.set_checks +
    counts.quantity_checks +
    counts.base_checks;
  const failed = issues.length > 0;
  const verdict = failed ? "FAIL" : checked === 0 ? "UNPROVEN" : "PASS";
  return { verdict, counts, issues };
}

export function runCli(argv: string[]): number {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbPath = get("--db");
  const from = get("--from");
  const to = get("--to");
  if (!dbPath || !from || !to) {
    console.error("usage: d2-quantity-oracle.ts --db <path> --from <iso> --to <iso>");
    return 2;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const r = checkD2Quantity(db, { from, to });
    console.log(`D2 quantity oracle: ${r.verdict} ${JSON.stringify(r.counts)}`);
    for (const i of r.issues.slice(0, 20)) console.log(`  ${i.kind}: ${i.detail}`);
    return r.verdict === "PASS" ? 0 : r.verdict === "FAIL" ? 1 : 3;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2));
}
