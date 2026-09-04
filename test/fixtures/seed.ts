/**
 * test/fixtures/seed.ts — seeded synthetic fixture database.
 *
 * Generates a deterministic fixture DB from the frozen DDL with known token
 * inputs and documented expected aggregates. No randomness; no Date.now().
 * All timestamps are fixed 2026-01-01 offsets.
 *
 * WP2/WP3/WP4 build their SQL and UI assertions against these fixtures instead
 * of waiting on real WP1 ingestion data.
 *
 * ── Fixture layout ──────────────────────────────────────────────────────────
 *
 * Pricing snapshots:
 *   snap-sonnet  claude-sonnet  [in=$3, out=$15, cr=$0.30, cw5m=$3.75, cw1h=$4.50] $/MTok
 *   snap-haiku   claude-haiku   [in=$0.80, out=$4, cr=$0.08, cw5m=$1.00, cw1h=$1.20] $/MTok
 *
 * Workspaces:
 *   ws-alpha  project-alpha  (3 sessions)
 *   ws-beta   project-beta   (2 sessions: 1 RECONCILED + 1 LIVE)
 *
 * Sessions (all RECONCILED unless noted):
 *   sess-a1  ws-alpha  3 sonnet turns  → cost_equiv_u = 29_175 μUSD
 *   sess-a2  ws-alpha  1 sonnet + 1 haiku turn → cost_equiv_u = 18_800 μUSD
 *   sess-a3  ws-alpha  2 haiku turns   → cost_equiv_u = 1_800 μUSD
 *   sess-b1  ws-beta   2 sonnet turns  → cost_equiv_u = 49_350 μUSD
 *   sess-b2  ws-beta   1 haiku turn (LIVE, provisional=1) → NOT in reconciled totals
 *
 * ── Expected aggregates (RECONCILED, provisional=0) ─────────────────────────
 *
 * workspace-alpha (3 sessions, 7 turns):
 *   cost_equiv_u = 29_175 + 18_800 + 1_800 = 49_775 μUSD = $0.049775
 *   turns        = 7   (sess-a1=3, sess-a2=2, sess-a3=2)
 *
 * workspace-beta (1 session, 2 turns — sess-b2 excluded as provisional):
 *   cost_equiv_u = 49_350 μUSD = $0.04935
 *   turns        = 2
 *
 * global (9 reconciled turns, 2 workspaces):
 *   cost_equiv_u = 49_775 + 49_350 = 99_125 μUSD = $0.099125
 *   turns        = 9   (alpha 7 + beta 2; provisional LIVE turn excluded)
 *
 * Live sessions: 1 (sess-b2, ws-beta, 1 haiku turn, cost_equiv_u=1_600 μUSD)
 *
 * ── Pricing arithmetic (verification) ───────────────────────────────────────
 * Formula: cost_u = tokens × price_per_MTok  (prices are in $/MTok = μUSD/token)
 *
 * sess-a1:
 *   turn-a1-1: in=1000,out=200,cr=0,cw5m=0,cw1h=0 → sonnet → 1000×3+200×15=3000+3000=6000
 *   turn-a1-2: in=2000,out=400,cr=1000,cw5m=500,cw1h=0 → 2000×3+400×15+1000×0.30+500×3.75
 *              = 6000+6000+300+1875 = 14_175
 *   turn-a1-3: in=1500,out=300,cr=0,cw5m=0,cw1h=0 → 1500×3+300×15=4500+4500=9000
 *   sess-a1 total: 6000+14_175+9000 = 29_175 μUSD ✓
 *
 * sess-a2:
 *   turn-a2-1: in=3000,out=600,cr=0,cw5m=0,cw1h=0 → sonnet → 3000×3+600×15=9000+9000=18_000
 *   turn-a2-2: in=500,out=100,cr=0,cw5m=0,cw1h=0 → haiku → 500×0.80+100×4=400+400=800
 *   sess-a2 total: 18_000+800 = 18_800 μUSD ✓
 *
 * sess-a3:
 *   turn-a3-1: in=200,out=50,cr=0,cw5m=0,cw1h=0 → haiku → 200×0.80+50×4=160+200=360 (round: 360)
 *   turn-a3-2: in=500,out=200,cr=0,cw5m=0,cw1h=0 → haiku → 500×0.80+200×4=400+800=1200 (round: 1200)
 *   sess-a3 total: 360+1200 = 1_560 μUSD
 *   NOTE: seed below uses 900+900=1_800 for cleaner numbers — see turn definitions below.
 *
 * sess-b1:
 *   turn-b1-1: in=5000,out=1000,cr=2000,cw5m=1000,cw1h=0 → sonnet
 *              5000×3+1000×15+2000×0.30+1000×3.75 = 15000+15000+600+3750 = 34_350
 *   turn-b1-2: in=2500,out=500,cr=0,cw5m=0,cw1h=0 → sonnet → 2500×3+500×15=7500+7500=15_000
 *   sess-b1 total: 34_350+15_000 = 49_350 μUSD ✓
 *
 * sess-b2 (LIVE, provisional):
 *   turn-b2-1: in=1000,out=200,cr=0,cw5m=0,cw1h=0 → haiku → 1000×0.80+200×4=800+800=1_600
 *   provisional=1 → excluded from reconciled aggregates ✓
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";

// ── Fixed base timestamp (2026-01-01T00:00:00Z) ──────────────────────────────
const BASE_TS = "2026-01-01T00:00:00.000Z";

function ts(offsetMinutes: number): string {
  const d = new Date(BASE_TS);
  d.setMinutes(d.getMinutes() + offsetMinutes);
  return d.toISOString();
}

// ── Pricing snapshot prices (μUSD/token = $/MTok numerically) ────────────────
// [in, out, cacheRead, cw5m, cw1h]
const SONNET_PRICES = [3, 15, 0.3, 3.75, 4.5] as const;
const HAIKU_PRICES = [0.8, 4, 0.08, 1.0, 1.2] as const;

function costU(
  input: number,
  output: number,
  cr: number,
  cw5m: number,
  cw1h: number,
  prices: readonly [number, number, number, number, number],
): number {
  return Math.round(
    input * prices[0] + output * prices[1] + cr * prices[2] + cw5m * prices[3] + cw1h * prices[4],
  );
}

/**
 * Seed a migrated database with synthetic fixtures.
 *
 * The caller is responsible for opening and migrating the DB first.
 * This function only inserts; it never creates tables.
 */
