/**
 * P3.L L7 independent check. Written before the L7 implementation, from the design only.
 *
 * Copies --db to --work, migrates the copy, runs `writeLedgerDaily(copy, now)` twice, then
 * checks the table and `ledgerDailyProvider` against live `buildClaimLedger` recomputes over
 * the same midnight-aligned 7-day blocks (block k = [D − 7(k+1)d, D − 7k d), D = UTC midnight
 * at or before --now):
 *   1. per day, per (lane, detector, rec, component): table Σ == live block ledger Σ;
 *   2. re-running the writer changes nothing (idempotent);
 *   3. 7d / 14d / 30d tile == Σ live days over the window; tile == Σ causes ≤ spend;
 *      prev windows likewise;
 *   4. a cause whose 7d claims all carry one rec id == that card's `allocated_u_per_wk` (AE4);
 *   5. coverage: PARTIAL iff a cause detector has no spend producer; null iff none has one;
 *   6. OD-1: Σ position_u == avoidable_u, buckets recomputed from `turns`; top_claim ==
 *      the largest (detector, turn) claim value; sessions_affected == distinct sessions.
 * It never imports the implementation's aggregation, only its two entry points.
 *
 *   npx tsx scripts/parity/l7-daily-check.ts --db <path> --work <copy path> --now <ISO>
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/open.js";
import { SPEND_LANE_DETECTOR_IDS, buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { writeLedgerDaily } from "../../src/detector/ledger-daily.js";
import { CAUSES } from "../../src/query/api/diagnostics-causes.js";
import { ledgerDailyProvider } from "../../src/query/api/ledger-daily-provider.js";
import { buildRecommendations } from "../../src/query/api/recommendations.js";
import { setQueryDb } from "../../src/query/db-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKS = 9;
const BUCKETS = 6;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    args.set(flag, value);
  }
  const dbPath = args.get("--db");
  const workPath = args.get("--work");
  const now = new Date(args.get("--now") ?? "");
  if (!dbPath || !workPath || !Number.isFinite(now.getTime())) {
    throw new Error("Usage: l7-daily-check.ts --db <path> --work <copy path> --now ISO");
  }
  return { dbPath, workPath, now };
}

const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ts: string) => new Date(ts).toISOString().slice(0, 10);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

interface LiveClaim {
  day: string;
  lane: string;
  detector: string;
  rec: string;
  component: string;
  session: string;
  message: string;
  ts: string;
  value_u: number;
  tokens: number;
  bucket: number;
}

/** Every live ledger claim of the 9 blocks, each tagged with its turn's UTC day and bucket. */
function liveClaims(db: Db, midnight: number): LiveClaim[] {
  const turnTs = new Map<string, string>();
  const bucket = new Map<string, number>();
  const turns = db
    .prepare("SELECT session_id, message_id, ts FROM turns ORDER BY session_id, ts, message_id")
    .all() as Array<{ session_id: string; message_id: string; ts: string }>;
  const counts = new Map<string, number>();
  for (const t of turns) counts.set(t.session_id, (counts.get(t.session_id) ?? 0) + 1);
  const next = new Map<string, number>();
  for (const t of turns) {
    const index = next.get(t.session_id) ?? 0;
    next.set(t.session_id, index + 1);
    const key = `${t.session_id}|${t.message_id}`;
    turnTs.set(key, t.ts);
    const count = counts.get(t.session_id) ?? 1;
    bucket.set(key, Math.min(BUCKETS - 1, Math.floor((index * BUCKETS) / count)));
  }
  const out: LiveClaim[] = [];
  for (let k = 0; k < BLOCKS; k++) {
    const toIso = iso(midnight - 7 * k * DAY_MS);
    const fromIso = iso(midnight - 7 * (k + 1) * DAY_MS);
    const ledger = buildClaimLedger(db, { now: new Date(toIso), fromIso, toIso });
    for (const claim of ledger.claims) {
      const ts = turnTs.get(claim.turnKey);
      if (ts === undefined) throw new Error(`claim on unknown turn ${claim.turnKey}`);
      const message = claim.turnKey.slice(claim.sessionId.length + 1);
      out.push({
        day: dayOf(ts),
        lane: claim.lane,
        detector: claim.detectorId,
        rec: claim.recId ?? "",
        component: claim.component,
        session: claim.sessionId,
        message,
        ts,
        value_u: claim.value_u,
        tokens: claim.tokens,
        bucket: bucket.get(claim.turnKey) ?? 0,
      });
    }
  }
  return out;
}

function tableRows(db: Db) {
  return db
    .prepare(
      `SELECT day, lane, detector_id, rec_id, component, SUM(value_u) AS value_u, SUM(tokens) AS tokens
         FROM ledger_daily GROUP BY day, lane, detector_id, rec_id, component`,
    )
    .all() as Array<{
    day: string;
    lane: string;
    detector_id: string;
    rec_id: string;
    component: string;
    value_u: number;
    tokens: number;
  }>;
}

