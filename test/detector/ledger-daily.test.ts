/**
 * test/detector/ledger-daily.test.ts — P3.L L7 writer: midnight-aligned 7-day blocks of the
 * claim ledger aggregated per UTC day. Synthetic DB, test-only producers (1 token = 1 µ$ unit).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim, ClaimProducer } from "../../src/detector/claim-ledger.js";
import { buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { writeLedgerDaily } from "../../src/detector/ledger-daily.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const WS = "ws-l7";
const NOW = new Date("2027-03-01T10:00:00.000Z"); // D = 2027-03-01T00:00Z
const DAY_MS = 24 * 60 * 60 * 1000;
const TABLES = ["ledger_daily", "ledger_daily_top", "ledger_daily_sessions", "ledger_daily_marks"];

let db: Database.Database;

beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, 'l7', '2027-01-01T00:00:00.000Z')",
  ).run(WS);
  db.prepare(
    `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-l7', 'sonnet', '[1,1,1,1,1]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
});
afterEach(() => db.close());

function addTurn(session: string, message: string, ts: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, '/f.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(session, WS, ts, ts);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-5', 0, 1000, 1000, 1000, 0, 0, 0, NULL, 'snap-l7', 0, 'LIST_EQUIV', 0, 'v1')`,
  ).run(message, session, WS, ts);
}

type Spec = [session: string, message: string, tokens: number, detector?: string];

/** A producer that claims `tokens` of cacheRead on each listed turn. */
function producers(specs: Spec[]): ClaimProducer[] {
  const byDetector = new Map<string, Spec[]>();
  for (const spec of specs) {
    const id = spec[3] ?? "D1";
    byDetector.set(id, [...(byDetector.get(id) ?? []), spec]);
  }
  return [...byDetector].map(([detectorId, list]) => ({
    detectorId,
    produce: (): Claim[] =>
      list.map(([session, message, tokens]) => ({
        detectorId,
        workspaceId: WS,
        sessionId: session,
        turnKey: `${session}|${message}`,
        component: "cacheRead",
        slice: "MEMORY.md",
        tokens,
        recId: `rec-${detectorId}`,
      })),
  }));
}

