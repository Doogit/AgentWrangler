/**
 * DH2 live run: each probe vs its detector on a SQLite-backup-API copy of the live DB, at every
 * stored week end (detector_week_results week_start + 7d) plus the latest window.
 *
 *   node --import tsx/esm scripts/detector-health/probe-live.ts --db <copy.sqlite> [--ids B3,D9] [--out x.json]
 *
 * Never point --db at the live DB: detectors run read/write against it. Prints aggregates only (SEC-101).
 */

import fs from "node:fs";
import Database from "better-sqlite3";
import { runLiveProbes } from "./live-probes.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db");
if (!dbPath || /[\\/]\.agentwrangler[\\/]db\.sqlite$/.test(dbPath))
  throw new Error("--db <backup copy> is required (never the live DB)");
const db = new Database(dbPath);
const rows = runLiveProbes(db, arg("ids")?.split(","));

console.log("| id | week end | status | fired | stored | candidates | qualifying | outcome |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(
    `| ${r.id} | ${r.weekEnd.slice(0, 10)} | ${r.status} | ${r.fired} | ${r.stored} | ${r.candidates} | ${r.qualifying} | ${r.outcome} |`,
  );
const out = arg("out");
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2));
db.close();
