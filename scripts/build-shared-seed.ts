/**
 * Shared seed script for verify-app.mjs and future demo/test use.
 * Spawned by: node --import tsx/esm scripts/build-shared-seed.ts <dbPath>
 * Seeds the real JSONL fixtures from test/fixtures/ingest (SEC-101 safe).
 *
 * The fixtures carry fixed 2026-01 timestamps. Left as-is they fall outside the
 * dashboard's default 7d window, so every page loads empty. We therefore shift
 * every line's `timestamp` so the newest lands ~1 day before build time, on a
 * throwaway temp copy — the raw fixtures are never modified. `now` is real time
 * so the reconcile cutoff sits after the shifted turns (sessions RECONCILED, not
 * stuck LIVE). Non-parseable lines (a deliberate broken-JSON fixture) pass
 * through verbatim.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import { buildContext, runDetectors } from "../src/detector/engine.js";
import { openDb } from "../src/db/open.js";
import { runBackscan } from "../src/ingest/index.js";
import { shiftCorpus } from "./lib/shift-corpus.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("build-shared-seed: missing <dbPath>");
  process.exit(1);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO, "test", "fixtures", "ingest");

// Shift so the newest turn lands ~1 day before now (comfortably inside 7d),
// writing a shifted copy into a temp tree and preserving relative paths.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-seed-"));
try {
  shiftCorpus(FIXTURE_ROOT, tempRoot, Date.now());
} catch (err) {
  console.error(`build-shared-seed: ${(err as Error).message}`);
  process.exit(1);
}

// Start from a fresh DB. The ingestor uses INSERT OR IGNORE keyed on stable
// message_ids, so rebuilding over an existing seed would KEEP stale turns
// (e.g. old timestamps) and silently serve outdated data — the deterministic-seed
// invariant the tests/demo/golden set all depend on. Remove any prior artifact first.
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

const db = openDb(dbPath);
runMigrations(db);
runBackscan(db, [tempRoot], {
  now: () => new Date(),
  activityWindowSecs: 300,
});

// Materialize recommendation rows. Ingest alone leaves the `recommendations`
// table empty (the daemon would populate it on the next ingest tick, but the
// seed daemon runs with an empty scan root and never ticks) — so the Recs tab
// would render blank. runDetectors persists PROPOSED cards from the seed events.
runDetectors(db, buildContext(new Date()));

db.close();

fs.rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write("seed-ok\n");