const snapshot = () =>
  JSON.stringify(
    TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4, 5, 6`).all()),
  );

// Block 0 = [2027-02-22, 2027-03-01); block 1 = [2027-02-15, 2027-02-22).
function sixTurnSession(): void {
  for (let i = 0; i < 6; i++)
    addTurn("s1", `m${i}`, `2027-02-${i < 3 ? "24" : "25"}T0${i}:00:00.000Z`);
}

describe("writeLedgerDaily", () => {
  it("splits a block into UTC days; day sums equal the live ledger", () => {
    sixTurnSession();
    const specs: Spec[] = [
      ["s1", "m0", 1000],
      ["s1", "m5", 500],
    ];
    const result = writeLedgerDaily(db, NOW, producers(specs));
    expect(result).toEqual({ blocks_total: 9, blocks_written: 9 });
    const rows = db
      .prepare("SELECT day, value_u, tokens FROM ledger_daily ORDER BY day")
      .all() as Array<{ day: string; value_u: number; tokens: number }>;
    expect(rows).toEqual([
      { day: "2027-02-24", value_u: 1000, tokens: 1000 },
      { day: "2027-02-25", value_u: 500, tokens: 500 },
    ]);
    const live = buildClaimLedger(
      db,
      {
        now: new Date("2027-03-01T00:00:00.000Z"),
        fromIso: "2027-02-22T00:00:00.000Z",
        toIso: "2027-03-01T00:00:00.000Z",
      },
      producers(specs),
    );
    expect(live.claims.reduce((t, c) => t + c.value_u, 0)).toBe(
      rows.reduce((t, r) => t + r.value_u, 0),
    );
  });

  it("buckets by session position: first turn in pos0, last turn in pos5; Σ pos == value", () => {
    sixTurnSession();
    writeLedgerDaily(
      db,
      NOW,
      producers([
        ["s1", "m0", 1000],
        ["s1", "m5", 500],
      ]),
    );
    const rows = db
      .prepare(
        "SELECT day, value_u, pos0_u, pos1_u, pos2_u, pos3_u, pos4_u, pos5_u FROM ledger_daily ORDER BY day",
      )
      .all() as Array<Record<string, number | string>>;
    expect(rows[0]).toMatchObject({ pos0_u: 1000, pos5_u: 0 });
    expect(rows[1]).toMatchObject({ pos0_u: 0, pos5_u: 500 });
    for (const r of rows) {
      const sum = [0, 1, 2, 3, 4, 5].reduce((t, i) => t + (r[`pos${i}_u`] as number), 0);
      expect(sum).toBe(r.value_u);
    }
  });

  it("stores the largest (detector, turn) and per-session sums", () => {
    sixTurnSession();
    writeLedgerDaily(
      db,
      NOW,
      producers([
        ["s1", "m0", 300],
        ["s1", "m1", 700],
        ["s1", "m2", 700],
      ]),
    );
    expect(
      db.prepare("SELECT session_id, message_id, value_u FROM ledger_daily_top").all(),
    ).toEqual([{ session_id: "s1", message_id: "m2", value_u: 700 }]); // tie → later ts
    expect(db.prepare("SELECT session_id, value_u FROM ledger_daily_sessions").all()).toEqual([
      { session_id: "s1", value_u: 1700 },
    ]);
  });

  it("is idempotent, and a new turn in block 1 makes only block 1 stale", () => {
    sixTurnSession();
    addTurn("s2", "x0", "2027-02-16T00:00:00.000Z");
    const prod = producers([
      ["s1", "m0", 1000],
      ["s2", "x0", 400],
    ]);
    writeLedgerDaily(db, NOW, prod);
    const before = snapshot();
    expect(writeLedgerDaily(db, NOW, prod)).toEqual({ blocks_total: 9, blocks_written: 0 });
    expect(snapshot()).toBe(before);

    addTurn("s2", "x1", "2027-02-17T00:00:00.000Z");
    expect(writeLedgerDaily(db, NOW, prod).blocks_written).toBe(1);
    expect(writeLedgerDaily(db, NOW, prod).blocks_written).toBe(0);
  });

  it("a date roll rebuilds the shifted grid and GCs rows outside it", () => {
    sixTurnSession();
    addTurn("s2", "x0", "2026-12-31T00:00:00.000Z"); // oldest block only
    const prod = producers([
      ["s1", "m0", 1000],
      ["s2", "x0", 400],
    ]);
    writeLedgerDaily(db, NOW, prod);
    const oldest = new Date(Date.UTC(2027, 2, 1) - 63 * DAY_MS).toISOString();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM ledger_daily WHERE block_start = ?").get(oldest),
    ).toEqual({ n: 1 });

    const next = new Date(NOW.getTime() + DAY_MS);
    expect(writeLedgerDaily(db, next, prod).blocks_written).toBe(9);
    for (const t of TABLES)
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE block_start = ?`).get(oldest),
      ).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_daily_marks").get()).toEqual({ n: 9 });
  });

  it("a provisional turn flipped to final (rowid unchanged) makes its block stale", () => {
    addTurn("s1", "m0", "2027-02-24T00:00:00.000Z");
    db.prepare("UPDATE turns SET provisional = 1 WHERE message_id = 'm0'").run();
    const prod = producers([["s1", "m0", 1000]]);
    writeLedgerDaily(db, NOW, prod);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_daily").get()).toEqual({ n: 0 });
    db.prepare("UPDATE turns SET provisional = 0 WHERE message_id = 'm0'").run();
    expect(writeLedgerDaily(db, NOW, prod).blocks_written).toBe(1);
    expect(db.prepare("SELECT SUM(value_u) AS v FROM ledger_daily").get()).toEqual({ v: 1000 });
  });

  it("a repriced turn (cost_equiv_u changed in place) makes its block stale", () => {
    addTurn("s1", "m0", "2027-02-24T00:00:00.000Z");
    const prod = producers([["s1", "m0", 1000]]);
    writeLedgerDaily(db, NOW, prod);
    db.prepare("UPDATE turns SET cost_equiv_u = 5 WHERE message_id = 'm0'").run();
    expect(writeLedgerDaily(db, NOW, prod).blocks_written).toBe(1);
  });

  it("a mid-loop throw after a date roll leaves no old-grid rows behind", () => {
    addTurn("s1", "m0", "2027-02-24T00:00:00.000Z");
    writeLedgerDaily(db, NOW, producers([["s1", "m0", 1000]]));
    const next = new Date(NOW.getTime() + DAY_MS);
    const failFrom = new Date(Date.UTC(2027, 2, 2) - 14 * DAY_MS).toISOString(); // block 1 start
    const boom: ClaimProducer = {
      detectorId: "D1",
      produce: (_db, ctx) => {
        if (ctx.fromIso === failFrom) throw new Error("boom");
        return [];
      },
    };
    expect(() => writeLedgerDaily(db, next, [boom])).toThrow("boom");
    const starts = db.prepare("SELECT DISTINCT block_start AS s FROM ledger_daily").all();
    const newGrid = new Set(
      Array.from({ length: 9 }, (_, k) =>
        new Date(Date.UTC(2027, 2, 2) - 7 * (k + 1) * DAY_MS).toISOString(),
      ),
    );
    for (const r of starts as Array<{ s: string }>) expect(newGrid.has(r.s)).toBe(true);
  });

  it("buckets a middle turn of a 12-turn session that straddles the block boundary", () => {
    // turns 0..5 in block 1 (before 02-22), 6..11 in block 0; turn 7 of 12 → bucket 3
    for (let i = 0; i < 12; i++)
      addTurn(
        "s3",
        `t${String(i).padStart(2, "0")}`,
        `2027-02-${i < 6 ? "21" : "23"}T${String(i).padStart(2, "0")}:00:00.000Z`,
      );
    writeLedgerDaily(db, NOW, producers([["s3", "t07", 800]]));
    expect(
      db.prepare("SELECT pos0_u, pos1_u, pos2_u, pos3_u, pos4_u, pos5_u FROM ledger_daily").all(),
    ).toEqual([{ pos0_u: 0, pos1_u: 0, pos2_u: 0, pos3_u: 800, pos4_u: 0, pos5_u: 0 }]);
  });

  it("asOf at midnight and at 23:59 the same day share one grid", () => {
    addTurn("s1", "m0", "2027-02-24T00:00:00.000Z");
    const prod = producers([["s1", "m0", 1000]]);
    writeLedgerDaily(db, new Date("2027-03-01T00:00:00.000Z"), prod);
    const before = snapshot();
    expect(writeLedgerDaily(db, new Date("2027-03-01T23:59:00.000Z"), prod).blocks_written).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it("top ties on value and ts → the larger message_id wins", () => {
    addTurn("s1", "a1", "2027-02-24T00:00:00.000Z");
    addTurn("s1", "b1", "2027-02-24T00:00:00.000Z");
    writeLedgerDaily(
      db,
      NOW,
      producers([
        ["s1", "a1", 500],
        ["s1", "b1", 500],
      ]),
    );
    expect(db.prepare("SELECT message_id FROM ledger_daily_top").all()).toEqual([
      { message_id: "b1" },
    ]);
  });
});
