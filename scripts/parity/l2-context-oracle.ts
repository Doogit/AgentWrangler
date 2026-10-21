/**
 * P3.L L2 oracle: expected D1 and D2 ledger claims from plain SQL. Imports no src/ code, so it
 * is independent of the producers it checks (design §6 L2). Compare with
 * `ledger-conservation.ts` on the same --db/--from/--to window.
 *
 * D1: per current MEMORY/CLAUDE_MD source, each eligible turn (cache_read > 0) claims
 *   round(min(asOfTokens − target, cache_read) × 0.5) cache-read tokens, where asOfTokens is the
 *   latest context_inventory_history row at or before the turn with the current row's
 *   attribution_version (MEMORY: observed on or after the U0.1 basis change), else the current size.
 *   Ignores the cross-source per-turn cap (only binds when a turn's cache read < Σ deltas).
 * D2: detector net = round(cacheReadSpend × round4(Σavoided / Σcontext)) − round(rebuild), over
 *   main-thread turns of qualifying sessions; the ledger's D2 Σ must match it within rounding.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import Database from "better-sqlite3";

// Mirrors of src constants (savings.ts); a drift here is a finding, not a fix.
const D1_TARGETS: Record<string, number> = { CLAUDE_MD: 2_000, MEMORY: 1_000 };
const D1_FRACTION = 0.5;
const D2_TURNS = 150;
const D2_AVG_CONTEXT = 180_000;
const D2_MIN_SESSIONS = 3;
const D2_CALLS_PER_SPLIT = 150;
const D2_SUMMARY = 2_000;
const GLOBAL = "__global__";
/** U0.1 (1a2482df): MEMORY rows before this measured all memory files, not MEMORY.md. */
const MEMORY_BASIS_SINCE = "2026-09-23T23:08:00.000Z";

const ELIGIBLE: Record<string, string> = {
  MEMORY:
    "(t.is_sidechain = 0 OR EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type = 'fork'))",
  CLAUDE_MD:
    "(t.is_sidechain = 0 OR NOT EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type IN ('Explore', 'Plan')))",
};

const PRICE = (index: number) =>
  `COALESCE((SELECT CAST(json_extract(ps.unit_prices_json, '$[${index}]') AS REAL)
     FROM pricing_snapshots ps WHERE ps.snapshot_id = t.pricing_snapshot_id), 0)`;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i] ?? "", argv[i + 1] ?? "");
  const db = args.get("--db");
  if (!db) throw new Error("Usage: l2-context-oracle.ts --db <path> [--from ISO --to ISO]");
  const to = new Date(args.get("--to") ?? Date.now());
  const from = new Date(args.get("--from") ?? to.getTime() - 7 * 86_400_000);
  return { db, fromIso: from.toISOString(), toIso: to.toISOString() };
}

function recId(detector: string, scopeWs: string | null, scopeKey: string): string {
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  return `rec-${detector}-${scopeWs ?? "global"}-${hash}`;
}

function d1(db: Database.Database, fromIso: string, toIso: string) {
  const sources = db
    .prepare(
      `SELECT workspace_id, component, file_ref, tokens, attribution_version FROM context_inventory
        WHERE component IN ('MEMORY', 'CLAUDE_MD') ORDER BY probe_id`,
    )
    .all() as Array<{
    workspace_id: string;
    component: string;
    file_ref: string;
    tokens: number;
    attribution_version: string;
  }>;
  const byRec: Record<string, { value_u: number; tokens: number; turns: number }> = {};
  for (const s of sources) {
    const target = D1_TARGETS[s.component] ?? Number.POSITIVE_INFINITY;
    const isGlobal = s.workspace_id === GLOBAL;
    const row = db
      .prepare(
        `WITH x AS (
           SELECT t.cache_read_tokens AS cr, ${PRICE(2)} AS price,
                  COALESCE((SELECT h.tokens FROM context_inventory_history h
                     WHERE h.workspace_id = @ws AND h.component = @comp AND h.file_ref = @ref
                       AND h.attribution_version = @av AND h.observed_at >= @since
                       AND h.observed_at <= t.ts ORDER BY h.observed_at DESC, h.id DESC LIMIT 1),
                    @current) - @target AS delta
             FROM turns t
            WHERE t.workspace_id ${isGlobal ? "!=" : "="} @ws AND t.ts >= @from AND t.ts < @to
              AND t.provisional = 0 AND t.cache_read_tokens > 0 AND ${ELIGIBLE[s.component]})
         SELECT COUNT(*) AS turns,
                COALESCE(SUM(ROUND(MIN(delta, cr) * @fraction)), 0) AS tokens,
                COALESCE(SUM(ROUND(MIN(delta, cr) * @fraction) * price), 0) AS value_u
           FROM x WHERE delta > 0`,
      )
      .get({
        ws: s.workspace_id,
        comp: s.component,
        ref: s.file_ref,
        av: s.attribution_version,
        since: s.component === "MEMORY" ? MEMORY_BASIS_SINCE : "",
        current: s.tokens,
        target,
        from: fromIso,
        to: toIso,
        fraction: D1_FRACTION,
      }) as { turns: number; tokens: number; value_u: number };
    if (row.turns === 0) continue;
    const scope = isGlobal ? "global" : s.workspace_id;
    const id = recId(
      "D1",
      isGlobal ? null : s.workspace_id,
      `D1|${scope}|${s.component}|${path.basename(s.file_ref)}`,
    );
    const acc = (byRec[id] ??= { value_u: 0, tokens: 0, turns: 0 });
    acc.value_u += row.value_u;
    acc.tokens += row.tokens;
    acc.turns += row.turns;
  }
  const total_u = Object.values(byRec).reduce((sum, r) => sum + r.value_u, 0);
  return { total_u: Math.round(total_u), byRec };
}

