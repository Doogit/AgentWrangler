/**
 * test/query/api/ledger-daily-provider.test.ts — P3.L L7 reader over `ledger_daily`.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim, ClaimProducer } from "../../../src/detector/claim-ledger.js";
import { writeLedgerDaily } from "../../../src/detector/ledger-daily.js";
import {
  ledgerDailyProvider,
  ledgerReliabilityU,
} from "../../../src/query/api/ledger-daily-provider.js";
import { migratedMemDb } from "../../ingest/dbutil.js";

const WS = "ws-l7p";
const NOW = new Date("2027-03-01T10:00:00.000Z");

let db: Database.Database;

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

const producer = (
  detectorId: string,
  list: Array<[session: string, message: string, tokens: number]>,
): ClaimProducer => ({
  detectorId,
  produce: (): Claim[] =>
    list.map(([sessionId, message, tokens]) => ({
      detectorId,
      workspaceId: WS,
      sessionId,
      turnKey: `${sessionId}|${message}`,
      component: "cacheRead",
      slice: `${detectorId}.md`,
      tokens,
      recId: `rec-${detectorId}`,
    })),
});

beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, 'l7p', '2027-01-01T00:00:00.000Z')",
  ).run(WS);
  db.prepare(
    `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-l7', 'sonnet', '[1,1,1,1,1]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
  // 7d window = [02-22, 03-01); 14d = [02-15, 03-01); previous 14d = [02-01, 02-15).
  addTurn("s1", "m0", "2027-02-27T01:00:00.000Z");
  addTurn("s1", "m1", "2027-02-20T01:00:00.000Z");
  addTurn("s1", "m2", "2027-02-10T01:00:00.000Z");
  addTurn("s2", "x0", "2027-02-27T05:00:00.000Z");
  writeLedgerDaily(db, NOW, [
    producer("D1", [
      ["s1", "m0", 1000],
      ["s1", "m1", 1000],
      ["s1", "m2", 1000],
      ["s2", "x0", 700], // leaves 300 of the turn's 1000 cacheRead for D10
    ]),
    producer("D10", [["s2", "x0", 300]]),
  ]);
});
afterEach(() => db.close());

describe("ledgerDailyProvider", () => {
  it("sums window days, previous window, positions, top claim and sessions", () => {
    const out = ledgerDailyProvider(db)(14, NOW);
    const c = out.causes.get("ALWAYS_LOADED_TOO_BIG");
    expect(c).toMatchObject({
      avoidable_u: 3000, // 02-27: 1000 + 700 + 300 ; 02-20: 1000 (02-10 is previous)
      prev_avoidable_u: 1000,
      basis: "LEDGER",
      coverage: "ALL",
      sessions_affected: 2,
    });
    expect(c?.position_u?.reduce((t, v) => t + v, 0)).toBe(3000);
    expect(c?.top_claim).toEqual({
      session_id: "s1",
      message_id: "m0",
      value_u: 1000,
      ts: "2027-02-27T01:00:00.000Z",
    });
  });

  it("7d window excludes older days and its previous window is the 7 days before", () => {
    const c = ledgerDailyProvider(db)(7, NOW).causes.get("ALWAYS_LOADED_TOO_BIG");
    expect(c?.avoidable_u).toBe(2000);
    expect(c?.prev_avoidable_u).toBe(1000);
    expect(c?.sessions_affected).toBe(2);
  });

  it("reports PARTIAL coverage with zero (not null) when producers exist but claimed nothing", () => {
    const c = ledgerDailyProvider(db)(7, NOW).causes.get("TOOL_RESULTS_TOO_LARGE");
    expect(c).toMatchObject({
      coverage: "PARTIAL",
      avoidable_u: 0,
      basis: "LEDGER",
      sessions_affected: 0,
    });
    expect(c?.top_claim).toBeUndefined();
  });

  it("tile equals the sum of the cause figures", () => {
    for (const w of [7, 14, 30] as const) {
      const out = ledgerDailyProvider(db)(w, NOW);
      const sum = [...out.causes.values()].reduce((t, f) => t + (f.avoidable_u ?? 0), 0);
      expect(out.tile_u).toBe(sum);
    }
    expect(ledgerDailyProvider(db)(7, NOW).tile_u).toBe(2000);
  });

  it("returns every figure null when no block ends at the requested midnight", () => {
    const out = ledgerDailyProvider(db)(7, new Date("2027-03-02T10:00:00.000Z"));
    expect(out.tile_u).toBeNull();
    expect(out.causes.size).toBeGreaterThan(0);
    for (const f of out.causes.values())
      expect(f).toMatchObject({ avoidable_u: null, prev_avoidable_u: null, basis: null });
  });

  it("does not double count old-grid rows when a date-roll rewrite dies mid-loop", () => {
    const next = new Date("2027-03-02T10:00:00.000Z");
    const failFrom = new Date(Date.UTC(2027, 2, 2) - 14 * 24 * 60 * 60 * 1000).toISOString();
    const boom: ClaimProducer = {
      detectorId: "D1",
      produce: (_db, ctx) => {
        if (ctx.fromIso === failFrom) throw new Error("boom");
        return [];
      },
    };
    expect(() => writeLedgerDaily(db, next, [boom])).toThrow("boom");
    // Block 1 is unmarked, so a 7d call (blocks 0-1) must be all-null rather than a partial sum.
    const out = ledgerDailyProvider(db)(7, next);
    expect(out.tile_u).toBeNull();
    for (const f of out.causes.values()) expect(f.avoidable_u).toBeNull();
  });

  it("requires every needed block: a missing oldest block nulls 30d but not 7d", () => {
    const oldest = new Date(Date.UTC(2027, 2, 1) - 63 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM ledger_daily_marks WHERE block_start = ?").run(oldest);
    expect(ledgerDailyProvider(db)(30, NOW).tile_u).toBeNull();
    expect(ledgerDailyProvider(db)(7, NOW).tile_u).toBe(2000);
  });

  it("asOf at midnight and at 23:59 the same day give the same result", () => {
    const a = ledgerDailyProvider(db)(14, new Date("2027-03-01T00:00:00.000Z"));
    const b = ledgerDailyProvider(db)(14, new Date("2027-03-01T23:59:00.000Z"));
    expect([...b.causes]).toEqual([...a.causes]);
    expect(b.tile_u).toBe(a.tile_u);
    expect(a.tile_u).toBe(3000);
  });

  it("ledgerReliabilityU sums reliability rows for the families; null when none", () => {
    const reliability = (id: string): ClaimProducer => ({
      detectorId: id,
      produce: (): Claim[] => [
        {
          detectorId: id,
          workspaceId: WS,
          sessionId: "s1",
          turnKey: "s1|m0",
          component: "cacheRead",
          slice: "turn:*",
          tokens: 400,
          lane: "reliability",
          assumed: true,
        },
      ],
    });
    writeLedgerDaily(db, NOW, [reliability("C3")]);
    expect(ledgerReliabilityU(db, 7, NOW, ["C3", "C4"])).toBe(400);
    expect(ledgerReliabilityU(db, 7, NOW, ["C4"])).toBeNull();
    // Spend rows never leak into the reliability sum.
    expect(ledgerReliabilityU(db, 7, NOW, ["D1"])).toBeNull();
    // Outside the window / unmarked midnight.
    expect(ledgerReliabilityU(db, 7, new Date("2027-03-02T10:00:00.000Z"), ["C3"])).toBeNull();
  });

  it("top_claim ties on value and ts → the larger message_id wins", () => {
    addTurn("s3", "a1", "2027-02-28T03:00:00.000Z"); // a turn bills 1000 cacheRead, so max 1000
    addTurn("s3", "b1", "2027-02-28T03:00:00.000Z");
    writeLedgerDaily(db, NOW, [
      producer("D1", [
        ["s1", "m0", 1000],
        ["s1", "m1", 1000],
        ["s1", "m2", 1000],
        ["s2", "x0", 700],
        ["s3", "a1", 1000],
        ["s3", "b1", 1000],
      ]),
      producer("D10", [["s2", "x0", 300]]),
    ]);
    const c = ledgerDailyProvider(db)(7, NOW).causes.get("ALWAYS_LOADED_TOO_BIG");
    expect(c?.top_claim).toMatchObject({ session_id: "s3", message_id: "b1", value_u: 1000 });
  });
});
