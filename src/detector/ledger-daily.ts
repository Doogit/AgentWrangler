/**
 * P3.L L7 — `ledger_daily`: the claim ledger aggregated per UTC day, in midnight-aligned 7-day
 * blocks. Block k = [D − 7(k+1) days, D − 7k days), D = UTC midnight at or before `now`; 9 blocks
 * cover 63 days (30d + its previous 30d). Per-turn claims are never persisted, only daily sums.
 */
import type { Db } from "../db/open.js";
import { CLAIM_PRODUCERS, type ClaimProducer, buildClaimLedger } from "./claim-ledger.js";
import { inputSignature } from "./engine.js";

export const LEDGER_DAILY_BLOCKS = 9;
/** Bump when the row semantics change so every block rebuilds. */
export const LEDGER_DAILY_VERSION = "3"; // 2: card review F2/F4/F7 claim changes; 3: D7 N2

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKETS = 6;

interface Cell {
  day: string;
  lane: string;
  detector: string;
  rec: string;
  component: string;
  value: number;
  tokens: number;
  pos: number[];
}

interface TurnAgg {
  day: string;
  lane: string;
  detector: string;
  session: string;
  message: string;
  ts: string;
  value: number;
}

interface MarkRow {
  block_end: string;
  turns_rowid_hwm: number;
  producers_sig: string;
  inputs_sig: string;
  turns_fp: string;
}

/** The block grid for a UTC midnight: block k = [D − 7(k+1) days, D − 7k days). */
export function ledgerDailyGrid(
  midnight: number,
  blocks = LEDGER_DAILY_BLOCKS,
): Array<{ start: string; end: string }> {
  return Array.from({ length: blocks }, (_, k) => ({
    start: new Date(midnight - 7 * (k + 1) * DAY_MS).toISOString(),
    end: new Date(midnight - 7 * k * DAY_MS).toISOString(),
  }));
}

