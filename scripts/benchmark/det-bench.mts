/**
 * det-bench — per-detector evaluate() rows and ms for DETECTOR_BUDGETS (ADR-113).
 * Rebuilt for U7 from the P0-U14 method (7dc68891): W0 window ending at the DB's last
 * reconciled turn, rows counted by the daemon's own wrapper (detector-counters.ts),
 * one warm-up pass, then the median of 3. Run it on a COPY: opening migrates the DB.
 *
 * CLI: `npx tsx scripts/benchmark/det-bench.mts <db-copy> [<repo-root>] [A1,B1,...]`
 * Budget: rows_read = ceil(1.2 x rows); ms = max(5, ceil(2.4 x ms)).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dbPath, root = process.cwd(), only] = process.argv.slice(2);
if (dbPath === undefined) throw new Error("usage: det-bench.mts <db-copy> [<repo-root>] [ids]");
const imp = (p: string) => import(pathToFileURL(path.join(root, p)).href);
const { openDb } = await imp("src/db/open.ts");
const { DETECTORS } = await imp("src/detector/registry.ts");
const { wrapDbForCounting } = await imp("src/daemon/detector-counters.ts");

const db = openDb(dbPath);
const { m: maxTs } = db.prepare("SELECT MAX(ts) AS m FROM turns WHERE provisional = 0").get() as {
  m: string;
};
const now = new Date(maxTs);
const ctx = {
  now,
  fromIso: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  toIso: now.toISOString(),
};
const counts = wrapDbForCounting(db);
const ids = only ? new Set(only.split(",")) : null;
const detectors = DETECTORS.filter((d: { id: string }) => !ids || ids.has(d.id));

const runs: Record<string, { ms: number[]; rows: number[] }> = {};
for (let pass = 0; pass < 4; pass++) {
  for (const d of detectors) {
    const rows0 = counts.rows;
    const t0 = performance.now();
    d.evaluate(db, ctx);
    const ms = performance.now() - t0;
    if (pass === 0) continue; // warm-up primes the page cache
    const run = (runs[d.id] ??= { ms: [], rows: [] });
    run.ms.push(ms);
    run.rows.push(counts.rows - rows0);
  }
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[1] ?? 0;
console.log(`window ${ctx.fromIso} .. ${ctx.toIso}`);
for (const [id, r] of Object.entries(runs)) {
  const rows = median(r.rows);
  const ms = median(r.ms);
  console.log(
    `${id}\tbench ${rows} rows / ${Math.round(ms)} ms\trows_read ${Math.ceil(1.2 * rows)} ms ${Math.max(5, Math.ceil(2.4 * ms))}`,
  );
}
db.close();
