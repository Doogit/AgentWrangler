import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimLedger, LedgerEntry } from "../../src/detector/claim-ledger.js";
import {
  __resetLedgerAggregates,
  aggregateClaims,
  aggregateLedger,
  seedLedgerAggregates,
  usedLedgerAggregates,
} from "../../src/query/api/ledger-aggregate.js";
import { RecEvidenceContext } from "../../src/query/api/rec-evidence.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// The reset grid is Monday 00:00 UTC when user_config has no limit_resets_at.
const NOW = new Date("2027-01-20T12:00:00.000Z"); // Wednesday; the current grid week starts 01-18
const WEEK_A = { from: "2026-11-30T00:00:00.000Z", to: "2026-12-07T00:00:00.000Z" };
const WEEK_B = { from: "2026-12-07T00:00:00.000Z", to: "2026-12-14T00:00:00.000Z" };
const CURRENT = { from: "2027-01-13T12:00:00.000Z", to: NOW.toISOString() };

const db = createInMemoryFixtureDb();
db.prepare("DELETE FROM user_config WHERE key = 'limit_resets_at'").run();

function turn(id: string, ts: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count)
     VALUES ('agg-sess', 'ws-alpha', 'fixture/agg', ?, ?, 'RECONCILED', 1)`,
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES (?, 'agg-sess', 'ws-alpha', ?, 'claude-sonnet', 'test')`,
  ).run(id, ts);
}

let builds: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  builds = [];
  __resetLedgerAggregates();
  const original = RecEvidenceContext.prototype.ledger;
  spy = vi.spyOn(RecEvidenceContext.prototype, "ledger").mockImplementation(function (
    this: RecEvidenceContext,
    window,
  ) {
    builds.push(window.from);
    return original.call(this, window);
  });
  turn("agg-a1", "2026-12-02T00:00:00.000Z");
  turn("agg-b1", "2026-12-09T00:00:00.000Z");
});
afterEach(() => {
  spy.mockRestore();
  db.prepare("DELETE FROM turns WHERE message_id LIKE 'agg-%'").run();
  db.prepare("DELETE FROM sessions WHERE session_id = 'agg-sess'").run();
});

/** One build as the worker runs it: seed from the previous build, evaluate, hand back the used set. */
function build(windows: Array<{ from: string; to: string }>) {
  const context = new RecEvidenceContext(db, NOW);
  for (const window of windows) context.aggregate(window);
  return usedLedgerAggregates();
}

describe("closed-window ledger aggregate reuse", () => {
  it("rebuilds only the closed window whose fingerprint changed", () => {
    const first = build([WEEK_A, WEEK_B]);
    expect(builds).toHaveLength(2);
    expect(first).toHaveLength(2);

    builds = [];
    seedLedgerAggregates(first);
    build([WEEK_A, WEEK_B]);
    expect(builds).toEqual([]); // both reused

    // A late turn lands inside week A only.
    turn("agg-a2", "2026-12-03T00:00:00.000Z");
    builds = [];
    seedLedgerAggregates(first);
    const third = build([WEEK_A, WEEK_B]);
    expect(builds).toEqual([WEEK_A.from]);
    expect(third).toHaveLength(2);
  });

  it("drops a key that the next build no longer uses", () => {
    const first = build([WEEK_A, WEEK_B]);
    seedLedgerAggregates(first);
    expect(build([WEEK_B])).toHaveLength(1);
  });

  it("never serves a current-week window from the cache, and never stores it", () => {
    const first = build([WEEK_A, CURRENT]);
    expect(first).toHaveLength(1); // only the closed week is carried
    builds = [];
    seedLedgerAggregates(first);
    build([WEEK_A, CURRENT]);
    expect(builds).toEqual([CURRENT.from]); // current week rebuilt, week A reused
  });

  it("a request-time context without a clock caches nothing", () => {
    const context = new RecEvidenceContext(db);
    context.aggregate(WEEK_A);
    expect(usedLedgerAggregates()).toEqual([]);
  });
});

describe("ledger aggregate readers", () => {
  const claim = (over: Partial<LedgerEntry>): LedgerEntry =>
    ({
      detectorId: "D8",
      workspaceId: "ws-alpha",
      sessionId: "s1",
      turnKey: "t",
      component: "cw5m",
      slice: "*",
      tokens: 1,
      raw_tokens: 1,
      requested_tokens: 1,
      unpriced: false,
      lane: "spend",
      recId: "rec-1",
      value_u: 0.1,
      ...over,
    }) as LedgerEntry;
  // Floats whose sum depends on addition order (0.1 + 0.2 + 0.3 differs from 0.3 + 0.2 + 0.1).
  const ledger = {
    claims: [
      claim({ value_u: 0.1 }),
      claim({ sessionId: "s2", value_u: 1e16 }),
      claim({ value_u: 0.2 }),
      claim({ lane: "reliability", sidechain: true, value_u: 0.7 }),
      claim({ sessionId: "s2", value_u: -1e16 }),
      claim({ value_u: 0.3 }),
      { ...claim({ unpriced: true, value_u: 0 }), recId: undefined } as unknown as LedgerEntry,
    ],
    subordinate: [],
    rejected: [],
    billed: new Map(),
    billedValue: new Map(),
  } as ClaimLedger;

  it("replays the ledger's claims in order with the fields the readers use", () => {
    const replay = [...aggregateClaims(aggregateLedger(ledger))];
    expect(replay).toEqual(
      ledger.claims.map((c) => ({
        detectorId: c.detectorId,
        recId: c.recId,
        workspaceId: c.workspaceId,
        sessionId: c.sessionId,
        lane: c.lane,
        sidechain: c.sidechain === true,
        unpriced: c.unpriced,
        value_u: c.value_u,
      })),
    );
  });

  it("gives byte-identical per-rec and per-session sums to the full ledger", () => {
    const sum = (
      claims: Iterable<{
        lane: string;
        recId?: string | undefined;
        sessionId: string;
        value_u: number;
      }>,
    ) => {
      const byRec = new Map<string, number>();
      const bySession = new Map<string, number>();
      for (const c of claims) {
        if (c.lane === "spend" && c.recId !== undefined)
          byRec.set(c.recId, (byRec.get(c.recId) ?? 0) + c.value_u);
        bySession.set(c.sessionId, (bySession.get(c.sessionId) ?? 0) + c.value_u);
      }
      return { byRec, bySession };
    };
    const old = sum(ledger.claims);
    const slim = sum(aggregateClaims(aggregateLedger(ledger)));
    expect([...slim.byRec]).toEqual([...old.byRec]);
    expect([...slim.bySession]).toEqual([...old.bySession]);
    // Control: summing per tuple first would not match, which is why values stay per claim.
    expect(0.1 + 0.2 + 0.3).not.toBe(0.3 + 0.2 + 0.1);
  });
});
