/**
 * P3.L L7 — the `ledger_daily` reader behind the Diagnostics Avoidable-spend seam.
 * Spend lane only. Windows are whole UTC days ending at the midnight at or before `asOf`.
 * The default provider of the Diagnostics triage build (P4 U8).
 */
import type { Db } from "../../db/open.js";
import { SPEND_LANE_DETECTOR_IDS } from "../../detector/claim-ledger.js";
import { ledgerDailyGrid } from "../../detector/ledger-daily.js";
import type { AvoidableCauseFigure, AvoidableProvider } from "./diagnostics-avoidable.js";
import { CAUSES } from "./diagnostics-causes.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * L8: Σ reliability-lane `value_u` (the recovery turns' full cost, an upper bound) for the
 * given families over whole UTC days [E-w, E). Null when the window's blocks are not all
 * marked or hold no such row.
 */
export function ledgerReliabilityU(
  db: Db,
  windowDays: number,
  asOf: Date,
  detectors: readonly string[],
): number | null {
  const midnight = Math.floor(asOf.getTime() / DAY_MS) * DAY_MS;
  const needed = ledgerDailyGrid(midnight, Math.ceil(windowDays / 7));
  const getMark = db.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?");
  const complete = needed.every(
    (b) => (getMark.get(b.start) as { block_end: string } | undefined)?.block_end === b.end,
  );
  if (!complete || detectors.length === 0) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(value_u), 0) AS v FROM ledger_daily
        WHERE lane = 'reliability' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
          AND detector_id IN (SELECT value FROM json_each(?))`,
    )
    .get(
      day(midnight - windowDays * DAY_MS),
      day(midnight),
      JSON.stringify(needed.map((b) => b.start)),
      JSON.stringify(detectors),
    ) as { n: number; v: number };
  return row.n === 0 ? null : Math.round(row.v);
}

export function ledgerDailyProvider(db: Db): AvoidableProvider {
  return (windowDays, asOf) => {
    const midnight = Math.floor(asOf.getTime() / DAY_MS) * DAY_MS;
    const spendCauses = CAUSES.filter((c) => c.section === "spend");
    const causes = new Map<string, AvoidableCauseFigure>();
    const coverageOf = (detectors: string[]) =>
      detectors.every((d) => SPEND_LANE_DETECTOR_IDS.has(d)) ? "ALL" : "PARTIAL";
    const detectorsOf = (cause: (typeof spendCauses)[number]) => [
      ...new Set(cause.keys.map((k) => k.detector_id)),
    ];

    // Every grid block the window and its previous window touch must be marked for this midnight.
    const needed = ledgerDailyGrid(midnight, Math.ceil((2 * windowDays) / 7));
    const getMark = db.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?");
    const complete = needed.every(
      (b) => (getMark.get(b.start) as { block_end: string } | undefined)?.block_end === b.end,
    );
    if (!complete) {
      for (const cause of spendCauses)
        causes.set(cause.cause_id, {
          avoidable_u: null,
          prev_avoidable_u: null,
          basis: null,
          coverage: coverageOf(detectorsOf(cause)),
        });
      return { causes, tile_u: null };
    }

    const from = day(midnight - windowDays * DAY_MS);
    const prevFrom = day(midnight - 2 * windowDays * DAY_MS);
    const to = day(midnight);
    const starts = JSON.stringify(needed.map((b) => b.start));
    const sums = db.prepare(
      `SELECT COALESCE(SUM(value_u), 0) AS v, COALESCE(SUM(pos0_u), 0) AS p0,
              COALESCE(SUM(pos1_u), 0) AS p1, COALESCE(SUM(pos2_u), 0) AS p2,
              COALESCE(SUM(pos3_u), 0) AS p3, COALESCE(SUM(pos4_u), 0) AS p4,
              COALESCE(SUM(pos5_u), 0) AS p5
         FROM ledger_daily
        WHERE lane = 'spend' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
          AND detector_id IN (SELECT value FROM json_each(?))`,
    );
    const topStmt = db.prepare(
      `SELECT session_id, message_id, ts, value_u FROM ledger_daily_top
        WHERE lane = 'spend' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
          AND detector_id IN (SELECT value FROM json_each(?))
        ORDER BY value_u DESC, ts DESC, message_id DESC LIMIT 1`,
    );
    const sessionsStmt = db.prepare(
      `SELECT session_id, SUM(value_u) AS v FROM ledger_daily_sessions
        WHERE lane = 'spend' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
          AND detector_id IN (SELECT value FROM json_each(?))
        GROUP BY session_id`,
    );

    let tile = 0;
    for (const cause of spendCauses) {
      const detectors = detectorsOf(cause);
      const coverage = coverageOf(detectors);
      const producers = detectors.filter((d) => SPEND_LANE_DETECTOR_IDS.has(d));
      if (producers.length === 0) {
        causes.set(cause.cause_id, {
          avoidable_u: null,
          prev_avoidable_u: null,
          basis: null,
          coverage,
        });
        continue;
      }
      const ids = JSON.stringify(producers);
      const cur = sums.get(from, to, starts, ids) as Record<string, number>;
      const prev = sums.get(prevFrom, from, starts, ids) as { v: number };
      const top = topStmt.get(from, to, starts, ids) as
        | { session_id: string; message_id: string; ts: string; value_u: number }
        | undefined;
      const sessions = (
        sessionsStmt.all(from, to, starts, ids) as Array<{ session_id: string; v: number }>
      )
        .map((s) => ({ session_id: s.session_id, value_u: Math.round(s.v) }))
        .sort(
          (a, b) =>
            b.value_u - a.value_u ||
            (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0),
        );
      const avoidable = Math.round(cur.v ?? 0);
      tile += avoidable;
      const figure: AvoidableCauseFigure = {
        avoidable_u: avoidable,
        prev_avoidable_u: Math.round(prev.v),
        basis: "LEDGER",
        coverage,
        position_u: [
          Math.round(cur.p0 ?? 0),
          Math.round(cur.p1 ?? 0),
          Math.round(cur.p2 ?? 0),
          Math.round(cur.p3 ?? 0),
          Math.round(cur.p4 ?? 0),
          Math.round(cur.p5 ?? 0),
        ],
        sessions_affected: sessions.length,
        sessions,
      };
      if (top !== undefined)
        figure.top_claim = {
          session_id: top.session_id,
          message_id: top.message_id,
          value_u: Math.round(top.value_u),
          ts: top.ts,
        };
      causes.set(cause.cause_id, figure);
    }
    return { causes, tile_u: tile, through: new Date(midnight).toISOString() };
  };
}
