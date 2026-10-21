/**
 * Independent pricing for DH3 oracles. No imports from src/**: µ$ per turn recomputed from the turn's token
 * columns and its pricing snapshot ([in, out, cacheRead, cw5m, cw1h] $/MTok).
 */

import type Database from "better-sqlite3";

const CHUNK = 500;

interface PriceRow {
  message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  cost_equiv_u: number | null;
  unit_prices_json: string | null;
}

function rowsFor(db: Database.Database, ids: string[]): PriceRow[] {
  const out: PriceRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(
      ...(db
        .prepare(
          `SELECT t.message_id, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
                  t.cache_write_1h, t.cache_write_other, t.cost_equiv_u, p.unit_prices_json
           FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
           WHERE t.message_id IN (${part.map(() => "?").join(",")})`,
        )
        .all(...part) as PriceRow[]),
    );
  }
  return out;
}

function price(r: PriceRow): number | null {
  if (!r.unit_prices_json) return null;
  const p = JSON.parse(r.unit_prices_json) as number[];
  const [pin, pout, pread, pw5, pw1] = p as [number, number, number, number, number];
  const dollars =
    (r.input_tokens * pin +
      r.output_tokens * pout +
      r.cache_read_tokens * pread +
      (r.cache_write_5m + r.cache_write_other) * pw5 +
      r.cache_write_1h * pw1) /
    1e6;
  return dollars * 1e6;
}

/** µ$ per turn; unpriceable turns (no snapshot) are absent from the map. */
export function priceTurns(db: Database.Database, messageIds: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rowsFor(db, messageIds)) {
    const v = price(r);
    if (v !== null) m.set(r.message_id, v);
  }
  return m;
}

export interface PriceCrossCheck {
  n: number;
  max_rel_diff: number;
  mean_signed_rel_diff: number;
}

/** Recomputed vs stored turns.cost_equiv_u, over turns with both and a non-zero stored cost. */
export function priceCrossCheck(db: Database.Database, ids: string[]): PriceCrossCheck {
  let n = 0;
  let max = 0;
  let sum = 0;
  for (const r of rowsFor(db, ids)) {
    const v = price(r);
    if (v === null || r.cost_equiv_u === null || r.cost_equiv_u === 0) continue;
    const rel = (v - r.cost_equiv_u) / r.cost_equiv_u;
    n++;
    sum += rel;
    max = Math.max(max, Math.abs(rel));
  }
  return { n, max_rel_diff: max, mean_signed_rel_diff: n > 0 ? sum / n : 0 };
}