function snapshot(db: Db): string {
  const tables = ["ledger_daily", "ledger_daily_top", "ledger_daily_sessions"];
  return JSON.stringify(
    tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4, 5, 6`).all()),
  );
}

function main() {
  const { dbPath, workPath, now } = parseArgs(process.argv);
  const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const failures: string[] = [];
  fs.rmSync(workPath, { force: true });
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  // Synchronous copy: better-sqlite3's backup() is async; VACUUM INTO is not.
  source.exec(`VACUUM INTO '${workPath.replaceAll("'", "''")}'`);
  source.close();
  const db = new Database(workPath) as unknown as Db;
  try {
    runMigrations(db);
    const first = writeLedgerDaily(db, now);
    const before = snapshot(db);
    const second = writeLedgerDaily(db, now);
    if (snapshot(db) !== before) failures.push("re-running writeLedgerDaily changed the tables");
    if (second.blocks_written !== 0)
      failures.push(`second run rewrote ${second.blocks_written} blocks (expected 0: nothing stale)`);

    // 1. Per-day table == live block ledgers.
    const live = liveClaims(db, midnight);
    const key = (d: string, l: string, det: string, r: string, c: string) =>
      [d, l, det, r, c].join("\t");
    const liveSum = new Map<string, { v: number; t: number }>();
    for (const c of live) {
      const k = key(c.day, c.lane, c.detector, c.rec, c.component);
      const cur = liveSum.get(k) ?? { v: 0, t: 0 };
      liveSum.set(k, { v: cur.v + c.value_u, t: cur.t + c.tokens });
    }
    const tableSum = new Map<string, { v: number; t: number }>();
    for (const r of tableRows(db))
      tableSum.set(key(r.day, r.lane, r.detector_id, r.rec_id, r.component), {
        v: r.value_u,
        t: r.tokens,
      });
    let cellMismatches = 0;
    for (const k of new Set([...liveSum.keys(), ...tableSum.keys()])) {
      const a = liveSum.get(k) ?? { v: 0, t: 0 };
      const b = tableSum.get(k) ?? { v: 0, t: 0 };
      if (!near(a.v, b.v, 1e-3) || a.t !== b.t) {
        if (cellMismatches++ < 10)
          failures.push(`day cell ${k}: live ${a.v}/${a.t} table ${b.v}/${b.t}`);
      }
    }
    if (cellMismatches > 10) failures.push(`… ${cellMismatches - 10} more day-cell mismatches`);

    // 3–6. Provider windows.
    const provider = ledgerDailyProvider(db);
    const spendCauses = CAUSES.filter((cause) => cause.section === "spend");
    const detectorsOf = (causeId: string) =>
      new Set(
        (spendCauses.find((c) => c.cause_id === causeId)?.keys ?? []).map((k) => k.detector_id),
      );
    const dayFrom = (days: number) => dayOf(iso(midnight - days * DAY_MS));
    const inWindow = (c: LiveClaim, fromDays: number, toDays: number) =>
      c.lane === "spend" && c.day >= dayFrom(fromDays) && c.day < dayFrom(toDays);
    const spend = (fromDays: number, toDays: number) =>
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0",
          )
          .get(iso(midnight - fromDays * DAY_MS), iso(midnight - toDays * DAY_MS)) as { u: number }
      ).u;
    const summary: Record<string, unknown> = {};
    for (const w of [7, 14, 30] as const) {
      const figures = provider(w, now);
      const windowClaims = live.filter((c) => inWindow(c, w, 0));
      const prevClaims = live.filter((c) => inWindow(c, 2 * w, w));
      const lane = Math.round(windowClaims.reduce((t, c) => t + c.value_u, 0));
      let causeSum = 0;
      const causeRows: Record<string, unknown> = {};
      for (const cause of spendCauses) {
        const dets = detectorsOf(cause.cause_id);
        const producers = [...dets].filter((d) => SPEND_LANE_DETECTOR_IDS.has(d));
        const fig = figures.causes.get(cause.cause_id);
        if (fig === undefined) {
          failures.push(`${w}d: no figure for spend cause ${cause.cause_id}`);
          continue;
        }
        const wantCoverage = producers.length === dets.size ? "ALL" : "PARTIAL";
        if (fig.coverage !== wantCoverage)
          failures.push(`${w}d ${cause.cause_id}: coverage ${fig.coverage} != ${wantCoverage}`);
        if (producers.length === 0) {
          if (fig.avoidable_u !== null || fig.basis !== null)
            failures.push(`${w}d ${cause.cause_id}: no producer but avoidable_u=${fig.avoidable_u}`);
          continue;
        }
        const mine = windowClaims.filter((c) => dets.has(c.detector));
        const want = Math.round(mine.reduce((t, c) => t + c.value_u, 0));
        const wantPrev = Math.round(
          prevClaims.filter((c) => dets.has(c.detector)).reduce((t, c) => t + c.value_u, 0),
        );
        if (fig.basis !== "LEDGER") failures.push(`${w}d ${cause.cause_id}: basis ${fig.basis}`);
        if (fig.avoidable_u === null || !near(fig.avoidable_u, want, 1))
          failures.push(`${w}d ${cause.cause_id}: avoidable_u ${fig.avoidable_u} != live ${want}`);
        if (fig.prev_avoidable_u === null || !near(fig.prev_avoidable_u, wantPrev, 1))
          failures.push(`${w}d ${cause.cause_id}: prev ${fig.prev_avoidable_u} != live ${wantPrev}`);
        causeSum += fig.avoidable_u ?? 0;

        // OD-1: positions.
        const pos = new Array<number>(BUCKETS).fill(0);
        for (const c of mine) pos[c.bucket] = (pos[c.bucket] ?? 0) + c.value_u;
        const gotPos = fig.position_u;
        if (gotPos === undefined || gotPos.length !== BUCKETS) {
          failures.push(`${w}d ${cause.cause_id}: position_u missing`);
        } else {
          for (let b = 0; b < BUCKETS; b++)
            if (!near(gotPos[b] ?? 0, pos[b] ?? 0, 1))
              failures.push(`${w}d ${cause.cause_id}: position_u[${b}] ${gotPos[b]} != ${pos[b]}`);
          if (!near(gotPos.reduce((t, v) => t + v, 0), fig.avoidable_u ?? 0, BUCKETS))
            failures.push(`${w}d ${cause.cause_id}: Σ position_u != avoidable_u`);
        }
        // OD-1: top claim = the largest (detector, turn) Σ value.
        const perTurn = new Map<string, { v: number; c: LiveClaim }>();
        for (const c of mine) {
          const k = `${c.detector}\t${c.session}\t${c.message}`;
          const cur = perTurn.get(k);
          perTurn.set(k, { v: (cur?.v ?? 0) + c.value_u, c });
        }
        const top = Math.max(0, ...[...perTurn.values()].map((x) => x.v));
        if (top > 0) {
          const got = fig.top_claim;
          if (got === undefined || !near(got.value_u, top, 1))
            failures.push(`${w}d ${cause.cause_id}: top_claim ${got?.value_u} != ${top}`);
          else if (
            ![...perTurn.values()].some(
              (x) =>
                near(x.v, got.value_u, 1) &&
                x.c.session === got.session_id &&
                x.c.message === got.message_id &&
                x.c.ts === got.ts,
            )
          )
            failures.push(`${w}d ${cause.cause_id}: top_claim does not name a max-value turn`);
        } else if (fig.top_claim !== undefined) {
          failures.push(`${w}d ${cause.cause_id}: top_claim present with no valued claim`);
        }
        // OD-1: sessions with a valued claim.
        const sessions = new Set(mine.filter((c) => c.value_u > 0).map((c) => c.session)).size;
        if (fig.sessions_affected !== sessions)
          failures.push(
            `${w}d ${cause.cause_id}: sessions_affected ${fig.sessions_affected} != ${sessions}`,
          );
        causeRows[cause.cause_id] = { avoidable_u: fig.avoidable_u, prev: fig.prev_avoidable_u };
      }
      if (figures.tile_u !== causeSum)
        failures.push(`${w}d: tile ${figures.tile_u} != Σ causes ${causeSum}`);
      if (figures.tile_u === null || !near(figures.tile_u, lane, spendCauses.length))
        failures.push(`${w}d: tile ${figures.tile_u} != live spend lane ${lane}`);
      const windowSpend = spend(w, 0);
      if ((figures.tile_u ?? 0) > windowSpend)
        failures.push(`${w}d: tile ${figures.tile_u} > spend ${windowSpend}`);
      summary[`${w}d`] = { tile_u: figures.tile_u, lane_u: lane, spend_u: windowSpend, causeRows };
    }

    // 4. AE4: a cause whose 7d claims all carry one rec id == that card.
    setQueryDb(db);
    const view = buildRecommendations(undefined, new Date(midnight)).data;
    if (view === null) throw new Error("buildRecommendations returned no data");
    const cards = new Map<string, number | null | undefined>();
    for (const card of [
      ...view.active,
      ...view.limit_warnings,
      ...view.adopted,
      ...view.dismissed,
      ...view.history,
      ...(view.below_floor ?? []),
    ])
      cards.set(card.rec_id, (card as { allocated_u_per_wk?: number | null }).allocated_u_per_wk);
    const fig7 = provider(7, now);
    let ae4Checked = 0;
    for (const cause of spendCauses) {
      const dets = detectorsOf(cause.cause_id);
      const recs = new Set(
        live.filter((c) => inWindow(c, 7, 0) && dets.has(c.detector)).map((c) => c.rec),
      );
      const [only] = [...recs];
      if (recs.size !== 1 || only === undefined || !cards.has(only)) continue;
      ae4Checked++;
      const card = cards.get(only);
      const got = fig7.causes.get(cause.cause_id)?.avoidable_u;
      if (typeof card !== "number" || typeof got !== "number" || !near(card, got, 1))
        failures.push(`AE4 ${cause.cause_id}: cause ${got} != card ${only.slice(0, 12)} ${card}`);
    }
    summary.ae4_causes_checked = ae4Checked;
    summary.writer = { first, second };
    summary.failures = failures;
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
