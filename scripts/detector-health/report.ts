/**
 * DH4: `npm run detector-health`. Backs up ~/.agentwrangler/db.sqlite (read-only, SQLite backup API) into a temp
 * dir, builds the health report on the copy at one pinned `now`, and writes
 * .claude/audits/detector-health/<date>.md. Never reads the live DB in place beyond the backup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildRows, renderReport } from "./health-report.js";
import { liveWeekEnds } from "./live-probes.js";

const LIVE_DB = path.join(os.homedir(), ".agentwrangler", "db.sqlite");
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.claude/audits/detector-health",
);

const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dh4-"));
const copy = path.join(tmp, "copy.sqlite");
try {
  const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
  try {
    await live.backup(copy);
  } finally {
    live.close();
  }
  const db = new Database(copy);
  try {
    const weekEnds = liveWeekEnds(db);
    const rows = await buildRows(db, now);
    const out = path.join(OUT_DIR, `${now.toISOString().slice(0, 10)}.md`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(out, renderReport(rows, now, weekEnds));
    const red = rows.filter((r) => r.overall === "red").map((r) => r.id);
    console.log(`wrote ${out}: ${rows.length} rows, red: ${red.join(" ") || "none"}`);
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
