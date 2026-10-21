import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_PRODUCERS,
  SPEND_LANE_DETECTOR_IDS,
  buildClaimLedger,
} from "../../src/detector/claim-ledger.js";
import { recId } from "../../src/detector/rec-id.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const ctx: DetectorContext = {
  now: new Date("2026-01-02T00:00:00.000Z"),
  fromIso: "2026-01-01T00:00:00.000Z",
  toIso: "2026-01-02T00:00:00.000Z",
};

type Db = ReturnType<typeof createInMemoryFixtureDb>;

// L8: a failure is priced at its recovery turn. Fixture sess-a1: msg-a1-1 (00:00), msg-a1-2 (00:10,
// in=2000 out=400 cacheRead=1000 cw5m=500), msg-a1-3 (00:20, in=1500 out=300).
describe("claim ledger L8 recovery turn", () => {
  const dbs: Db[] = [];
  const fixture = () => {
    const db = createInMemoryFixtureDb();
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  // C3 (Edit NOT_READ) has no minimum count, so one event is enough.
  function fail(db: Db, id: string, owner: string, at: string) {
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class,
         tool_error_class, tool_error_classifier_version)
       VALUES (?, 'sess-a1', ?, 'Edit', 'ERROR', 'NOT_READ', 'tool-error-1')`,
    ).run(id, at);
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    ).run(id, owner);
  }
  const c3 = (db: Db, window = ctx) =>
    buildClaimLedger(db, window).claims.filter((claim) => claim.detectorId === "C3");
  const addTurn = (db: Db, id: string, at: string, side: number, prov: number) =>
    db
      .prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
           cache_write_other, pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, 'sess-a1', 'ws-alpha', ?, 'claude-sonnet', ?, 7, 7, 0, 0, 0, 0,
           'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
      )
      .run(id, at, side, prov);

  it("claims the full billed tokens of the next turn, not the issuing turn", () => {
    const db = fixture();
    fail(db, "f1", "msg-a1-1", "2026-01-01T00:01:00.000Z");
    const claims = c3(db);
    expect(claims.every((claim) => claim.turnKey === "sess-a1|msg-a1-2")).toBe(true);
    expect(Object.fromEntries(claims.map((claim) => [claim.component, claim.tokens]))).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 1000,
      cw5m: 500,
    });
    expect(
      claims.every(
        (claim) =>
          claim.lane === "reliability" && claim.slice === "turn:*" && claim.assumed === true,
      ),
    ).toBe(true);
  });

  it("skips sidechain and provisional turns when finding the recovery turn", () => {
    const db = fixture();
    addTurn(db, "msg-side", "2026-01-01T00:05:00.000Z", 1, 0);
    addTurn(db, "msg-prov", "2026-01-01T00:06:00.000Z", 0, 1);
    fail(db, "f1", "msg-a1-1", "2026-01-01T00:01:00.000Z");
    expect(new Set(c3(db).map((claim) => claim.turnKey))).toEqual(new Set(["sess-a1|msg-a1-2"]));
  });

  it("prices several failures in one turn as one recovery claim", () => {
    const db = fixture();
    // Successful calls between the failures keep D7's loop matcher from excluding the turn.
    fail(db, "f1", "msg-a1-1", "2026-01-01T00:01:00.000Z");
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, input_hash)
       VALUES ('ok1', 'sess-a1', '2026-01-01T00:02:00.000Z', 'Bash', 'OK', 'h-ok')`,
    ).run();
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES ('ok1', 'msg-a1-1', 1, 0)",
    ).run();
    fail(db, "f2", "msg-a1-1", "2026-01-01T00:03:00.000Z");
    expect(c3(db)).toHaveLength(4);
  });

  it("claims nothing when the session ends at the issuing turn", () => {
    const db = fixture();
    fail(db, "f1", "msg-a1-3", "2026-01-01T00:21:00.000Z");
    expect(c3(db)).toEqual([]);
  });

  it("drops a recovery turn outside the window, either side", () => {
    const db = fixture();
    fail(db, "f1", "msg-a1-2", "2026-01-01T00:11:00.000Z");
    // R = msg-a1-3 at 00:20, past toIso.
    expect(c3(db, { ...ctx, toIso: "2026-01-01T00:15:00.000Z" })).toEqual([]);
    expect(c3(db)).toHaveLength(2);
    // R = msg-a1-2 at 00:10, before fromIso.
    const early = fixture();
    fail(early, "f1", "msg-a1-1", "2026-01-01T00:13:00.000Z");
    expect(c3(early, { ...ctx, fromIso: "2026-01-01T00:12:00.000Z" })).toEqual([]);
  });

  // U7: C3 emits one card per workspace, so the claim's rec id drops the session.
  it("tags a reliability claim with its card's rec id (C3: workspace)", () => {
    const db = fixture();
    fail(db, "f1", "msg-a1-1", "2026-01-01T00:01:00.000Z");
    const ids = new Set(c3(db).map((claim) => claim.recId));
    expect(ids).toEqual(new Set([recId("C3", "ws-alpha", "C3|ws-alpha")]));
  });

  // U9 r9: C1 fires one global card per tool (`C1|<tool>`); a bare "C1" key matched no card.
  it("tags a C1 claim with the failing tool's card rec id", () => {
    const db = fixture();
    // An outlier tool (C1 needs 20+ calls, 3+ errors, over twice the corpus rate) among many
    // successful calls of another tool.
    const call = (id: string, tool: string, exit: string, n: number) => {
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, input_hash)
         VALUES (?, 'sess-a1', ?, ?, ?, ?)`,
      ).run(id, `2026-01-01T00:01:${String(n % 60).padStart(2, "0")}.000Z`, tool, exit, id);
      db.prepare(
        "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, 'msg-a1-1', ?, 0)",
      ).run(id, n);
    };
    for (let i = 0; i < 20; i++)
      call(`j${i}`, "mcp__x__js", i % 2 === 0 && i < 6 ? "ERROR" : "OK", i);
    for (let i = 0; i < 100; i++) call(`r${i}`, "Read", "OK", 20 + i);
    const claims = buildClaimLedger(db, ctx).claims.filter((claim) => claim.detectorId === "C1");
    expect(claims.length).toBeGreaterThan(0);
    expect(new Set(claims.map((claim) => claim.recId))).toEqual(
      new Set([recId("C1", null, "C1|mcp__x__js")]),
    );
  });

  describe("recovery-turn collision between two recs of one family", () => {
    // C9 keys on (workspace, label), so two labels denied in one turn share the recovery turn.
    const deny = (db: Db, id: string, label: string, at: string) =>
      db
        .prepare(
          `INSERT INTO ingest_metric_events
             (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
              is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
           VALUES (?, 'sess-a1', NULL, 0, 0, 0, 0, ?, 'bash:args-1', ?, 0)`,
        )
        .run(id, label, at);
    const c9 = (db: Db) =>
      buildClaimLedger(db, ctx).claims.filter((claim) => claim.detectorId === "C9");
    const hook = recId("C9", "ws-alpha", "C9|ws-alpha|HOOK_BLOCK");
    const rule = recId("C9", "ws-alpha", "C9|ws-alpha|DENY_RULE");

    it("gives the whole recovery turn to the rec with the most issuing events", () => {
      const db = fixture();
      deny(db, "d1", "deny-rule", "2026-01-01T00:02:00.000Z");
      deny(db, "d2", "hook-block", "2026-01-01T00:03:00.000Z");
      deny(db, "d3", "hook-block", "2026-01-01T00:04:00.000Z");
      const claims = c9(db);
      expect(new Set(claims.map((claim) => claim.recId))).toEqual(new Set([hook]));
      // One owner, full turn: the recovery turn is priced once, not split.
      expect(Object.fromEntries(claims.map((claim) => [claim.component, claim.tokens]))).toEqual({
        input: 2000,
        output: 400,
        cacheRead: 1000,
        cw5m: 500,
      });
    });

    it("breaks a tie to the lowest rec id", () => {
      const db = fixture();
      deny(db, "d1", "deny-rule", "2026-01-01T00:02:00.000Z");
      deny(db, "d2", "hook-block", "2026-01-01T00:03:00.000Z");
      const expected = [hook, rule].sort()[0];
      expect(new Set(c9(db).map((claim) => claim.recId))).toEqual(new Set([expected]));
    });
  });

  it("prices a D14 user Esc (an ingest_metric_events row) at its recovery turn, tagged with its card (RC-D14)", () => {
    const db = fixture();
    db.prepare("UPDATE sessions SET state = 'RECONCILED' WHERE session_id = 'sess-a1'").run();
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, classifier_label, classifier_version, event_ts, is_sidechain)
       VALUES ('esc1', 'sess-a1', NULL, 0, 0, 0, 1, 'interrupt-cancel', 'classifier-2',
               '2026-01-01T00:01:00.000Z', 0)`,
    ).run();
    const claims = buildClaimLedger(db, ctx).claims.filter((claim) => claim.detectorId === "D14");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.turnKey === "sess-a1|msg-a1-2")).toBe(true);
    expect(new Set(claims.map((claim) => claim.recId))).toEqual(
      new Set([recId("D14", "ws-alpha", "D14|ws-alpha|sess-a1|PURE_INTERRUPT")]),
    );
  });

  it("leaves spend-lane claims identical with and without the reliability producers", () => {
    const db = fixture();
    fail(db, "f1", "msg-a1-1", "2026-01-01T00:01:00.000Z");
    const spendOnly = CLAIM_PRODUCERS.filter((p) => SPEND_LANE_DETECTOR_IDS.has(p.detectorId));
    const spend = (ledger: ReturnType<typeof buildClaimLedger>) =>
      ledger.claims.filter((claim) => claim.lane === "spend");
    expect(spend(buildClaimLedger(db, ctx))).toEqual(spend(buildClaimLedger(db, ctx, spendOnly)));
  });
});