function buildBlock(
  db: Db,
  start: string,
  end: string,
  producers: readonly ClaimProducer[],
): {
  cells: Cell[];
  tops: TurnAgg[];
  sessions: Array<{ day: string; lane: string; detector: string; session: string; value: number }>;
} {
  const ledger = buildClaimLedger(
    db,
    { now: new Date(end), fromIso: start, toIso: end },
    producers,
  );
  const turnTs = new Map<string, string>();
  for (const t of db
    .prepare("SELECT session_id, message_id, ts FROM turns WHERE ts >= ? AND ts < ?")
    .iterate(start, end) as Iterable<{ session_id: string; message_id: string; ts: string }>)
    turnTs.set(`${t.session_id}|${t.message_id}`, t.ts);

  // Session position buckets: every turn of the session, ordered by ts, message_id.
  const sessionIds = [...new Set(ledger.claims.map((c) => c.sessionId))];
  const bucket = new Map<string, number>();
  if (sessionIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT session_id, message_id FROM turns
          WHERE session_id IN (SELECT value FROM json_each(?))
          ORDER BY session_id, ts, message_id`,
      )
      .all(JSON.stringify(sessionIds)) as Array<{ session_id: string; message_id: string }>;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.session_id, (counts.get(r.session_id) ?? 0) + 1);
    const next = new Map<string, number>();
    for (const r of rows) {
      const index = next.get(r.session_id) ?? 0;
      next.set(r.session_id, index + 1);
      const count = counts.get(r.session_id) ?? 1;
      bucket.set(
        `${r.session_id}|${r.message_id}`,
        Math.min(BUCKETS - 1, Math.floor((index * BUCKETS) / count)),
      );
    }
  }

  const cells = new Map<string, Cell>();
  const perTurn = new Map<string, TurnAgg>();
  for (const claim of ledger.claims) {
    const ts = turnTs.get(claim.turnKey);
    if (ts === undefined) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const rec = claim.recId ?? "";
    const cellKey = JSON.stringify([day, claim.lane, claim.detectorId, rec, claim.component]);
    let cell = cells.get(cellKey);
    if (cell === undefined) {
      cell = {
        day,
        lane: claim.lane,
        detector: claim.detectorId,
        rec,
        component: claim.component,
        value: 0,
        tokens: 0,
        pos: new Array<number>(BUCKETS).fill(0),
      };
      cells.set(cellKey, cell);
    }
    cell.value += claim.value_u;
    cell.tokens += claim.tokens;
    const b = bucket.get(claim.turnKey) ?? 0;
    cell.pos[b] = (cell.pos[b] ?? 0) + claim.value_u;

    const turnKeyStr = JSON.stringify([day, claim.lane, claim.detectorId, claim.turnKey]);
    const agg = perTurn.get(turnKeyStr);
    if (agg === undefined) {
      perTurn.set(turnKeyStr, {
        day,
        lane: claim.lane,
        detector: claim.detectorId,
        session: claim.sessionId,
        message: claim.turnKey.slice(claim.sessionId.length + 1),
        ts,
        value: claim.value_u,
      });
    } else {
      agg.value += claim.value_u;
    }
  }

  const topByKey = new Map<string, TurnAgg>();
  const sessionSums = new Map<
    string,
    { day: string; lane: string; detector: string; session: string; value: number }
  >();
  for (const agg of perTurn.values()) {
    if (agg.value <= 0) continue;
    const key = JSON.stringify([agg.day, agg.lane, agg.detector]);
    const cur = topByKey.get(key);
    if (
      cur === undefined ||
      agg.value > cur.value ||
      (agg.value === cur.value &&
        (agg.ts > cur.ts || (agg.ts === cur.ts && agg.message > cur.message)))
    )
      topByKey.set(key, agg);
  }
  for (const agg of perTurn.values()) {
    const key = JSON.stringify([agg.day, agg.lane, agg.detector, agg.session]);
    const cur = sessionSums.get(key);
    if (cur === undefined)
      sessionSums.set(key, {
        day: agg.day,
        lane: agg.lane,
        detector: agg.detector,
        session: agg.session,
        value: agg.value,
      });
    else cur.value += agg.value;
  }
  return {
    cells: [...cells.values()],
    tops: [...topByKey.values()],
    sessions: [...sessionSums.values()].filter((s) => s.value > 0),
  };
}

export function writeLedgerDaily(
  db: Db,
  now: Date,
  producers: readonly ClaimProducer[] = CLAIM_PRODUCERS,
): { blocks_total: number; blocks_written: number } {
  const startedAt = Date.now();
  const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const producersSig = `${producers.map((p) => p.detectorId).join(",")}|v${LEDGER_DAILY_VERSION}`;
  // Accepted (L7 review #4): any inputs_sig change rebuilds all 9 blocks; the cost is bounded, not per-block.
  const inputsSig = inputSignature(db);
  const getMark = db.prepare("SELECT * FROM ledger_daily_marks WHERE block_start = ?");
  const newerTurn = db.prepare(
    "SELECT 1 FROM turns WHERE rowid > ? AND ts >= ? AND ts < ? LIMIT 1",
  );
  const maxRowid = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS hwm FROM turns");
  const insCell = db.prepare(
    `INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens,
       pos0_u, pos1_u, pos2_u, pos3_u, pos4_u, pos5_u)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insTop = db.prepare(
    `INSERT INTO ledger_daily_top (block_start, day, lane, detector_id, session_id, message_id, ts, value_u)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insSession = db.prepare(
    `INSERT INTO ledger_daily_sessions (block_start, day, lane, detector_id, session_id, value_u)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const upsertMark = db.prepare(
    `INSERT OR REPLACE INTO ledger_daily_marks
       (block_start, block_end, turns_rowid_hwm, producers_sig, inputs_sig, turns_fp, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const fingerprint = db.prepare(
    `SELECT COUNT(*) || '|' || COALESCE(SUM(provisional), 0) || '|' || COALESCE(SUM(COALESCE(cost_equiv_u, 0)), 0)
            || '|' || COUNT(pricing_snapshot_id) || COALESCE(MIN(pricing_snapshot_id), '') || COALESCE(MAX(pricing_snapshot_id), '') AS fp
       FROM turns WHERE ts >= ? AND ts < ?`,
  );

  // Out-of-grid GC runs first: a throw mid-loop must never leave old-grid rows overlapping the new grid.
  const grid = ledgerDailyGrid(midnight);
  db.transaction(() => {
    const keep = JSON.stringify(grid.map((b) => b.start));
    for (const table of [
      "ledger_daily",
      "ledger_daily_top",
      "ledger_daily_sessions",
      "ledger_daily_marks",
    ])
      db.prepare(
        `DELETE FROM ${table} WHERE block_start NOT IN (SELECT value FROM json_each(?))`,
      ).run(keep);
  })();

  let written = 0;
  for (const { start, end } of grid) {
    const mark = getMark.get(start) as MarkRow | undefined;
    // Computed before building, like the hwm: a change during the build leaves the block stale next call.
    const fp = (fingerprint.get(start, end) as { fp: string }).fp;
    const stale =
      mark === undefined ||
      mark.block_end !== end ||
      mark.producers_sig !== producersSig ||
      mark.inputs_sig !== inputsSig ||
      mark.turns_fp !== fp ||
      newerTurn.get(mark.turns_rowid_hwm, start, end) !== undefined;
    if (!stale) continue;

    const hwm = (maxRowid.get() as { hwm: number }).hwm;
    const block = buildBlock(db, start, end, producers);
    db.transaction(() => {
      for (const table of ["ledger_daily", "ledger_daily_top", "ledger_daily_sessions"])
        db.prepare(`DELETE FROM ${table} WHERE block_start = ?`).run(start);
      for (const c of block.cells)
        insCell.run(
          start,
          c.day,
          c.lane,
          c.detector,
          c.rec,
          c.component,
          c.value,
          c.tokens,
          ...c.pos,
        );
      for (const t of block.tops)
        insTop.run(start, t.day, t.lane, t.detector, t.session, t.message, t.ts, t.value);
      for (const s of block.sessions)
        insSession.run(start, s.day, s.lane, s.detector, s.session, s.value);
      upsertMark.run(start, end, hwm, producersSig, inputsSig, fp, new Date().toISOString());
    })();
    written++;
  }

  console.log(
    `ledger-daily — ${written}/${LEDGER_DAILY_BLOCKS} blocks written in ${Date.now() - startedAt} ms`,
  );
  return { blocks_total: LEDGER_DAILY_BLOCKS, blocks_written: written };
}