export function seedFixtureDb(db: Database.Database): void {
  // ── Pricing snapshots ─────────────────────────────────────────────────────
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
     (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?,?,?,?,?)`,
  ).run(
    "snap-sonnet",
    "sonnet-4",
    JSON.stringify(SONNET_PRICES),
    BASE_TS,
    ts(30 * 24 * 60), // stale after 30 days
  );

  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
     (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?,?,?,?,?)`,
  ).run("snap-haiku", "haiku", JSON.stringify(HAIKU_PRICES), BASE_TS, ts(30 * 24 * 60));

  // ── Workspaces ────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
     (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run("ws-alpha", "project-alpha", BASE_TS);

  db.prepare(
    `INSERT OR IGNORE INTO workspaces
     (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run("ws-beta", "project-beta", BASE_TS);

  // ── Sessions ──────────────────────────────────────────────────────────────
  // sess-a1: ws-alpha, RECONCILED, 3 sonnet turns, cost_equiv_u = 29_175
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "sess-a1",
    "ws-alpha",
    "/fake/alpha/sess-a1.jsonl",
    ts(0),
    ts(30),
    "RECONCILED",
    3,
    29_175,
    "[]",
  );

  // sess-a2: ws-alpha, RECONCILED, 2 turns (1 sonnet + 1 haiku), cost_equiv_u = 18_800
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "sess-a2",
    "ws-alpha",
    "/fake/alpha/sess-a2.jsonl",
    ts(60),
    ts(90),
    "RECONCILED",
    2,
    18_800,
    "[]",
  );

  // sess-a3: ws-alpha, RECONCILED, 2 haiku turns, cost_equiv_u = 1_800
  // Turn counts: turn-a3-1: 900 μUSD, turn-a3-2: 900 μUSD
  // in=600,out=75,cr=0 → haiku → 600×0.80+75×4=480+300=780 (round)
  // in=500,out=0,cr=0 → haiku → 500×0.80=400... let's use turns that sum cleanly.
  // Actual turn definitions below give 900+900=1_800. See turn inserts.
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "sess-a3",
    "ws-alpha",
    "/fake/alpha/sess-a3.jsonl",
    ts(120),
    ts(135),
    "RECONCILED",
    2,
    1_800,
    "[]",
  );

  // sess-b1: ws-beta, RECONCILED, 2 sonnet turns, cost_equiv_u = 49_350
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "sess-b1",
    "ws-beta",
    "/fake/beta/sess-b1.jsonl",
    ts(200),
    ts(240),
    "RECONCILED",
    2,
    49_350,
    "[]",
  );

  // sess-b2: ws-beta, LIVE (provisional), 1 haiku turn, cost_equiv_u = 1_600
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
      state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("sess-b2", "ws-beta", "/fake/beta/sess-b2.jsonl", ts(300), ts(305), "LIVE", 1, 1_600, "[]");

  // ── Turns ─────────────────────────────────────────────────────────────────
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO turns
     (message_id, session_id, workspace_id, ts, model,
      is_sidechain, input_tokens, output_tokens,
      cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
      tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
      provisional, parser_version)
     VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?)`,
  );

  // sess-a1 — 3 sonnet turns
  // turn-a1-1: in=1000,out=200 → 1000×3+200×15=3000+3000=6000
  insertTurn.run(
    "msg-a1-1",
    "sess-a1",
    "ws-alpha",
    ts(0),
    "claude-sonnet",
    0,
    1000,
    200,
    0,
    0,
    0,
    0,
    null,
    "snap-sonnet",
    costU(1000, 200, 0, 0, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );
  // turn-a1-2: in=2000,out=400,cr=1000,cw5m=500 → 6000+6000+300+1875=14175
  insertTurn.run(
    "msg-a1-2",
    "sess-a1",
    "ws-alpha",
    ts(10),
    "claude-sonnet",
    0,
    2000,
    400,
    1000,
    500,
    0,
    0,
    null,
    "snap-sonnet",
    costU(2000, 400, 1000, 500, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );
  // turn-a1-3: in=1500,out=300 → 4500+4500=9000
  insertTurn.run(
    "msg-a1-3",
    "sess-a1",
    "ws-alpha",
    ts(20),
    "claude-sonnet",
    0,
    1500,
    300,
    0,
    0,
    0,
    0,
    null,
    "snap-sonnet",
    costU(1500, 300, 0, 0, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );

  // sess-a2 — 1 sonnet + 1 haiku
  // turn-a2-1: in=3000,out=600,sonnet → 9000+9000=18000
  insertTurn.run(
    "msg-a2-1",
    "sess-a2",
    "ws-alpha",
    ts(60),
    "claude-sonnet",
    0,
    3000,
    600,
    0,
    0,
    0,
    0,
    null,
    "snap-sonnet",
    costU(3000, 600, 0, 0, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );
  // turn-a2-2: in=500,out=100,haiku → 400+400=800
  insertTurn.run(
    "msg-a2-2",
    "sess-a2",
    "ws-alpha",
    ts(70),
    "claude-haiku",
    0,
    500,
    100,
    0,
    0,
    0,
    0,
    null,
    "snap-haiku",
    costU(500, 100, 0, 0, 0, HAIKU_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );

  // sess-a3 — 2 haiku turns summing to 1_800
  // turn-a3-1: in=450,out=225,haiku → 450×0.80+225×4=360+900=1260... not clean.
  // Use: in=750,out=75 → 750×0.80+75×4=600+300=900 ✓
  insertTurn.run(
    "msg-a3-1",
    "sess-a3",
    "ws-alpha",
    ts(120),
    "claude-haiku",
    0,
    750,
    75,
    0,
    0,
    0,
    0,
    null,
    "snap-haiku",
    costU(750, 75, 0, 0, 0, HAIKU_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );
  // turn-a3-2: same → 900
  insertTurn.run(
    "msg-a3-2",
    "sess-a3",
    "ws-alpha",
    ts(125),
    "claude-haiku",
    0,
    750,
    75,
    0,
    0,
    0,
    0,
    null,
    "snap-haiku",
    costU(750, 75, 0, 0, 0, HAIKU_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );

  // sess-b1 — 2 sonnet turns
  // turn-b1-1: in=5000,out=1000,cr=2000,cw5m=1000 → 15000+15000+600+3750=34350
  insertTurn.run(
    "msg-b1-1",
    "sess-b1",
    "ws-beta",
    ts(200),
    "claude-sonnet",
    0,
    5000,
    1000,
    2000,
    1000,
    0,
    0,
    null,
    "snap-sonnet",
    costU(5000, 1000, 2000, 1000, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );
  // turn-b1-2: in=2500,out=500 → 7500+7500=15000
  insertTurn.run(
    "msg-b1-2",
    "sess-b1",
    "ws-beta",
    ts(220),
    "claude-sonnet",
    0,
    2500,
    500,
    0,
    0,
    0,
    0,
    null,
    "snap-sonnet",
    costU(2500, 500, 0, 0, 0, SONNET_PRICES),
    "LIST_EQUIV",
    0,
    "test-v1",
  );

  // sess-b2 — 1 LIVE haiku turn (provisional=1, excluded from reconciled aggregates)
  // turn-b2-1: in=1000,out=200,haiku → 800+800=1600
  insertTurn.run(
    "msg-b2-1",
    "sess-b2",
    "ws-beta",
    ts(300),
    "claude-haiku",
    0,
    1000,
    200,
    0,
    0,
    0,
    0,
    null,
    "snap-haiku",
    costU(1000, 200, 0, 0, 0, HAIKU_PRICES),
    "LIST_EQUIV",
    1,
    "test-v1", // provisional=1
  );

  // ── user_config seed rows (FW-06/FW-07) ──────────────────────────────────
  const insertConfig = db.prepare(
    "INSERT OR IGNORE INTO user_config (key, value, updated_at) VALUES (?,?,?)",
  );
  insertConfig.run("limit_tokens", null, BASE_TS);
  insertConfig.run("last_warned_jd", null, BASE_TS);
}

/**
 * Create a fresh in-memory fixture database, run migrations, and seed it.
 * Returns the open database (caller is responsible for closing).
 */
export function createInMemoryFixtureDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedFixtureDb(db);
  return db;
}

/**
 * Create an on-disk fixture database at `dbPath`, migrate, and seed.
 * Parent directories are created if missing.
 * Returns the open database.
 */
export function createFixtureDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(dbPath);
  runMigrations(db);
  seedFixtureDb(db);
  return db;
}
