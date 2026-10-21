/**
 * P3.L L9 view dump. Runs the real builders at a fixed `--now` (a UTC midnight, so the cards' trailing
 * 7d window and the ledger's whole-UTC-day windows line up) and writes what the app would show:
 *   cards.json                       the `/api/recommendations` response (default workspace)
 *   diagnostics-{7,14,30}.json       the `GET /api/diagnostics?window=N` view, with the hand-off join
 * `ledger-sql-oracle.ts` checks these against SQL over the same DB. This script may import src/: it
 * produces the claims under test. It never opens the live DB.
 *
 *   npx tsx scripts/parity/l9-dump-views.ts --db <copy> --now <midnight iso> --out <dir> [--prepare]
 *
 * `--prepare` first migrates the copy and writes the ledger (as l7-daily-check.ts does); without it the
 * copy must already have both.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { joinHandoffs } from "../../src/daemon/diagnostics-snapshot.js";
import type { HandoffCandidate } from "../../src/daemon/diagnostics-snapshot.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/open.js";
import { writeLedgerDaily } from "../../src/detector/ledger-daily.js";
import { buildDiagnosticsTriage } from "../../src/query/api/diagnostics-triage.js";
import { buildRecommendations, headlineSavings } from "../../src/query/api/recommendations.js";
import { setQueryDb } from "../../src/query/db-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(msg: string): never {
  console.error(
    `${msg}\nUsage: l9-dump-views.ts --db <copy> --now <midnight iso> --out <dir> [--prepare]`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
let prepare = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  if (a === "--prepare") prepare = true;
  else if (a === "--db" || a === "--now" || a === "--out") {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`Missing value for ${a}`);
    flags.set(a, v);
  } else fail(`Unknown flag ${a}`);
}
const dbPath = flags.get("--db");
const out = flags.get("--out");
const now = new Date(flags.get("--now") ?? "");
if (!dbPath || !out) fail("--db and --out are required");
if (!Number.isFinite(now.getTime())) fail("--now must be an ISO date");
if (now.getTime() % DAY_MS !== 0) fail("--now must be a UTC midnight");

const live = path.join(os.homedir(), ".agentwrangler", "db.sqlite");
if (path.resolve(dbPath).toLowerCase() === path.resolve(live).toLowerCase())
  fail("Refusing to open the live DB; pass a copy");
if (!fs.existsSync(dbPath)) fail(`db not found: ${dbPath}`);

const db = new Database(dbPath, { fileMustExist: true }) as unknown as Db;
try {
  if (prepare) {
    runMigrations(db);
    writeLedgerDaily(db, now);
  }
  setQueryDb(db);
  fs.mkdirSync(out, { recursive: true });

  const cards = buildRecommendations(undefined, now);
  fs.writeFileSync(path.join(out, "cards.json"), JSON.stringify(cards));

  // Hand-off candidates exactly as createHandoffSource builds them from the active cards.
  const active = cards.data?.active ?? [];
  const keys = new Map(
    (
      db
        .prepare(
          "SELECT rec_id, COALESCE(rule_id, template_id) AS key FROM recommendations WHERE state = 'PROPOSED'",
        )
        .all() as Array<{ rec_id: string; key: string | null }>
    ).map((r) => [r.rec_id, r.key]),
  );
  const candidates: HandoffCandidate[] = active.map((card) => ({
    rec_id: card.rec_id,
    detector_id: card.detector_id,
    key: keys.get(card.rec_id) ?? null,
    headline_u: headlineSavings(card),
  }));

  for (const w of [7, 14, 30] as const) {
    const view = joinHandoffs(buildDiagnosticsTriage(db, w, now), candidates);
    fs.writeFileSync(
      path.join(out, `diagnostics-${w}.json`),
      JSON.stringify({ ...view, status: "ready" }),
    );
  }
  console.log(
    `l9-dump-views: wrote cards.json + diagnostics-{7,14,30}.json to ${out} at ${now.toISOString()}`,
  );
} finally {
  db.close();
}