function d2(db: Database.Database, fromIso: string, toIso: string) {
  const w = { from: fromIso, to: toIso };
  const sessions = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n FROM turns
        WHERE ts >= @from AND ts < @to AND provisional = 0 AND is_sidechain = 0
        GROUP BY session_id HAVING COUNT(*) > ${D2_TURNS} AND AVG(context_tokens) > ${D2_AVG_CONTEXT}`,
    )
    .all(w) as Array<{ session_id: string; n: number }>;
  if (sessions.length < D2_MIN_SESSIONS) return { fires: false, sessions: sessions.length };

  // Base prefix: median first-turn context of main sessions that started in the window.
  const firsts = (
    db
      .prepare(
        `WITH f AS (SELECT session_id, MIN(ts) AS ts FROM turns
                     WHERE is_sidechain = 0 AND provisional = 0 AND ts < @to GROUP BY session_id)
         SELECT t.input_tokens + t.cache_read_tokens + t.cache_write_5m + t.cache_write_1h
                + t.cache_write_other AS ctx
           FROM f JOIN turns t ON t.session_id = f.session_id AND t.ts = f.ts
                  AND t.is_sidechain = 0 AND t.provisional = 0
          WHERE f.ts >= @from GROUP BY t.session_id`,
      )
      .all(w) as Array<{ ctx: number }>
  )
    .map((r) => r.ctx)
    .sort((a, b) => a - b);
  const mid = Math.floor(firsts.length / 2);
  const base =
    firsts.length === 0
      ? 0
      : firsts.length % 2
        ? (firsts[mid] ?? 0)
        : Math.round(((firsts[mid - 1] ?? 0) + (firsts[mid] ?? 0)) / 2);

  const ids = sessions.map((s) => s.session_id);
  const inList = ids.map(() => "?").join(",");
  const agg = db
    .prepare(
      `WITH r AS (
         SELECT t.session_id, t.context_tokens AS c,
                ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.ts, t.message_id) - 1 AS i,
                COUNT(*) OVER (PARTITION BY t.session_id) AS n
           FROM turns t WHERE t.session_id IN (${inList}) AND t.ts >= ? AND t.ts < ?
            AND t.provisional = 0 AND t.is_sidechain = 0),
       p AS (SELECT *, (i * ((n - 1) / ${D2_CALLS_PER_SPLIT} + 1)) / n AS part FROM r),
       last AS (SELECT session_id, part, c AS at_split FROM p
                 WHERE i = (SELECT MAX(i) FROM p p2 WHERE p2.session_id = p.session_id AND p2.part = p.part))
       SELECT SUM(p.c) AS ctx_total,
              SUM(CASE WHEN p.part > 0
                  THEN MIN(p.c, MAX(0, l.at_split - ? - ${D2_SUMMARY})) ELSE 0 END) AS avoided
         FROM p LEFT JOIN last l ON l.session_id = p.session_id AND l.part = p.part - 1`,
    )
    .get(...ids, fromIso, toIso, base) as { ctx_total: number; avoided: number };
  const spend = db
    .prepare(
      `SELECT SUM(t.cache_read_tokens * ${PRICE(2)}) AS read_u,
              SUM((t.cache_write_5m + t.cache_write_other) * ${PRICE(3)}
                  + t.cache_write_1h * ${PRICE(4)}) AS write_u,
              SUM(t.cache_write_5m + t.cache_write_other + t.cache_write_1h) AS write_tokens
         FROM turns t WHERE t.session_id IN (${inList}) AND t.ts >= ? AND t.ts < ?
          AND t.provisional = 0 AND t.is_sidechain = 0`,
    )
    .get(...ids, fromIso, toIso) as { read_u: number; write_u: number; write_tokens: number };
  const reduction = Number((agg.avoided / agg.ctx_total).toFixed(4));
  const splits = sessions.reduce((sum, s) => sum + Math.floor((s.n - 1) / D2_CALLS_PER_SPLIT), 0);
  const writePrice = spend.write_tokens > 0 ? spend.write_u / spend.write_tokens : 0;
  const gross_u = Math.round(spend.read_u * reduction);
  const rebuild_u = Math.round(splits * (base + D2_SUMMARY) * writePrice);
  return {
    fires: true,
    sessions: sessions.length,
    rec_id: recId("D2", null, "D2|global|D2_LONG_CONTEXT_CACHE_READ_V1"),
    base_prefix_tokens: base,
    reduction_fraction: reduction,
    gross_u,
    rebuild_u,
    net_u: Math.max(0, gross_u - rebuild_u),
  };
}

const { db: dbPath, fromIso, toIso } = parseArgs(process.argv);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  console.log(
    JSON.stringify(
      {
        window: { from: fromIso, to: toIso },
        D1: d1(db, fromIso, toIso),
        D2: d2(db, fromIso, toIso),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
