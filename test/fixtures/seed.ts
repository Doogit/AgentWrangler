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
import { DEFAULT_CAP_READ_COEFF, capWeightForTurn } from "../../src/query/cap-weighted.js";

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

// ── RR U3 user profiles (reused by U4) ──────────────────────────────────────
// Synthetic: invented titles/slugs, token counts only (SEC-101). Times are offsets before `now`,
// so these seeders take `now` (the base seed above is pinned to 2026-01-01).

/** Cap-weighted tokens per limit-% point in the Pro profile's snapshots (so the weekly check passes). */
export const PRO_PROFILE_TOKENS_PER_PCT = 100_000;
/** Limit % already used this week before any local turn (claude.ai web use): readings sit this far above local usage. */
export const PRO_PROFILE_UNSEEN_PCT = 13.1;

interface ProfileTurn {
  session: string;
  hoursAgo: number;
  model: string;
  sidechain: 0 | 1;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function seedProfile(
  db: Database.Database,
  prefix: string,
  slug: string,
  sessions: { id: string; title: string }[],
  turns: ProfileTurn[],
  now: Date,
): void {
  const ws = `ws-${prefix}`;
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(ws, slug, now.toISOString());
  const at = (h: number) => new Date(now.getTime() - h * 36e5).toISOString();
  for (const s of sessions) {
    const mine = turns.filter((t) => t.session === s.id);
    db.prepare(
      `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags, title)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.id,
      ws,
      `/fake/${prefix}/${s.id}.jsonl`,
      at(Math.max(...mine.map((t) => t.hoursAgo))),
      at(Math.min(...mine.map((t) => t.hoursAgo))),
      "RECONCILED",
      mine.length,
      0,
      "[]",
      s.title,
    );
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO turns
     (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
      cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
      cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  turns.forEach((t, i) => {
    const prices = t.model.includes("haiku") ? HAIKU_PRICES : SONNET_PRICES;
    insert.run(
      `msg-${prefix}-${i}`,
      t.session,
      ws,
      at(t.hoursAgo),
      t.model,
      t.sidechain,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheWrite,
      0,
      0,
      costU(t.input, t.output, t.cacheRead, t.cacheWrite, 0, prices),
      "LIST_EQUIV",
      0,
      "test-v1",
    );
  });
  db.prepare(
    "UPDATE sessions SET cost_equiv_u = (SELECT COALESCE(SUM(cost_equiv_u),0) FROM turns WHERE turns.session_id = sessions.session_id) WHERE workspace_id = ?",
  ).run(ws);
}

/**
 * Profile 1 — Pro user, no subagents. Three sessions over ~5 days, all main-thread, one model, plus
 * weekly limit_snapshots (source "api") at 100k cap-weighted tokens per % point (offset by a
 * constant 13.1 pts of use outside this machine) so the weekly tracking check passes. Limit week resets 40 h after `now`.
 */
export function seedProProfile(db: Database.Database, now: Date): { resetsAt: string } {
  const sessions = [
    { id: "pro-s1", title: "Draft the onboarding checklist" },
    { id: "pro-s2", title: "Tidy the weekly report script" },
    { id: "pro-s3", title: "Plan the research reading list" },
  ];
  const m = "claude-sonnet-5";
  const turn = (
    session: string,
    hoursAgo: number,
    input: number,
    cacheWrite: number,
  ): ProfileTurn => ({
    session,
    hoursAgo,
    model: m,
    sidechain: 0,
    input,
    output: input / 5,
    cacheRead: input * 2,
    cacheWrite,
  });
  const turns = [
    turn("pro-s1", 110, 300_000, 400_000),
    turn("pro-s1", 100, 200_000, 300_000),
    turn("pro-s2", 70, 250_000, 350_000),
    turn("pro-s2", 40, 150_000, 200_000),
    turn("pro-s3", 20, 350_000, 450_000),
    turn("pro-s3", 3, 100_000, 100_000),
  ];
  seedProfile(db, "pro", "pro-notes", sessions, turns, now);
  const resetsAt = new Date(Math.round((now.getTime() + 40 * 36e5) / 36e5) * 36e5).toISOString();
  const capOf = (t: ProfileTurn) =>
    capWeightForTurn(
      {
        input_tokens: t.input,
        output_tokens: t.output,
        cache_read_tokens: t.cacheRead,
        cache_write_5m: t.cacheWrite,
        cache_write_1h: 0,
        cache_write_other: 0,
      },
      DEFAULT_CAP_READ_COEFF,
    );
  const insertSnap = db.prepare(
    "INSERT OR IGNORE INTO limit_snapshots (ts, resets_at, used_pct, source) VALUES (?,?,?,?)",
  );
  // A reading 1 h after each of turns 2, 4, 5 and 6 (hoursAgo 100, 40, 20, 3 -> 99, 39, 19, 2 h ago).
  for (const upTo of [100, 40, 20, 3]) {
    const cum = turns.filter((t) => t.hoursAgo >= upTo).reduce((a, t) => a + capOf(t), 0);
    insertSnap.run(
      new Date(now.getTime() - (upTo - 1) * 36e5).toISOString(),
      resetsAt,
      cum / PRO_PROFILE_TOKENS_PER_PCT + PRO_PROFILE_UNSEEN_PCT,
      "api",
    );
  }
  return { resetsAt };
}

/**
 * Profile 2 — API-key user, no OAuth. Two sessions with heavy subagent (sidechain) use across two
 * models, and no limit_snapshots, so only rolling windows and tokens/$ can be shown.
 */
export function seedApiKeyProfile(db: Database.Database, now: Date): void {
  const sessions = [
    { id: "api-s1", title: "Batch-process the nightly exports" },
    { id: "api-s2", title: "Investigate flaky integration job" },
  ];
  const t = (
    session: string,
    hoursAgo: number,
    model: string,
    sidechain: 0 | 1,
    input: number,
  ): ProfileTurn => ({
    session,
    hoursAgo,
    model,
    sidechain,
    input,
    output: input / 4,
    cacheRead: input * 3,
    cacheWrite: input,
  });
  seedProfile(
    db,
    "api",
    "api-batch",
    sessions,
    [
      t("api-s1", 100, "claude-sonnet-5", 0, 100_000),
      t("api-s1", 99, "claude-haiku-4", 1, 300_000),
      t("api-s1", 98, "claude-haiku-4", 1, 300_000),
      t("api-s2", 4, "claude-sonnet-5", 0, 200_000),
      t("api-s2", 3, "claude-sonnet-5", 1, 400_000),
      t("api-s2", 1, "claude-haiku-4", 1, 100_000),
    ],
    now,
  );
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

// ── RR U4 "waste" profile (held-out oracle for the audit CLI) ───────────────
// Synthetic and invented (SEC-101). Plants exactly five wastes, each >= 5% of the profile's $:
//   W1 oversized subagent    one general-purpose agent, 150 turns, ~400k context each (session w-s1)
//   W2 Opus reviewer fan-out 12 sidechain `reviewer` agents on Opus doing short review turns (session w-s2)
//   W3 idle cache rebuilds   14 main turns, each after a 2 h gap, each rewriting ~200k of 1h cache (session w-s3)
//   W4 broken hook path      a settings hook pointing at a missing script; its non-blocking errors are in the
//                            JSONL (scan.mjs), and the session pays for a 30-error shell retry loop (session w-s4)
//   W5 Opus mechanical turns 60 Opus main-thread turns, each one git/npm call with ~2.5k output (session w-s5)
// Plus a normal Sonnet baseline session (w-s0) that is NOT a waste.

export const WASTE_PROFILE = {
  workspaceId: "ws-waste",
  slug: "waste-ledger-app",
  sessions: [
    { id: "w-s0", title: "Add the monthly summary export" },
    { id: "w-s1", title: "Sweep the legacy importer for dead branches" },
    { id: "w-s2", title: "Review the settings refactor" },
    { id: "w-s3", title: "Draft the quarterly planning notes" },
    { id: "w-s4", title: "Get the release build passing" },
    { id: "w-s5", title: "Tidy commits and rerun the checks" },
  ],
} as const;

const OPUS_PRICES = [15, 75, 1.5, 18.75, 30] as const;
const SONNET_W_PRICES = [3, 15, 0.3, 3.75, 6] as const;

export function seedWasteProfile(db: Database.Database, now: Date): void {
  const P = WASTE_PROFILE;
  const snap = (id: string, tier: string, prices: readonly number[]) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        id,
        tier,
        JSON.stringify(prices),
        now.toISOString(),
        new Date(now.getTime() + 30 * 864e5).toISOString(),
      );
  snap("snap-w-opus", "opus", OPUS_PRICES);
  snap("snap-w-sonnet", "sonnet", SONNET_W_PRICES);
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at, discovered_cwd) VALUES (?,?,?,?)",
  ).run(P.workspaceId, P.slug, now.toISOString(), "/work/waste-ledger-app");

  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 36e5).toISOString();
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions
     (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags, title)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO turns
     (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
      cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u,
      cost_claim, provisional, parser_version, thinking_tokens, agent_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, exit_class, bash_command_family)
     VALUES (?,?,?,?,?,?)`,
  );
  const insertMeta = db.prepare(
    "INSERT OR IGNORE INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?,?,0,0)",
  );
  const insertAgent = db.prepare(
    "INSERT OR IGNORE INTO subagent_meta (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len) VALUES (?,?,?,?,1,40)",
  );

  interface T {
    session: string;
    h: number; // hours ago
    opus?: boolean;
    sonnetW?: boolean; // use the 1h-priced sonnet snapshot
    side?: boolean;
    agent?: string;
    input: number;
    output: number;
    cr: number;
    cw5?: number;
    cw1?: number;
    think?: number;
    tool?: { name: string; family: string; exit: "OK" | "ERROR" };
  }
  const turns: T[] = [];
  // w-s0 baseline: 40 ordinary Sonnet turns over ~2 days, no tools.
  for (let i = 0; i < 40; i++)
    turns.push({
      session: "w-s0",
      h: 470 - i * 1.2,
      sonnetW: true,
      input: 4000,
      output: 1500,
      cr: 150_000,
      cw5: 3000,
    });
  // W1: one agent, 150 turns, huge context.
  for (let i = 0; i < 150; i++)
    turns.push({
      session: "w-s1",
      h: 400 - i * 0.05,
      sonnetW: true,
      side: true,
      agent: "agent-w1-big",
      input: 6000,
      output: 900,
      cr: 380_000,
      cw5: 8000,
    });
  // W2: 12 Opus reviewer agents x 6 short turns, in one session.
  for (let a = 0; a < 12; a++)
    for (let i = 0; i < 6; i++)
      turns.push({
        session: "w-s2",
        h: 300 - a * 0.5 - i * 0.02,
        opus: true,
        side: true,
        agent: `agent-w2-rev${a}`,
        input: 3000,
        output: 600,
        cr: 40_000,
        cw5: 8000,
      });
  // W3: 14 main turns, each after a 2 h idle gap, each rebuilding ~200k of 1h cache.
  for (let i = 0; i < 14; i++)
    turns.push({
      session: "w-s3",
      h: 250 - i * 2,
      sonnetW: true,
      input: 5000,
      output: 800,
      cr: 2000,
      cw1: 200_000,
    });
  // W4: 60 Sonnet turns in a retry loop; 30 shell errors.
  for (let i = 0; i < 60; i++)
    turns.push({
      session: "w-s4",
      h: 150 - i * 0.1,
      sonnetW: true,
      input: 5000,
      output: 1500,
      cr: 200_000,
      cw5: 2000,
      tool:
        i % 2 === 0
          ? { name: "Bash", family: "BASH_BUILD", exit: "ERROR" }
          : { name: "Bash", family: "BASH_BUILD", exit: "OK" },
    });
  // W5: 60 Opus main-thread turns, one git/npm call each, heavy output + thinking.
  for (let i = 0; i < 60; i++)
    turns.push({
      session: "w-s5",
      h: 60 - i * 0.2,
      opus: true,
      input: 2000,
      output: 2500,
      cr: 80_000,
      cw5: 1000,
      think: 2000,
      tool: { name: "Bash", family: i % 2 === 0 ? "BASH_GIT" : "BASH_NPM", exit: "OK" },
    });

  for (const s of P.sessions) {
    const mine = turns.filter((t) => t.session === s.id);
    insertSession.run(
      s.id,
      P.workspaceId,
      `/fake/waste/${s.id}.jsonl`,
      at(Math.max(...mine.map((t) => t.h))),
      at(Math.min(...mine.map((t) => t.h))),
      "RECONCILED",
      mine.length,
      0,
      "[]",
      s.title,
    );
  }
  const agents = new Set<string>();
  turns.forEach((t, i) => {
    const prices = t.opus ? OPUS_PRICES : SONNET_W_PRICES;
    const cost = costU(t.input, t.output, t.cr, t.cw5 ?? 0, t.cw1 ?? 0, prices);
    const id = `msg-w-${i}`;
    insertTurn.run(
      id,
      t.session,
      P.workspaceId,
      at(t.h),
      t.opus ? "claude-opus-5" : "claude-sonnet-5",
      t.side ? 1 : 0,
      t.input,
      t.output,
      t.cr,
      t.cw5 ?? 0,
      t.cw1 ?? 0,
      0,
      t.opus ? "snap-w-opus" : "snap-w-sonnet",
      cost,
      "LIST_EQUIV",
      0,
      "test-v1",
      t.think ?? null,
      t.agent ?? null,
    );
    if (t.agent && !agents.has(t.agent)) {
      agents.add(t.agent);
      insertAgent.run(
        t.agent,
        t.session,
        t.agent.startsWith("agent-w2") ? "reviewer" : "general-purpose",
        `tu-${t.agent}`,
      );
    }
    if (t.tool) {
      insertTool.run(`te-w-${i}`, t.session, at(t.h), t.tool.name, t.tool.exit, t.tool.family);
      insertMeta.run(`te-w-${i}`, id);
    }
  });
  db.prepare(
    "UPDATE sessions SET cost_equiv_u = (SELECT COALESCE(SUM(cost_equiv_u),0) FROM turns WHERE turns.session_id = sessions.session_id) WHERE workspace_id = ?",
  ).run(P.workspaceId);
}
